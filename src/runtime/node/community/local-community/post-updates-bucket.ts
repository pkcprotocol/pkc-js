import { CID } from "multiformats/cid";
import Logger from "../../../../logger.js";
import { PKCError } from "../../../../pkc-error.js";
import { statMfsPathSafely } from "../../../../util.js";
import type { LocalCommunity } from "../local-community.js";
import { patchUnixFsDirectory, type UnixFsBlock, type UnixFsDirectoryEntry } from "./unixfs-directory-patch.js";

// How a post's CommentUpdate reaches the postUpdates folder in MFS. This is the only way: nothing in
// pkc-js writes a file through `files write`.
//
// A bucket is one MFS directory, `/<address>/postUpdates/<bucket>`, with one `<postCid>/update` file
// per post. The posts' new files are built here, the bucket's directory is patched here to link them
// (patchUnixFsDirectory: only the nodes on the changed posts' paths are read and rebuilt, the rest of
// the bucket is carried over by cid), the new blocks go to the daemon as one CAR, and the new bucket
// is swapped in with a cp and a mv.
//
// Why not `files write`, which is what MFS is for:
//  - Kubo loses a write that is still open when a directory above the file is flushed (ipfs/kubo#11494,
//    tracked in issue #556, seen as #551 and #456): the write and the flush after it both succeed and
//    the folder keeps the previous file. Deleting any community on the daemon flushes the MFS root.
//    cp, rm and mv hold nothing open across the request.
//  - Above about 3,000 posts kubo turns the bucket into a HAMT, and from then on every write into it
//    costs the daemon a walk of ~256 KiB of the bucket's links (ipfs/boxo#1226). Rewriting 17,857
//    posts that way took 164 s and 1,000 s of daemon CPU per cycle (issue #471).
//  - The bucket's cid is known before the daemon sees it, so what MFS ends up holding can be checked
//    with one stat instead of reading every file back.
//
// The swap goes through `<bucket>.next` with every step persisted, so a crash can never lose the
// bucket: cp (flush:true) lands the new directory beside the live one, rm takes the live one down,
// mv puts the new one in its place. recoverInterruptedBucketSwap finishes or discards a swap the
// previous process left behind. The blocks a swap adds are pinned until the bucket hangs off the MFS
// root, so a concurrent repo gc cannot take them in between (buildSwapPinManifests).

export type PostUpdatesBucketRow = { postCid: string; updateFileBytes: Uint8Array };

// Time budget for each MFS and import call: a repo gc holds MFS writes off for its whole run (kubo
// 0.43), and on a large repo that is minutes, not seconds.
const MFS_OP_TIMEOUT_MS = 10 * 60 * 1000;

// kubo's MFS defaults for a directory: a basic dag-pb directory until its links pass this many bytes
// (name + cid, boxo's SizeEstimationLinks), then a HAMT with 256-wide shards
const MFS_SHARD_SPLIT_THRESHOLD_BYTES = 256 * 1024;

export const POST_UPDATES_BUCKET_NEXT_SUFFIX = ".next";

// How many times a bucket is swapped in before giving up on MFS holding what was swapped
const MAX_ATTEMPTS_TO_SWAP_POST_UPDATES_BUCKET = 4;

type KuboRpcClient = ReturnType<LocalCommunity["_clientsManager"]["getDefaultKuboRpcClient"]>;

export const isAbsentPathError = (error: unknown) => error instanceof Error && error.message.includes("file does not exist");

async function statMfsPathOrUndefined(kuboRpcClient: KuboRpcClient, path: string, log: Logger) {
    try {
        return await statMfsPathSafely({ kuboRpcClient, path, log });
    } catch (error) {
        if (isAbsentPathError(error)) return undefined;
        throw error;
    }
}

// A bucket that MFS does not hold but that held posts: the files of the posts already marked as published are
// gone with it and no cycle writes them again, so they are marked to be written with the next cycle (#590).
// Posts of a bucket that was emptied on purpose (a purge, or the post moved to a wider bucket) are not marked as
// published in it any more, so this finds nothing to do for them. Returns how many posts were marked.
export function markPostsOfLostBucketForRewrite({
    community,
    bucket,
    log
}: {
    community: LocalCommunity;
    bucket: number;
    log: Logger;
}): number {
    const marked = community._dbHandler.markPublishedPostsOfBucketAsUnpublished(bucket);
    if (marked > 0)
        log.error(
            `The postUpdates bucket ${bucket} of community ${community.address} is not in MFS, and ${marked} posts were published in it. They will be written again by the next cycle`
        );
    return marked;
}

// The posts' `<postCid>/update` files, as the bucket's entries for them (each a `<postCid>` directory
// holding the file) and the blocks those are made of
async function buildPostUpdateFiles(posts: PostUpdatesBucketRow[]): Promise<{ entries: UnixFsDirectoryEntry[]; blocks: UnixFsBlock[] }> {
    const { importer } = await import("ipfs-unixfs-importer");
    const blocks = new Map<string, UnixFsBlock>();
    const blockstore = {
        put: async (cid: CID, bytes: Uint8Array) => {
            blocks.set(cid.toString(), { cid, bytes });
            return cid;
        }
    };
    const entries: UnixFsDirectoryEntry[] = [];
    // The same layout kubo's MFS gives files written into it: CIDv0, dag-pb leaves of 256 KiB, 174 links per node
    for await (const entry of importer(
        posts.map((post) => ({ path: `${post.postCid}/update`, content: post.updateFileBytes })),
        blockstore,
        {
            profile: "unixfs-v0-2015",
            cidVersion: 0,
            rawLeaves: false,
            reduceSingleLeafToSelf: true,
            shardSplitThresholdBytes: MFS_SHARD_SPLIT_THRESHOLD_BYTES,
            wrapWithDirectory: false
        }
    ))
        if (entry.path && !entry.path.includes("/")) entries.push({ name: entry.path, cid: entry.cid, size: Number(entry.size) });
    if (entries.length !== posts.length) throw Error(`Built ${entries.length} post directories for ${posts.length} posts`);
    return { entries, blocks: [...blocks.values()] };
}

// A CARv1: a dag-cbor header naming the roots, then each block as varint(length) + cid bytes + block bytes
export async function encodeCarV1(roots: CID[], blocks: { cid: CID; bytes: Uint8Array }[]): Promise<Uint8Array> {
    const dagCbor = await import("@ipld/dag-cbor");
    const varint = (value: number): Uint8Array => {
        const out: number[] = [];
        while (value >= 0x80) {
            out.push((value & 0x7f) | 0x80);
            value = Math.floor(value / 128);
        }
        out.push(value);
        return Uint8Array.from(out);
    };
    const header = dagCbor.encode({ roots, version: 1 });
    const parts: Uint8Array[] = [varint(header.length), header];
    for (const { cid, bytes } of blocks) parts.push(varint(cid.bytes.length + bytes.length), cid.bytes, bytes);
    const car = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
    let offset = 0;
    for (const part of parts) {
        car.set(part, offset);
        offset += part.length;
    }
    return car;
}

// What the import pins while a bucket is being swapped in: one or more manifest nodes that link the blocks
// the swap adds, and nothing else.
//
// Pinning the new bucket's root instead, which is what a CAR import offers, makes the daemon walk the whole
// bucket to pin it: 195 ms of a 213 ms write of one post into a bucket of 18,000. And the root cannot be
// pinned before its blocks are there (`block put --pin` does that without a walk): a pin whose blocks are
// missing makes every repo gc on the daemon abort and `pin ls` hang, for as long as it exists, and a cycle
// cut off mid-import leaves it behind.
//
// A manifest links each changed post's directory, which the pin follows down to the post's file, and each
// rebuilt node of the bucket's own directory as a raw block. The same bytes under the raw codec are a leaf
// to the pinner, so it does not follow them into the rest of the bucket, and they are the same block to
// the daemon, whose blockstore and gc go by multihash. The pin is complete the moment the import returns,
// and one left behind by a process that died holds this swap's new blocks and no more.
const SWAP_PIN_MANIFEST_MAX_LINKS = 4000; // about 160 KiB a manifest
const RAW_CODEC = 0x55;

async function buildSwapPinManifests({
    postEntries,
    directoryNodes
}: {
    postEntries: UnixFsDirectoryEntry[];
    directoryNodes: UnixFsBlock[];
}): Promise<UnixFsBlock[]> {
    const dagPb = await import("@ipld/dag-pb");
    const { sha256 } = await import("multiformats/hashes/sha2");
    const pinned = [...postEntries.map((entry) => entry.cid), ...directoryNodes.map((node) => CID.createV1(RAW_CODEC, node.cid.multihash))];
    const manifests: UnixFsBlock[] = [];
    for (let index = 0; index < pinned.length; index += SWAP_PIN_MANIFEST_MAX_LINKS) {
        const bytes = dagPb.encode(
            dagPb.prepare({ Links: pinned.slice(index, index + SWAP_PIN_MANIFEST_MAX_LINKS).map((cid) => ({ Name: "", Hash: cid })) })
        );
        manifests.push({ cid: CID.createV1(dagPb.code, await sha256.digest(bytes)), bytes });
    }
    return manifests;
}

// Finishes or discards a swap that an earlier process left half done. Returns the live bucket's stat,
// or undefined when the bucket does not exist yet.
async function recoverInterruptedBucketSwap(kuboRpcClient: KuboRpcClient, bucketPath: string, log: Logger) {
    const kubo = kuboRpcClient._client;
    const nextPath = bucketPath + POST_UPDATES_BUCKET_NEXT_SUFFIX;
    const next = await statMfsPathOrUndefined(kuboRpcClient, nextPath, log);
    let live = await statMfsPathOrUndefined(kuboRpcClient, bucketPath, log);
    if (next) {
        if (live) {
            // The swap stopped before the live bucket came down: the live one is still the published one
            log(`Discarding the stale rebuilt bucket ${nextPath} left by an interrupted swap`);
            await kubo.files.rm(nextPath, { recursive: true, timeout: MFS_OP_TIMEOUT_MS });
        } else {
            // The swap stopped between taking the live bucket down and moving the new one in
            log(`Finishing the interrupted swap of ${nextPath} into ${bucketPath}`);
            await kubo.files.mv(nextPath, bucketPath, { flush: true, timeout: MFS_OP_TIMEOUT_MS });
            // Read back like any other swap: the caller takes what this returns for what MFS holds
            live = await statMfsPathOrUndefined(kuboRpcClient, bucketPath, log);
            if (!live?.cid.equals(next.cid))
                throw Error(
                    `MFS holds ${live?.cid.toString()} at ${bucketPath} after the interrupted swap of ${next.cid.toString()} was finished`
                );
        }
    }
    return live;
}

// Writes the given posts' CommentUpdate files into one bucket, and returns once MFS holds them.
export async function writePostUpdatesToBucket({
    community,
    bucketPath,
    posts
}: {
    community: LocalCommunity;
    bucketPath: string;
    posts: PostUpdatesBucketRow[];
}): Promise<void> {
    const log = Logger("pkc-js:local-community:sync:writePostUpdatesToBucket");
    const kuboRpcClient = community._clientsManager.getDefaultKuboRpcClient();
    const kubo = kuboRpcClient._client;
    const nextPath = bucketPath + POST_UPDATES_BUCKET_NEXT_SUFFIX;

    const { entries, blocks: fileBlocks } = await buildPostUpdateFiles(posts);
    // The bucket's nodes read from the daemon and the ones built here, so a later attempt reads nothing twice
    const bucketBlocks = new Map<string, Uint8Array>();
    const getBlock = async (cid: CID): Promise<Uint8Array> => {
        const key = cid.toString();
        let bytes = bucketBlocks.get(key);
        if (!bytes) {
            bytes = await kubo.block.get(cid, { timeout: MFS_OP_TIMEOUT_MS });
            bucketBlocks.set(key, bytes);
        }
        return bytes;
    };

    let live = await recoverInterruptedBucketSwap(kuboRpcClient, bucketPath, log);
    // No bucket to patch: the one this builds holds these posts only. Posts published in it before are not in it.
    if (!live) markPostsOfLostBucketForRewrite({ community, bucket: Number(bucketPath.split("/").pop()), log });
    let bucketExisted = false;
    for (let attempt = 1; ; attempt++) {
        if (live) bucketExisted = true;
        // A bucket that existed and is gone must not be answered by building one that holds these posts only
        else if (bucketExisted)
            throw new PKCError("ERR_POST_UPDATES_BUCKET_SWAP_WAS_LOST", { communityAddress: community.address, bucketPath, attempt });

        const { cid: root, newBlocks } = await patchUnixFsDirectory({
            directoryCid: live?.cid,
            entriesToPut: entries,
            getBlock,
            shardSplitThresholdBytes: MFS_SHARD_SPLIT_THRESHOLD_BYTES
        });
        // The bucket in MFS links every post's new file already: nothing to write, or a swap whose result
        // differs from what was swapped in only by what somebody else changed since (a purge removing its post)
        if (live && root.equals(live.cid)) return;
        if (attempt > MAX_ATTEMPTS_TO_SWAP_POST_UPDATES_BUCKET)
            throw new PKCError("ERR_POST_UPDATES_BUCKET_SWAP_WAS_LOST", {
                communityAddress: community.address,
                bucketPath,
                attempts: attempt - 1,
                bucketCidInMfs: live?.cid.toString(),
                bucketCidWithThePosts: root.toString()
            });
        for (const block of newBlocks) bucketBlocks.set(block.cid.toString(), block.bytes);

        // The new blocks must survive a repo gc (another community's cycle, or the daemon's own) until the
        // bucket hangs off the MFS root, so the import pins them. See buildSwapPinManifests for what is pinned.
        const manifests = await buildSwapPinManifests({ postEntries: entries, directoryNodes: newBlocks });
        const car = await encodeCarV1(
            manifests.map((manifest) => manifest.cid),
            [...manifests, ...fileBlocks, ...newBlocks]
        );
        try {
            for await (const result of kubo.dag.import([car], { pinRoots: true, timeout: MFS_OP_TIMEOUT_MS }))
                if (result.root.pinErrorMsg)
                    throw Error(
                        `Failed to pin the new blocks of bucket ${bucketPath} (${result.root.cid.toString()}): ${result.root.pinErrorMsg}`
                    );
            log(
                `Bucket ${bucketPath}: ${posts.length} posts written, ${newBlocks.length} of the bucket's nodes rebuilt (${car.length} bytes imported), root ${root.toString()}`
            );
            // Every step flushes: the new bucket must be on disk under the MFS root before the live one goes
            await kubo.files.cp(`/ipfs/${root.toString()}`, nextPath, { parents: true, flush: true, timeout: MFS_OP_TIMEOUT_MS });
            if (live) await kubo.files.rm(bucketPath, { recursive: true, timeout: MFS_OP_TIMEOUT_MS });
            await kubo.files.mv(nextPath, bucketPath, { flush: true, timeout: MFS_OP_TIMEOUT_MS });
        } finally {
            // Referenced from the MFS root now, or abandoned. "not pinned" is the import itself having failed.
            for (const manifest of manifests)
                await kubo.pin.rm(manifest.cid, { timeout: MFS_OP_TIMEOUT_MS }).catch((error) => {
                    if (!(error instanceof Error && error.message.includes("not pinned")))
                        log.error(`Failed to unpin ${manifest.cid.toString()}, which pinned the new blocks of bucket ${bucketPath}`, error);
                });
        }

        // The daemon reported every step as done. Kubo has reported MFS changes as done that MFS then did
        // not hold (ipfs/kubo#11494), so the bucket is read back by its cid, which is known exactly.
        const swapped = await statMfsPathOrUndefined(kuboRpcClient, bucketPath, log);
        if (swapped?.cid.equals(root)) return;
        log.error(
            `Bucket ${bucketPath} is ${swapped?.cid.toString()} in MFS after ${root.toString()} was swapped in (attempt ${attempt}), checking it for the posts' files`
        );
        live = await recoverInterruptedBucketSwap(kuboRpcClient, bucketPath, log);
    }
}

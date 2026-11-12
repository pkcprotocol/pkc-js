import { CID } from "multiformats/cid";
import Logger from "../../../../logger.js";
import { statMfsPathSafely } from "../../../../util.js";
import type { LocalCommunity } from "../local-community.js";

// Rebuilding a postUpdates bucket in node instead of rewriting its files one by one (issue #471).
//
// A bucket is one MFS directory, `/<address>/postUpdates/<bucket>`, with one `<postCid>/update` file
// per post. Above about 3,000 posts kubo turns it into a HAMT, and from then on every `files write`
// into it costs the daemon a walk of ~256 KiB of the bucket's links (ipfs/boxo#1226: the replacement
// looks like a shrink, so the daemon checks whether the HAMT should fold back into a basic directory)
// plus, with flush:true, a re-serialization of every loaded shard. Rewriting 17,857 posts that way
// took 164 s and 1,000 s of daemon CPU per cycle; a one-author board (every post re-signed every
// cycle) pays it on every publication.
//
// Instead, when a slice carries enough posts for one bucket, the bucket is built here: the posts'
// new `update` files, the other entries linked exactly as the live bucket has them, laid out the way
// kubo's MFS lays it out (CIDv0, dag-pb leaves, 256 KiB link threshold for sharding), imported into
// the daemon as one CAR, and swapped in with a cp and a mv. The same 17,857 posts take about 2 s.
//
// The swap goes through `<bucket>.next` with every step persisted, so a crash can never lose the
// bucket: cp (flush:true) lands the new directory beside the live one, rm takes the live one down,
// mv puts the new one in its place. recoverInterruptedBucketSwap finishes or discards a swap the
// previous process left behind. The new root is pinned from the import until it hangs off the MFS
// root, so a concurrent repo gc (another community's cycle, or the daemon's own) cannot take its
// blocks in between.

export type PostUpdatesBucketRow = { postCid: string; updateFileBytes: Uint8Array };

type DirectoryLink = { name: string; cid: CID; size: bigint };

// Time budget for each MFS and import call: a repo gc holds MFS writes off for its whole run (kubo
// 0.43), and on a large repo that is minutes, not seconds.
const MFS_OP_TIMEOUT_MS = 10 * 60 * 1000;

// kubo's MFS defaults for a directory: a basic dag-pb directory until its links pass this many bytes
// (name + cid, boxo's SizeEstimationLinks), then a HAMT with 256-wide shards
const MFS_SHARD_SPLIT_THRESHOLD_BYTES = 256 * 1024;

export const POST_UPDATES_BUCKET_NEXT_SUFFIX = ".next";

// A bucket is rebuilt when a slice has at least this many posts in it; below that the files are
// written one by one. The rebuild's fixed cost is reading the bucket's links and building its
// directory (about 2 s for 17,857 posts, less for a basic directory), the per-file write costs about
// 20 ms of daemon CPU on a sharded bucket (ipfs/boxo#1226) and well under 1 ms on a basic one, so
// the two meet at a couple of hundred posts; the 1M-comment bench (17,857 posts, 2,000-row slices)
// ran with this value. An instance field on LocalCommunity so a test can lower it.
export const POST_UPDATES_NODE_BUILT_BUCKET_MIN_POSTS = 200;

type KuboRpcClient = ReturnType<LocalCommunity["_clientsManager"]["getDefaultKuboRpcClient"]>;

const isAbsentPathError = (error: unknown) => error instanceof Error && error.message.includes("file does not exist");

async function statMfsPathOrUndefined(kuboRpcClient: KuboRpcClient, path: string, log: Logger) {
    try {
        return await statMfsPathSafely({ kuboRpcClient, path, log });
    } catch (error) {
        if (isAbsentPathError(error)) return undefined;
        throw error;
    }
}

// The entries of a UnixFS directory as its dag-pb links (name, cid and the link's Tsize), walking the
// shards of a HAMT. `ipfs ls` reports a size of 0 for a directory entry whether or not it resolves
// the children, and the entries here are the posts' directories, so the links are read from the
// blocks themselves to carry their Tsize over unchanged.
async function listUnixFsDirectoryLinks(kubo: KuboRpcClient["_client"], directoryCid: CID): Promise<DirectoryLink[]> {
    const { UnixFS } = await import("ipfs-unixfs");
    const links: DirectoryLink[] = [];
    const walk = async (cid: CID) => {
        const node = (await kubo.dag.get(cid, { timeout: MFS_OP_TIMEOUT_MS })).value;
        if (!isPbNode(node)) throw Error(`Expected a dag-pb directory node at ${cid.toString()}`);
        const unixfs = UnixFS.unmarshal(node.Data);
        if (unixfs.type === "hamt-sharded-directory") {
            // A shard names its links <2 hex chars of the bucket index><entry name>; a bare index is a sub-shard
            const prefixLength = Math.max(1, Math.ceil(Math.log2(Number(unixfs.fanout ?? 256)) / 4));
            for (const link of node.Links) {
                if (link.Name.length === prefixLength) await walk(link.Hash);
                else links.push({ name: link.Name.slice(prefixLength), cid: link.Hash, size: BigInt(link.Tsize ?? 0) });
            }
        } else if (unixfs.type === "directory") {
            for (const link of node.Links) links.push({ name: link.Name, cid: link.Hash, size: BigInt(link.Tsize ?? 0) });
        } else throw Error(`Expected a UnixFS directory at ${cid.toString()}, got ${unixfs.type}`);
    };
    await walk(directoryCid);
    return links;
}

type PbNode = { Data: Uint8Array; Links: { Name: string; Hash: CID; Tsize?: number }[] };
function isPbNode(value: unknown): value is PbNode {
    if (typeof value !== "object" || value === null) return false;
    const node = value as Partial<PbNode>;
    return (
        node.Data instanceof Uint8Array &&
        Array.isArray(node.Links) &&
        node.Links.every(
            (link) =>
                typeof link?.Name === "string" && (link.Tsize === undefined || typeof link.Tsize === "number") && link.Hash instanceof CID
        )
    );
}

// Builds the bucket directory: a `<postCid>/update` file per changed post, and every other entry linked
// as the live bucket links it. Returns the bucket's root and every block that does not exist yet (the
// changed posts' files and directories, and the bucket's own node or shards).
async function buildPostUpdatesBucketDag({
    existingLinks,
    changedPosts
}: {
    existingLinks: DirectoryLink[];
    changedPosts: PostUpdatesBucketRow[];
}): Promise<{ root: CID; blocks: { cid: CID; bytes: Uint8Array }[] }> {
    const { importer } = await import("ipfs-unixfs-importer");
    const blocks = new Map<string, { cid: CID; bytes: Uint8Array }>();
    const blockstore = {
        put: async (cid: CID, bytes: Uint8Array) => {
            blocks.set(cid.toString(), { cid, bytes });
            return cid;
        }
    };
    // The same layout kubo's MFS gives files written into it: CIDv0, dag-pb leaves of 256 KiB, 174 links per node
    const layoutOptions = {
        profile: "unixfs-v0-2015",
        cidVersion: 0,
        rawLeaves: false,
        reduceSingleLeafToSelf: true,
        shardSplitThresholdBytes: MFS_SHARD_SPLIT_THRESHOLD_BYTES
    } as const;

    // The changed posts' `<postCid>/update` files and their `<postCid>` directories
    const postDirectoryLinks = new Map<string, DirectoryLink>();
    for await (const entry of importer(
        changedPosts.map((post) => ({ path: `${post.postCid}/update`, content: post.updateFileBytes })),
        blockstore,
        { ...layoutOptions, wrapWithDirectory: false }
    ))
        if (entry.path && !entry.path.includes("/"))
            postDirectoryLinks.set(entry.path, { name: entry.path, cid: entry.cid, size: entry.size });
    if (postDirectoryLinks.size !== changedPosts.length)
        throw Error(`Built ${postDirectoryLinks.size} post directories for ${changedPosts.length} changed posts`);

    // The bucket itself: every entry is a known link, so the file builder just hands the link back instead
    // of building anything. The importer only looks at the links' names and cids to decide on sharding.
    const bucketName = "bucket";
    const knownLinks = new Map<string, DirectoryLink>();
    for (const link of existingLinks) knownLinks.set(`${bucketName}/${link.name}`, link);
    for (const link of postDirectoryLinks.values()) knownLinks.set(`${bucketName}/${link.name}`, link);
    let root: CID | undefined;
    for await (const entry of importer(
        [...knownLinks.keys()].map((path) => ({ path, content: new Uint8Array(0) })),
        blockstore,
        {
            ...layoutOptions,
            wrapWithDirectory: false,
            fileBuilder: async (file) => {
                for await (const chunk of file.content) void chunk;
                const link = file.path ? knownLinks.get(file.path) : undefined;
                if (!link) throw Error(`No known link for bucket entry ${file.path}`);
                return { cid: link.cid, size: link.size, path: file.path };
            }
        }
    ))
        if (entry.path === bucketName) root = entry.cid;
    if (!root) throw Error("The rebuilt postUpdates bucket has no root");
    return { root, blocks: [...blocks.values()] };
}

// A CARv1: a dag-cbor header naming the root, then each block as varint(length) + cid bytes + block bytes
async function encodeCarV1(root: CID, blocks: { cid: CID; bytes: Uint8Array }[]): Promise<Uint8Array> {
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
    const header = dagCbor.encode({ roots: [root], version: 1 });
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
            live = next;
        }
        // Its root was pinned for the swap and never unpinned
        await kubo.pin.rm(next.cid, { timeout: MFS_OP_TIMEOUT_MS }).catch(() => undefined);
    }
    return live;
}

// Writes one slice's posts into one bucket by rebuilding the bucket. Returns the posts the bucket kept
// from before, so the caller can re-check them against the DB the way it re-checks the slice's own posts.
export async function rebuildPostUpdatesBucket({
    community,
    bucketPath,
    posts
}: {
    community: LocalCommunity;
    bucketPath: string;
    posts: PostUpdatesBucketRow[];
}): Promise<{ keptPostCids: string[] }> {
    const log = Logger("pkc-js:local-community:sync:rebuildPostUpdatesBucket");
    const kuboRpcClient = community._clientsManager.getDefaultKuboRpcClient();
    const kubo = kuboRpcClient._client;
    const nextPath = bucketPath + POST_UPDATES_BUCKET_NEXT_SUFFIX;

    const live = await recoverInterruptedBucketSwap(kuboRpcClient, bucketPath, log);
    const changedPostCids = new Set(posts.map((post) => post.postCid));
    // A post purged since the live bucket was written is gone from the DB, and its entry is being removed
    // by the purge (or sits in _mfsPathsToRemove): it must not be carried into the new bucket
    const existingLinks = live
        ? (await listUnixFsDirectoryLinks(kubo, live.cid)).filter(
              (link) => !changedPostCids.has(link.name) && community._dbHandler.commentExistsInDb(link.name)
          )
        : [];

    const { root, blocks } = await buildPostUpdatesBucketDag({ existingLinks, changedPosts: posts });
    const car = await encodeCarV1(root, blocks);
    for await (const result of kubo.dag.import([car], { pinRoots: true, timeout: MFS_OP_TIMEOUT_MS }))
        if (result.root.pinErrorMsg) throw Error(`Failed to pin the rebuilt bucket ${root.toString()}: ${result.root.pinErrorMsg}`);
    log(
        `Built bucket ${bucketPath} in node: ${posts.length} posts written, ${existingLinks.length} kept, ${blocks.length} new blocks (${car.length} bytes), root ${root.toString()}`
    );

    try {
        // Every step flushes: the new bucket must be on disk under the MFS root before the live one goes
        await kubo.files.cp(`/ipfs/${root.toString()}`, nextPath, { parents: true, flush: true, timeout: MFS_OP_TIMEOUT_MS });
        if (live) await kubo.files.rm(bucketPath, { recursive: true, timeout: MFS_OP_TIMEOUT_MS });
        await kubo.files.mv(nextPath, bucketPath, { flush: true, timeout: MFS_OP_TIMEOUT_MS });
    } finally {
        // Referenced from the MFS root now (or abandoned beside it, where the next write cleans it up)
        await kubo.pin
            .rm(root, { timeout: MFS_OP_TIMEOUT_MS })
            .catch((error) => log.error(`Failed to unpin the rebuilt bucket root ${root.toString()}`, error));
    }
    return { keptPostCids: existingLinks.map((link) => link.name) };
}

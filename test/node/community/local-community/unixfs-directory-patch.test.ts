import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import { importer } from "ipfs-unixfs-importer";
import { murmur3128 } from "@multiformats/murmur3";
import { mockPKC } from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import {
    patchUnixFsDirectory,
    type UnixFsDirectoryEntry
} from "../../../../dist/node/runtime/node/community/local-community/unixfs-directory-patch.js";
import { encodeCarV1 } from "../../../../dist/node/runtime/node/community/local-community/post-updates-bucket.js";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";

// patchUnixFsDirectory changes some entries of a UnixFS directory by reading and rebuilding only the nodes
// on those entries' paths. It is how every post CommentUpdate reaches the postUpdates folder, so it is
// checked three ways: against ipfs-unixfs-importer building the same directory from scratch (the cids
// must be equal, which pins every byte of every node), for how little it reads, and against a kubo
// daemon reading and changing the directories it produces.

const MFS_SHARD_SPLIT_THRESHOLD_BYTES = 256 * 1024;
const raw = 0x55;

// A seeded generator: the same directories on every run
function createRandom(seed: number) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

async function entryNamed(name: string, generation = 0): Promise<UnixFsDirectoryEntry> {
    const bytes = new TextEncoder().encode(`${name}#${generation}`);
    return { name, cid: CID.createV1(raw, await sha256.digest(bytes)), size: bytes.length };
}

async function postCidLikeName(index: number): Promise<string> {
    return CID.createV0(await sha256.digest(new TextEncoder().encode(`post ${index}`))).toString();
}

// The reference: the same directory built from scratch by ipfs-unixfs-importer, every entry a known link
async function buildWithImporter(entries: Iterable<UnixFsDirectoryEntry>, shardSplitThresholdBytes: number): Promise<CID> {
    const byPath = new Map<string, UnixFsDirectoryEntry>();
    for (const entry of entries) byPath.set(`directory/${entry.name}`, entry);
    let root: CID | undefined;
    for await (const imported of importer(
        [...byPath.keys()].map((path) => ({ path, content: new Uint8Array(0) })),
        { put: async (cid: CID) => cid },
        {
            profile: "unixfs-v0-2015",
            cidVersion: 0,
            rawLeaves: false,
            reduceSingleLeafToSelf: true,
            shardSplitThresholdBytes,
            wrapWithDirectory: false,
            fileBuilder: async (file) => {
                for await (const chunk of file.content) void chunk;
                const entry = byPath.get(file.path!)!;
                return { cid: entry.cid, size: BigInt(entry.size), path: file.path };
            }
        }
    ))
        if (imported.path === "directory") root = imported.cid;
    if (!root) throw Error("The importer built no directory");
    return root;
}

// A blockstore that counts what is read from it
function createBlockstore() {
    const blocks = new Map<string, Uint8Array>();
    const store = {
        reads: 0,
        getBlock: async (cid: CID): Promise<Uint8Array> => {
            store.reads++;
            const bytes = blocks.get(cid.toString());
            if (!bytes) throw Error(`Block ${cid.toString()} was never stored`);
            return bytes;
        },
        // Applies a patch and stores what it built, as the daemon would after the import
        patch: async (
            directoryCid: CID | undefined,
            changes: { put?: UnixFsDirectoryEntry[]; remove?: string[] },
            shardSplitThresholdBytes = MFS_SHARD_SPLIT_THRESHOLD_BYTES
        ) => {
            const result = await patchUnixFsDirectory({
                directoryCid,
                entriesToPut: changes.put ?? [],
                namesToRemove: changes.remove,
                getBlock: store.getBlock,
                shardSplitThresholdBytes
            });
            for (const block of result.newBlocks) blocks.set(block.cid.toString(), block.bytes);
            return result;
        }
    };
    return store;
}

describe("patchUnixFsDirectory against a directory built from scratch", () => {
    it("builds a basic directory, then overwrites, adds and removes entries in it", async () => {
        const store = createBlockstore();
        const model = new Map<string, UnixFsDirectoryEntry>();
        for (let i = 0; i < 40; i++) model.set(`entry-${i}`, await entryNamed(`entry-${i}`));
        let { cid } = await store.patch(undefined, { put: [...model.values()] });
        expect(cid.toString()).to.equal((await buildWithImporter(model.values(), MFS_SHARD_SPLIT_THRESHOLD_BYTES)).toString());

        model.set("entry-3", await entryNamed("entry-3", 1));
        model.set("entry-new", await entryNamed("entry-new"));
        model.delete("entry-7");
        ({ cid } = await store.patch(cid, { put: [model.get("entry-3")!, model.get("entry-new")!], remove: ["entry-7", "never-there"] }));
        expect(cid.toString()).to.equal((await buildWithImporter(model.values(), MFS_SHARD_SPLIT_THRESHOLD_BYTES)).toString());
    });

    it("an empty directory is the well-known empty UnixFS directory", async () => {
        const { cid } = await createBlockstore().patch(undefined, {});
        expect(cid.toString()).to.equal("QmUNLLsPACCz1vLxQVkXqqLX5R1X345qqfHbsf67hvA3Nn");
    });

    it("returns the same cid and builds nothing when every entry is already there", async () => {
        const store = createBlockstore();
        const entries = await Promise.all(Array.from({ length: 4000 }, async (_, i) => entryNamed(await postCidLikeName(i))));
        for (const threshold of [MFS_SHARD_SPLIT_THRESHOLD_BYTES * 100, MFS_SHARD_SPLIT_THRESHOLD_BYTES]) {
            const { cid } = await store.patch(undefined, { put: entries }, threshold);
            const again = await store.patch(cid, { put: entries.slice(100, 300), remove: ["never-there"] }, threshold);
            expect(again.cid.toString()).to.equal(cid.toString());
            expect(again.newBlocks).to.have.lengthOf(0);
        }
    });

    it("turns a basic directory into a HAMT when its links pass the threshold", async () => {
        const store = createBlockstore();
        // 46 + 36 bytes per link: 3,197 of them reach 256 KiB
        const entries = await Promise.all(Array.from({ length: 3400 }, async (_, i) => entryNamed(await postCidLikeName(i))));
        const basic = await store.patch(undefined, { put: entries.slice(0, 3000) });
        expect(basic.newBlocks, "3,000 post entries still fit a basic directory").to.have.lengthOf(1);
        expect(basic.cid.toString()).to.equal(
            (await buildWithImporter(entries.slice(0, 3000), MFS_SHARD_SPLIT_THRESHOLD_BYTES)).toString()
        );

        const sharded = await store.patch(basic.cid, { put: entries.slice(3000) });
        expect(sharded.newBlocks.length, "3,400 post entries are a HAMT of many shards").to.be.greaterThan(100);
        expect(sharded.cid.toString()).to.equal((await buildWithImporter(entries, MFS_SHARD_SPLIT_THRESHOLD_BYTES)).toString());
    });

    it("patches a HAMT through random rounds of adds, overwrites and removals", async () => {
        const random = createRandom(551);
        const store = createBlockstore();
        const model = new Map<string, UnixFsDirectoryEntry>();
        for (let i = 0; i < 6000; i++) {
            const name = await postCidLikeName(i);
            model.set(name, await entryNamed(name));
        }
        let { cid } = await store.patch(undefined, { put: [...model.values()] });
        expect(cid.toString()).to.equal((await buildWithImporter(model.values(), MFS_SHARD_SPLIT_THRESHOLD_BYTES)).toString());

        let nextNewPost = 6000;
        for (let round = 0; round < 12; round++) {
            const names = [...model.keys()];
            const put: UnixFsDirectoryEntry[] = [];
            const remove: string[] = [];
            const changes = round % 3 === 0 ? 1 : 1 + Math.floor(random() * 400);
            for (let i = 0; i < changes; i++) {
                const kind = random();
                if (kind < 0.5) {
                    const name = names[Math.floor(random() * names.length)];
                    if (remove.includes(name)) continue;
                    put.push(await entryNamed(name, round + 1));
                } else if (kind < 0.8) {
                    const name = await postCidLikeName(nextNewPost++);
                    put.push(await entryNamed(name));
                } else {
                    const name = names[Math.floor(random() * names.length)];
                    if (put.some((entry) => entry.name === name)) continue;
                    remove.push(name);
                }
            }
            for (const name of remove) model.delete(name);
            for (const entry of put) model.set(entry.name, entry);
            ({ cid } = await store.patch(cid, { put, remove }));
            expect(cid.toString(), `round ${round}: ${put.length} puts, ${remove.length} removals`).to.equal(
                (await buildWithImporter(model.values(), MFS_SHARD_SPLIT_THRESHOLD_BYTES)).toString()
            );
        }
    });

    it("handles names whose hashes collide for several levels, and hoists what a removal leaves alone in a shard", async () => {
        // Names sharing the first two bytes of their hash sit two sub-shards deep. A threshold of 0 makes
        // every directory a HAMT, so a handful of entries exercises the deep paths.
        const byPrefix = new Map<string, string[]>();
        let colliding: string[] | undefined;
        for (let i = 0; !colliding; i++) {
            const name = `name-${i}`;
            const hash = await murmur3128.encode(new TextEncoder().encode(name));
            const prefix = `${hash[0]}-${hash[1]}`;
            const names = byPrefix.get(prefix) ?? [];
            names.push(name);
            byPrefix.set(prefix, names);
            if (names.length === 3) colliding = names;
        }
        const others = ["a", "b", "c", "d", "e"];
        const store = createBlockstore();
        const model = new Map<string, UnixFsDirectoryEntry>();
        const check = async (cid: CID, step: string) =>
            expect(cid.toString(), step).to.equal((await buildWithImporter(model.values(), 0)).toString());

        for (const name of [...others, colliding[0]]) model.set(name, await entryNamed(name));
        let { cid } = await store.patch(undefined, { put: [...model.values()] }, 0);
        await check(cid, "one of the colliding names");

        for (const name of colliding.slice(1)) {
            model.set(name, await entryNamed(name));
            ({ cid } = await store.patch(cid, { put: [model.get(name)!] }, 0));
            await check(cid, `added ${name}, which collides for two levels`);
        }
        for (const name of colliding.slice(0, 2)) {
            model.delete(name);
            ({ cid } = await store.patch(cid, { remove: [name] }, 0));
            await check(cid, `removed ${name}: what is left moves back up`);
        }
        // Down to nothing but the root's own entries, one removal at a time
        for (const name of [colliding[2], ...others.slice(0, 4)]) {
            model.delete(name);
            ({ cid } = await store.patch(cid, { remove: [name] }, 0));
            await check(cid, `removed ${name}`);
        }
    });

    it("reads only the shards on a changed entry's path, however many entries the directory has", async () => {
        const store = createBlockstore();
        const entries = await Promise.all(Array.from({ length: 18_000 }, async (_, i) => entryNamed(await postCidLikeName(i))));
        const { cid, newBlocks } = await store.patch(undefined, { put: entries });
        expect(newBlocks.length, "18,000 posts are a root shard and its 256 sub-shards").to.be.greaterThan(250);

        store.reads = 0;
        const one = await store.patch(cid, { put: [await entryNamed(entries[1234].name, 1)] });
        // The root is read once to tell what kind of directory it is and once as a shard: the caller caches blocks
        expect(store.reads, "blocks read to change one post").to.be.at.most(4);
        expect(one.newBlocks.length, "nodes rebuilt to change one post").to.be.at.most(3);
        const expected = [...entries];
        expected[1234] = await entryNamed(entries[1234].name, 1);
        expect(one.cid.toString()).to.equal((await buildWithImporter(expected, MFS_SHARD_SPLIT_THRESHOLD_BYTES)).toString());
    });

    it("refuses a node that is not a directory", async () => {
        const { UnixFS } = await import("ipfs-unixfs");
        const dagPb = await import("@ipld/dag-pb");
        const fileBytes = dagPb.encode(dagPb.prepare({ Data: new UnixFS({ type: "file" }).marshal(), Links: [] }));
        const fileCid = CID.createV0(await sha256.digest(fileBytes));
        await expect(
            patchUnixFsDirectory({
                directoryCid: fileCid,
                entriesToPut: [],
                getBlock: async () => fileBytes,
                shardSplitThresholdBytes: MFS_SHARD_SPLIT_THRESHOLD_BYTES
            })
        ).rejects.toThrow("Expected a UnixFS directory");
    });
});

// Skipped under RPC: the test talks to the kubo daemon behind a local PKC's kubo client, and an RPC
// client has no kubo client of its own.
describeSkipIfRpc("patchUnixFsDirectory against a kubo daemon", () => {
    let pkc: PKC;
    const mfsDirectory = `/unixfs-directory-patch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const kubo = () => Object.values(pkc.clients.kuboRpcClients)[0]._client;
    const getBlock = async (cid: CID) => kubo().block.get(cid);

    // Everything this test stores is pinned until it ends: other suites' communities run a repo gc on the
    // shared daemon, and reading a directory whose blocks a gc took hangs on a network fetch (and holds
    // every other MFS user off meanwhile).
    const pinned: CID[] = [];

    // A real file per entry, so the daemon holds every block the directory links
    const addEntries = async (count: number, firstIndex: number, generation = 0): Promise<UnixFsDirectoryEntry[]> => {
        const entries: UnixFsDirectoryEntry[] = [];
        const names = await Promise.all(Array.from({ length: count }, (_, i) => postCidLikeName(firstIndex + i)));
        // Wrapped in one directory, so that one pin covers every file
        for await (const added of kubo().addAll(
            names.map((name) => ({ path: name, content: new TextEncoder().encode(`${name}#${generation}`) })),
            { pin: true, wrapWithDirectory: true, cidVersion: 0 }
        )) {
            if (added.path === "") pinned.push(added.cid);
            else entries.push({ name: added.path, cid: added.cid, size: Number(added.size) });
        }
        expect(entries).to.have.lengthOf(count);
        return entries;
    };
    // The root goes in pinned before the rest, the way writePostUpdatesToBucket stores a bucket
    const importIntoDaemon = async (root: CID, blocks: { cid: CID; bytes: Uint8Array }[]) => {
        const rootBlock = blocks.find((block) => block.cid.equals(root))!;
        const stored = await kubo().block.put(rootBlock.bytes, { pin: true, format: "v0", mhtype: "sha2-256" });
        expect(stored.toString()).to.equal(root.toString());
        pinned.push(root);
        for await (const result of kubo().dag.import([await encodeCarV1([root], blocks)], { pinRoots: false })) void result;
    };
    const readFile = async (path: string) => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of kubo().cat(path)) chunks.push(chunk);
        return Buffer.concat(chunks).toString();
    };

    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        await kubo()
            .files.rm(mfsDirectory, { recursive: true })
            .catch((): undefined => undefined);
        for (const cid of pinned)
            await kubo()
                .pin.rm(cid)
                .catch((): undefined => undefined);
        await pkc.destroy();
    });

    it("kubo lists, reads, and changes through MFS a HAMT that was patched, and its changes can be patched in turn", async () => {
        const entries = await addEntries(4000, 0);
        const built = await patchUnixFsDirectory({
            directoryCid: undefined,
            entriesToPut: entries,
            getBlock,
            shardSplitThresholdBytes: MFS_SHARD_SPLIT_THRESHOLD_BYTES
        });
        await importIntoDaemon(built.cid, built.newBlocks);
        expect((await kubo().files.stat(`/ipfs/${built.cid.toString()}`)).type).to.equal("directory");

        // Patched: 300 overwritten, 200 added, 100 removed
        const overwritten = await addEntries(300, 500, 1);
        const added = await addEntries(200, 4000);
        const removed = entries.slice(1000, 1100).map((entry) => entry.name);
        const patched = await patchUnixFsDirectory({
            directoryCid: built.cid,
            entriesToPut: [...overwritten, ...added],
            namesToRemove: removed,
            getBlock,
            shardSplitThresholdBytes: MFS_SHARD_SPLIT_THRESHOLD_BYTES
        });
        await importIntoDaemon(patched.cid, patched.newBlocks);

        const expected = new Map(entries.map((entry) => [entry.name, entry.cid.toString()]));
        for (const entry of [...overwritten, ...added]) expected.set(entry.name, entry.cid.toString());
        for (const name of removed) expected.delete(name);
        const listed = new Map<string, string>();
        for await (const entry of kubo().ls(patched.cid)) listed.set(entry.name, entry.cid.toString());
        expect(listed.size).to.equal(expected.size);
        expect([...listed].sort()).to.deep.equal([...expected].sort());
        expect(await readFile(`/ipfs/${patched.cid.toString()}/${overwritten[7].name}`)).to.equal(`${overwritten[7].name}#1`);

        // kubo's own HAMT code changes the directory: one entry removed, one added
        const bucketPath = `${mfsDirectory}/bucket`;
        await kubo().files.cp(`/ipfs/${patched.cid.toString()}`, bucketPath, { parents: true, flush: true });
        const [extra] = await addEntries(1, 9000);
        await kubo().files.rm(`${bucketPath}/${entries[0].name}`, { recursive: true });
        await kubo().files.cp(`/ipfs/${extra.cid.toString()}`, `${bucketPath}/${extra.name}`, { flush: true });
        const changedByKubo = (await kubo().files.stat(bucketPath)).cid;
        expected.delete(entries[0].name);
        expected.set(extra.name, extra.cid.toString());

        // and the directory kubo wrote is patched again
        const [another] = await addEntries(1, 9001);
        const repatched = await patchUnixFsDirectory({
            directoryCid: CID.parse(changedByKubo.toString()),
            entriesToPut: [another],
            namesToRemove: [entries[1].name],
            getBlock,
            shardSplitThresholdBytes: MFS_SHARD_SPLIT_THRESHOLD_BYTES
        });
        await importIntoDaemon(repatched.cid, repatched.newBlocks);
        expected.delete(entries[1].name);
        expected.set(another.name, another.cid.toString());
        const relisted = new Map<string, string>();
        for await (const entry of kubo().ls(repatched.cid)) relisted.set(entry.name, entry.cid.toString());
        expect([...relisted].sort()).to.deep.equal([...expected].sort());
    }, 300_000);
});

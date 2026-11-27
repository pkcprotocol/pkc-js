import { CID } from "multiformats/cid";
import { sha256 } from "multiformats/hashes/sha2";
import * as dagPb from "@ipld/dag-pb";
import { murmur3128 } from "@multiformats/murmur3";
import { UnixFS } from "ipfs-unixfs";
import pLimit from "p-limit";

// Changing some entries of a UnixFS directory without reading the rest of it.
//
// A directory is one dag-pb block until its links pass the shard threshold, and a HAMT after that: a
// tree of 256-wide shards in which an entry sits on the path its name's hash spells out, one byte per
// level. Putting or removing an entry therefore only touches the shards on that path, and every other
// shard is carried over by its cid without being fetched. On a bucket of 18,000 posts that is the root
// shard and one sub-shard per changed post, about 20 KB, instead of all 257 shards.
//
// The nodes are laid out exactly as ipfs-unixfs-importer lays them out (and as kubo's MFS reads them):
// murmur3-x64-128 of the name, its first 8 bytes consumed one per level, links named
// <2 hex digits of the slot><entry name> (a bare slot is a sub-shard), the occupied slots as a bitfield
// in the node's data, a sub-shard with a single entry left hoisted into its parent. A directory patched
// here has the same cid as one built from scratch from the same entries.

export type UnixFsDirectoryEntry = { name: string; cid: CID; size: number };
export type UnixFsBlock = { cid: CID; bytes: Uint8Array };

const HAMT_FANOUT = 256n;
const HAMT_HASH_TYPE_MURMUR3_X64_64 = 0x22n;
// One hash byte per level, and go's implementation only uses the first 8 bytes of the hash
const HAMT_MAX_DEPTH = 8;
const HAMT_SLOT_PREFIX_LENGTH = 2;
const SHARD_FETCH_CONCURRENCY = 32;

const textEncoder = new TextEncoder();

class HamtShard {
    slots = new Map<number, UnixFsDirectoryEntry | HamtShard>();
    // The block this shard is stored as. Unset once the shard differs from that block (or never had one).
    stored: { cid: CID; size: number } | undefined;
    // False for a shard known only by its link: its slots are read from its block the first time a path crosses it
    loaded: boolean;
    loading: Promise<void> | undefined;
    constructor(stored?: { cid: CID; size: number }) {
        this.stored = stored;
        this.loaded = stored === undefined;
    }
}

type DirectoryMetadata = { mode?: UnixFS["mode"]; mtime?: UnixFS["mtime"] };

export async function patchUnixFsDirectory({
    directoryCid,
    entriesToPut,
    namesToRemove = [],
    getBlock,
    shardSplitThresholdBytes
}: {
    // The directory to start from. Undefined starts from an empty one.
    directoryCid: CID | undefined;
    entriesToPut: UnixFsDirectoryEntry[];
    namesToRemove?: string[];
    getBlock: (cid: CID) => Promise<Uint8Array>;
    // A basic directory whose links (name + cid bytes) add up to more than this becomes a HAMT
    shardSplitThresholdBytes: number;
}): Promise<{ cid: CID; newBlocks: UnixFsBlock[] }> {
    const cidVersion = directoryCid?.version ?? 0;
    const newBlocks: UnixFsBlock[] = [];
    const storeNode = async (node: dagPb.PBNode): Promise<{ cid: CID; bytes: Uint8Array }> => {
        const bytes = dagPb.encode(dagPb.prepare(node));
        const cid = CID.create(cidVersion, dagPb.code, await sha256.digest(bytes));
        newBlocks.push({ cid, bytes });
        return { cid, bytes };
    };

    const slotsByName = new Map<string, Uint8Array>();
    const slotsOf = async (name: string): Promise<Uint8Array> => {
        let slots = slotsByName.get(name);
        if (!slots) {
            slots = (await murmur3128.encode(textEncoder.encode(name))).subarray(0, HAMT_MAX_DEPTH);
            slotsByName.set(name, slots);
        }
        return slots;
    };
    const slotAt = async (name: string, depth: number): Promise<number> => {
        if (depth >= HAMT_MAX_DEPTH) throw Error(`The HAMT is deeper than ${HAMT_MAX_DEPTH} levels at entry ${name}`);
        return (await slotsOf(name))[depth];
    };

    const loadShard = async (shard: HamtShard): Promise<void> => {
        if (shard.loaded) return;
        shard.loading ??= (async () => {
            const stored = shard.stored!;
            const node = dagPb.decode(await getBlock(stored.cid));
            readHamtShardMetadata(node, stored.cid);
            for (const link of node.Links) {
                const linkName = link.Name ?? "";
                const slot = parseInt(linkName.slice(0, HAMT_SLOT_PREFIX_LENGTH), 16);
                if (linkName.length < HAMT_SLOT_PREFIX_LENGTH || !Number.isInteger(slot))
                    throw Error(`HAMT shard ${stored.cid.toString()} has a link without a slot prefix: "${linkName}"`);
                const child = { cid: CID.decode(link.Hash.bytes), size: link.Tsize ?? 0 };
                shard.slots.set(
                    slot,
                    linkName.length === HAMT_SLOT_PREFIX_LENGTH
                        ? new HamtShard(child)
                        : { name: linkName.slice(HAMT_SLOT_PREFIX_LENGTH), ...child }
                );
            }
            shard.loaded = true;
        })();
        await shard.loading;
    };

    const putEntry = async (shard: HamtShard, depth: number, entry: UnixFsDirectoryEntry): Promise<boolean> => {
        await loadShard(shard);
        const slot = await slotAt(entry.name, depth);
        const occupant = shard.slots.get(slot);
        if (occupant instanceof HamtShard) {
            if (!(await putEntry(occupant, depth + 1, entry))) return false;
        } else if (!occupant || occupant.name === entry.name) {
            if (occupant && occupant.cid.equals(entry.cid) && occupant.size === entry.size) return false;
            shard.slots.set(slot, entry);
        } else {
            // Two names on one slot: both move a level down, as deep as their hashes keep agreeing
            const subShard = new HamtShard();
            await putEntry(subShard, depth + 1, occupant);
            await putEntry(subShard, depth + 1, entry);
            shard.slots.set(slot, subShard);
        }
        shard.stored = undefined;
        return true;
    };

    const removeEntry = async (shard: HamtShard, depth: number, name: string): Promise<boolean> => {
        await loadShard(shard);
        const slot = await slotAt(name, depth);
        const occupant = shard.slots.get(slot);
        if (!occupant) return false;
        if (occupant instanceof HamtShard) {
            if (!(await removeEntry(occupant, depth + 1, name))) return false;
            // A sub-shard left with one entry gives it back to its parent. As the recursion unwinds this
            // repeats at every level, so the entry ends up where a directory built without the removed
            // name would have it.
            if (occupant.slots.size === 0) shard.slots.delete(slot);
            else if (occupant.slots.size === 1) {
                const [onlyOccupant] = occupant.slots.values();
                if (!(onlyOccupant instanceof HamtShard)) shard.slots.set(slot, onlyOccupant);
            }
        } else {
            if (occupant.name !== name) return false;
            shard.slots.delete(slot);
        }
        shard.stored = undefined;
        return true;
    };

    const storeShard = async (shard: HamtShard, metadata?: DirectoryMetadata): Promise<{ cid: CID; size: number }> => {
        if (shard.stored) return shard.stored;
        const links: dagPb.PBLink[] = [];
        let highestSlot = -1;
        for (const slot of shard.slots.keys()) if (slot > highestSlot) highestSlot = slot;
        // The occupied slots, one bit each, as a big-endian number without leading zero bytes
        const bitfield = new Uint8Array(highestSlot < 0 ? 0 : (highestSlot >> 3) + 1);
        let linkedSize = 0;
        for (const [slot, occupant] of shard.slots) {
            bitfield[bitfield.length - 1 - (slot >> 3)] |= 1 << (slot & 7);
            const prefix = slot.toString(16).toUpperCase().padStart(HAMT_SLOT_PREFIX_LENGTH, "0");
            const link =
                occupant instanceof HamtShard
                    ? { Name: prefix, ...(await storeShard(occupant)) }
                    : { Name: prefix + occupant.name, cid: occupant.cid, size: occupant.size };
            links.push({ Name: link.Name, Hash: link.cid, Tsize: link.size });
            linkedSize += link.size;
        }
        const data = new UnixFS({
            type: "hamt-sharded-directory",
            data: bitfield,
            fanout: HAMT_FANOUT,
            hashType: HAMT_HASH_TYPE_MURMUR3_X64_64,
            mode: metadata?.mode,
            mtime: metadata?.mtime
        }).marshal();
        const { cid, bytes } = await storeNode({ Data: data, Links: links });
        shard.stored = { cid, size: bytes.length + linkedSize };
        return shard.stored;
    };

    // Reads the shards on the changed names' paths concurrently, so that the changes, which have to be
    // applied one after the other, find them loaded
    const loadShardsOnPathsOf = async (root: HamtShard, names: string[]) => {
        const limit = pLimit(SHARD_FETCH_CONCURRENCY);
        await Promise.all(
            names.map((name) =>
                limit(async () => {
                    let shard = root;
                    for (let depth = 0; depth < HAMT_MAX_DEPTH; depth++) {
                        await loadShard(shard);
                        const occupant = shard.slots.get(await slotAt(name, depth));
                        if (!(occupant instanceof HamtShard)) return;
                        shard = occupant;
                    }
                })
            )
        );
    };

    const patchHamt = async (root: HamtShard, metadata: DirectoryMetadata) => {
        await loadShardsOnPathsOf(root, [...namesToRemove, ...entriesToPut.map((entry) => entry.name)]);
        for (const name of namesToRemove) await removeEntry(root, 0, name);
        for (const entry of entriesToPut) await putEntry(root, 0, entry);
        return (await storeShard(root, metadata)).cid;
    };

    const entries = new Map<string, UnixFsDirectoryEntry>();
    let metadata: DirectoryMetadata = {};
    if (directoryCid) {
        const node = dagPb.decode(await getBlock(directoryCid));
        if (!node.Data) throw Error(`Expected a UnixFS directory at ${directoryCid.toString()}, got a node without data`);
        const unixfs = UnixFS.unmarshal(node.Data);
        metadata = { mode: unixfs.mode, mtime: unixfs.mtime };
        if (unixfs.type === "hamt-sharded-directory") {
            const cid = await patchHamt(new HamtShard({ cid: directoryCid, size: 0 }), metadata);
            return { cid, newBlocks };
        }
        if (unixfs.type !== "directory") throw Error(`Expected a UnixFS directory at ${directoryCid.toString()}, got ${unixfs.type}`);
        for (const link of node.Links) {
            const name = link.Name ?? "";
            entries.set(name, { name, cid: CID.decode(link.Hash.bytes), size: link.Tsize ?? 0 });
        }
    }

    // A basic directory: one block holding every link
    let changed = directoryCid === undefined;
    for (const name of namesToRemove) if (entries.delete(name)) changed = true;
    for (const entry of entriesToPut) {
        const existing = entries.get(entry.name);
        if (existing && existing.cid.equals(entry.cid) && existing.size === entry.size) continue;
        entries.set(entry.name, entry);
        changed = true;
    }
    if (!changed) return { cid: directoryCid!, newBlocks };

    let linksBytes = 0;
    for (const entry of entries.values()) linksBytes += textEncoder.encode(entry.name).length + entry.cid.bytes.length;
    if (linksBytes > shardSplitThresholdBytes) {
        const root = new HamtShard();
        for (const entry of entries.values()) await putEntry(root, 0, entry);
        return { cid: (await storeShard(root, metadata)).cid, newBlocks };
    }
    const { cid } = await storeNode({
        Data: new UnixFS({ type: "directory", mode: metadata.mode, mtime: metadata.mtime }).marshal(),
        Links: [...entries.values()].map((entry) => ({ Name: entry.name, Hash: entry.cid, Tsize: entry.size }))
    });
    return { cid, newBlocks };
}

function readHamtShardMetadata(node: dagPb.PBNode, cid: CID): UnixFS {
    if (!node.Data) throw Error(`Expected a HAMT shard at ${cid.toString()}, got a node without data`);
    const unixfs = UnixFS.unmarshal(node.Data);
    if (unixfs.type !== "hamt-sharded-directory") throw Error(`Expected a HAMT shard at ${cid.toString()}, got ${unixfs.type}`);
    // The hash type is not checked: ipfs-unixfs does not hand it back when it reads a node, and murmur3-x64-64
    // is the only one any implementation writes
    if (unixfs.fanout !== HAMT_FANOUT)
        throw Error(`HAMT shard ${cid.toString()} has fanout ${unixfs.fanout}, only ${HAMT_FANOUT} is supported`);
    return unixfs;
}

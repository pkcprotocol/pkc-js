import { base32 } from "multiformats/bases/base32";
import { CID } from "multiformats/cid";
import * as Digest from "multiformats/hashes/digest";
import * as raw from "multiformats/codecs/raw";
import type { AbortOptions, AwaitIterable } from "interface-store";
import Logger from "../logger.js";

const log = Logger("pkc-js:libp2p-js:blockstore");

/**
 * The dependency tree contains more than one copy of multiformats (helia 6's internals are still on
 * 13 while our tree is on 14), and blockstore-core ships its own nested interface-blockstore. A CID
 * handed to us by helia is therefore not the same class as a CID we construct, and the packages'
 * `Blockstore`/`Pair` types are not mutually assignable.
 *
 * This wrapper sidesteps all of it by typing structurally: the only thing it ever needs from a CID
 * is the multihash bytes, and every backend we use (blockstore-core, blockstore-fs, blockstore-idb)
 * addresses blocks by exactly those bytes and ignores the codec.
 */
export interface BlockstoreCid {
    multihash: { bytes: Uint8Array };
}

export interface BlockstorePair {
    cid: BlockstoreCid;
    bytes: AwaitIterable<Uint8Array>;
}

export interface ChildBlockstore {
    has(cid: BlockstoreCid, options?: AbortOptions): boolean | Promise<boolean>;
    put(cid: BlockstoreCid, val: Uint8Array | AwaitIterable<Uint8Array>, options?: AbortOptions): unknown;
    get(cid: BlockstoreCid, options?: AbortOptions): AwaitIterable<Uint8Array>;
    delete(cid: BlockstoreCid, options?: AbortOptions): void | Promise<void>;
    getAll(options?: AbortOptions): AwaitIterable<BlockstorePair>;
}

export interface LruBlockstoreOptions {
    // hard ceiling on the total size of stored blocks
    maxBytes: number;
    // when maxBytes is reached, evict down to this fraction of it, so we do not run an eviction on
    // every subsequent put at the boundary
    lowWaterRatio?: number;
}

// Sum an incoming block value, which the streaming blockstore API allows to be either a single
// Uint8Array or an (async) iterable of chunks. We have to materialize it either way: the value is
// consumed once, so measuring it and then handing the original iterable to the child would give
// the child an already-drained iterator.
async function materialize(val: Uint8Array | AwaitIterable<Uint8Array>): Promise<{ chunks: Uint8Array[]; size: number }> {
    if (val instanceof Uint8Array) return { chunks: [val], size: val.byteLength };
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of val) {
        chunks.push(chunk);
        size += chunk.byteLength;
    }
    return { chunks, size };
}

// blockstore-core keys on `base32(cid.multihash.bytes)`, blockstore-idb on the base32upper of the
// same bytes, and blockstore-fs shards on them too, so a CID rebuilt with the raw codec addresses
// the same block that was originally put under dag-pb or any other codec.
function cidFromIndexKey(key: string): CID {
    return CID.createV1(raw.code, Digest.decode(base32.decode(key)));
}

/**
 * A size-capped LRU cache in front of any blockstore.
 *
 * pkc-js pins nothing: every block we hold is refetchable from the network and we are not a
 * provider of record for any of it. So the eviction policy here is a plain cache policy rather
 * than helia's pin-based `gc()`, which with zero pins would simply delete everything.
 *
 * Recency is tracked by `_sizes` insertion order (a Map iterates in insertion order, so the front
 * is the least recently used). Reads and writes move a key to the back; `getAll` deliberately does
 * NOT, since a full scan would otherwise flatten the LRU ordering into scan order.
 *
 * Nothing protects a block that an in-flight DAG walk is midway through reading. Worst case an
 * eviction lands between two blocks of an active load and that load re-fetches the block, which is
 * latency rather than corruption. Do not "fix" this with pins.
 */
export class LruBlockstore {
    private readonly _child: ChildBlockstore;
    private readonly _maxBytes: number;
    private readonly _lowWaterBytes: number;
    // base32(multihash) => block size in bytes. Insertion order is the LRU order.
    private readonly _sizes = new Map<string, number>();
    private _totalBytes = 0;
    // serializes eviction runs so two concurrent puts cannot both evict down to the low water mark
    private _evicting?: Promise<void>;

    constructor(child: ChildBlockstore, options: LruBlockstoreOptions) {
        if (!(options.maxBytes > 0)) throw Error("LruBlockstore requires a positive maxBytes");
        const lowWaterRatio = options.lowWaterRatio ?? 0.75;
        if (!(lowWaterRatio > 0 && lowWaterRatio <= 1)) throw Error("LruBlockstore requires lowWaterRatio in (0, 1]");
        this._child = child;
        this._maxBytes = options.maxBytes;
        this._lowWaterBytes = Math.floor(options.maxBytes * lowWaterRatio);
    }

    get totalBytes() {
        return this._totalBytes;
    }

    get blockCount() {
        return this._sizes.size;
    }

    private _keyOf(cid: BlockstoreCid) {
        return base32.encode(cid.multihash.bytes);
    }

    // move an already-known key to the back of the LRU order
    private _touch(key: string) {
        const size = this._sizes.get(key);
        if (size === undefined) return;
        this._sizes.delete(key);
        this._sizes.set(key, size);
    }

    private _register(key: string, size: number) {
        const previous = this._sizes.get(key);
        if (previous !== undefined) {
            this._totalBytes -= previous;
            this._sizes.delete(key);
        }
        this._sizes.set(key, size);
        this._totalBytes += size;
    }

    private _unregister(key: string) {
        const size = this._sizes.get(key);
        if (size === undefined) return;
        this._sizes.delete(key);
        this._totalBytes -= size;
    }

    async has(cid: BlockstoreCid, options?: AbortOptions) {
        return this._child.has(cid, options);
    }

    async put(cid: BlockstoreCid, val: Uint8Array | AwaitIterable<Uint8Array>, options?: AbortOptions) {
        const { chunks, size } = await materialize(val);
        await this._child.put(cid, chunks, options);
        this._register(this._keyOf(cid), size);
        await this._evictIfNeeded();
        return cid;
    }

    async *get(cid: BlockstoreCid, options?: AbortOptions) {
        const key = this._keyOf(cid);
        const known = this._sizes.has(key);
        if (known) this._touch(key);
        let size = 0;
        try {
            for await (const chunk of this._child.get(cid, options)) {
                size += chunk.byteLength;
                yield chunk;
            }
        } catch (e) {
            // The block is gone from the child but still in our index, so the index is now lying
            // about both the block count and the byte total. Happens when a second process sharing
            // the same directory evicted it, or when something outside pkc-js cleaned the store.
            // Drop it so the accounting stays honest and the cap keeps meaning what it says.
            this._unregister(key);
            throw e;
        }
        // A block already in a persistent child from a previous session is absent from the index
        // until something reads it (or the rebuild scan reaches it), so register it now that its
        // size is known. Only on full consumption: a caller that abandons the iterator mid-block
        // would otherwise register a short size and drift the byte total downward.
        if (!known) {
            this._register(key, size);
            await this._evictIfNeeded();
        }
    }

    async delete(cid: BlockstoreCid, options?: AbortOptions) {
        await this._child.delete(cid, options);
        this._unregister(this._keyOf(cid));
    }

    // blockstore-core's BaseBlockstore would supply these in terms of put/get/delete, but extending
    // it would pull in its nested interface-blockstore copy and that copy's incompatible Pair type.
    async *putMany(source: AwaitIterable<{ cid: BlockstoreCid; bytes: Uint8Array | AwaitIterable<Uint8Array> }>, options?: AbortOptions) {
        for await (const { cid, bytes } of source) {
            await this.put(cid, bytes, options);
            yield cid;
        }
    }

    async *getMany(source: AwaitIterable<BlockstoreCid>, options?: AbortOptions) {
        for await (const cid of source) yield { cid, bytes: this.get(cid, options) };
    }

    async *deleteMany(source: AwaitIterable<BlockstoreCid>, options?: AbortOptions) {
        for await (const cid of source) {
            await this.delete(cid, options);
            yield cid;
        }
    }

    async *getAll(options?: AbortOptions) {
        // deliberately does not touch: see class docstring
        yield* this._child.getAll(options);
    }

    private async _evictIfNeeded() {
        if (this._totalBytes <= this._maxBytes) return;
        // fold into an in-flight run rather than starting a second one
        if (this._evicting) return this._evicting;
        this._evicting = this._evict().finally(() => {
            this._evicting = undefined;
        });
        return this._evicting;
    }

    private async _evict() {
        const startBytes = this._totalBytes;
        let evicted = 0;
        while (this._totalBytes > this._lowWaterBytes) {
            // Map iteration order is insertion order, so the first entry is the least recently used
            const oldest = this._sizes.keys().next();
            if (oldest.done === true) break;
            const key = oldest.value;
            const size = this._sizes.get(key) ?? 0;
            // Drop from the index first: if the child delete fails we must not keep counting bytes
            // for a block we have given up on, or the total drifts upward forever and every
            // subsequent put triggers a futile eviction pass.
            this._sizes.delete(key);
            this._totalBytes -= size;
            evicted++;
            try {
                await this._child.delete(cidFromIndexKey(key));
            } catch (e) {
                log.error("Failed to evict block from blockstore", key, e);
            }
        }
        log(
            `Evicted ${evicted} blocks from blockstore, ${startBytes} bytes => ${this._totalBytes} bytes (max ${this._maxBytes}, low water ${this._lowWaterBytes})`
        );
    }

    /**
     * Populate the index from a child that already holds blocks (a persistent backend on a second
     * run). Sizes are only knowable by reading every block back, so this is O(store) in IO and is
     * meant to be kicked off in the background rather than awaited before the first load. Until it
     * finishes the store can sit over its cap, since we cannot evict what we have not counted.
     *
     * Resilient by design: blockstore-fs reconstructs a CID in `getAll` by decoding raw multihash
     * bytes, which throws for any hash that is not a valid CIDv0 (i.e. anything but sha2-256).
     * A store holding such a block would otherwise abort the whole scan, so a failure here leaves
     * a partial index rather than propagating.
     */
    async rebuildIndex(options?: AbortOptions) {
        let scanned = 0;
        try {
            for await (const { cid, bytes } of this._child.getAll(options)) {
                const key = this._keyOf(cid);
                if (this._sizes.has(key)) continue; // written during the scan; already counted
                let size = 0;
                for await (const chunk of bytes) size += chunk.byteLength;
                this._register(key, size);
                scanned++;
            }
        } catch (e) {
            log.error("Failed to fully rebuild blockstore index, continuing with a partial index", e);
        }
        log(`Rebuilt blockstore index from ${scanned} existing blocks, ${this._totalBytes} bytes`);
        await this._evictIfNeeded();
        return { blocks: scanned, bytes: this._totalBytes };
    }
}

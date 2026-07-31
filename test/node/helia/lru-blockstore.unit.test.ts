// Unit tests for the size-capped LRU blockstore added for
// https://github.com/pkcprotocol/pkc-js/issues/240
//
// Helia never evicts blocks on its own: every fetched block is written to the blockstore, and only
// `helia.gc()` (pin-based, and pkc-js pins nothing) or dropping the whole instance removes one. A
// long-lived client therefore grew without bound. These cover the eviction policy itself plus the
// two behaviours that are easy to get subtly wrong: recency tracking, and rebuilding the byte index
// from a persistent backend that already holds blocks.

import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MemoryBlockstore } from "blockstore-core";
import { FsBlockstore } from "blockstore-fs";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { LruBlockstore, type ChildBlockstore } from "../../../dist/node/helia/lru-blockstore.js";

async function blockOf(content: string, sizeBytes?: number) {
    const base = new TextEncoder().encode(content);
    const bytes = sizeBytes === undefined ? base : new Uint8Array(sizeBytes).fill(base[0] ?? 1);
    // keep the content distinct so distinct labels hash to distinct CIDs even when padded
    if (sizeBytes !== undefined) bytes.set(base.subarray(0, Math.min(base.length, bytes.length)));
    const cid = CID.createV1(raw.code, await sha256.digest(bytes));
    return { cid, bytes };
}

// MemoryBlockstore.get is a sync generator while the fs/idb backends are async ones, so accept both
async function collect(iterable: AsyncIterable<Uint8Array> | Iterable<Uint8Array>) {
    const chunks: Uint8Array[] = [];
    for await (const chunk of iterable) chunks.push(chunk);
    return chunks;
}

async function sizeOfGet(store: LruBlockstore, cid: CID) {
    let size = 0;
    for await (const chunk of store.get(cid)) size += chunk.byteLength;
    return size;
}

const tmpDirs: string[] = [];
afterEach(async () => {
    while (tmpDirs.length) {
        const dir = tmpDirs.pop()!;
        await fs.promises.rm(dir, { recursive: true, force: true });
    }
});

describe("LruBlockstore accounting", () => {
    it("tracks total bytes and block count across put and delete", async () => {
        const store = new LruBlockstore(new MemoryBlockstore(), { maxBytes: 10_000 });
        const a = await blockOf("a", 100);
        const b = await blockOf("b", 250);

        await store.put(a.cid, a.bytes);
        await store.put(b.cid, b.bytes);
        expect(store.totalBytes).to.equal(350);
        expect(store.blockCount).to.equal(2);

        await store.delete(a.cid);
        expect(store.totalBytes).to.equal(250);
        expect(store.blockCount).to.equal(1);
    });

    it("does not double count a block that is put twice", async () => {
        const store = new LruBlockstore(new MemoryBlockstore(), { maxBytes: 10_000 });
        const a = await blockOf("a", 100);
        await store.put(a.cid, a.bytes);
        await store.put(a.cid, a.bytes);
        expect(store.totalBytes).to.equal(100);
        expect(store.blockCount).to.equal(1);
    });

    it("sums a block supplied as an async iterable of chunks without draining it before the child", async () => {
        // The streaming blockstore API allows put() to be handed an iterable rather than a single
        // Uint8Array. Measuring it consumes it, so the wrapper has to materialize and forward the
        // materialized chunks - if it forwarded the original iterator the child would store nothing.
        const child = new MemoryBlockstore();
        const store = new LruBlockstore(child, { maxBytes: 10_000 });
        const a = await blockOf("a", 300);
        async function* chunks() {
            yield a.bytes.subarray(0, 100);
            yield a.bytes.subarray(100);
        }
        await store.put(a.cid, chunks());

        expect(store.totalBytes).to.equal(300);
        const readBack = await collect(child.get(a.cid));
        expect(readBack.reduce((acc, c) => acc + c.byteLength, 0)).to.equal(300);
    });
});

describe("LruBlockstore eviction", () => {
    it("evicts down to the low water mark once maxBytes is exceeded", async () => {
        const child = new MemoryBlockstore();
        // 1000 byte cap, evict down to 500
        const store = new LruBlockstore(child, { maxBytes: 1000, lowWaterRatio: 0.5 });
        const blocks = await Promise.all([1, 2, 3, 4, 5].map((n) => blockOf(String(n), 300)));

        // 3 x 300 = 900 is under the cap, so nothing has been evicted yet
        for (const block of blocks.slice(0, 3)) await store.put(block.cid, block.bytes);
        expect(store.totalBytes).to.equal(900);

        // the 4th put crosses 1000 and must evict down to the low water mark, not merely to the cap
        await store.put(blocks[3].cid, blocks[3].bytes);
        expect(store.totalBytes).to.be.at.most(500);
        expect(store.totalBytes).to.be.greaterThan(0);
        // the eviction must have actually removed blocks from the child, not just from the index
        expect(await child.has(blocks[0].cid)).to.be.false;

        // headroom below the low water mark is then reusable: a further put stays under the cap
        // without triggering another eviction
        await store.put(blocks[4].cid, blocks[4].bytes);
        expect(store.totalBytes).to.be.at.most(1000);
        expect(await child.has(blocks[4].cid), "the most recent put always survives").to.be.true;
    });

    it("evicts the least recently used block, not the oldest written one", async () => {
        const child = new MemoryBlockstore();
        // low water of 630 leaves room for two of these three 300 byte blocks, so exactly one
        // eviction happens and the test isolates *which* block that is
        const store = new LruBlockstore(child, { maxBytes: 700, lowWaterRatio: 0.9 });
        const first = await blockOf("first", 300);
        const second = await blockOf("second", 300);

        await store.put(first.cid, first.bytes);
        await store.put(second.cid, second.bytes);
        // read the OLDER block, making the newer one least-recently-used
        await sizeOfGet(store, first.cid);

        const third = await blockOf("third", 300);
        await store.put(third.cid, third.bytes);

        expect(await child.has(first.cid), "re-read block should have survived").to.be.true;
        expect(await child.has(second.cid), "least recently used block should have been evicted").to.be.false;
    });

    it("does not let getAll reorder recency", async () => {
        // A full scan touching every key would flatten LRU order into scan order, so the next
        // eviction would drop whatever the scan happened to visit first rather than the coldest block.
        const child = new MemoryBlockstore();
        const store = new LruBlockstore(child, { maxBytes: 700, lowWaterRatio: 0.9 });
        const cold = await blockOf("cold", 300);
        const hot = await blockOf("hot", 300);
        await store.put(cold.cid, cold.bytes);
        await store.put(hot.cid, hot.bytes);
        await sizeOfGet(store, cold.cid); // cold is now the most recently used

        for await (const _pair of store.getAll()) {
            // drain
        }

        const third = await blockOf("third", 300);
        await store.put(third.cid, third.bytes);
        expect(await child.has(cold.cid), "getAll must not have reset recency").to.be.true;
        expect(await child.has(hot.cid)).to.be.false;
    });

    it("keeps the byte total correct when the child fails to delete during eviction", async () => {
        // If a failed delete left the block counted, the total would drift upward forever and every
        // later put would trigger another futile eviction pass.
        const memory = new MemoryBlockstore();
        const child: ChildBlockstore = {
            has: (cid, options) => memory.has(cid as CID, options),
            put: (cid, val, options) => memory.put(cid as CID, val, options),
            get: (cid, options) => memory.get(cid as CID, options),
            delete: async () => {
                throw Error("child delete is broken");
            },
            getAll: (options) => memory.getAll(options)
        };
        const store = new LruBlockstore(child, { maxBytes: 500, lowWaterRatio: 0.5 });
        const blocks = await Promise.all([1, 2, 3].map((n) => blockOf(String(n), 300)));
        for (const block of blocks) await store.put(block.cid, block.bytes);

        expect(store.totalBytes).to.be.at.most(500);
        expect(store.blockCount).to.be.at.most(1);
    });

    it("serializes concurrent evictions instead of each draining to the low water mark", async () => {
        const child = new MemoryBlockstore();
        const store = new LruBlockstore(child, { maxBytes: 1000, lowWaterRatio: 0.5 });
        const blocks = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => blockOf(String(n), 300)));

        await Promise.all(blocks.map((block) => store.put(block.cid, block.bytes)));

        // Whatever the interleaving, the store must end up under the cap and must not have emptied
        // itself: two overlapping eviction runs each draining to the low water mark would.
        expect(store.totalBytes).to.be.at.most(1000);
        expect(store.blockCount).to.be.greaterThan(0);
        // the index and the child must agree
        let childCount = 0;
        for await (const _pair of child.getAll()) childCount++;
        expect(childCount).to.equal(store.blockCount);
    });
});

describe("LruBlockstore index rebuild against a persistent backend", () => {
    async function tmpFsBlockstore() {
        const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pkc-lru-blockstore-"));
        tmpDirs.push(dir);
        const store = new FsBlockstore(dir);
        await store.open();
        return { dir, store };
    }

    it("counts blocks written by a previous session", async () => {
        const { dir, store: firstRun } = await tmpFsBlockstore();
        const blocks = await Promise.all([1, 2, 3].map((n) => blockOf(String(n), 200)));
        const firstLru = new LruBlockstore(firstRun, { maxBytes: 10_000 });
        for (const block of blocks) await firstLru.put(block.cid, block.bytes);
        expect(firstLru.totalBytes).to.equal(600);
        await firstRun.close();

        // second "process": a fresh wrapper over the same directory starts with an empty index
        const secondRun = new FsBlockstore(dir);
        await secondRun.open();
        const secondLru = new LruBlockstore(secondRun, { maxBytes: 10_000 });
        expect(secondLru.totalBytes).to.equal(0);

        const result = await secondLru.rebuildIndex();
        expect(result.blocks).to.equal(3);
        expect(secondLru.totalBytes).to.equal(600);
        await secondRun.close();
    });

    it("evicts down to the cap when the existing store is already over it", async () => {
        const { dir, store: firstRun } = await tmpFsBlockstore();
        const blocks = await Promise.all([1, 2, 3, 4].map((n) => blockOf(String(n), 300)));
        const firstLru = new LruBlockstore(firstRun, { maxBytes: 10_000 });
        for (const block of blocks) await firstLru.put(block.cid, block.bytes);
        await firstRun.close();

        const secondRun = new FsBlockstore(dir);
        await secondRun.open();
        // 1200 bytes on disk, cap of 800
        const secondLru = new LruBlockstore(secondRun, { maxBytes: 800, lowWaterRatio: 0.5 });
        await secondLru.rebuildIndex();
        expect(secondLru.totalBytes).to.be.at.most(400);
        await secondRun.close();
    });

    it("registers a block's size on first read when it predates the index", async () => {
        // The rebuild runs in the background, so reads can land before it reaches a given block.
        // Those reads must still account for what they touched, or the cap under-counts.
        const { dir, store: firstRun } = await tmpFsBlockstore();
        const block = await blockOf("persisted", 400);
        await firstRun.put(block.cid, block.bytes);
        await firstRun.close();

        const secondRun = new FsBlockstore(dir);
        await secondRun.open();
        const lru = new LruBlockstore(secondRun, { maxBytes: 10_000 });
        expect(lru.totalBytes).to.equal(0);

        const readSize = await sizeOfGet(lru, block.cid);
        expect(readSize).to.equal(400);
        expect(lru.totalBytes).to.equal(400);
        expect(lru.blockCount).to.equal(1);
        await secondRun.close();
    });

    it("does not register a partial size when a read is abandoned midway", async () => {
        const { dir, store: firstRun } = await tmpFsBlockstore();
        // large enough that the fs read stream yields more than one chunk
        const block = await blockOf("big", 200_000);
        await firstRun.put(block.cid, block.bytes);
        await firstRun.close();

        const secondRun = new FsBlockstore(dir);
        await secondRun.open();
        const lru = new LruBlockstore(secondRun, { maxBytes: 10_000_000 });

        for await (const _chunk of lru.get(block.cid)) break; // abandon after the first chunk

        // a partial size must not be recorded; a later full read records the real one
        expect(lru.totalBytes, "abandoned read must not register a short size").to.equal(0);
        const full = await sizeOfGet(lru, block.cid);
        expect(full).to.equal(200_000);
        expect(lru.totalBytes).to.equal(200_000);
        await secondRun.close();
    });
});

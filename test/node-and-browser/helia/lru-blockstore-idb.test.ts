// Browser-side coverage for the size-capped LRU blockstore (https://github.com/pkcprotocol/pkc-js/issues/240).
//
// The unit tests under test/node cover the LRU over blockstore-core and blockstore-fs. This file
// covers the backend the browser actually uses, blockstore-idb, because IndexedDB differs from both
// in the ways most likely to break the wrapper: values come back as a single chunk rather than a
// stream, and the store survives being closed and reopened, which is the whole point of persisting.
//
// Skipped outside a browser: blockstore-idb needs a real IndexedDB, and node has none.

import { describe, it, expect, afterEach } from "vitest";
import { IDBBlockstore } from "blockstore-idb";
import { CID } from "multiformats/cid";
import * as raw from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { LruBlockstore } from "../../../dist/node/helia/lru-blockstore.js";
import { isRunningInBrowser } from "../../../dist/node/test/test-util.js";

const describeSkipIfNotBrowser = isRunningInBrowser() ? describe : describe.skip;

async function blockOf(label: string, size: number) {
    const bytes = new Uint8Array(size).fill(label.charCodeAt(0));
    bytes.set(new TextEncoder().encode(label).subarray(0, Math.min(label.length, size)));
    const cid = CID.createV1(raw.code, await sha256.digest(bytes));
    return { cid, bytes };
}

async function readSize(store: LruBlockstore, cid: CID) {
    let size = 0;
    for await (const chunk of store.get(cid)) size += chunk.byteLength;
    return size;
}

describeSkipIfNotBrowser("LruBlockstore over blockstore-idb", () => {
    const opened: IDBBlockstore[] = [];
    let dbCounter = 0;

    async function openIdb(name: string) {
        const store = new IDBBlockstore(name);
        await store.open();
        opened.push(store);
        return store;
    }

    afterEach(async () => {
        while (opened.length) {
            const store = opened.pop()!;
            // close BEFORE destroy: destroy() is deleteDB(), and IndexedDB blocks a delete until
            // every open connection to the database is closed, so destroying first deadlocks.
            await store.close();
            try {
                await store.destroy();
            } catch {
                // best effort; the per-test database name keeps runs isolated regardless
            }
        }
    });

    it("accounts bytes for blocks IndexedDB returns as a single chunk", async () => {
        const child = await openIdb(`pkc-lru-idb-accounting-${dbCounter++}`);
        const store = new LruBlockstore(child, { maxBytes: 10_000 });
        const a = await blockOf("a", 400);
        const b = await blockOf("b", 600);

        await store.put(a.cid, a.bytes);
        await store.put(b.cid, b.bytes);

        expect(store.totalBytes).to.equal(1000);
        expect(store.blockCount).to.equal(2);
        expect(await readSize(store, a.cid)).to.equal(400);
    });

    it("evicts the least recently used block and removes it from IndexedDB", async () => {
        const child = await openIdb(`pkc-lru-idb-evict-${dbCounter++}`);
        // low water of 630 leaves room for two of these 300 byte blocks, so exactly one eviction runs
        const store = new LruBlockstore(child, { maxBytes: 700, lowWaterRatio: 0.9 });
        const first = await blockOf("first", 300);
        const second = await blockOf("second", 300);
        await store.put(first.cid, first.bytes);
        await store.put(second.cid, second.bytes);
        await readSize(store, first.cid); // first becomes most recently used

        const third = await blockOf("third", 300);
        await store.put(third.cid, third.bytes);

        expect(await child.has(first.cid), "re-read block should have survived").to.be.true;
        expect(await child.has(second.cid), "least recently used block should have been evicted").to.be.false;
        expect(await child.has(third.cid)).to.be.true;
        expect(store.totalBytes).to.be.at.most(700);
    });

    it("keeps blocks across a close and reopen, and rebuilds the index from them", async () => {
        // This is the behaviour that makes persistence worth having: a refresh must not re-fetch
        // what was already verified. A fresh wrapper starts with an empty index, so the rebuild has
        // to recover the byte total from the database itself.
        const dbName = `pkc-lru-idb-persist-${dbCounter++}`;
        const firstSession = await openIdb(dbName);
        const blocks = await Promise.all([1, 2, 3].map((n) => blockOf(`block-${n}`, 200)));
        const firstLru = new LruBlockstore(firstSession, { maxBytes: 10_000 });
        for (const block of blocks) await firstLru.put(block.cid, block.bytes);
        expect(firstLru.totalBytes).to.equal(600);
        await firstSession.close();
        opened.pop(); // reopened below; the afterEach cleanup uses the second handle

        const secondSession = await openIdb(dbName);
        const secondLru = new LruBlockstore(secondSession, { maxBytes: 10_000 });
        expect(secondLru.totalBytes, "a fresh wrapper starts with no index").to.equal(0);

        const rebuilt = await secondLru.rebuildIndex();
        expect(rebuilt.blocks).to.equal(3);
        expect(secondLru.totalBytes).to.equal(600);
        for (const block of blocks) expect(await secondSession.has(block.cid)).to.be.true;
    });

    it("registers a block's size on first read when the rebuild has not reached it yet", async () => {
        const dbName = `pkc-lru-idb-lazy-${dbCounter++}`;
        const firstSession = await openIdb(dbName);
        const block = await blockOf("persisted", 500);
        await firstSession.put(block.cid, block.bytes);
        await firstSession.close();
        opened.pop();

        const secondSession = await openIdb(dbName);
        const lru = new LruBlockstore(secondSession, { maxBytes: 10_000 });
        expect(lru.totalBytes).to.equal(0);

        expect(await readSize(lru, block.cid)).to.equal(500);
        expect(lru.totalBytes, "a read must account for what it touched").to.equal(500);
        expect(lru.blockCount).to.equal(1);
    });

    it("drops a block from the index when IndexedDB no longer has it", async () => {
        // Another tab sharing the origin can evict a block this instance still believes it holds.
        // The read fails, and the index must stop counting the block rather than inflate the total.
        const child = await openIdb(`pkc-lru-idb-missing-${dbCounter++}`);
        const store = new LruBlockstore(child, { maxBytes: 10_000 });
        const block = await blockOf("vanishing", 300);
        await store.put(block.cid, block.bytes);
        expect(store.totalBytes).to.equal(300);

        await child.delete(block.cid); // behind the wrapper's back, as another tab would

        let threw = false;
        try {
            await readSize(store, block.cid);
        } catch {
            threw = true;
        }
        expect(threw, "reading a block IndexedDB no longer has must fail").to.be.true;
        expect(store.totalBytes, "index must not keep counting a block that is gone").to.equal(0);
        expect(store.blockCount).to.equal(0);
    });
});

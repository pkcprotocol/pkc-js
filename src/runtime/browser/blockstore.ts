import { IDBBlockstore } from "blockstore-idb";
import { MemoryBlockstore } from "blockstore-core";
import type { Blockstore } from "interface-blockstore";

export interface PkcBlockstore {
    blockstore: Blockstore;
    // true when blocks outlive the page, which is what makes the index rebuild worth running
    persistent: boolean;
    // cap to use when the caller did not set one; depends on whether we landed in IndexedDB or in memory
    defaultMaxBytes: number;
    close: () => Promise<void>;
}

// Measured growth is ~20MB/hour with 65 communities subscribed and updating (see pkc-js#240), so
// 250MB is ~12h of continuous use before the first eviction: a normal tab session never evicts and
// only a marathon or pinned tab does. It also stays well inside Chrome's per-origin quota and
// Firefox's group limit, so we are never the reason the browser evicts the whole origin.
export const DEFAULT_BLOCKSTORE_MAX_BYTES = 250 * 1024 * 1024;

// The IndexedDB cap would be a poor memory cap: on the fallback path the blocks sit in the heap of
// a tab that also has to render an app, so keep it well clear of a tab crash.
export const DEFAULT_IN_MEMORY_BLOCKSTORE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Browser block storage for the libp2p-js client: blocks in IndexedDB so a refresh does not
 * re-fetch everything from the network.
 *
 * The browser may evict the whole origin under storage pressure, so the store is treated as a
 * cache that can vanish between sessions rather than as durable state. Nothing we keep here is
 * unrecoverable: every block is refetchable from the network.
 *
 * If IndexedDB is unavailable (private-mode restrictions, a disabled origin, a non-DOM worker
 * without it) we fall back to memory rather than failing PKC construction: a slower client beats
 * no client.
 */
export async function createBlockstoreForLibp2pJsClient({ dataPath, key }: { dataPath?: string; key: string }): Promise<PkcBlockstore> {
    // dataPath is a node concept, accepted here only to keep one signature across runtimes
    void dataPath;
    try {
        const store = new IDBBlockstore(`pkc-js-blockstore-${key}`);
        await store.open();
        return { blockstore: store, persistent: true, defaultMaxBytes: DEFAULT_BLOCKSTORE_MAX_BYTES, close: () => store.close() };
    } catch {
        return {
            blockstore: new MemoryBlockstore(),
            persistent: false,
            defaultMaxBytes: DEFAULT_IN_MEMORY_BLOCKSTORE_MAX_BYTES,
            close: async () => {}
        };
    }
}

import { FsBlockstore } from "blockstore-fs";
import { MemoryBlockstore } from "blockstore-core";
import path from "path";
import type { Blockstore } from "interface-blockstore";

export interface PkcBlockstore {
    blockstore: Blockstore;
    // true when blocks outlive the process, which is what makes the index rebuild worth running
    persistent: boolean;
    // cap to use when the caller did not set one; depends on whether we landed on disk or in memory
    defaultMaxBytes: number;
    close: () => Promise<void>;
}

// Measured growth is ~20MB/hour with 65 communities subscribed and updating (see pkc-js#240), so
// 1GB is a bit over two days of continuous use before the first eviction. Desktop/CLI disk is
// cheap and node consumers often run the kubo path anyway, so this is deliberately generous.
export const DEFAULT_BLOCKSTORE_MAX_BYTES = 1024 * 1024 * 1024;

// The disk cap would be a terrible memory cap: without a dataPath the blocks are held in the heap,
// where a gigabyte is an out-of-memory crash rather than a cache.
export const DEFAULT_IN_MEMORY_BLOCKSTORE_MAX_BYTES = 100 * 1024 * 1024;

/**
 * Node block storage for the libp2p-js client: blocks on disk under the pkc data directory so a
 * restart does not re-fetch everything from the network.
 *
 * Falls back to memory when there is no dataPath (`noData`, or a browser-shaped consumer running
 * under node), since there is nowhere to put a directory.
 *
 * Each libp2p-js client key gets its own directory. Two processes pointed at the same dataPath and
 * the same key share one directory. Unlike the community databases (which take a proper-lock-file
 * lock, see db-handler.ts) this is deliberately NOT locked: a lock would stop the second process
 * from running at all, which is the wrong trade for a cache that both can safely use. Measured
 * behaviour when shared:
 *   - concurrent writes of the same block are safe; blockstore-fs writes via steno (temp file plus
 *     atomic rename) and explicitly tolerates another context having created the file,
 *   - a block one process evicts while another is reading it surfaces as a NotFoundError, which
 *     fails that one load and self-heals on retry (the next `has` misses and refetches),
 *   - the size cap is per process, so N processes sharing a directory can leave up to N times
 *     maxBytes on disk.
 */
export async function createBlockstoreForLibp2pJsClient({ dataPath, key }: { dataPath?: string; key: string }): Promise<PkcBlockstore> {
    if (!dataPath)
        return {
            blockstore: new MemoryBlockstore(),
            persistent: false,
            defaultMaxBytes: DEFAULT_IN_MEMORY_BLOCKSTORE_MAX_BYTES,
            close: async () => {}
        };

    const store = new FsBlockstore(path.join(dataPath, "blockstore", key));
    await store.open();
    return { blockstore: store, persistent: true, defaultMaxBytes: DEFAULT_BLOCKSTORE_MAX_BYTES, close: () => store.close() };
}

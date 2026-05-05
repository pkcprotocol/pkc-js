import { sha256 } from "js-sha256";
import type { PKC } from "../pkc/pkc.js";
import type { NameResolveCacheOptions } from "../schema.js";

const CACHE_NAME = "pkcjs_lrustorage_nameResolutions" as const;
const CACHE_MAX_ITEMS = 5000;

export type NameResolutionCacheEntry = {
    publicKey: string;
    resolverKey: string;
    provider: string;
    resolvedAtMs: number;
};

type NameResolutionCacheLookupArgs = {
    name: string;
    resolverKey: string;
    provider: string;
    cache?: NameResolveCacheOptions;
};

// Wraps the existing LRUStorageInterface (Node SQLite + browser localforage + in-memory under noData)
// to provide typed name-resolution caching with HTTP-style max-age freshness control.
export class NameResolutionCache {
    private _pkc: PKC;

    constructor(pkc: PKC) {
        this._pkc = pkc;
    }

    private async _store() {
        return this._pkc._createStorageLRU({ cacheName: CACHE_NAME, maxItems: CACHE_MAX_ITEMS });
    }

    private static _key({ name, resolverKey, provider }: { name: string; resolverKey: string; provider: string }): string {
        return `${name}::${resolverKey}::${sha256(provider)}`;
    }

    // Returns the cached entry only if it satisfies cache.maxAge (seconds).
    //   cache.maxAge === 0     → always returns undefined (bypass)
    //   cache.maxAge === N     → returns entry if Date.now() - resolvedAtMs <= N * 1000
    //   cache.maxAge undefined → no freshness threshold, returns whatever is cached
    async get(args: NameResolutionCacheLookupArgs): Promise<NameResolutionCacheEntry | undefined> {
        if (args.cache?.maxAge === 0) return undefined;
        const store = await this._store();
        const entry = (await store.getItem(NameResolutionCache._key(args))) as NameResolutionCacheEntry | undefined;
        if (!entry || typeof entry !== "object" || typeof entry.publicKey !== "string") return undefined;
        if (typeof args.cache?.maxAge === "number") {
            const ageMs = Date.now() - entry.resolvedAtMs;
            if (ageMs > args.cache.maxAge * 1000) return undefined;
        }
        return entry;
    }

    async set(args: { name: string; entry: NameResolutionCacheEntry }): Promise<void> {
        const store = await this._store();
        await store.setItem(
            NameResolutionCache._key({
                name: args.name,
                resolverKey: args.entry.resolverKey,
                provider: args.entry.provider
            }),
            args.entry
        );
    }
}

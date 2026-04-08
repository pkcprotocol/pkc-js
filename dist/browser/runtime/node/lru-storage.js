import path from "path";
import SqliteCache from "./sqlite-lru-cache.js";
// This code is highly inspired by https://github.com/jkelin/cache-sqlite-lru-ttl
// Storing items that will be evicted based on LRU
export default class LRUStorage {
    constructor(opts) {
        this._opts = opts;
    }
    toJSON() {
        return undefined;
    }
    async init() {
        const dbPath = this._opts.pkc.noData || !this._opts.pkc.dataPath ? `:memory:` : path.join(this._opts.pkc.dataPath, "lru-storage");
        this._cache = new SqliteCache({
            database: dbPath,
            cacheTableName: this._opts.cacheName,
            maxItems: this._opts.maxItems
        });
    }
    async getItem(key) {
        return this._cache.get(key);
    }
    async setItem(key, value) {
        return this._cache.set(key, value);
    }
    async removeItem(key) {
        await this._cache.delete(key);
        return true;
    }
    async clear() {
        return this._cache.clear();
    }
    async keys() {
        throw Error("LruStorage.keys() is Not implemented");
    }
    async destroy() {
        await this._cache.close();
    }
}
//# sourceMappingURL=lru-storage.js.map
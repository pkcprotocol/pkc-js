import localForage from "localforage";
import { v4 as uuidV4 } from "uuid";
import { hideClassPrivateProps } from "../../util.js";
// Storage is for long term items, no eviction based on ttl or anything like that
export default class Storage {
    constructor(pkc) {
        this._pkc = pkc;
        hideClassPrivateProps(this);
    }
    toJSON() {
        return undefined;
    }
    async init() {
        const storageName = this._pkc.noData ? `Browser-storage-no-data-${uuidV4()}` : "pkcjs_storage";
        this._store = localForage.createInstance({
            name: storageName
        });
    }
    async getItem(key) {
        return this._store.getItem(key);
    }
    async setItem(key, value) {
        await this._store.setItem(key, value);
    }
    async removeItem(key) {
        if (Array.isArray(key))
            await Promise.all(key.map((k) => this._store.removeItem(k)));
        else
            await this._store.removeItem(key);
        return true;
    }
    async clear() {
        await this._store.clear();
    }
    async destroy() { }
}
//# sourceMappingURL=storage.js.map
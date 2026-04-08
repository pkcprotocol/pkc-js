import path from "path";
import fs from "fs";
import { hideClassPrivateProps } from "../../util.js";
import { KeyvBetterSqlite3 } from "./community/keyv-better-sqlite3.js";
import Database from "better-sqlite3";
// Storage is for long term items, no eviction based on ttl or anything like that
export default class Storage {
    constructor(pkc) {
        this._pkc = pkc;
        let dbFilePath;
        if (this._pkc.noData || !this._pkc.dataPath) {
            dbFilePath = ":memory:";
        }
        else {
            fs.mkdirSync(this._pkc.dataPath, { recursive: true });
            dbFilePath = path.join(this._pkc.dataPath, "storage.db");
        }
        this._db = new Database(dbFilePath);
        this._keyv = new KeyvBetterSqlite3(this._db);
        this._keyv.on("error", (err) => {
            err.details = { ...err.details, dbFilePath, keyv: this._keyv, db: this._db };
            console.error("Error in Keyv", err);
            this._pkc.emit("error", err);
        });
        hideClassPrivateProps(this);
    }
    toJSON() {
        return undefined;
    }
    async init() { }
    async getItem(key) {
        return this._keyv.get(key);
    }
    async setItem(key, value) {
        this._keyv.set(key, value);
    }
    async removeItem(key) {
        if (Array.isArray(key))
            return this._keyv.deleteMany(key);
        else
            return this._keyv.delete(key);
    }
    async clear() {
        this._keyv.clear();
    }
    async destroy() {
        // Disconnect the underlying store adapter
        await this._keyv.disconnect();
        this._db.close();
    }
}
//# sourceMappingURL=storage.js.map
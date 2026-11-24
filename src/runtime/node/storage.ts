import { PKC } from "../../pkc/pkc.js";
import type { StorageInterface } from "../../types.js";
import path from "path";
import fs from "fs";
import { hideClassPrivateProps } from "../../util.js";
import { KeyvBetterSqlite3 } from "./community/keyv-better-sqlite3.js";
import Database from "better-sqlite3";

// Storage is for long term items, no eviction based on ttl or anything like that
export default class Storage implements StorageInterface {
    private _pkc: PKC;
    private _keyv: KeyvBetterSqlite3;
    private _db: Database.Database;

    constructor(pkc: Storage["_pkc"]) {
        this._pkc = pkc;

        let dbFilePath: string;
        if (this._pkc.noData || !this._pkc.dataPath) {
            dbFilePath = ":memory:";
        } else {
            fs.mkdirSync(this._pkc.dataPath, { recursive: true });
            dbFilePath = path.join(this._pkc.dataPath, "storage.db");
        }
        this._db = new Database(dbFilePath);
        // Every PKC instance on a dataPath has this file open, and so does its communities registry, which several
        // instances write to (see communities-registry.ts, issue #585). In WAL mode readers and the one writer do not
        // block each other. An in-memory database has no journal to choose
        if (dbFilePath !== ":memory:") this._db.pragma("journal_mode = WAL");
        this._keyv = new KeyvBetterSqlite3(this._db);

        this._keyv.on("error", (err: any) => {
            err.details = { ...err.details, dbFilePath, keyv: this._keyv, db: this._db };
            console.error("Error in Keyv", err);
            this._pkc.emit("error", err);
        });

        hideClassPrivateProps(this);
    }

    toJSON() {
        return undefined;
    }

    async init() {}
    async getItem(key: string) {
        return this._keyv.get(key);
    }

    async setItem(key: string, value: any) {
        this._keyv.set(key, value);
    }

    async removeItem(key: string | string[]) {
        if (Array.isArray(key)) return this._keyv.deleteMany(key);
        else return this._keyv.delete(key);
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

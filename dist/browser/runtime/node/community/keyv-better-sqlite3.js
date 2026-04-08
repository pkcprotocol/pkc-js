import { EventEmitter } from "events";
/**
 * A KeyvStoreAdapter implementation using better-sqlite3 directly
 */
export class KeyvBetterSqlite3 extends EventEmitter {
    constructor(db, options = {}) {
        super();
        this.ttlSupport = true;
        this.db = db;
        this.opts = {
            table: "keyv",
            keySize: 255,
            createTable: true,
            // These properties are needed by Keyv internals
            dialect: "sqlite",
            // Use a default URL since we don't know how to safely access the filename
            url: `sqlite://${db.name}`,
            ...options
        };
        if (this.opts.createTable) {
            try {
                // Create table with value as JSON (including ttl)
                this.db.exec(`
          CREATE TABLE IF NOT EXISTS ${this.opts.table} (
            key TEXT PRIMARY KEY,
            value TEXT
          )
        `);
            }
            catch (error) {
                throw error;
            }
        }
    }
    /**
     * Get a value from the store
     */
    get(key) {
        try {
            const stmt = this.db.prepare(`SELECT * FROM ${this.opts.table} WHERE key = ?`);
            const row = stmt.get("keyv:" + key);
            if (!row) {
                return undefined;
            }
            const parsed = JSON.parse(row.value);
            // Check if the value has expired
            if (parsed.expires && parsed.expires <= Date.now()) {
                // Value has expired, remove it from the store
                try {
                    this.delete(key);
                }
                catch (e) {
                    e.details = { ...e.details, row, parsed, key };
                    this.emit("error", e);
                }
                return undefined;
            }
            return parsed.value;
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Get multiple values from the store
     */
    getMany(keys) {
        try {
            const placeholders = keys.map(() => "?").join(",");
            const stmt = this.db.prepare(`
        SELECT * FROM ${this.opts.table} 
        WHERE key IN (${placeholders})
      `);
            const rows = stmt.all(...keys.map((key) => "keyv:" + key));
            const now = Date.now();
            const results = keys.map((key) => {
                const row = rows.find((r) => r.key === "keyv:" + key);
                if (!row)
                    return undefined;
                try {
                    const parsed = JSON.parse(row.value);
                    // Check if the value has expired
                    if (parsed.expires && parsed.expires <= now) {
                        // Value has expired, remove it from the store
                        try {
                            this.delete(key);
                        }
                        catch (err) {
                            this.emit("error", err);
                        }
                        return undefined;
                    }
                    return parsed.value;
                }
                catch (e) {
                    return undefined;
                }
            });
            return results;
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Set a value in the store
     */
    set(key, value, ttl) {
        try {
            const expires = typeof ttl === "number" ? Date.now() + ttl : null;
            const valueWithExpires = {
                value,
                ...(expires && { expires })
            };
            const stmt = this.db.prepare(`
        INSERT INTO ${this.opts.table} (key, value)
        VALUES (?, ?)
        ON CONFLICT(key) 
        DO UPDATE SET value = excluded.value
      `);
            const result = stmt.run("keyv:" + key, JSON.stringify(valueWithExpires));
            return result;
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Delete a value from the store
     */
    delete(key) {
        try {
            const stmt = this.db.prepare(`DELETE FROM ${this.opts.table} WHERE key = ?`);
            const result = stmt.run("keyv:" + key);
            return result.changes > 0;
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Delete multiple values from the store
     */
    deleteMany(keys) {
        try {
            const placeholders = keys.map(() => "?").join(",");
            const stmt = this.db.prepare(`DELETE FROM ${this.opts.table} WHERE key IN (${placeholders})`);
            const result = stmt.run(...keys.map((key) => "keyv:" + key));
            return result.changes > 0;
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Clear all values from the store
     */
    clear() {
        try {
            const stmt = this.db.prepare(this.namespace ? `DELETE FROM ${this.opts.table} WHERE key LIKE ?` : `DELETE FROM ${this.opts.table}`);
            if (this.namespace) {
                stmt.run(`${this.namespace}:%`);
            }
            else {
                stmt.run();
            }
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Check if a key exists in the store
     */
    has(key) {
        try {
            const stmt = this.db.prepare(`SELECT value FROM ${this.opts.table} WHERE key = ?`);
            const row = stmt.get("keyv:" + key);
            if (!row) {
                return false;
            }
            try {
                const parsed = JSON.parse(row.value);
                // Check if the value has expired
                if (parsed.expires && parsed.expires <= Date.now()) {
                    // Value has expired, remove it from the store
                    try {
                        this.delete(key);
                    }
                    catch (err) {
                        this.emit("error", err);
                    }
                    return false;
                }
                return true;
            }
            catch (e) {
                return false;
            }
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Iterate over all values in the store
     * Note: Even though better-sqlite3 is synchronous, we need to keep this
     * as an async generator to comply with the KeyvStoreAdapter interface
     */
    async *iterator(namespace) {
        const ns = namespace || this.namespace;
        const pattern = ns ? `${ns}:%` : "%";
        const now = Date.now();
        try {
            const stmt = this.db.prepare(`SELECT key, value FROM ${this.opts.table} WHERE key LIKE ?`);
            const rows = stmt.all(pattern);
            for (const row of rows) {
                try {
                    const parsed = JSON.parse(row.value);
                    // Skip expired values
                    if (parsed.expires && parsed.expires <= now) {
                        // Value has expired, remove it from the store
                        try {
                            this.delete(row.key);
                        }
                        catch (err) {
                            this.emit("error", err);
                        }
                        continue;
                    }
                    yield [row.key, parsed.value];
                }
                catch (e) {
                    // Skip invalid JSON
                    continue;
                }
            }
        }
        catch (error) {
            throw error;
        }
    }
    /**
     * Disconnect from the store
     */
    disconnect() {
        // The database is managed externally, so we don't close it here
    }
}
export default KeyvBetterSqlite3;
//# sourceMappingURL=keyv-better-sqlite3.js.map
import { EventEmitter } from "events";
import { Database as BetterSqlite3Database } from "better-sqlite3";
import { PKCError } from "../../../pkc-error.js";

export interface KeyvBetterSqlite3Options {
    /**
     * Table name for storage (defaults to 'keyv')
     */
    table?: string;
    /**
     * Size limit for keys (defaults to 255)
     */
    keySize?: number;
    /**
     * Whether to create the table if it doesn't exist (defaults to true)
     */
    createTable?: boolean;
}

interface KeyvRow {
    key: string;
    value: string;
}

interface KeyvValue {
    value: any;
    expires?: number | null;
}

/**
 * A KeyvStoreAdapter implementation using better-sqlite3 directly
 */
export class KeyvBetterSqlite3 extends EventEmitter {
    ttlSupport: boolean;
    opts: KeyvBetterSqlite3Options & {
        dialect: string;
        url: string;
    };
    namespace?: string;
    db: BetterSqlite3Database;

    constructor(db: BetterSqlite3Database, options: KeyvBetterSqlite3Options = {}) {
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
            } catch (error) {
                throw error;
            }
        }
    }

    /**
     * Get a value from the store
     */
    get<Value>(key: string): Value | undefined {
        try {
            const stmt = this.db.prepare(`SELECT * FROM ${this.opts.table} WHERE key = ?`);
            const row = stmt.get("keyv:" + key) as KeyvRow | undefined;

            if (!row) {
                return undefined;
            }

            const parsed = JSON.parse(row.value) as KeyvValue;
            // Check if the value has expired
            if (parsed.expires && parsed.expires <= Date.now()) {
                // Value has expired, remove it from the store
                try {
                    this.delete(key);
                } catch (e) {
                    (e as PKCError).details = { ...(e as PKCError).details, row, parsed, key };
                    this.emit("error", e);
                }

                return undefined;
            }

            return parsed.value;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Get multiple values from the store
     */
    getMany<Value>(keys: string[]): Array<Value | undefined> {
        try {
            const placeholders = keys.map(() => "?").join(",");
            const stmt = this.db.prepare(`
        SELECT * FROM ${this.opts.table} 
        WHERE key IN (${placeholders})
      `);

            const rows = stmt.all(...keys.map((key) => "keyv:" + key)) as KeyvRow[];
            const now = Date.now();

            const results = keys.map((key) => {
                const row = rows.find((r) => r.key === "keyv:" + key);
                if (!row) return undefined;

                try {
                    const parsed = JSON.parse(row.value) as KeyvValue;
                    // Check if the value has expired
                    if (parsed.expires && parsed.expires <= now) {
                        // Value has expired, remove it from the store
                        try {
                            this.delete(key);
                        } catch (err) {
                            this.emit("error", err);
                        }
                        return undefined;
                    }
                    return parsed.value;
                } catch (e) {
                    return undefined;
                }
            });

            return results;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Set a value in the store
     */
    set(key: string, value: any, ttl?: number): any {
        try {
            const expires = typeof ttl === "number" ? Date.now() + ttl : null;
            const valueWithExpires: KeyvValue = {
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
        } catch (error) {
            throw error;
        }
    }

    /**
     * Delete a value from the store
     */
    delete(key: string): boolean {
        try {
            const stmt = this.db.prepare(`DELETE FROM ${this.opts.table} WHERE key = ?`);
            const result = stmt.run("keyv:" + key);
            return result.changes > 0;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Delete multiple values from the store
     */
    deleteMany(keys: string[]): boolean {
        try {
            const placeholders = keys.map(() => "?").join(",");
            const stmt = this.db.prepare(`DELETE FROM ${this.opts.table} WHERE key IN (${placeholders})`);
            const result = stmt.run(...keys.map((key) => "keyv:" + key));
            return result.changes > 0;
        } catch (error) {
            throw error;
        }
    }

    /**
     * Clear all values from the store
     */
    clear(): void {
        try {
            const stmt = this.db.prepare(
                this.namespace ? `DELETE FROM ${this.opts.table} WHERE key LIKE ?` : `DELETE FROM ${this.opts.table}`
            );

            if (this.namespace) {
                stmt.run(`${this.namespace}:%`);
            } else {
                stmt.run();
            }
        } catch (error) {
            throw error;
        }
    }

    /**
     * Check if a key exists in the store
     */
    has(key: string): boolean {
        try {
            const stmt = this.db.prepare(`SELECT value FROM ${this.opts.table} WHERE key = ?`);
            const row = stmt.get("keyv:" + key) as KeyvRow | undefined;

            if (!row) {
                return false;
            }

            try {
                const parsed = JSON.parse(row.value) as KeyvValue;
                // Check if the value has expired
                if (parsed.expires && parsed.expires <= Date.now()) {
                    // Value has expired, remove it from the store
                    try {
                        this.delete(key);
                    } catch (err) {
                        this.emit("error", err);
                    }
                    return false;
                }
                return true;
            } catch (e) {
                return false;
            }
        } catch (error) {
            throw error;
        }
    }

    /**
     * Iterate over all values in the store
     * Note: Even though better-sqlite3 is synchronous, we need to keep this
     * as an async generator to comply with the KeyvStoreAdapter interface
     */
    async *iterator<Value>(namespace?: string): AsyncGenerator<[string, Value], void, unknown> {
        const ns = namespace || this.namespace;
        const pattern = ns ? `${ns}:%` : "%";
        const now = Date.now();

        try {
            const stmt = this.db.prepare(`SELECT key, value FROM ${this.opts.table} WHERE key LIKE ?`);
            const rows = stmt.all(pattern) as KeyvRow[];

            for (const row of rows) {
                try {
                    const parsed = JSON.parse(row.value) as KeyvValue;

                    // Skip expired values
                    if (parsed.expires && parsed.expires <= now) {
                        // Value has expired, remove it from the store
                        try {
                            this.delete(row.key as unknown as string);
                        } catch (err) {
                            this.emit("error", err);
                        }
                        continue;
                    }

                    yield [row.key, parsed.value];
                } catch (e) {
                    // Skip invalid JSON
                    continue;
                }
            }
        } catch (error) {
            throw error;
        }
    }

    /**
     * Disconnect from the store
     */
    disconnect(): void {
        // The database is managed externally, so we don't close it here
    }
}

export default KeyvBetterSqlite3;

import path from "node:path";
import fs from "node:fs/promises";
import Database from "better-sqlite3";
import Logger from "../../logger.js";

const debug = Logger("pkc-js:address-rewriter-db");

export type RequestLogEntry = {
    keys: string[];
    receivedAt: number;
    transmittedAt?: number;
    success: boolean;
    statusCode?: number;
    method: string;
    url: string;
    error?: string;
    retryCount?: number;
    bodyPreview?: string;
};

export type ReprovideLogEntry = {
    key: string;
    timestamp: number;
    success: boolean;
    error?: string;
    blockNotLocal?: boolean;
};

export class AddressRewriterDatabase {
    private _db: Database.Database | null = null;
    private _dbPath: string;

    constructor(dataPath: string, kuboConfig: any, proxyTarget: URL) {
        this._dbPath = this._initializeDbPath(dataPath, kuboConfig, proxyTarget);
    }

    private _initializeDbPath(dataPath: string, kuboConfig: any, proxyTarget: URL): string {
        if (!dataPath) {
            throw new Error("dataPath must be defined for request logging");
        }

        // Get kubo client hostname:port
        let kuboIdentifier = "unknown";
        if (kuboConfig && typeof kuboConfig === "object" && "host" in kuboConfig && "port" in kuboConfig) {
            kuboIdentifier = `${kuboConfig.host}_${kuboConfig.port}`;
        }

        // Get proxy target hostname:port
        const proxyIdentifier = `${proxyTarget.hostname}_${proxyTarget.port || (proxyTarget.protocol === "https:" ? "443" : "80")}`;

        const fileName = `address_rewriter_${kuboIdentifier}_${proxyIdentifier}.db`;
        return path.join(dataPath, ".address-rewriter", fileName);
    }

    async initialize(): Promise<void> {
        try {
            // Ensure directory exists
            const dbDir = path.dirname(this._dbPath);
            await fs.mkdir(dbDir, { recursive: true });

            // Initialize SQLite database
            this._db = new Database(this._dbPath);

            // Create request logs table - logs HTTP requests through the proxy
            this._db.exec(`
                CREATE TABLE IF NOT EXISTS request_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    keys TEXT NOT NULL,
                    received_at INTEGER NOT NULL,
                    transmitted_at INTEGER,
                    success INTEGER NOT NULL,
                    status_code INTEGER,
                    method TEXT NOT NULL,
                    url TEXT NOT NULL,
                    error TEXT,
                    retry_count INTEGER DEFAULT 0,
                    body_preview TEXT,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Create reprovide logs table - logs kubo routing.provide() attempts
            this._db.exec(`
                CREATE TABLE IF NOT EXISTS reprovide_logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    key TEXT NOT NULL,
                    timestamp INTEGER NOT NULL,
                    success INTEGER NOT NULL,
                    error TEXT,
                    block_not_local INTEGER DEFAULT 0,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Create failed keys table
            this._db.exec(`
                CREATE TABLE IF NOT EXISTS failed_keys (
                    key TEXT PRIMARY KEY,
                    added_at INTEGER NOT NULL,
                    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
                )
            `);

            // Create indexes
            this._db.exec(`
                CREATE INDEX IF NOT EXISTS idx_request_logs_received_at ON request_logs(received_at);
                CREATE INDEX IF NOT EXISTS idx_reprovide_logs_timestamp ON reprovide_logs(timestamp);
                CREATE INDEX IF NOT EXISTS idx_reprovide_logs_key ON reprovide_logs(key);
            `);

            try {
                this._db.exec("ALTER TABLE request_logs ADD COLUMN body_preview TEXT");
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                if (!message.toLowerCase().includes("duplicate column name")) {
                    throw error;
                }
            }

            debug(`Initialized SQLite database at ${this._dbPath}`);
        } catch (error) {
            debug.error(`Failed to initialize database at ${this._dbPath}:`, error);
            throw error;
        }
    }

    close(): void {
        if (this._db) {
            this._db.close();
            this._db = null;
        }
    }

    insertRequestLogs(logs: RequestLogEntry[]): void {
        if (!this._db) {
            throw new Error("Database not initialized");
        }

        const insertStmt = this._db.prepare(`
            INSERT INTO request_logs (
                keys, received_at, transmitted_at, success, status_code, 
                method, url, error, retry_count, body_preview
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const transaction = this._db.transaction(() => {
            for (const log of logs) {
                insertStmt.run(
                    JSON.stringify(log.keys),
                    log.receivedAt,
                    log.transmittedAt || null,
                    log.success ? 1 : 0,
                    log.statusCode || null,
                    log.method,
                    log.url,
                    log.error || null,
                    log.retryCount || 0,
                    log.bodyPreview || null
                );
            }
        });

        transaction();
    }

    insertReprovideLog(key: string, success: boolean, error?: string, blockNotLocal?: boolean): void {
        if (!this._db) {
            throw new Error("Database not initialized");
        }

        const insertStmt = this._db.prepare(`
            INSERT INTO reprovide_logs (key, timestamp, success, error, block_not_local)
            VALUES (?, ?, ?, ?, ?)
        `);

        insertStmt.run(key, Date.now(), success ? 1 : 0, error || null, blockNotLocal ? 1 : 0);
    }

    loadFailedKeys(): string[] {
        if (!this._db) {
            return [];
        }

        try {
            const stmt = this._db.prepare("SELECT key FROM failed_keys");
            const rows = stmt.all() as { key: string }[];
            return rows.map((row) => row.key);
        } catch (error) {
            debug.error("Failed to load failed keys from database:", error);
            return [];
        }
    }

    saveFailedKeys(keys: string[]): void {
        if (!this._db) {
            throw new Error("Database not initialized");
        }

        // Clear existing failed keys and insert current ones
        const transaction = this._db.transaction(() => {
            this._db!.exec("DELETE FROM failed_keys");

            if (keys.length > 0) {
                const insertStmt = this._db!.prepare("INSERT INTO failed_keys (key, added_at) VALUES (?, ?)");
                const now = Date.now();
                for (const key of keys) {
                    insertStmt.run(key, now);
                }
            }
        });

        transaction();
    }
}

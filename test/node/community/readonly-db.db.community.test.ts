import { it, describe, beforeAll, afterAll, expect } from "vitest";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type Database from "better-sqlite3";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

interface FakeCommunity {
    address: string;
    _pkc: { noData: boolean };
    _cidsToUnPin: Set<string>;
    _blocksToRm: string[];
    _mfsPathsToRemove: Set<string>;
    _clientsManager: object;
    _calculateLocalMfsPathForCommentUpdate: () => string;
    _addOldPageCidsToCidsToUnpin: () => Promise<void>;
    _addAllCidsUnderPurgedCommentToBeRemoved: () => void;
}

function createFakeCommunity(address: string): FakeCommunity {
    return {
        address,
        _pkc: { noData: true },
        _cidsToUnPin: new Set<string>(),
        _blocksToRm: [],
        _mfsPathsToRemove: new Set<string>(),
        _clientsManager: {},
        _calculateLocalMfsPathForCommentUpdate: () => "",
        _addOldPageCidsToCidsToUnpin: async () => {},
        _addAllCidsUnderPurgedCommentToBeRemoved: () => {}
    };
}

interface DbHandlerPrivate {
    _db: Database.Database;
}

function getPrivate(handler: DbHandler): DbHandlerPrivate {
    return handler as unknown as DbHandlerPrivate;
}

const TEST_ADDRESS = "12D3KooWReadonlyTestCommunity";

interface DbHandlerWithConfig {
    _dbConfig: { filename: string; fileMustExist: boolean };
}

function cleanupDbFiles(dbPath: string) {
    for (const suffix of ["", "-shm", "-wal"]) {
        try {
            fs.unlinkSync(dbPath + suffix);
        } catch {
            // ignore if file doesn't exist
        }
    }
}

// RPC tests can't access LocalCommunity internals directly
describeSkipIfRpc("initDbIfNeeded with readonly: true should not crash", function () {
    let dbHandler: DbHandler | undefined;
    const tmpDbPath = path.join(os.tmpdir(), `pkc-readonly-test-${Date.now()}.db`);

    afterAll(() => {
        if (dbHandler) {
            try {
                dbHandler.destoryConnection();
            } catch {
                // ignore cleanup errors
            }
            dbHandler = undefined;
        }
        cleanupDbFiles(tmpDbPath);
    });

    it("should not throw SQLITE_READONLY when reopening db in readonly mode", async () => {
        const fakeCommunity = createFakeCommunity(TEST_ADDRESS);
        dbHandler = new DbHandler(fakeCommunity as unknown as LocalCommunity);
        // Set _dbConfig directly to use temp file (avoids :memory: which can't be readonly)
        (dbHandler as unknown as DbHandlerWithConfig)._dbConfig = { filename: tmpDbPath, fileMustExist: false };

        // Step 1: Open writable, create tables and insert old pre-rebranding keyv key
        await dbHandler.initDbIfNeeded();

        const db = getPrivate(dbHandler)._db;
        db.prepare("INSERT OR REPLACE INTO keyv (key, value) VALUES (?, ?)").run(
            "keyv:INTERNAL_SUBPLEBBIT",
            JSON.stringify({ value: { address: TEST_ADDRESS } })
        );

        // Step 2: Destroy connection (simulates what happens between update loops)
        dbHandler.destoryConnection();

        // Step 3: Reopen in readonly mode (simulates state === "updating")
        // This should NOT throw SQLITE_READONLY
        await expect(dbHandler.initDbIfNeeded({ readonly: true })).resolves.not.toThrow();
    });

    it("should still be able to read keyv data when opened readonly", async () => {
        const fakeCommunity = createFakeCommunity(TEST_ADDRESS + "2");
        const tmpDbPath2 = tmpDbPath + ".read";
        const handler = new DbHandler(fakeCommunity as unknown as LocalCommunity);
        (handler as unknown as DbHandlerWithConfig)._dbConfig = { filename: tmpDbPath2, fileMustExist: false };

        // Create writable DB with data
        await handler.initDbIfNeeded();
        const db = getPrivate(handler)._db;
        db.prepare("INSERT OR REPLACE INTO keyv (key, value) VALUES (?, ?)").run(
            "keyv:INTERNAL_COMMUNITY",
            JSON.stringify({ value: { address: TEST_ADDRESS + "2", title: "Test" } })
        );
        handler.destoryConnection();

        // Reopen readonly and verify reads work
        await handler.initDbIfNeeded({ readonly: true });
        const row = getPrivate(handler)._db.prepare("SELECT value FROM keyv WHERE key = ?").get("keyv:INTERNAL_COMMUNITY") as
            | { value: string }
            | undefined;
        expect(row).toBeDefined();
        expect(JSON.parse(row!.value)).toHaveProperty("value.title", "Test");

        handler.destoryConnection();
        cleanupDbFiles(tmpDbPath2);
    });
});

import { existsSync, promises as fsPromises } from "node:fs";
import path from "node:path";
import { v4 as uuidV4 } from "uuid";
import Database from "better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Logger from "../../../dist/node/logger.js";
import { deleteOldCommunityInWindows, tryToDeleteCommunitiesThatFailedToBeDeletedBefore } from "../../../dist/node/runtime/node/util.js";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { mockPKC } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// On Windows a community DB that is still held when a delete() or a rename tries to remove it is recorded in storage
// (PERSISTENT_DELETED_COMMUNITIES) and removed on the next PKC start. Nothing took the address off that list when a live
// DB was written to the same path afterwards, so the next start deleted that live DB: renaming a community back to its
// old address, or creating a community at an address still on the list, lost the whole community on the next restart.
// The busy file is simulated by failing fs.promises.rm with EBUSY, as in delete-old-community-in-windows.test.ts.

const STORAGE_KEY = "PERSISTENT_DELETED_COMMUNITIES";

function createPkcWithStorage(dataPath: string): { pkc: PKC; storage: Map<string, unknown> } {
    const storage = new Map<string, unknown>();
    const pkc = {
        dataPath,
        _storage: {
            getItem: async (key: string): Promise<unknown> => storage.get(key),
            setItem: async (key: string, value: unknown): Promise<void> => void storage.set(key, value),
            removeItem: async (key: string): Promise<boolean> => storage.delete(key)
        }
    } as unknown as PKC;
    return { pkc, storage };
}

function createCommunityDb(dbPath: string, rows: string[]) {
    const db = new Database(dbPath);
    try {
        db.exec("CREATE TABLE posts (cid TEXT PRIMARY KEY)");
        const insert = db.prepare("INSERT INTO posts (cid) VALUES (?)");
        for (const row of rows) insert.run(row);
    } finally {
        db.close();
    }
}

function readCommunityDbRows(dbPath: string): string[] {
    const db = new Database(dbPath, { readonly: true });
    try {
        return (db.prepare("SELECT cid FROM posts ORDER BY cid").all() as { cid: string }[]).map((row) => row.cid);
    } finally {
        db.close();
    }
}

const busyError = () => Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });

// Reads and writes the DB files and the PKC storage in a local dataPath; over RPC the communities live in the server's dataPath
describeSkipIfRpc("a community DB written to a path that is waiting for a failed deletion", () => {
    let dataPath: string;

    beforeEach(async () => {
        dataPath = path.join(process.cwd(), ".tmp", "failed-deletion-path-reuse", uuidV4());
        await fsPromises.mkdir(path.join(dataPath, "communities"), { recursive: true });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await fsPromises.rm(dataPath, { recursive: true, force: true });
    });

    it("is not deleted on the next start after a community is renamed back onto it", async () => {
        const { pkc, storage } = createPkcWithStorage(dataPath);
        const oldAddress = "old-name.bso";
        const newAddress = "new-name.bso";
        const oldPath = path.join(dataPath, "communities", oldAddress);
        const newPath = path.join(dataPath, "communities", newAddress);
        createCommunityDb(oldPath, ["QmPostBeforeRename"]);

        // Rename old -> new on Windows while the old file stays held: changeDbFilename copies the DB to the new path,
        // then the old file cannot be removed and is recorded for a later delete
        const sourceDb = new Database(oldPath, { fileMustExist: true });
        await sourceDb.backup(newPath);
        sourceDb.close();
        const realRm = fsPromises.rm.bind(fsPromises);
        vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
            if (target === oldPath) throw busyError();
            return realRm(target, options);
        });
        await deleteOldCommunityInWindows(oldPath, pkc, { timeoutMs: 200 });
        vi.restoreAllMocks();
        expect(storage.get(STORAGE_KEY)).to.deep.equal([oldAddress]);

        // The owner keeps using the community and renames it back before restarting
        const db = new Database(newPath);
        db.prepare("INSERT INTO posts (cid) VALUES (?)").run("QmPostAfterRename");
        db.close();
        const fakeCommunity = { address: newAddress, _pkc: pkc };
        const dbHandler = new DbHandler(fakeCommunity as unknown as LocalCommunity);
        await dbHandler.changeDbFilename(newAddress, oldAddress);
        expect(readCommunityDbRows(oldPath)).to.deep.equal(["QmPostAfterRename", "QmPostBeforeRename"]);

        // The next PKC start runs the deferred deletes
        await tryToDeleteCommunitiesThatFailedToBeDeletedBefore(pkc, Logger("pkc-js:test:failed-deletion-path-reuse"));

        expect(existsSync(oldPath)).to.be.true;
        expect(readCommunityDbRows(oldPath)).to.deep.equal(["QmPostAfterRename", "QmPostBeforeRename"]);
        expect(storage.get(STORAGE_KEY)).to.be.undefined;
    });

    it("is not deleted on the next start after a new community is created at that address", async () => {
        const pkc = await mockPKC({ dataPath }, false, false);
        try {
            const signer = await pkc.createSigner();
            // A deletion of this address failed earlier and its leftover file has since gone (removed by hand, say)
            await pkc._storage.setItem(STORAGE_KEY, [signer.address]);

            const community = (await pkc.createCommunity({ signer })) as LocalCommunity;
            const dbPath = path.join(dataPath, "communities", community.address);
            expect(existsSync(dbPath)).to.be.true;

            await tryToDeleteCommunitiesThatFailedToBeDeletedBefore(pkc, Logger("pkc-js:test:failed-deletion-path-reuse"));

            expect(existsSync(dbPath)).to.be.true;
            expect(await pkc._storage.getItem(STORAGE_KEY)).to.be.undefined;
        } finally {
            await pkc.destroy();
        }
    });
});

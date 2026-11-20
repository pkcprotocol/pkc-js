import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidV4 } from "uuid";
import Database from "better-sqlite3";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { isCommunityStartLocked, isCommunityStartLockedSync } from "../../../dist/node/runtime/node/community/start-lock.js";
import { listCommunitiesSync, moveCommunityDbToDeletedDirectory } from "../../../dist/node/runtime/node/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { holdStartLockInAnotherProcess } from "../../helpers/start-lock-holder.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";

// The start lock is a file lock on the community's sidecar that lives on the holder's connection to the community DB
// (issue #561, see start-lock.ts). The kernel releases it when the holder dies, which is the point, but it also goes
// when that connection is closed, when the connection object is garbage collected (better-sqlite3 closes it), and, on
// POSIX, when the holder's process opens and closes the sidecar outside SQLite. Each of those would let another process
// start the community next to a live one, silently. These cases pin what keeps the lock held for as long as its holder
// wants it. Whether it is held is always asked of a second OS process, the only view that counts.

function createDbHandler({ dataPath, address }: { dataPath: string; address: string }): DbHandler {
    const fakeCommunity = { address, _pkc: { dataPath } };
    return new DbHandler(fakeCommunity as unknown as LocalCommunity);
}

// Uses DbHandler and a second OS process on a local dataPath (Node-only), not reachable over RPC
describeSkipIfRpc("how long a start lock stays held", () => {
    let dataPath: string;
    let address: string;
    let dbHandler: DbHandler;
    let holder: Awaited<ReturnType<typeof holdStartLockInAnotherProcess>> | undefined;

    const anotherProcessIsRefused = async () => {
        const refused = await holdStartLockInAnotherProcess({ dataPath, communityAddress: address }).then(
            // waited for: until that process is gone it has the DB open, which Windows does not let the cleanup delete
            async (taker): Promise<Error | undefined> => {
                await taker.kill();
                return undefined;
            },
            (e: Error) => e
        );
        return refused?.message === "failed ERR_COMMUNITY_ALREADY_STARTED";
    };

    beforeEach(async () => {
        dataPath = path.join(process.cwd(), ".tmp", "start-lock-lifetime", uuidV4());
        address = `12D3KooWStartLockLifetime${uuidV4().slice(0, 8)}`;
        fs.mkdirSync(path.join(dataPath, "communities"), { recursive: true });
        new Database(path.join(dataPath, "communities", address)).close();
        dbHandler = createDbHandler({ dataPath, address });
        await dbHandler.initDbIfNeeded();
    });

    afterEach(async () => {
        await holder?.kill();
        holder = undefined;
        await dbHandler.unlockCommunityStart().catch(() => {});
        dbHandler.destoryConnection();
        await fs.promises.rm(dataPath, { recursive: true, force: true });
    });

    it("closing the connection that holds it is refused, and the lock stays held", async () => {
        await dbHandler.lockCommunityStart();

        // under vitest it throws, so a test that reaches a path closing the connection of a started community fails
        expect(() => dbHandler.destoryConnection()).to.throw(/while it holds the community's start lock/);
        expect(dbHandler._db.open, "the connection was closed all the same").to.be.true;
        expect(await anotherProcessIsRefused()).to.be.true;

        // outside of it the call is logged and does nothing: a caller that mistook the community for a stopped one
        // must not take a running community's lock away
        const vitestEnv = process.env["VITEST"];
        delete process.env["VITEST"];
        try {
            expect(() => dbHandler.destoryConnection()).to.not.throw();
        } finally {
            process.env["VITEST"] = vitestEnv;
        }
        expect(dbHandler._db.open, "the connection was closed all the same").to.be.true;
        expect(dbHandler.holdsStartLock()).to.be.true;
        expect(await anotherProcessIsRefused()).to.be.true;

        await dbHandler.unlockCommunityStart();
        expect(() => dbHandler.destoryConnection()).to.not.throw();
    });

    // Taking the lock also removes the lock directory of the lock this one replaced. A failure there used to come after
    // the lock was taken: the failed start had no started state to tear down, so nothing released the lock and the
    // community could not be started again by any process until this one exited.
    it("is not left held when the old lock directory can't be removed", async () => {
        const oldLockDirectory = path.join(dataPath, "communities", `${address}.start.lock`);
        const realRm = fs.promises.rm.bind(fs.promises);
        vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
            if (target === oldLockDirectory) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
            return realRm(target, options);
        });
        try {
            await expect(dbHandler.lockCommunityStart()).rejects.toThrow("EPERM");
        } finally {
            vi.restoreAllMocks();
        }

        expect(dbHandler.holdsStartLock()).to.be.false;
        expect(await isCommunityStartLocked({ dataPath, communityAddress: address })).to.be.false;
        // taken directly: a process that failed for any other reason would not have been refused either
        holder = await holdStartLockInAnotherProcess({ dataPath, communityAddress: address });
        expect(isCommunityStartLockedSync({ dataPath, communityAddress: address })).to.be.true;
    });

    // start() opens the community's DB some awaits before it takes the lock. Another process that deletes the community
    // in between moves the DB away and removes the sidecar; the lock was then taken on a new sidecar, for a community
    // whose DB is no longer at its path: started, publishing, and writing to a file nothing will read again.
    it("is not taken for a community whose DB another process deleted after this one opened it", async () => {
        const dbPath = path.join(dataPath, "communities", address);
        // what the other process's delete() does to the files
        await moveCommunityDbToDeletedDirectory(address, { dataPath } as unknown as PKC);
        expect(fs.existsSync(dbPath)).to.be.false;

        const error = await dbHandler.lockCommunityStart().then(
            (): Error | undefined => undefined,
            (e: Error) => e
        );

        expect(error, "the lock was taken for a community with no DB at its path").to.be.instanceOf(Error);
        expect(dbHandler.holdsStartLock()).to.be.false;
        expect((error as { code?: string }).code).to.equal("CAN_NOT_LOAD_LOCAL_COMMUNITY_IF_DB_DOES_NOT_EXIST");
        expect(fs.existsSync(dbPath), "a DB file was created at the deleted community's path").to.be.false;

        // The sidecar the refused take created stays, unlocked. Removing it could unlink the one a process that
        // recreated the community meanwhile holds, and whoever takes the address next uses it as it is.
        new Database(dbPath).close();
        expect(await anotherProcessIsRefused(), "a community recreated at the address can't be started").to.be.false;
    });

    it("survives garbage collection in the holder's process, as long as the handler is referenced", async () => {
        holder = await holdStartLockInAnotherProcess({ dataPath, communityAddress: address, forceGc: true });

        expect(await isCommunityStartLocked({ dataPath, communityAddress: address })).to.be.true;
        const error = await dbHandler.lockCommunityStart().then(
            (): { code?: string } | undefined => undefined,
            (e: { code?: string }) => e
        );
        expect(error?.code).to.equal("ERR_COMMUNITY_ALREADY_STARTED");
    });

    it("survives the holder's own checks of it and its listing of the communities directory", async () => {
        await dbHandler.lockCommunityStart();
        // A file the listing does not know, so it reads its header with plain fs calls, as it does for every DB it has
        // not listed yet. The sidecar must not get that treatment.
        new Database(path.join(dataPath, "communities", "not-listed-yet")).close();
        const fakePkc = { dataPath } as unknown as PKC;

        for (let i = 0; i < 50; i++) {
            expect(isCommunityStartLockedSync({ dataPath, communityAddress: address })).to.be.true;
            expect(listCommunitiesSync(fakePkc)).to.include(address);
        }
        expect(listCommunitiesSync(fakePkc).filter((file) => file.includes(".lock"))).to.deep.equal([]);

        expect(await anotherProcessIsRefused()).to.be.true;
    });

    // pkc.communities checks every community on each refresh, in the event loop. Through SQLite a held lock took 31ms to
    // check on Windows, which stalled a process with a few dozen started communities for seconds (the first Windows CI
    // run of issue #561). 40 checks take about 2ms on every platform.
    it("is cheap to check while held, from its holder's process and from another", async () => {
        const timeChecks = () => {
            const startedAt = performance.now();
            for (let i = 0; i < 40; i++) expect(isCommunityStartLockedSync({ dataPath, communityAddress: address })).to.be.true;
            return performance.now() - startedAt;
        };

        await dbHandler.lockCommunityStart();
        expect(timeChecks(), "40 checks from the holder's process, in ms").to.be.lessThan(250);
        await dbHandler.unlockCommunityStart();

        holder = await holdStartLockInAnotherProcess({ dataPath, communityAddress: address });
        expect(timeChecks(), "40 checks from another process, in ms").to.be.lessThan(250);
    });

    it("survives writes, a failed write, a VACUUM and a backup on the connection that holds it", async () => {
        await dbHandler.lockCommunityStart();
        const db = dbHandler._db;

        db.exec("CREATE TABLE work (a UNIQUE); BEGIN IMMEDIATE; INSERT INTO work VALUES (1); COMMIT");
        expect(() => db.exec("BEGIN; INSERT INTO work VALUES (1); COMMIT")).to.throw();
        if (db.inTransaction) db.exec("ROLLBACK");
        db.exec("VACUUM");
        db.pragma("wal_checkpoint(TRUNCATE)");
        await db.backup(path.join(dataPath, "backup"));
        expect(dbHandler.runInWriteTransaction(() => db.prepare("SELECT count(*) AS n FROM work").get())).to.deep.equal({ n: 1 });

        expect(await anotherProcessIsRefused()).to.be.true;
    });

    it("is not taken on a read-only connection, which could not hold it", async () => {
        dbHandler.destoryConnection();
        await dbHandler.initDbIfNeeded({ readonly: true });

        await expect(dbHandler.lockCommunityStart()).rejects.toThrow(/read-only/);
        expect(await isCommunityStartLocked({ dataPath, communityAddress: address })).to.be.false;
    });
});

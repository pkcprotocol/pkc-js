import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidV4 } from "uuid";
import Database from "better-sqlite3";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import {
    closeCommunitiesRegistry,
    getCommunitiesRegistry,
    isCommunityStartLocked,
    isCommunityStartLockedSync
} from "../../../dist/node/runtime/node/community/communities-registry.js";
import { moveCommunityDbToDeletedDirectory } from "../../../dist/node/runtime/node/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { holdStartLockInAnotherProcess } from "../../helpers/start-lock-holder.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";

// A community is started while the communities registry names the PKC instance that started it and that instance's
// lock is held (issue #585, see communities-registry.ts and pkc-instance-lock.ts). The instance's lock is a file lock
// that lives on the registry's connection. The kernel releases it when the holder dies, which is the point, but it would
// also go if that connection were closed or garbage collected (better-sqlite3 closes it), and, on POSIX, if the
// holder's process opened and closed the lock file outside SQLite. Each of those would let another process start the
// community next to a live one, silently. These cases pin what keeps a community claimed for as long as its holder
// wants it. Whether it is claimed is always asked of a second OS process, the only view that counts.

// What stands in for the PKC instance of each handler, to close its communities registry with
const instances: { dataPath: string }[] = [];

function createDbHandler({ dataPath, address }: { dataPath: string; address: string }): DbHandler {
    const fakeCommunity = { address, _pkc: { dataPath } };
    instances.push(fakeCommunity._pkc);
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
        // its connection to storage.db would keep the dataPath from being removed on Windows
        for (const instance of instances.splice(0)) closeCommunitiesRegistry(instance);
        await fs.promises.rm(dataPath, { recursive: true, force: true });
    });

    it("closing the connection that holds it is refused, and the lock stays held", async () => {
        await dbHandler.lockCommunityStart();

        // under vitest it throws, so a test that reaches a path closing the connection of a started community fails
        expect(() => dbHandler.destoryConnection()).to.throw(/while it has the community started/);
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

    // start() opens the community's DB some awaits before it claims the community. Another process that deletes the
    // community in between moves the DB away; the claim was then made for a community whose DB is no longer at its
    // path: started, publishing, and writing to a file nothing will read again.
    // Not on Windows: a DB that a process has open cannot be removed there, so the other process's delete leaves it
    // at its path (to be removed later, see tryToDeleteCommunitiesThatFailedToBeDeletedBefore) and this state is not reached.
    it.skipIf(process.platform === "win32")(
        "is not taken for a community whose DB another process deleted after this one opened it",
        async () => {
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

            expect(isCommunityStartLockedSync({ dataPath, communityAddress: address }), "a community that is gone is started").to.be.false;

            // and a community created at the address afterwards can be started
            new Database(dbPath).close();
            expect(await anotherProcessIsRefused(), "a community recreated at the address can't be started").to.be.false;
        }
    );

    it("survives garbage collection in the holder's process, as long as the handler is referenced", async () => {
        holder = await holdStartLockInAnotherProcess({ dataPath, communityAddress: address, forceGc: true });

        expect(await isCommunityStartLocked({ dataPath, communityAddress: address })).to.be.true;
        const error = await dbHandler.lockCommunityStart().then(
            (): { code?: string } | undefined => undefined,
            (e: { code?: string }) => e
        );
        expect(error?.code).to.equal("ERR_COMMUNITY_ALREADY_STARTED");
    });

    it("survives the holder's own checks of it, and another PKC instance of its process listing the directory", async () => {
        await dbHandler.lockCommunityStart();
        // A DB the registry has no row for, so it reads its header with plain fs calls. The lock file of an instance
        // must never get that treatment in the instance's own process: on POSIX it would drop the lock
        new Database(path.join(dataPath, "communities", "not-listed-yet")).close();

        for (let i = 0; i < 50; i++) expect(isCommunityStartLockedSync({ dataPath, communityAddress: address })).to.be.true;
        // a second instance in this process: it sweeps the lock files of dead instances and lists the directory
        const otherInstance = { dataPath };
        instances.push(otherInstance);
        const otherRegistry = getCommunitiesRegistry(otherInstance);
        try {
            otherRegistry.startMonitoring({ onChange: () => {} });
            for (let i = 0; i < 50; i++) otherRegistry.readChangesOfOtherInstances();
            expect(otherRegistry.isStarted(address)).to.be.true;
        } finally {
            otherRegistry.close();
        }

        expect(await anotherProcessIsRefused()).to.be.true;
    });

    // Through SQLite a held lock took 31ms to check on Windows (the first Windows CI run of issue #561), so the check
    // reads the lock byte there. 40 checks, each of which also opens the registry, take a few ms on every platform.
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

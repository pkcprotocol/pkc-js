import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidV4 } from "uuid";
import Database from "better-sqlite3";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { isCommunityStartLocked, isCommunityStartLockedSync } from "../../../dist/node/runtime/node/community/start-lock.js";
import { listCommunitiesSync } from "../../../dist/node/runtime/node/util.js";
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
            (taker): Error | undefined => {
                void taker.kill();
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

    it("closing the connection that holds it is refused under vitest, and the lock stays held", async () => {
        await dbHandler.lockCommunityStart();

        expect(() => dbHandler.destoryConnection()).to.throw(/held the community's start lock/);
        expect(dbHandler._db.open, "the connection was closed all the same").to.be.true;
        expect(await anotherProcessIsRefused()).to.be.true;

        await dbHandler.unlockCommunityStart();
        expect(() => dbHandler.destoryConnection()).to.not.throw();
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

    it("survives writes, a failed write, a VACUUM and a backup on the connection that holds it", async () => {
        await dbHandler.lockCommunityStart();
        const db = dbHandler._db;

        db.exec("CREATE TABLE work (a UNIQUE); BEGIN IMMEDIATE; INSERT INTO work VALUES (1); COMMIT");
        expect(() => db.exec("BEGIN; INSERT INTO work VALUES (1); COMMIT")).to.throw();
        if (db.inTransaction) db.exec("ROLLBACK");
        db.exec("VACUUM");
        db.pragma("wal_checkpoint(TRUNCATE)");
        await db.backup(path.join(dataPath, "backup"));

        expect(await anotherProcessIsRefused()).to.be.true;
    });

    it("is not taken on a read-only connection, which could not hold it", async () => {
        dbHandler.destoryConnection();
        await dbHandler.initDbIfNeeded({ readonly: true });

        await expect(dbHandler.lockCommunityStart()).rejects.toThrow(/read-only/);
        expect(await isCommunityStartLocked({ dataPath, communityAddress: address })).to.be.false;
    });
});

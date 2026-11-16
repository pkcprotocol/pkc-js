import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidV4 } from "uuid";
import Database from "better-sqlite3";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { isCommunityStartLocked, isCommunityStartLockedSync } from "../../../dist/node/runtime/node/community/start-lock.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { holdStartLockInAnotherProcess } from "../../helpers/start-lock-holder.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

// The start lock decides which process runs a community. A process that is killed (SIGKILL, an OOM kill, power loss)
// cannot release it. The lock used to be a file its holder refreshed from a timer, held for as long as its mtime was
// under 10s old, so a killed holder's lock still read "held" for up to 10s: a server restarted sooner than that failed
// to start its communities with ERR_COMMUNITY_ALREADY_STARTED and never hosted them again (issue #546). The lock is
// held in the kernel now, which releases it the moment the holding process dies, and not before (issue #561).

function createDbHandler({ dataPath, address }: { dataPath: string; address: string }): DbHandler {
    const fakeCommunity = { address, _pkc: { dataPath } };
    return new DbHandler(fakeCommunity as unknown as LocalCommunity);
}

// Uses DbHandler and a second OS process on a local dataPath (Node-only), not reachable over RPC
describeSkipIfRpc("the start lock of a community whose holder is another process", () => {
    let dataPath: string;
    let address: string;
    let dbHandler: DbHandler;
    let holder: Awaited<ReturnType<typeof holdStartLockInAnotherProcess>> | undefined;

    beforeEach(async () => {
        dataPath = path.join(process.cwd(), ".tmp", "start-lock-killed-holder", uuidV4());
        address = `12D3KooWStartLockHolder${uuidV4().slice(0, 8)}`;
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

    it("is free the moment a holder is killed, and can be taken at once", async () => {
        holder = await holdStartLockInAnotherProcess({ dataPath, communityAddress: address });
        expect(await isCommunityStartLocked({ dataPath, communityAddress: address })).to.be.true;

        await holder.kill(); // SIGKILL: the holder gets no chance to release its lock

        expect(isCommunityStartLockedSync({ dataPath, communityAddress: address }), "a dead process still holds the lock").to.be.false;
        expect(await isCommunityStartLocked({ dataPath, communityAddress: address })).to.be.false;
        await dbHandler.lockCommunityStart();
        expect(await isCommunityStartLocked({ dataPath, communityAddress: address })).to.be.true;
    });

    it("is refused with ERR_COMMUNITY_ALREADY_STARTED while its holder lives, and the holder keeps it", async () => {
        holder = await holdStartLockInAnotherProcess({ dataPath, communityAddress: address });

        const error = await dbHandler.lockCommunityStart().then(
            (): PKCError | undefined => undefined,
            (e: PKCError) => e
        );
        expect(error?.code).to.equal("ERR_COMMUNITY_ALREADY_STARTED");
        expect(holder.process.exitCode).to.be.null;
        expect(await isCommunityStartLocked({ dataPath, communityAddress: address })).to.be.true;

        // A second process is refused the same way
        const secondProcessError = await holdStartLockInAnotherProcess({ dataPath, communityAddress: address }).then(
            (): Error | undefined => undefined,
            (e: Error) => e
        );
        expect(secondProcessError?.message).to.equal("failed ERR_COMMUNITY_ALREADY_STARTED");
    });
});

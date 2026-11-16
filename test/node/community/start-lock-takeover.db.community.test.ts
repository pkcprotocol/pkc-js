import { afterEach, beforeEach, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidV4 } from "uuid";
import Database from "better-sqlite3";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { isCommunityStartLocked } from "../../../dist/node/runtime/node/community/start-lock.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { holdStartLockInAnotherProcess } from "../../helpers/start-lock-holder.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

// The start lock decides which process runs a community. It used to be a file its holder kept fresh from a timer, and
// another process that found it stale (the holder's event loop blocked past 10s by a VACUUM or a migration) took it
// over: two processes then ran one community until the first noticed and stopped. The lock is held in the kernel now
// (issue #561), for as long as its holder lives, so a holder that goes quiet for any length of time keeps it and there
// is no takeover to report. What a started community does about another process is covered by
// start-lock-takeover.community.test.ts.

function createDbHandler({ dataPath, address }: { dataPath: string; address: string }): DbHandler {
    const fakeCommunity = { address, _pkc: { dataPath } };
    return new DbHandler(fakeCommunity as unknown as LocalCommunity);
}

// Uses DbHandler and a second OS process on a local dataPath (Node-only), not reachable over RPC
describeSkipIfRpc("DbHandler.lockCommunityStart against a holder that cannot lose its lock", () => {
    let dataPath: string;
    let address: string;
    let dbHandler: DbHandler;
    let holder: Awaited<ReturnType<typeof holdStartLockInAnotherProcess>> | undefined;

    beforeEach(async () => {
        dataPath = path.join(process.cwd(), ".tmp", "start-lock-takeover", uuidV4());
        address = `12D3KooWStartLockTakeover${uuidV4().slice(0, 8)}`;
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

    it("refuses a takeover of a holder whose event loop has been blocked for longer than the old 10s stale threshold", async () => {
        holder = await holdStartLockInAnotherProcess({ dataPath, communityAddress: address, blockEventLoopForMs: 14_000 });

        await new Promise((resolve) => setTimeout(resolve, 11_500)); // the holder has run no timer for 11.5s by now

        const error = await dbHandler.lockCommunityStart().then(
            (): PKCError | undefined => undefined,
            (e: PKCError) => e
        );
        expect(error?.code, "took over the lock of a live process").to.equal("ERR_COMMUNITY_ALREADY_STARTED");
        expect(holder.process.exitCode).to.be.null;
        expect(await isCommunityStartLocked({ dataPath, communityAddress: address })).to.be.true;
    });

    it("can be released and taken again by the same handler, and each release frees it for another process", async () => {
        await dbHandler.lockCommunityStart();
        expect(await isCommunityStartLocked({ dataPath, communityAddress: address })).to.be.true;
        await dbHandler.unlockCommunityStart();
        expect(await isCommunityStartLocked({ dataPath, communityAddress: address })).to.be.false;

        await dbHandler.lockCommunityStart();
        const refused = await holdStartLockInAnotherProcess({ dataPath, communityAddress: address }).then(
            (): Error | undefined => undefined,
            (e: Error) => e
        );
        expect(refused?.message).to.equal("failed ERR_COMMUNITY_ALREADY_STARTED");

        await dbHandler.unlockCommunityStart();
        holder = await holdStartLockInAnotherProcess({ dataPath, communityAddress: address });
        expect(await isCommunityStartLocked({ dataPath, communityAddress: address })).to.be.true;
    });
});

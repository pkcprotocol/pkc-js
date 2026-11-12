import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidV4 } from "uuid";
import Database from "better-sqlite3";
import lockfile from "@pkcprotocol/proper-lock-file";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { isCommunityStartLocked } from "../../../dist/node/runtime/node/community/start-lock.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { takeOverStartLockFromAnotherProcess } from "../../helpers/start-lock-takeover.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// The start lock decides which process runs a community. Its holder keeps it fresh from a timer; another process that
// finds it stale (the holder's event loop blocked past 10s by a VACUUM or a migration) takes it over, and the lock
// library reports the loss to the holder through onCompromised. That report used to go to a no-op, so the holder kept
// running the community next to the process that took it over. lockCommunityStart now passes it on, once, and only for
// the lock it still holds. What the community does with it is covered by start-lock-takeover.community.test.ts.

type OnCompromised = (error: Error) => void;

function createDbHandler({ dataPath, address }: { dataPath: string; address: string }): DbHandler {
    const fakeCommunity = { address, _pkc: { dataPath } };
    return new DbHandler(fakeCommunity as unknown as LocalCommunity);
}

// Uses DbHandler and a lock directory in a local dataPath (Node-only), not reachable over RPC
describeSkipIfRpc("DbHandler.lockCommunityStart when the start lock is lost", () => {
    let dataPath: string;
    let address: string;
    let dbHandler: DbHandler;
    let otherProcess: { kill: () => void } | undefined;

    beforeEach(() => {
        dataPath = path.join(process.cwd(), ".tmp", "start-lock-takeover", uuidV4());
        address = `12D3KooWStartLockTakeover${uuidV4().slice(0, 8)}`;
        fs.mkdirSync(path.join(dataPath, "communities"), { recursive: true });
        new Database(path.join(dataPath, "communities", address)).close(); // the lock resolves the DB file's real path
        dbHandler = createDbHandler({ dataPath, address });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        otherProcess?.kill();
        otherProcess = undefined;
        await dbHandler.unlockCommunityStart().catch(() => {});
        await fs.promises.rm(dataPath, { recursive: true, force: true });
    });

    it("reports a takeover by another process once, and leaves that process's lock alone", async () => {
        const onCompromised = vi.fn<OnCompromised>();
        await dbHandler.lockCommunityStart({ onCompromised });

        otherProcess = await takeOverStartLockFromAnotherProcess({ dataPath, communityAddress: address });
        // the holder notices at its next refresh, at most 5s after the takeover
        await vi.waitFor(() => expect(onCompromised).toHaveBeenCalled(), { timeout: 15000, interval: 100 });

        expect(onCompromised).toHaveBeenCalledTimes(1);
        expect((onCompromised.mock.calls[0][0] as Error & { code?: string }).code).to.equal("ECOMPROMISED");

        // Stopping afterwards must not release the lock the other process holds now
        await dbHandler.unlockCommunityStart().catch(() => {});
        expect(await isCommunityStartLocked({ dataPath, communityAddress: address })).to.be.true;
        expect(onCompromised).toHaveBeenCalledTimes(1);
    });

    it("does not pass on a report for a lock it already released, even after taking the lock again", async () => {
        const lockOnCompromisedByAcquisition: OnCompromised[] = [];
        const realLock = lockfile.lock;
        vi.spyOn(lockfile, "lock").mockImplementation(async (file, options) => {
            if (options.onCompromised) lockOnCompromisedByAcquisition.push(options.onCompromised);
            return realLock(file, options);
        });

        const firstOnCompromised = vi.fn<OnCompromised>();
        await dbHandler.lockCommunityStart({ onCompromised: firstOnCompromised });
        await dbHandler.unlockCommunityStart();
        const secondOnCompromised = vi.fn<OnCompromised>();
        await dbHandler.lockCommunityStart({ onCompromised: secondOnCompromised });

        // The library calls a lock's onCompromised when a refresh that was in flight during unlock() finds the lock
        // directory gone or replaced. That lock was released on purpose, so it was not lost.
        expect(lockOnCompromisedByAcquisition).to.have.length(2);
        lockOnCompromisedByAcquisition[0](Object.assign(new Error("late report"), { code: "ECOMPROMISED" }));

        expect(firstOnCompromised).not.toHaveBeenCalled();
        expect(secondOnCompromised).not.toHaveBeenCalled();
    });
});

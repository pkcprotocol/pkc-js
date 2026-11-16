import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { mockPKC, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { isCommunityStartLocked } from "../../../dist/node/runtime/node/community/start-lock.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { takeOverStartLockFromAnotherProcess } from "../../helpers/start-lock-takeover.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

// When another process on the same dataPath takes a started community's start lock over (it found the lock stale
// because this process's event loop was blocked past 10s, by a VACUUM of a large DB say), this process used to keep
// running the community: two processes then published and wrote the same community. It now emits
// ERR_COMMUNITY_START_LOCK_COMPROMISED and stops, and leaves the lock to the process that took it.

// A second OS process takes the start lock in the local dataPath; over RPC the community runs in the server's process
describeSkipIfRpc("a started community whose start lock another process takes over", () => {
    let pkc: PKCType;
    let otherProcess: { kill: () => void } | undefined;

    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        otherProcess?.kill();
        await pkc.destroy();
    });

    it("emits ERR_COMMUNITY_START_LOCK_COMPROMISED, stops, and leaves the lock to the other process", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        const errors: PKCError[] = [];
        community.on("error", (error) => void errors.push(error as PKCError));
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        otherProcess = await takeOverStartLockFromAnotherProcess({ dataPath: pkc.dataPath!, communityAddress: community.address });

        // the community notices at its lock's next refresh, at most 5s after the takeover
        await vi.waitFor(() => expect(community.state).to.equal("stopped"), { timeout: 20000, interval: 200 });
        expect(errors.map((error) => error.code)).to.include("ERR_COMMUNITY_START_LOCK_COMPROMISED");
        expect(await isCommunityStartLocked({ dataPath: pkc.dataPath!, communityAddress: community.address })).to.be.true;
    });
});

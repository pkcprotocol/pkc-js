import { afterAll, beforeAll, expect, it } from "vitest";
import { mockPKC, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { isCommunityStartLocked } from "../../../dist/node/runtime/node/community/start-lock.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { holdStartLockInAnotherProcess } from "../../helpers/start-lock-holder.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

// Another process on the same dataPath used to be able to take a started community's start lock over (it found the lock
// stale because this process's event loop was blocked past 10s, by a VACUUM of a large DB say), and this process then
// had to notice and stop. The lock is held in the kernel now (issue #561): the other process is refused for as long as
// this one lives, and the community keeps running.

// A second OS process asks for the start lock in the local dataPath; over RPC the community runs in the server's process
describeSkipIfRpc("a started community whose start lock another process asks for", () => {
    let pkc: PKCType;

    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it("keeps running and keeps its lock, and the other process is refused with ERR_COMMUNITY_ALREADY_STARTED", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        const errors: PKCError[] = [];
        community.on("error", (error) => void errors.push(error as PKCError));
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        const refused = await holdStartLockInAnotherProcess({ dataPath: pkc.dataPath!, communityAddress: community.address }).then(
            async (holder): Promise<Error | undefined> => {
                await holder.kill();
                return undefined;
            },
            (e: Error) => e
        );
        expect(refused?.message, "another process took the start lock of a started community").to.equal(
            "failed ERR_COMMUNITY_ALREADY_STARTED"
        );

        expect(community.state).to.equal("started");
        expect(errors).to.deep.equal([]);
        expect(await isCommunityStartLocked({ dataPath: pkc.dataPath!, communityAddress: community.address })).to.be.true;

        await community.stop();
        expect(await isCommunityStartLocked({ dataPath: pkc.dataPath!, communityAddress: community.address })).to.be.false;
    });
});

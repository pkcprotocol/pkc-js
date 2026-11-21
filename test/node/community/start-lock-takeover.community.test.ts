import { afterAll, beforeAll, expect, it } from "vitest";
import { mockPKC, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import Database from "better-sqlite3";
import path from "node:path";
import { getCommunitiesRegistry, isCommunityStartLocked } from "../../../dist/node/runtime/node/community/communities-registry.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { holdStartLockInAnotherProcess } from "../../helpers/start-lock-holder.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

// Another process on the same dataPath used to be able to take a started community's start lock over (it found the lock
// stale because this process's event loop was blocked past 10s, by a VACUUM of a large DB say), and this process then
// had to notice and stop. A PKC instance holds its lock in the kernel now (issues #561 and #585): the other process is
// refused for as long as this one lives, and the community keeps running. Should a started community find itself
// claimed by another live instance all the same, it says so and stops: two instances must never publish one community.

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

    it("stops itself with an error at its next publish cycle when the registry names another live instance", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        const errors: PKCError[] = [];
        community.on("error", (error) => void errors.push(error as PKCError));
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        // Another live instance on the dataPath, written into the registry as the one that has the community started.
        // start() never lets that happen, so it is written by hand
        const otherInstance = { dataPath: pkc.dataPath! };
        const otherRegistry = getCommunitiesRegistry(otherInstance);
        try {
            const storage = new Database(path.join(pkc.dataPath!, "storage.db"));
            try {
                storage
                    .prepare("UPDATE localCommunities SET startedBy = ? WHERE address = ?")
                    .run(otherRegistry.instanceId, community.address);
            } finally {
                storage.close();
            }
            await community.edit({ title: `wakes the publish loop ${Date.now()}` }).catch(() => {});

            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => community.state === "stopped",
                eventName: "statechange"
            });
            expect(errors.map((error) => error.code)).to.include("ERR_COMMUNITY_START_TAKEN_BY_ANOTHER_PKC_INSTANCE");
            // it did not take the other instance's claim away on its way down
            expect(otherRegistry.isStarted(community.address)).to.be.true;
            expect(community._dbHandler.holdsStartLock()).to.be.false;
        } finally {
            otherRegistry.close();
            if (community.state !== "stopped") await community.stop().catch(() => {});
        }
    });
});

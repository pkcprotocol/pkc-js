import {
    mockPKC,
    createSubWithNoChallenge,
    publishRandomPost,
    publishVote,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    createPendingApprovalChallenge,
    publishCommentToModQueue
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { beforeAll, afterAll, it, expect } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { SignerWithPublicKeyAddress } from "../../../dist/node/signer/index.js";

// Regression tests for issues #226 (votes), #334 (author comment edits) and #335 (comments sent to
// the mod queue): the community publish loop sleeps for `publishInterval` between syncs and only
// wakes early on `_communityUpdateTrigger`. storeCommentModeration sets that trigger right after its
// DB write; storeVote, storeCommentEdit (outside its purge branch) and storeComment (for a pending
// comment, which the lastPostCid/lastCommentCid change excludes) did not. The votes/edits-aware
// queryCommentsToBeUpdated and the mod-queue check both run inside the sync, after the sleep, so
// those publications reached the published record only when the timer fired, up to a full
// publishInterval (20s in production) after the author already received a successful
// challengeverification.
//
// The test server runs its communities with publishInterval = 1s, which hides the gap behind the
// polling lag of the existing publication tests. This suite runs its own LocalCommunities with a
// long publishInterval and bounds the time between a publication's challengeverification and its
// effect reaching a client. The moderation case is the control: it exercises the wake-up path that
// already existed, so it proves the bound is reachable in this setup.
//
// Cannot run under RPC: the publish loop lives in the RPC server, which owns its publishInterval,
// so the client cannot lengthen it to expose the lag.

const PUBLISH_INTERVAL_MS = 30_000;
// Anything below publishInterval can only be met by an explicit wake-up; leave generous room for
// the client-side CommentUpdate fetch (updateInterval 500ms) and a slow runner.
const MAX_PROPAGATION_MS = 10_000;

describeSkipIfRpc("Publications wake the community publish loop (issues #226, #334, #335)", () => {
    let pkc: PKC;
    let community: LocalCommunity;
    let moderatorSigner: SignerWithPublicKeyAddress;

    beforeAll(async () => {
        pkc = await mockPKC({ publishInterval: PUBLISH_INTERVAL_MS, updateInterval: 500 });
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        moderatorSigner = await pkc.createSigner();
        await community.edit({ roles: { [moderatorSigner.address]: { role: "moderator" } } });
        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.roles?.[moderatorSigner.address]?.role === "moderator"
        });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    // The post's first CommentUpdate must already be published before the timed publication goes
    // out, otherwise the timer would also cover the post's own update cycle.
    async function publishPostWithPublishedCommentUpdate(): Promise<Comment & { cid: string }> {
        const post = await publishRandomPost({ communityAddress: community.address, pkc });
        expect(post.cid).to.be.a("string");
        await post.update();
        await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => typeof post.updatedAt === "number" });
        return post as Comment & { cid: string };
    }

    async function msUntil(post: Comment, predicate: () => boolean): Promise<number> {
        const start = Date.now();
        await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => predicate() });
        return Date.now() - start;
    }

    it("control: a comment moderation is reflected on the comment well within publishInterval", async () => {
        const post = await publishPostWithPublishedCommentUpdate();
        const pinMod = await pkc.createCommentModeration({
            communityAddress: community.address,
            commentCid: post.cid,
            commentModeration: { pinned: true, reason: "Wake-up control (issue #226)" },
            signer: moderatorSigner
        });
        await publishWithExpectedResult({ publication: pinMod, expectedChallengeSuccess: true });

        const elapsedMs = await msUntil(post, () => post.pinned === true);
        await post.stop();
        expect(elapsedMs, `moderation took ${elapsedMs}ms to propagate`).toBeLessThan(MAX_PROPAGATION_MS);
    });

    it("a vote is reflected in the comment's upvoteCount well within publishInterval (issue #226)", async () => {
        const post = await publishPostWithPublishedCommentUpdate();
        expect(post.upvoteCount).to.equal(0);
        await publishVote({ commentCid: post.cid, communityAddress: community.address, vote: 1, pkc });

        const elapsedMs = await msUntil(post, () => post.upvoteCount === 1);
        await post.stop();
        expect(elapsedMs, `vote took ${elapsedMs}ms to propagate`).toBeLessThan(MAX_PROPAGATION_MS);
    });

    it("an author comment edit is reflected on the comment well within publishInterval (issue #334)", async () => {
        const post = await publishPostWithPublishedCommentUpdate();
        expect([false, undefined]).to.include(post.spoiler);
        const spoilerEdit = await pkc.createCommentEdit({
            communityAddress: community.address,
            commentCid: post.cid,
            spoiler: true,
            signer: post.signer!
        });
        await publishWithExpectedResult({ publication: spoilerEdit, expectedChallengeSuccess: true });

        const elapsedMs = await msUntil(post, () => post.spoiler === true);
        await post.stop();
        expect(elapsedMs, `author edit took ${elapsedMs}ms to propagate`).toBeLessThan(MAX_PROPAGATION_MS);
    });

    // The wake-up trigger used to be cleared at the END of a publish cycle, after the record was
    // built from the DB and pushed through kubo add + name.publish. A publication stored while that
    // cycle was in flight is not in the record, sets the trigger, and then had it cleared, so it
    // waited for the timer like before the fix. The cycle is held inside a wrapped name.publish
    // while the vote runs to completion, which pins the interleaving instead of racing for it.
    it("a vote stored while a publish cycle is in flight is published by the next cycle, not the next timer tick", async () => {
        const post = await publishPostWithPublishedCommentUpdate();
        expect(post.upvoteCount).to.equal(0);

        const namesysApi = community._clientsManager.getDefaultKuboRpcClient()._client.name;
        const originalPublish = namesysApi.publish.bind(namesysApi);
        let cycleHeld = false;
        let voteStoredDuringHeldCycle: Promise<unknown> | undefined;
        const holdOneCycleWhileVoteLands = async (...args: Parameters<typeof originalPublish>): ReturnType<typeof originalPublish> => {
            if (!cycleHeld) {
                cycleHeld = true;
                namesysApi.publish = originalPublish; // only this cycle is held
                // The record under args[0] was built before this vote exists. The vote's
                // challengeverification arrives while the cycle is still in flight.
                voteStoredDuringHeldCycle = publishVote({ commentCid: post.cid, communityAddress: community.address, vote: 1, pkc });
                await voteStoredDuringHeldCycle;
            }
            return originalPublish(...args);
        };
        namesysApi.publish = holdOneCycleWhileVoteLands as typeof namesysApi.publish;

        try {
            // Start a cycle through the wake-up path that already worked before this fix
            const pinMod = await pkc.createCommentModeration({
                communityAddress: community.address,
                commentCid: post.cid,
                commentModeration: { pinned: true, reason: "Start a publish cycle to hold" },
                signer: moderatorSigner
            });
            await publishWithExpectedResult({ publication: pinMod, expectedChallengeSuccess: true });

            const holdDeadline = Date.now() + MAX_PROPAGATION_MS;
            while (!cycleHeld) {
                if (Date.now() > holdDeadline) throw Error("Timed out waiting for the publish loop to reach name.publish");
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            await voteStoredDuringHeldCycle;

            const elapsedMs = await msUntil(post, () => post.upvoteCount === 1);
            expect(post.pinned, "the held cycle's record should have been published too").to.be.true;
            expect(elapsedMs, `vote stored mid-cycle took ${elapsedMs}ms to propagate`).toBeLessThan(MAX_PROPAGATION_MS);
        } finally {
            namesysApi.publish = originalPublish;
            await post.stop();
        }
    });
});

describeSkipIfRpc("A comment sent to the mod queue wakes the community publish loop (issue #335)", () => {
    let pkc: PKC;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC({ publishInterval: PUBLISH_INTERVAL_MS, updateInterval: 500 });
        community = (await pkc.createCommunity()) as LocalCommunity;
        await community.edit({ settings: { challenges: [createPendingApprovalChallenge()] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("the pending comment shows up in modQueue.pageCids.pendingApproval well within publishInterval", async () => {
        expect(community.modQueue.pageCids?.pendingApproval).to.be.undefined;
        // Passing the pendingApproval challenge sends the comment to the queue with a successful
        // challengeverification carrying commentUpdate.pendingApproval = true.
        const { challengeVerification } = await publishCommentToModQueue({
            community,
            pkc,
            commentProps: { challengeRequest: { challengeAnswers: ["pending"] } }
        });
        expect(challengeVerification.commentUpdate?.pendingApproval).to.be.true;

        const start = Date.now();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => Boolean(community.modQueue.pageCids?.pendingApproval)
        });
        const elapsedMs = Date.now() - start;
        expect(elapsedMs, `mod-queue comment took ${elapsedMs}ms to be published`).toBeLessThan(MAX_PROPAGATION_MS);
    });
});

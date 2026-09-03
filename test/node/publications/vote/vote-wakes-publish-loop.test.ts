import {
    mockPKC,
    createSubWithNoChallenge,
    publishRandomPost,
    publishVote,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { beforeAll, afterAll, it, expect } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { SignerWithPublicKeyAddress } from "../../../../dist/node/signer/index.js";

// Regression tests for issue #226: the community publish loop sleeps for `publishInterval` between
// syncs and only wakes early on `_communityUpdateTrigger`. storeCommentModeration sets that trigger
// right after its DB write; storeVote does not, so an accepted vote is folded into the comment's
// CommentUpdate only when the timer fires, up to a full publishInterval (20s in production) after
// the voter already received a successful challengeverification.
//
// The test server runs its communities with publishInterval = 1s, which hides the gap behind the
// polling lag of the existing upvote/downvote tests. This suite runs its own LocalCommunity with a
// long publishInterval and bounds the time between a publication's challengeverification and the
// updated comment reaching a client. The moderation case is the control: it exercises the wake-up
// path that already exists, so it proves the bound is reachable in this setup.
//
// Cannot run under RPC: the publish loop lives in the RPC server, which owns its publishInterval,
// so the client cannot lengthen it to expose the lag.

const PUBLISH_INTERVAL_MS = 30_000;
// Anything below publishInterval can only be met by an explicit wake-up; leave generous room for
// the client-side CommentUpdate fetch (updateInterval 500ms) and a slow runner.
const MAX_PROPAGATION_MS = 10_000;

describeSkipIfRpc("Publishing a vote wakes the community publish loop (issue #226)", () => {
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

    it("a vote is reflected in the comment's upvoteCount well within publishInterval", async () => {
        const post = await publishPostWithPublishedCommentUpdate();
        expect(post.upvoteCount).to.equal(0);
        await publishVote({ commentCid: post.cid, communityAddress: community.address, vote: 1, pkc });

        const elapsedMs = await msUntil(post, () => post.upvoteCount === 1);
        await post.stop();
        expect(elapsedMs, `vote took ${elapsedMs}ms to propagate`).toBeLessThan(MAX_PROPAGATION_MS);
    });
});

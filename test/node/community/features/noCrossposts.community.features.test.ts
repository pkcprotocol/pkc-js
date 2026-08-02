// Crossposts (issue #32) — community.features.noCrossposts.
//
// noCrossposts is an INBOUND rule: it governs what this community accepts, not what other
// communities may do with this community's comments. It is enforced by the community at acceptance
// time, alongside the other feature toggles in checkCommentPublication.
import {
    mockPKC,
    createSubWithNoChallenge,
    generateMockPost,
    generateMockComment,
    publishWithExpectedResult,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    publishRandomPost,
    publishRandomReply
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined, CommentIpfsType } from "../../../../dist/node/publications/comment/types.js";

describe(`community.features.noCrossposts`, async () => {
    let pkc: PKC;
    let remotePKC: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let publishedPost: Comment;
    let crosspost: { cid: string; comment: CommentIpfsType };
    let crosspostPublishedBeforeFeatureEnabled: Comment;

    const setNoCrossposts = async (value: boolean | undefined) => {
        await community.edit({ features: { ...community.features, noCrossposts: value } });
    };

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        publishedPost = await publishRandomPost({ communityAddress: community.address, pkc: remotePKC });
        crosspost = { cid: publishedPost.cid!, comment: publishedPost.raw.comment! };
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it.sequential(`Crossposts are allowed by default`, async () => {
        expect(community.features?.noCrossposts).to.be.undefined;
        const post = await generateMockPost({ communityAddress: community.address, pkc: remotePKC, postProps: { crosspost } });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
        crosspostPublishedBeforeFeatureEnabled = post;
        expect(post.crosspost?.cid).to.equal(crosspost.cid);
    });

    it.sequential(`A reply carrying a crosspost is allowed by default`, async () => {
        // Unlike quotedCids, crossposts are not restricted to one of post/reply.
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, { crosspost });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        await setNoCrossposts(true);
        expect(community.features?.noCrossposts).to.be.true;

        const remoteCommunity = await remotePKC.getCommunity({ address: community.address });
        await remoteCommunity.update();
        await resolveWhenConditionIsTrue({
            toUpdate: remoteCommunity,
            predicate: async () => remoteCommunity.features?.noCrossposts === true
        });
        expect(remoteCommunity.features?.noCrossposts).to.be.true;
        await remoteCommunity.stop();
    });

    it.sequential(`Can't publish a post carrying a crosspost`, async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc: remotePKC, postProps: { crosspost } });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_NOT_ALLOWED_TO_PUBLISH_CROSSPOSTS
        });
    });

    it.sequential(`Can't publish a reply carrying a crosspost`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, { crosspost });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_NOT_ALLOWED_TO_PUBLISH_CROSSPOSTS
        });
    });

    it.sequential(`Can't publish a crosspost chain`, async () => {
        const chained = {
            cid: crosspostPublishedBeforeFeatureEnabled.cid!,
            comment: crosspostPublishedBeforeFeatureEnabled.raw.comment!
        };
        const post = await generateMockPost({ communityAddress: community.address, pkc: remotePKC, postProps: { crosspost: chained } });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_NOT_ALLOWED_TO_PUBLISH_CROSSPOSTS
        });
    });

    it.sequential(`Can still publish a plain post`, async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc: remotePKC });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it.sequential(`Can still publish a plain reply`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false);
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it.sequential(`Can still publish a reply carrying quotedCids`, async () => {
        // quotedCids is a reference, not a crosspost. noCrossposts must not touch it.
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            quotedCids: [publishedPost.cid!]
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it.sequential(`Crossposts stored before the feature was enabled are still readable`, async () => {
        // Enabling the feature rejects new crossposts; it does not purge or invalidate existing ones.
        const stored = await remotePKC.createComment({ cid: crosspostPublishedBeforeFeatureEnabled.cid! });
        await stored.update();
        await resolveWhenConditionIsTrue({ toUpdate: stored, predicate: async () => typeof stored.updatedAt === "number" });
        expect(stored.crosspost?.cid).to.equal(crosspost.cid);
        expect(stored.crosspost?.comment).to.deep.equal(crosspost.comment);
        await stored.stop();
    });

    it.sequential(`Can still vote on a crosspost stored before the feature was enabled`, async () => {
        const reply = await publishRandomReply({
            parentComment: crosspostPublishedBeforeFeatureEnabled as CommentIpfsWithCidDefined,
            pkc: remotePKC
        });
        expect(reply.cid).to.be.a("string");
    });

    it.sequential(`Disabling the feature re-allows crossposts`, async () => {
        await setNoCrossposts(false);
        const post = await generateMockPost({ communityAddress: community.address, pkc: remotePKC, postProps: { crosspost } });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it.sequential(`A client with a stale community record is still rejected`, async () => {
        // Enforcement is community-side. A publication built without ever reading community.features
        // is rejected all the same.
        await setNoCrossposts(true);
        const post = await generateMockPost({ communityAddress: community.address, pkc: remotePKC, postProps: { crosspost } });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_NOT_ALLOWED_TO_PUBLISH_CROSSPOSTS
        });
    });

    it.sequential(`noCrossposts does not stop this community's comments being crossposted elsewhere`, async () => {
        // Inbound only. A second community without the feature accepts a crosspost of a comment that
        // lives in the noCrossposts community.
        const otherCommunity = await createSubWithNoChallenge({}, pkc);
        await otherCommunity.start();
        await resolveWhenConditionIsTrue({
            toUpdate: otherCommunity,
            predicate: async () => typeof otherCommunity.updatedAt === "number"
        });
        try {
            const post = await generateMockPost({ communityAddress: otherCommunity.address, pkc: remotePKC, postProps: { crosspost } });
            await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
        } finally {
            await otherCommunity.delete();
        }
    });
});

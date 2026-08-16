// Crosspost chain depth (issue #250) — community.features.maxCrosspostDepth.
//
// Like noCrossposts, this is an INBOUND rule enforced by the community at acceptance time: it
// governs what this community accepts, not what other communities may do with this community's
// comments. It sits on `features` rather than `settings` because features is part of the published
// CommunityIpfs, so a publishing client can see the limit instead of discovering it only when the
// challenge exchange rejects the publication.
//
// It can only tighten below MAX_CROSSPOST_DEPTH, never above. The clamp itself is unit-tested in
// test/node-and-browser/crosspost/depth.test.ts, since a chain deeper than the protocol cap cannot
// be built through the public API at all. See docs/protocol/crossposts.md.
import {
    mockPKC,
    createSubWithNoChallenge,
    generateMockPost,
    generateMockComment,
    publishWithExpectedResult,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    publishRandomPost
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined, CommentIpfsType } from "../../../../dist/node/publications/comment/types.js";

describe(`community.features.maxCrosspostDepth`, async () => {
    let pkc: PKC;
    let remotePKC: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let publishedPost: Comment;
    let depthOne: { cid: string; comment: CommentIpfsType }; // embedding this makes a chain of depth 2
    let chainOfDepthTwo: Comment;

    const setMaxCrosspostDepth = async (value: number) => {
        await community.edit({ features: { ...community.features, maxCrosspostDepth: value } });
    };

    // A post carrying `crosspost`, published or expected to be rejected.
    const postCarrying = async (crosspost: { cid: string; comment: CommentIpfsType }) =>
        generateMockPost({ communityAddress: community.address, pkc: remotePKC, postProps: { crosspost } });

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        publishedPost = await publishRandomPost({ communityAddress: community.address, pkc: remotePKC });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it.sequential(`Chains are accepted by default, with no feature set`, async () => {
        expect(community.features?.maxCrosspostDepth).to.be.undefined;

        const crosspost = { cid: publishedPost.cid!, comment: publishedPost.raw.comment! };
        const depthOnePost = await postCarrying(crosspost);
        await publishWithExpectedResult({ publication: depthOnePost, expectedChallengeSuccess: true });
        depthOne = { cid: depthOnePost.cid!, comment: depthOnePost.raw.comment! };

        chainOfDepthTwo = await postCarrying(depthOne);
        await publishWithExpectedResult({ publication: chainOfDepthTwo, expectedChallengeSuccess: true });
        expect(chainOfDepthTwo.crosspost?.comment.crosspost?.cid).to.equal(publishedPost.cid);
    });

    it.sequential(`The feature reaches clients through the published community record`, async () => {
        // The reason it lives on features and not settings: settings never goes on the wire.
        await setMaxCrosspostDepth(1);
        expect(community.features?.maxCrosspostDepth).to.equal(1);

        const remoteCommunity = await remotePKC.createCommunity({ address: community.address });
        await remoteCommunity.update();
        await resolveWhenConditionIsTrue({
            toUpdate: remoteCommunity,
            predicate: async () => remoteCommunity.features?.maxCrosspostDepth === 1
        });
        expect(remoteCommunity.features?.maxCrosspostDepth).to.equal(1);
        await remoteCommunity.stop();
    });

    it.sequential(`A chain at the limit is still accepted`, async () => {
        const post = await postCarrying({ cid: publishedPost.cid!, comment: publishedPost.raw.comment! });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it.sequential(`A chain one level past the limit is rejected`, async () => {
        await publishWithExpectedResult({
            publication: await postCarrying(depthOne),
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_CROSSPOST_CHAIN_EXCEEDS_COMMUNITY_MAX_DEPTH
        });
    });

    it.sequential(`A reply is capped the same way as a post`, async () => {
        // Crossposts are not restricted to one of post/reply, so neither is the cap.
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, { crosspost: depthOne });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_CROSSPOST_CHAIN_EXCEEDS_COMMUNITY_MAX_DEPTH
        });
    });

    it.sequential(`maxCrosspostDepth 0 rejects every crosspost, like noCrossposts`, async () => {
        await setMaxCrosspostDepth(0);
        await publishWithExpectedResult({
            publication: await postCarrying({ cid: publishedPost.cid!, comment: publishedPost.raw.comment! }),
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_CROSSPOST_CHAIN_EXCEEDS_COMMUNITY_MAX_DEPTH
        });
    });

    it.sequential(`A comment carrying no crosspost is untouched by the cap`, async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc: remotePKC });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it.sequential(`Chains stored before the cap was tightened are still readable`, async () => {
        // Tightening rejects new publications; it does not purge or invalidate existing ones.
        const stored = await remotePKC.createComment({ cid: chainOfDepthTwo.cid! });
        await stored.update();
        await resolveWhenConditionIsTrue({ toUpdate: stored, predicate: async () => typeof stored.updatedAt === "number" });
        expect(stored.crosspost?.cid).to.equal(depthOne.cid);
        expect(stored.crosspost?.comment.crosspost?.cid).to.equal(publishedPost.cid);
        await stored.stop();
    });

    it.sequential(`Loosening the cap re-allows deeper chains`, async () => {
        await setMaxCrosspostDepth(2);
        expect(community.features?.maxCrosspostDepth).to.equal(2);
        await publishWithExpectedResult({ publication: await postCarrying(depthOne), expectedChallengeSuccess: true });
    });

    it.sequential(`A client with a stale community record is still rejected`, async () => {
        // Enforcement is community-side. A publication built without ever reading community.features
        // is rejected all the same.
        await setMaxCrosspostDepth(1);
        await publishWithExpectedResult({
            publication: await postCarrying(depthOne),
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_CROSSPOST_CHAIN_EXCEEDS_COMMUNITY_MAX_DEPTH
        });
    });

    it.sequential(`The cap is inbound only: another community still takes chains of this community's comments`, async () => {
        const otherCommunity = await createSubWithNoChallenge({}, pkc);
        await otherCommunity.start();
        await resolveWhenConditionIsTrue({
            toUpdate: otherCommunity,
            predicate: async () => typeof otherCommunity.updatedAt === "number"
        });
        try {
            const post = await generateMockPost({
                communityAddress: otherCommunity.address,
                pkc: remotePKC,
                postProps: { crosspost: depthOne }
            });
            await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
        } finally {
            await otherCommunity.delete();
        }
    });
});

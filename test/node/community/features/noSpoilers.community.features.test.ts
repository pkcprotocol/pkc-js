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
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe.concurrent(`community.features.noSpoilers`, async () => {
    let pkc: PKC;
    let remotePKC: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let publishedPost: Comment;

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        // Publish a post first (before enabling the feature)
        publishedPost = await publishRandomPost({ communityAddress: community.address, pkc: remotePKC });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        expect(community.features).to.be.undefined;
        await community.edit({ features: { ...community.features, noSpoilers: true } });
        expect(community.features?.noSpoilers).to.be.true;

        const remoteCommunity = await remotePKC.getCommunity({ address: community.address });
        await remoteCommunity.update();
        await resolveWhenConditionIsTrue({
            toUpdate: remoteCommunity,
            predicate: async () => remoteCommunity.features?.noSpoilers === true
        });
        expect(remoteCommunity.features?.noSpoilers).to.be.true;
        await remoteCommunity.stop();
    });

    it(`Can't publish a post with spoiler=true`, async () => {
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: {
                content: "Spoiler content",
                spoiler: true
            }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_HAS_SPOILER_ENABLED
        });
    });

    it(`Can't publish a reply with spoiler=true`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            content: "Spoiler reply",
            spoiler: true
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_HAS_SPOILER_ENABLED
        });
    });

    it(`Can publish a post without spoiler`, async () => {
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: {
                content: "Normal content"
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can publish a post with spoiler=false`, async () => {
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: {
                content: "Normal content",
                spoiler: false
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't edit a comment to set spoiler=true`, async () => {
        const commentEdit = await remotePKC.createCommentEdit({
            commentCid: publishedPost.cid!,
            spoiler: true,
            communityAddress: community.address,
            signer: publishedPost.signer
        });
        await publishWithExpectedResult({
            publication: commentEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_HAS_SPOILER_ENABLED
        });
    });
});

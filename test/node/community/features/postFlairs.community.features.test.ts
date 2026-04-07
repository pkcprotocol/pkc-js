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
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe(`community.features.postFlairs`, async () => {
    let pkc: PKC;
    let remotePKC: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let publishedPost: Comment;
    const validPostFlair = { text: "Discussion", backgroundColor: "#0000ff", textColor: "#ffffff" };

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        // Set up allowed post flairs
        await community.edit({ flairs: { post: [validPostFlair] } });

        // Publish a post before enabling the feature
        publishedPost = await publishRandomPost({ communityAddress: community.address, pkc: remotePKC });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it(`Can't publish a post with post flairs when postFlairs feature is disabled (default)`, async () => {
        expect(community.features?.postFlairs).to.be.undefined;
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: {
                flairs: [validPostFlair]
            }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_POST_FLAIRS_NOT_ALLOWED
        });
    });

    it(`Can't publish a reply with post flairs when postFlairs feature is disabled (default)`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            flairs: [validPostFlair]
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_POST_FLAIRS_NOT_ALLOWED
        });
    });

    it(`Can't edit a comment with flairs when postFlairs feature is disabled`, async () => {
        const flairsEdit = await remotePKC.createCommentEdit({
            communityAddress: community.address,
            commentCid: publishedPost.cid,
            flairs: [validPostFlair],
            signer: publishedPost.signer
        });
        await publishWithExpectedResult({
            publication: flairsEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_POST_FLAIRS_NOT_ALLOWED
        });
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        await community.edit({ features: { ...community.features, postFlairs: true } });
        expect(community.features?.postFlairs).to.be.true;
    });

    it(`Can publish a post with valid post flair when feature is enabled`, async () => {
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: {
                flairs: [validPostFlair]
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can publish a reply with valid post flair when feature is enabled`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            flairs: [validPostFlair]
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with invalid post flair (not in allowed list)`, async () => {
        const invalidFlair = { text: "Invalid", backgroundColor: "#ff0000" };
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: {
                flairs: [invalidFlair]
            }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_POST_FLAIR_NOT_IN_ALLOWED_FLAIRS
        });
    });

    it(`Can't publish a post with flair that has wrong colors`, async () => {
        const wrongColorFlair = { text: "Discussion", backgroundColor: "#ff0000", textColor: "#000000" };
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: {
                flairs: [wrongColorFlair]
            }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_POST_FLAIR_NOT_IN_ALLOWED_FLAIRS
        });
    });

    it(`Can edit a comment with valid flair when feature is enabled`, async () => {
        const flairsEdit = await remotePKC.createCommentEdit({
            communityAddress: community.address,
            commentCid: publishedPost.cid,
            flairs: [validPostFlair],
            signer: publishedPost.signer
        });
        await publishWithExpectedResult({ publication: flairsEdit, expectedChallengeSuccess: true });
    });

    it(`Can't edit a comment with invalid flair (not in allowed list)`, async () => {
        const invalidFlair = { text: "Invalid", backgroundColor: "#ff0000" };
        const flairsEdit = await remotePKC.createCommentEdit({
            communityAddress: community.address,
            commentCid: publishedPost.cid,
            flairs: [invalidFlair],
            signer: publishedPost.signer
        });
        await publishWithExpectedResult({
            publication: flairsEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_POST_FLAIR_NOT_IN_ALLOWED_FLAIRS
        });
    });

    it(`Can publish a post without post flairs when feature is enabled`, async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc: remotePKC });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with flair that has extra properties`, async () => {
        const flairWithExtraProps = { text: "Discussion", backgroundColor: "#0000ff", textColor: "#ffffff", expiresAt: 12345 };
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: {
                flairs: [flairWithExtraProps]
            }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_POST_FLAIR_NOT_IN_ALLOWED_FLAIRS
        });
    });

    it(`Can't publish a post with flair that is missing properties`, async () => {
        // validPostFlair has all 3 props, this one only has text
        const flairMissingProps = { text: "Discussion" };
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: {
                flairs: [flairMissingProps]
            }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_POST_FLAIR_NOT_IN_ALLOWED_FLAIRS
        });
    });
});

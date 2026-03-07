import {
    mockPlebbit,
    createSubWithNoChallenge,
    generateMockPost,
    generateMockComment,
    publishWithExpectedResult,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    publishRandomPost
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe(`subplebbit.features.postFlairs`, async () => {
    let plebbit: Plebbit;
    let remotePlebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let publishedPost: Comment;
    const validPostFlair = { text: "Discussion", backgroundColor: "#0000ff", textColor: "#ffffff" };

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        // Set up allowed post flairs
        await subplebbit.edit({ flairs: { post: [validPostFlair] } });

        // Publish a post before enabling the feature
        publishedPost = await publishRandomPost({ subplebbitAddress: subplebbit.address, plebbit: remotePlebbit });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it(`Can't publish a post with post flairs when postFlairs feature is disabled (default)`, async () => {
        expect(subplebbit.features?.postFlairs).to.be.undefined;
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
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
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            flairs: [validPostFlair]
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_POST_FLAIRS_NOT_ALLOWED
        });
    });

    it(`Can't edit a comment with flairs when postFlairs feature is disabled`, async () => {
        const flairsEdit = await remotePlebbit.createCommentEdit({
            subplebbitAddress: subplebbit.address,
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
        await subplebbit.edit({ features: { ...subplebbit.features, postFlairs: true } });
        expect(subplebbit.features?.postFlairs).to.be.true;
    });

    it(`Can publish a post with valid post flair when feature is enabled`, async () => {
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                flairs: [validPostFlair]
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can publish a reply with valid post flair when feature is enabled`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            flairs: [validPostFlair]
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with invalid post flair (not in allowed list)`, async () => {
        const invalidFlair = { text: "Invalid", backgroundColor: "#ff0000" };
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
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
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
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
        const flairsEdit = await remotePlebbit.createCommentEdit({
            subplebbitAddress: subplebbit.address,
            commentCid: publishedPost.cid,
            flairs: [validPostFlair],
            signer: publishedPost.signer
        });
        await publishWithExpectedResult({ publication: flairsEdit, expectedChallengeSuccess: true });
    });

    it(`Can't edit a comment with invalid flair (not in allowed list)`, async () => {
        const invalidFlair = { text: "Invalid", backgroundColor: "#ff0000" };
        const flairsEdit = await remotePlebbit.createCommentEdit({
            subplebbitAddress: subplebbit.address,
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
        const post = await generateMockPost({ subplebbitAddress: subplebbit.address, plebbit: remotePlebbit });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with flair that has extra properties`, async () => {
        const flairWithExtraProps = { text: "Discussion", backgroundColor: "#0000ff", textColor: "#ffffff", expiresAt: 12345 };
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
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
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
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

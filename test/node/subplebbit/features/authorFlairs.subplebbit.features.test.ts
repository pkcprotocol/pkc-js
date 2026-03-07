import {
    mockPlebbit,
    createSubWithNoChallenge,
    describeSkipIfRpc,
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

describe(`subplebbit.features.authorFlairs`, async () => {
    let plebbit: Plebbit;
    let remotePlebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let publishedPost: Comment;
    const validAuthorFlair = { text: "Verified", backgroundColor: "#00ff00", textColor: "#000000" };

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        // Set up allowed author flairs
        await subplebbit.edit({ flairs: { author: [validAuthorFlair] } });

        // Publish a post before enabling the feature
        publishedPost = await publishRandomPost({ subplebbitAddress: subplebbit.address, plebbit: remotePlebbit });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it(`Can't publish a post with author flairs when authorFlairs feature is disabled (default)`, async () => {
        expect(subplebbit.features?.authorFlairs).to.be.undefined;
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                author: { displayName: "Test", flairs: [validAuthorFlair] }
            }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_FLAIRS_NOT_ALLOWED
        });
    });

    it(`Can't publish a reply with author flairs when authorFlairs feature is disabled (default)`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            author: { displayName: "Test", flairs: [validAuthorFlair] }
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_FLAIRS_NOT_ALLOWED
        });
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        await subplebbit.edit({ features: { ...subplebbit.features, authorFlairs: true } });
        expect(subplebbit.features?.authorFlairs).to.be.true;
    });

    it(`Can publish a post with valid author flair when feature is enabled`, async () => {
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                author: { displayName: "Test", flairs: [validAuthorFlair] }
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can publish a reply with valid author flair when feature is enabled`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            author: { displayName: "Test", flairs: [validAuthorFlair] }
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with invalid author flair (not in allowed list)`, async () => {
        const invalidFlair = { text: "Invalid", backgroundColor: "#ff0000" };
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                author: { displayName: "Test", flairs: [invalidFlair] }
            }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_FLAIR_NOT_IN_ALLOWED_FLAIRS
        });
    });

    it(`Can't publish a post with author flair that has wrong colors`, async () => {
        const wrongColorFlair = { text: "Verified", backgroundColor: "#ff0000", textColor: "#ffffff" };
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                author: { displayName: "Test", flairs: [wrongColorFlair] }
            }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_FLAIR_NOT_IN_ALLOWED_FLAIRS
        });
    });

    it(`Can publish a post without author flairs when feature is enabled`, async () => {
        const post = await generateMockPost({ subplebbitAddress: subplebbit.address, plebbit: remotePlebbit });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with author flair that has extra properties`, async () => {
        const flairWithExtraProps = { text: "Verified", backgroundColor: "#00ff00", textColor: "#000000", expiresAt: 12345 };
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                author: { displayName: "Test", flairs: [flairWithExtraProps] }
            }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_FLAIR_NOT_IN_ALLOWED_FLAIRS
        });
    });

    it(`Can't publish a post with author flair that is missing properties`, async () => {
        // validAuthorFlair has all 3 props, this one only has text
        const flairMissingProps = { text: "Verified" };
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                author: { displayName: "Test", flairs: [flairMissingProps] }
            }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_FLAIR_NOT_IN_ALLOWED_FLAIRS
        });
    });
});

describeSkipIfRpc(`subplebbit.features.authorFlairs with pseudonymityMode`, () => {
    let plebbit: Plebbit;
    let remotePlebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let publishedPost: Comment;
    const validAuthorFlair = { text: "Verified", backgroundColor: "#00ff00", textColor: "#000000" };

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        await subplebbit.edit({
            features: { pseudonymityMode: "per-author" },
            flairs: { author: [validAuthorFlair] }
        });
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        publishedPost = await publishRandomPost({ subplebbitAddress: subplebbit.address, plebbit: remotePlebbit });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it(`Author flairs validation is skipped when pseudonymityMode is active (flairs will be stripped)`, async () => {
        // authorFlairs feature is NOT enabled, but pseudonymityMode is active
        // so the flairs will be stripped during anonymization - no need to reject
        expect(subplebbit.features?.authorFlairs).to.be.undefined;
        expect(subplebbit.features?.pseudonymityMode).to.equal("per-author");

        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                author: { displayName: "Test", flairs: [validAuthorFlair] }
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Author flairs validation is skipped for replies when pseudonymityMode is active`, async () => {
        expect(subplebbit.features?.authorFlairs).to.be.undefined;
        expect(subplebbit.features?.pseudonymityMode).to.equal("per-author");

        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            author: { displayName: "Test", flairs: [validAuthorFlair] }
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it.sequential(`requireAuthorFlairs is skipped when pseudonymityMode is active`, async () => {
        // Enable requireAuthorFlairs alongside pseudonymityMode
        await subplebbit.edit({ features: { ...subplebbit.features, authorFlairs: true, requireAuthorFlairs: true } });
        expect(subplebbit.features?.requireAuthorFlairs).to.be.true;
        expect(subplebbit.features?.pseudonymityMode).to.equal("per-author");

        // Publishing without author flairs should succeed because pseudonymityMode
        // would strip them anyway, so requiring them is meaningless
        const post = await generateMockPost({ subplebbitAddress: subplebbit.address, plebbit: remotePlebbit });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });
});

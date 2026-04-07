import {
    mockPKC,
    createSubWithNoChallenge,
    describeSkipIfRpc,
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

describe(`community.features.authorFlairs`, async () => {
    let pkc: PKC;
    let remotePKC: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let publishedPost: Comment;
    const validAuthorFlair = { text: "Verified", backgroundColor: "#00ff00", textColor: "#000000" };

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        // Set up allowed author flairs
        await community.edit({ flairs: { author: [validAuthorFlair] } });

        // Publish a post before enabling the feature
        publishedPost = await publishRandomPost({ communityAddress: community.address, pkc: remotePKC });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it(`Can't publish a post with author flairs when authorFlairs feature is disabled (default)`, async () => {
        expect(community.features?.authorFlairs).to.be.undefined;
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
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
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            author: { displayName: "Test", flairs: [validAuthorFlair] }
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_FLAIRS_NOT_ALLOWED
        });
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        await community.edit({ features: { ...community.features, authorFlairs: true } });
        expect(community.features?.authorFlairs).to.be.true;
    });

    it(`Can publish a post with valid author flair when feature is enabled`, async () => {
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: {
                author: { displayName: "Test", flairs: [validAuthorFlair] }
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can publish a reply with valid author flair when feature is enabled`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            author: { displayName: "Test", flairs: [validAuthorFlair] }
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with invalid author flair (not in allowed list)`, async () => {
        const invalidFlair = { text: "Invalid", backgroundColor: "#ff0000" };
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
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
            communityAddress: community.address,
            pkc: remotePKC,
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
        const post = await generateMockPost({ communityAddress: community.address, pkc: remotePKC });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with author flair that has extra properties`, async () => {
        const flairWithExtraProps = { text: "Verified", backgroundColor: "#00ff00", textColor: "#000000", expiresAt: 12345 };
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
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
            communityAddress: community.address,
            pkc: remotePKC,
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

describeSkipIfRpc(`community.features.authorFlairs with pseudonymityMode`, () => {
    let pkc: PKC;
    let remotePKC: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let publishedPost: Comment;
    const validAuthorFlair = { text: "Verified", backgroundColor: "#00ff00", textColor: "#000000" };

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        community = await createSubWithNoChallenge({}, pkc);
        await community.edit({
            features: { pseudonymityMode: "per-author" },
            flairs: { author: [validAuthorFlair] }
        });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        publishedPost = await publishRandomPost({ communityAddress: community.address, pkc: remotePKC });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it(`Author flairs validation is skipped when pseudonymityMode is active (flairs will be stripped)`, async () => {
        // authorFlairs feature is NOT enabled, but pseudonymityMode is active
        // so the flairs will be stripped during anonymization - no need to reject
        expect(community.features?.authorFlairs).to.be.undefined;
        expect(community.features?.pseudonymityMode).to.equal("per-author");

        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: {
                author: { displayName: "Test", flairs: [validAuthorFlair] }
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Author flairs validation is skipped for replies when pseudonymityMode is active`, async () => {
        expect(community.features?.authorFlairs).to.be.undefined;
        expect(community.features?.pseudonymityMode).to.equal("per-author");

        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            author: { displayName: "Test", flairs: [validAuthorFlair] }
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it.sequential(`requireAuthorFlairs is skipped when pseudonymityMode is active`, async () => {
        // Enable requireAuthorFlairs alongside pseudonymityMode
        await community.edit({ features: { ...community.features, authorFlairs: true, requireAuthorFlairs: true } });
        expect(community.features?.requireAuthorFlairs).to.be.true;
        expect(community.features?.pseudonymityMode).to.equal("per-author");

        // Publishing without author flairs should succeed because pseudonymityMode
        // would strip them anyway, so requiring them is meaningless
        const post = await generateMockPost({ communityAddress: community.address, pkc: remotePKC });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });
});

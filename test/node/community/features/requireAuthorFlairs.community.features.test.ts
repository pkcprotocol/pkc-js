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
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe(`subplebbit.features.requireAuthorFlairs`, async () => {
    let plebbit: PKC;
    let remotePKC: PKC;
    let subplebbit: LocalCommunity | RpcLocalCommunity;
    let publishedPost: CommentIpfsWithCidDefined;
    const validAuthorFlair = { text: "Verified", backgroundColor: "#00ff00", textColor: "#000000" };

    beforeAll(async () => {
        plebbit = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        // Set up allowed author flairs and enable authorFlairs feature first
        await subplebbit.edit({
            flairs: { author: [validAuthorFlair] },
            features: { authorFlairs: true }
        });

        // Publish a post before enabling requireAuthorFlairs (with author flair since authorFlairs is enabled)
        publishedPost = (await publishRandomPost({
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
            postProps: {
                author: { displayName: "Test", flairs: [validAuthorFlair] }
            }
        })) as unknown as CommentIpfsWithCidDefined;
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePKC.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        await subplebbit.edit({ features: { ...subplebbit.features, requireAuthorFlairs: true } });
        expect(subplebbit.features?.requireAuthorFlairs).to.be.true;
    });

    it(`Can't publish a post without author flairs`, async () => {
        const post = await generateMockPost({ communityAddress: subplebbit.address, plebbit: remotePKC });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_FLAIRS_REQUIRED
        });
    });

    it(`Can't publish a reply without author flairs`, async () => {
        const reply = await generateMockComment(publishedPost, remotePKC, false);
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_FLAIRS_REQUIRED
        });
    });

    it(`Can publish a post with valid author flair`, async () => {
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
            postProps: {
                author: { displayName: "Test", flairs: [validAuthorFlair] }
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can publish a reply with valid author flair`, async () => {
        const reply = await generateMockComment(publishedPost, remotePKC, false, {
            author: { displayName: "Test", flairs: [validAuthorFlair] }
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with invalid author flair even when required`, async () => {
        const invalidFlair = { text: "Invalid", backgroundColor: "#ff0000" };
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
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
});

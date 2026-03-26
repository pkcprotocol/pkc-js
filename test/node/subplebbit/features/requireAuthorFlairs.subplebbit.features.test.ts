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
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe(`subplebbit.features.requireAuthorFlairs`, async () => {
    let plebbit: Plebbit;
    let remotePlebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let publishedPost: CommentIpfsWithCidDefined;
    const validAuthorFlair = { text: "Verified", backgroundColor: "#00ff00", textColor: "#000000" };

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
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
            plebbit: remotePlebbit,
            postProps: {
                author: { displayName: "Test", flairs: [validAuthorFlair] }
            }
        })) as unknown as CommentIpfsWithCidDefined;
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        await subplebbit.edit({ features: { ...subplebbit.features, requireAuthorFlairs: true } });
        expect(subplebbit.features?.requireAuthorFlairs).to.be.true;
    });

    it(`Can't publish a post without author flairs`, async () => {
        const post = await generateMockPost({ communityAddress: subplebbit.address, plebbit: remotePlebbit });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_FLAIRS_REQUIRED
        });
    });

    it(`Can't publish a reply without author flairs`, async () => {
        const reply = await generateMockComment(publishedPost, remotePlebbit, false);
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_AUTHOR_FLAIRS_REQUIRED
        });
    });

    it(`Can publish a post with valid author flair`, async () => {
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                author: { displayName: "Test", flairs: [validAuthorFlair] }
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can publish a reply with valid author flair`, async () => {
        const reply = await generateMockComment(publishedPost, remotePlebbit, false, {
            author: { displayName: "Test", flairs: [validAuthorFlair] }
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with invalid author flair even when required`, async () => {
        const invalidFlair = { text: "Invalid", backgroundColor: "#ff0000" };
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
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
});

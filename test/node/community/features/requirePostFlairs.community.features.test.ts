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

describe(`subplebbit.features.requirePostFlairs`, async () => {
    let plebbit: PKC;
    let remotePKC: PKC;
    let subplebbit: LocalCommunity | RpcLocalCommunity;
    let publishedPost: CommentIpfsWithCidDefined;
    const validPostFlair = { text: "Discussion", backgroundColor: "#0000ff", textColor: "#ffffff" };

    beforeAll(async () => {
        plebbit = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        // Set up allowed post flairs and enable postFlairs feature first
        await subplebbit.edit({
            flairs: { post: [validPostFlair] },
            features: { postFlairs: true }
        });

        // Publish a post before enabling requirePostFlairs (with flair since postFlairs is enabled)
        publishedPost = (await publishRandomPost({
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
            postProps: {
                flairs: [validPostFlair]
            }
        })) as unknown as CommentIpfsWithCidDefined;
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePKC.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        await subplebbit.edit({ features: { ...subplebbit.features, requirePostFlairs: true } });
        expect(subplebbit.features?.requirePostFlairs).to.be.true;
    });

    it(`Can't publish a post without post flairs`, async () => {
        const post = await generateMockPost({ communityAddress: subplebbit.address, plebbit: remotePKC });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_POST_FLAIRS_REQUIRED
        });
    });

    it(`Can publish a reply without post flairs (requirePostFlairs only applies to posts)`, async () => {
        const reply = await generateMockComment(publishedPost, remotePKC, false);
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it(`Can publish a post with valid post flair`, async () => {
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
            postProps: {
                flairs: [validPostFlair]
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with invalid post flair even when required`, async () => {
        const invalidFlair = { text: "Invalid", backgroundColor: "#ff0000" };
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
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
});

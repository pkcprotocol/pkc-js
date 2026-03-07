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

describe(`subplebbit.features.requirePostFlairs`, async () => {
    let plebbit: Plebbit;
    let remotePlebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let publishedPost: CommentIpfsWithCidDefined;
    const validPostFlair = { text: "Discussion", backgroundColor: "#0000ff", textColor: "#ffffff" };

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
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
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                flairs: [validPostFlair]
            }
        })) as unknown as CommentIpfsWithCidDefined;
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        await subplebbit.edit({ features: { ...subplebbit.features, requirePostFlairs: true } });
        expect(subplebbit.features?.requirePostFlairs).to.be.true;
    });

    it(`Can't publish a post without post flairs`, async () => {
        const post = await generateMockPost({ subplebbitAddress: subplebbit.address, plebbit: remotePlebbit });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_POST_FLAIRS_REQUIRED
        });
    });

    it(`Can publish a reply without post flairs (requirePostFlairs only applies to posts)`, async () => {
        const reply = await generateMockComment(publishedPost, remotePlebbit, false);
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it(`Can publish a post with valid post flair`, async () => {
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                flairs: [validPostFlair]
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with invalid post flair even when required`, async () => {
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
});

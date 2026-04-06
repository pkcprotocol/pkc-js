import {
    mockPKC,
    createSubWithNoChallenge,
    generateMockPost,
    overrideCommentInstancePropsAndSign,
    publishWithExpectedResult,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";

describe(`subplebbit.features.requirePostLink`, async () => {
    let plebbit: PKC;
    let remotePKC: PKC;
    let subplebbit: LocalCommunity | RpcLocalCommunity;
    beforeAll(async () => {
        plebbit = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePKC.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        expect(subplebbit.features).to.be.undefined;
        await subplebbit.edit({ features: { ...subplebbit.features, requirePostLink: true } });
        expect(subplebbit.features?.requirePostLink).to.be.true;

        const remoteSub = await remotePKC.getCommunity({ address: subplebbit.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({ toUpdate: remoteSub, predicate: async () => remoteSub.features?.requirePostLink === true });

        expect(remoteSub.features?.requirePostLink).to.be.true;
        await remoteSub.stop();
    });

    it(`Can't publish a post with invalid link`, async () => {
        const invalidUrl = "test.com"; // invalid because it has no protocol
        const post = await generateMockPost({ communityAddress: subplebbit.address, plebbit: remotePKC });
        await overrideCommentInstancePropsAndSign(post, { link: invalidUrl } as Parameters<typeof overrideCommentInstancePropsAndSign>[1]);
        expect(post.link).to.equal(invalidUrl);
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_HAS_INVALID_LINK_FIELD
        });
    });
    it(`Can publish a post with valid link`, async () => {
        const validUrl = "https://google.com";
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
            postProps: { link: validUrl }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
        expect(post.link).to.equal(validUrl);
    });
});

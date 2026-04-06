import {
    mockPlebbit,
    createSubWithNoChallenge,
    generateMockPost,
    overrideCommentInstancePropsAndSign,
    publishWithExpectedResult,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/pkc/pkc.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/community/rpc-local-community.js";

describe(`subplebbit.features.requirePostLink`, async () => {
    let plebbit: Plebbit;
    let remotePlebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    beforeAll(async () => {
        plebbit = await mockPlebbit();
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        expect(subplebbit.features).to.be.undefined;
        await subplebbit.edit({ features: { ...subplebbit.features, requirePostLink: true } });
        expect(subplebbit.features?.requirePostLink).to.be.true;

        const remoteSub = await remotePlebbit.getSubplebbit({ address: subplebbit.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({ toUpdate: remoteSub, predicate: async () => remoteSub.features?.requirePostLink === true });

        expect(remoteSub.features?.requirePostLink).to.be.true;
        await remoteSub.stop();
    });

    it(`Can't publish a post with invalid link`, async () => {
        const invalidUrl = "test.com"; // invalid because it has no protocol
        const post = await generateMockPost({ communityAddress: subplebbit.address, plebbit: remotePlebbit });
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
            plebbit: remotePlebbit,
            postProps: { link: validUrl }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
        expect(post.link).to.equal(validUrl);
    });
});

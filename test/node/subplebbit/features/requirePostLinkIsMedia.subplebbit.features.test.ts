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
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/subplebbit/rpc-local-subplebbit.js";

describe.concurrent(`subplebbit.features.requirePostLinkIsMedia (with requirePostLink=true)`, async () => {
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
        await subplebbit.edit({ features: { ...subplebbit.features, requirePostLink: true, requirePostLinkIsMedia: true } });

        expect(subplebbit.features?.requirePostLinkIsMedia).to.be.true;
        expect(subplebbit.features?.requirePostLink).to.be.true;
        const remoteSub = await remotePlebbit.getSubplebbit({ address: subplebbit.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({
            toUpdate: remoteSub,
            predicate: async () => remoteSub.features?.requirePostLinkIsMedia === true
        });
        expect(remoteSub.features?.requirePostLinkIsMedia).to.be.true;
        expect(remoteSub.features?.requirePostLink).to.be.true;
        await remoteSub.stop();
    });

    it(`Can't publish a post with invalid link`, async () => {
        const invalidUrl = "test.com"; // invalid because it has no protocol
        const post = await generateMockPost({ subplebbitAddress: subplebbit.address, plebbit: remotePlebbit });
        await overrideCommentInstancePropsAndSign(post, { link: invalidUrl } as Parameters<typeof overrideCommentInstancePropsAndSign>[1]);
        expect(post.link).to.equal(invalidUrl);
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_POST_LINK_IS_NOT_OF_MEDIA
        });
    });

    it(`Can't publish a post with link that isn't of a media`, async () => {
        const urlOfNotMedia = "https://google.com";
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: { link: urlOfNotMedia }
        });
        expect(post.link).to.equal(urlOfNotMedia);
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_POST_LINK_IS_NOT_OF_MEDIA
        });
    });
    it(`Can publish a post with valid media link`, async () => {
        const validUrl = "https://img1.wsimg.com/isteam/ip/eb02f20b-e787-4a02-b188-d0fcbc250ba1/blob-6af1ead.png";
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: { link: validUrl }
        });
        expect(post.link).to.equal(validUrl);
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
        expect(post.link).to.equal(validUrl);
    });
});

describe.concurrent(`subplebbit.features.requirePostLinkIsMedia (without requirePostLink)`, async () => {
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
        await subplebbit.edit({ features: { ...subplebbit.features, requirePostLinkIsMedia: true } });

        expect(subplebbit.features?.requirePostLinkIsMedia).to.be.true;
        expect(subplebbit.features?.requirePostLink).to.be.undefined;
    });

    it(`Can publish a post without a link`, async () => {
        const post = await generateMockPost({ subplebbitAddress: subplebbit.address, plebbit: remotePlebbit });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with non-media link`, async () => {
        const urlOfNotMedia = "https://google.com";
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: { link: urlOfNotMedia }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_POST_LINK_IS_NOT_OF_MEDIA
        });
    });

    it(`Can publish a post with valid media link`, async () => {
        const validUrl = "https://img1.wsimg.com/isteam/ip/eb02f20b-e787-4a02-b188-d0fcbc250ba1/blob-6af1ead.png";
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: { link: validUrl }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });
});

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

describe.concurrent(`subplebbit.features.requirePostLinkIsMedia (with requirePostLink=true)`, async () => {
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
        await subplebbit.edit({ features: { ...subplebbit.features, requirePostLink: true, requirePostLinkIsMedia: true } });

        expect(subplebbit.features?.requirePostLinkIsMedia).to.be.true;
        expect(subplebbit.features?.requirePostLink).to.be.true;
        const remoteSub = await remotePKC.getCommunity({ address: subplebbit.address });
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
        const post = await generateMockPost({ communityAddress: subplebbit.address, plebbit: remotePKC });
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
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
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
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
            postProps: { link: validUrl }
        });
        expect(post.link).to.equal(validUrl);
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
        expect(post.link).to.equal(validUrl);
    });
});

describe.concurrent(`subplebbit.features.requirePostLinkIsMedia (without requirePostLink)`, async () => {
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
        await subplebbit.edit({ features: { ...subplebbit.features, requirePostLinkIsMedia: true } });

        expect(subplebbit.features?.requirePostLinkIsMedia).to.be.true;
        expect(subplebbit.features?.requirePostLink).to.be.undefined;
    });

    it(`Can publish a post without a link`, async () => {
        const post = await generateMockPost({ communityAddress: subplebbit.address, plebbit: remotePKC });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with non-media link`, async () => {
        const urlOfNotMedia = "https://google.com";
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
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
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
            postProps: { link: validUrl }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });
});

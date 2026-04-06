import {
    mockPlebbit,
    createSubWithNoChallenge,
    generateMockPost,
    generateMockComment,
    overrideCommentInstancePropsAndSign,
    publishWithExpectedResult,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    publishRandomPost
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/pkc/pkc.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe.concurrent(`subplebbit.features.requireReplyLinkIsMedia (with requireReplyLink=true)`, async () => {
    let plebbit: Plebbit;
    let remotePlebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let publishedPost: Comment;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        // Publish a post first (before enabling the feature)
        publishedPost = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: remotePlebbit });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        expect(subplebbit.features).to.be.undefined;
        await subplebbit.edit({ features: { ...subplebbit.features, requireReplyLink: true, requireReplyLinkIsMedia: true } });

        expect(subplebbit.features?.requireReplyLinkIsMedia).to.be.true;
        expect(subplebbit.features?.requireReplyLink).to.be.true;
        const remoteSub = await remotePlebbit.getSubplebbit({ address: subplebbit.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({
            toUpdate: remoteSub,
            predicate: async () => remoteSub.features?.requireReplyLinkIsMedia === true
        });
        expect(remoteSub.features?.requireReplyLinkIsMedia).to.be.true;
        expect(remoteSub.features?.requireReplyLink).to.be.true;
        await remoteSub.stop();
    });

    it(`Can't publish a reply with invalid link`, async () => {
        const invalidUrl = "test.com"; // invalid because it has no protocol
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false);
        await overrideCommentInstancePropsAndSign(reply, { link: invalidUrl } as Parameters<typeof overrideCommentInstancePropsAndSign>[1]);
        expect(reply.link).to.equal(invalidUrl);
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_LINK_IS_NOT_OF_MEDIA
        });
    });

    it(`Can't publish a reply with link that isn't of a media`, async () => {
        const urlOfNotMedia = "https://google.com";
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            link: urlOfNotMedia
        });
        expect(reply.link).to.equal(urlOfNotMedia);
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_LINK_IS_NOT_OF_MEDIA
        });
    });

    it(`Can publish a reply with valid media link`, async () => {
        const validUrl = "https://img1.wsimg.com/isteam/ip/eb02f20b-e787-4a02-b188-d0fcbc250ba1/blob-6af1ead.png";
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            link: validUrl
        });
        expect(reply.link).to.equal(validUrl);
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it(`Can still publish a post without a link`, async () => {
        const post = await generateMockPost({ communityAddress: subplebbit.address, plebbit: remotePlebbit });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });
});

describe.concurrent(`subplebbit.features.requireReplyLinkIsMedia (without requireReplyLink)`, async () => {
    let plebbit: Plebbit;
    let remotePlebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let publishedPost: Comment;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        // Publish a post first (before enabling the feature)
        publishedPost = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: remotePlebbit });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        expect(subplebbit.features).to.be.undefined;
        await subplebbit.edit({ features: { ...subplebbit.features, requireReplyLinkIsMedia: true } });

        expect(subplebbit.features?.requireReplyLinkIsMedia).to.be.true;
        expect(subplebbit.features?.requireReplyLink).to.be.undefined;
    });

    it(`Can publish a reply without a link`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            content: "Just text reply"
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it(`Can't publish a reply with non-media link`, async () => {
        const urlOfNotMedia = "https://google.com";
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            link: urlOfNotMedia
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_LINK_IS_NOT_OF_MEDIA
        });
    });

    it(`Can publish a reply with valid media link`, async () => {
        const validUrl = "https://img1.wsimg.com/isteam/ip/eb02f20b-e787-4a02-b188-d0fcbc250ba1/blob-6af1ead.png";
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            link: validUrl
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });
});

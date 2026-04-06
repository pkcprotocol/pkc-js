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

describe(`subplebbit.features.requireReplyLink`, async () => {
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
        await subplebbit.edit({ features: { ...subplebbit.features, requireReplyLink: true } });
        expect(subplebbit.features?.requireReplyLink).to.be.true;

        const remoteSub = await remotePlebbit.getSubplebbit({ address: subplebbit.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({ toUpdate: remoteSub, predicate: async () => remoteSub.features?.requireReplyLink === true });

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
            expectedReason: messages.ERR_REPLY_HAS_INVALID_LINK_FIELD
        });
    });

    it(`Can't publish a reply without a link`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            content: "Just text reply"
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_HAS_INVALID_LINK_FIELD
        });
    });

    it(`Can publish a reply with valid link`, async () => {
        const validUrl = "https://google.com";
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            link: validUrl
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it(`Can still publish a post without a link`, async () => {
        const post = await generateMockPost({ communityAddress: subplebbit.address, plebbit: remotePlebbit });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });
});

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
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe.concurrent(`community.features.noReplyLinks`, async () => {
    let pkc: PKC;
    let remotePKC: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let publishedPost: Comment;

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        community = await createSubWithNoChallenge({}, pkc);
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        // Publish a post first (before enabling the feature)
        publishedPost = await publishRandomPost({ communityAddress: community.address, pkc: remotePKC });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        expect(community.features).to.be.undefined;
        await community.edit({ features: { ...community.features, noReplyLinks: true } });
        expect(community.features?.noReplyLinks).to.be.true;

        const remoteCommunity = await remotePKC.getCommunity({ address: community.address });
        await remoteCommunity.update();
        await resolveWhenConditionIsTrue({
            toUpdate: remoteCommunity,
            predicate: async () => remoteCommunity.features?.noReplyLinks === true
        });
        expect(remoteCommunity.features?.noReplyLinks).to.be.true;
        await remoteCommunity.stop();
    });

    it(`Can publish a post with link (noReplyLinks only blocks replies)`, async () => {
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: {
                link: "https://example.com/article",
                content: "Just text"
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't publish a reply with a non-media link`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            link: "https://example.com/article"
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_HAS_LINK
        });
    });

    it(`Can't publish a reply with a media link`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            link: "https://example.com/photo.jpg"
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_HAS_LINK
        });
    });

    it(`Can publish a reply without a link`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            content: "Just text reply"
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });
});

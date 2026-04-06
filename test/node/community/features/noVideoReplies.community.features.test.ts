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

describe.concurrent(`subplebbit.features.noVideoReplies`, async () => {
    let plebbit: PKC;
    let remotePKC: PKC;
    let subplebbit: LocalCommunity | RpcLocalCommunity;
    let publishedPost: Comment;

    beforeAll(async () => {
        plebbit = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        // Publish a post first (before enabling the feature)
        publishedPost = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: remotePKC });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePKC.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        expect(subplebbit.features).to.be.undefined;
        await subplebbit.edit({ features: { ...subplebbit.features, noVideoReplies: true } });
        expect(subplebbit.features?.noVideoReplies).to.be.true;

        const remoteSub = await remotePKC.getCommunity({ address: subplebbit.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({ toUpdate: remoteSub, predicate: async () => remoteSub.features?.noVideoReplies === true });
        expect(remoteSub.features?.noVideoReplies).to.be.true;
        await remoteSub.stop();
    });

    it(`Can publish a post with video link (noVideoReplies only blocks replies)`, async () => {
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
            postProps: {
                link: "https://example.com/video.mp4",
                content: "Just text"
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't publish a reply with video link`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            link: "https://example.com/movie.webm"
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_HAS_LINK_THAT_IS_VIDEO
        });
    });

    it(`Can publish a reply without video link`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            content: "Just text reply"
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it(`Can't publish a reply with GIF link`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            link: "https://example.com/animation.gif"
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_HAS_LINK_THAT_IS_VIDEO
        });
    });

    it(`Can publish a reply with image link (noVideoReplies doesn't block images)`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            link: "https://example.com/image.png"
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });
});

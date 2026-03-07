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
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe.concurrent(`subplebbit.features.noVideos`, async () => {
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
        publishedPost = await publishRandomPost({ subplebbitAddress: subplebbit.address, plebbit: remotePlebbit });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        expect(subplebbit.features).to.be.undefined;
        await subplebbit.edit({ features: { ...subplebbit.features, noVideos: true } });
        expect(subplebbit.features?.noVideos).to.be.true;

        const remoteSub = await remotePlebbit.getSubplebbit({ address: subplebbit.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({ toUpdate: remoteSub, predicate: async () => remoteSub.features?.noVideos === true });
        expect(remoteSub.features?.noVideos).to.be.true;
        await remoteSub.stop();
    });

    it(`Can't publish a post with video link`, async () => {
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                link: "https://example.com/video.mp4",
                content: "Just text"
            }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_HAS_LINK_THAT_IS_VIDEO
        });
    });

    it(`Can't publish a reply with video link`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            link: "https://example.com/movie.webm"
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_HAS_LINK_THAT_IS_VIDEO
        });
    });

    it(`Can publish a post with image link (noVideos doesn't block images)`, async () => {
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                link: "https://example.com/image.png",
                content: "Just text"
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with GIF link`, async () => {
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                link: "https://example.com/animation.gif",
                content: "Just text"
            }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_HAS_LINK_THAT_IS_VIDEO
        });
    });

    it(`Can't publish a post with APNG link`, async () => {
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                link: "https://example.com/animation.apng",
                content: "Just text"
            }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_HAS_LINK_THAT_IS_VIDEO
        });
    });

    it(`Can publish a post with plain content (no link)`, async () => {
        const post = await generateMockPost({
            subplebbitAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                content: "Just plain text"
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });
});

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
import type { Plebbit } from "../../../../dist/node/pkc/pkc.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe.concurrent(`subplebbit.features.noMarkdownVideos`, async () => {
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

        // Publish a post first (before enabling the feature) to test comment edits later
        publishedPost = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: remotePlebbit });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        expect(subplebbit.features).to.be.undefined;
        await subplebbit.edit({ features: { ...subplebbit.features, noMarkdownVideos: true } });
        expect(subplebbit.features?.noMarkdownVideos).to.be.true;

        const remoteSub = await remotePlebbit.getSubplebbit({ address: subplebbit.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({ toUpdate: remoteSub, predicate: async () => remoteSub.features?.noMarkdownVideos === true });
        expect(remoteSub.features?.noMarkdownVideos).to.be.true;
        await remoteSub.stop();
    });

    it(`Can't publish a post with markdown video syntax (video extension)`, async () => {
        const contentWithMarkdownVideo = "Here is a video: ![video](https://example.com/video.mp4)";
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: { content: contentWithMarkdownVideo }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_VIDEO
        });
    });

    it(`Can't publish a post with HTML video tag`, async () => {
        const contentWithHtmlVideo = 'Here is a video: <video src="https://example.com/video.mp4"></video>';
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: { content: contentWithHtmlVideo }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_VIDEO
        });
    });

    it(`Can't publish a post with HTML iframe tag`, async () => {
        const contentWithIframe = 'Embedded video: <iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>';
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: { content: contentWithIframe }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_VIDEO
        });
    });

    it(`Can't publish a reply with markdown video`, async () => {
        const contentWithMarkdownVideo = "Reply with video: ![clip](https://example.com/clip.webm)";
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePlebbit, false, {
            content: contentWithMarkdownVideo
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_VIDEO
        });
    });

    it(`Can publish a post with plain text content`, async () => {
        const plainContent = "This is just plain text without any videos";
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: { content: plainContent }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't publish a post with markdown GIF`, async () => {
        const contentWithGif = "Here is a gif: ![gif](https://example.com/animation.gif)";
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: { content: contentWithGif }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_VIDEO
        });
    });

    it(`Can publish a post with markdown image (not video)`, async () => {
        // noMarkdownVideos should not block images
        const contentWithImage = "Here is an image: ![img](https://example.com/photo.jpg)";
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: { content: contentWithImage }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can publish a post with direct link field to video (not markdown content)`, async () => {
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePlebbit,
            postProps: {
                link: "https://example.com/video.mp4",
                content: "Just text"
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't edit a comment to add markdown video`, async () => {
        const contentWithMarkdownVideo = "Edited to include a video: ![vid](https://example.com/new.mp4)";
        const commentEdit = await remotePlebbit.createCommentEdit({
            commentCid: publishedPost.cid!,
            content: contentWithMarkdownVideo,
            communityAddress: subplebbit.address,
            signer: publishedPost.signer
        });
        await publishWithExpectedResult({
            publication: commentEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_VIDEO
        });
    });

    it(`Can't edit a comment to add iframe embed`, async () => {
        const contentWithIframe = 'Edited: <iframe src="https://youtube.com/embed/xyz"></iframe>';
        const commentEdit = await remotePlebbit.createCommentEdit({
            commentCid: publishedPost.cid!,
            content: contentWithIframe,
            communityAddress: subplebbit.address,
            signer: publishedPost.signer
        });
        await publishWithExpectedResult({
            publication: commentEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_VIDEO
        });
    });

    it(`Can edit a comment with plain text content`, async () => {
        const plainContent = "Edited to plain text content";
        const commentEdit = await remotePlebbit.createCommentEdit({
            commentCid: publishedPost.cid!,
            content: plainContent,
            communityAddress: subplebbit.address,
            signer: publishedPost.signer
        });
        await publishWithExpectedResult({ publication: commentEdit, expectedChallengeSuccess: true });
    });
});

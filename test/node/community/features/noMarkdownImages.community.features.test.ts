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

describe.concurrent(`subplebbit.features.noMarkdownImages`, async () => {
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

        // Publish a post first (before enabling the feature) to test comment edits later
        publishedPost = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: remotePKC });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePKC.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        expect(subplebbit.features).to.be.undefined;
        await subplebbit.edit({ features: { ...subplebbit.features, noMarkdownImages: true } });
        expect(subplebbit.features?.noMarkdownImages).to.be.true;

        const remoteSub = await remotePKC.getCommunity({ address: subplebbit.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({ toUpdate: remoteSub, predicate: async () => remoteSub.features?.noMarkdownImages === true });
        expect(remoteSub.features?.noMarkdownImages).to.be.true;
        await remoteSub.stop();
    });

    it(`Can't publish a post with markdown image syntax`, async () => {
        const contentWithMarkdownImage = "Here is some text with an image: ![alt text](https://example.com/image.png)";
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
            postProps: { content: contentWithMarkdownImage }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_IMAGE
        });
    });

    it(`Can't publish a post with HTML img tag`, async () => {
        const contentWithHtmlImg = 'Here is some text with an image: <img src="https://example.com/image.png" />';
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
            postProps: { content: contentWithHtmlImg }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_IMAGE
        });
    });

    it(`Can't publish a reply with markdown image`, async () => {
        const contentWithMarkdownImage = "Reply with image: ![photo](https://example.com/photo.jpg)";
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            content: contentWithMarkdownImage
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_IMAGE
        });
    });

    it(`Can publish a post with plain text content`, async () => {
        const plainContent = "This is just plain text without any images";
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
            postProps: { content: plainContent }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can publish a post with regular markdown link (not image)`, async () => {
        const contentWithLink = "Check out this [link](https://example.com)";
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
            postProps: { content: contentWithLink }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can publish a post with direct link field (not markdown content)`, async () => {
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
            postProps: {
                link: "https://example.com/image.png",
                content: "Just text"
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't edit a comment to add markdown image`, async () => {
        const contentWithMarkdownImage = "Edited to include an image: ![img](https://example.com/new.png)";
        const commentEdit = await remotePKC.createCommentEdit({
            commentCid: publishedPost.cid!,
            content: contentWithMarkdownImage,
            communityAddress: subplebbit.address,
            signer: publishedPost.signer
        });
        await publishWithExpectedResult({
            publication: commentEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_IMAGE
        });
    });

    it(`Can edit a comment with plain text content`, async () => {
        const plainContent = "Edited to plain text content";
        const commentEdit = await remotePKC.createCommentEdit({
            commentCid: publishedPost.cid!,
            content: plainContent,
            communityAddress: subplebbit.address,
            signer: publishedPost.signer
        });
        await publishWithExpectedResult({ publication: commentEdit, expectedChallengeSuccess: true });
    });
});

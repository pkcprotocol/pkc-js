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

describe.concurrent(`community.features.noMarkdownImages`, async () => {
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

        // Publish a post first (before enabling the feature) to test comment edits later
        publishedPost = await publishRandomPost({ communityAddress: community.address, pkc: remotePKC });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        expect(community.features).to.be.undefined;
        await community.edit({ features: { ...community.features, noMarkdownImages: true } });
        expect(community.features?.noMarkdownImages).to.be.true;

        const remoteSub = await remotePKC.getCommunity({ address: community.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({ toUpdate: remoteSub, predicate: async () => remoteSub.features?.noMarkdownImages === true });
        expect(remoteSub.features?.noMarkdownImages).to.be.true;
        await remoteSub.stop();
    });

    it(`Can't publish a post with markdown image syntax`, async () => {
        const contentWithMarkdownImage = "Here is some text with an image: ![alt text](https://example.com/image.png)";
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
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
            communityAddress: community.address,
            pkc: remotePKC,
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
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: { content: plainContent }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can publish a post with regular markdown link (not image)`, async () => {
        const contentWithLink = "Check out this [link](https://example.com)";
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: { content: contentWithLink }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can publish a post with direct link field (not markdown content)`, async () => {
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
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
            communityAddress: community.address,
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
            communityAddress: community.address,
            signer: publishedPost.signer
        });
        await publishWithExpectedResult({ publication: commentEdit, expectedChallengeSuccess: true });
    });
});

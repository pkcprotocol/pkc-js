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

describe.concurrent(`community.features.noMarkdownAudio`, async () => {
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
        await community.edit({ features: { ...community.features, noMarkdownAudio: true } });
        expect(community.features?.noMarkdownAudio).to.be.true;

        const remoteCommunity = await remotePKC.getCommunity({ address: community.address });
        await remoteCommunity.update();
        await resolveWhenConditionIsTrue({
            toUpdate: remoteCommunity,
            predicate: async () => remoteCommunity.features?.noMarkdownAudio === true
        });
        expect(remoteCommunity.features?.noMarkdownAudio).to.be.true;
        await remoteCommunity.stop();
    });

    it(`Can't publish a post with markdown audio syntax (.mp3)`, async () => {
        const contentWithMarkdownAudio = "Here is audio: ![song](https://example.com/song.mp3)";
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: { content: contentWithMarkdownAudio }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_AUDIO
        });
    });

    it(`Can't publish a post with HTML audio tag`, async () => {
        const contentWithHtmlAudio = 'Here is audio: <audio src="https://example.com/song.mp3"></audio>';
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: { content: contentWithHtmlAudio }
        });
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_AUDIO
        });
    });

    it(`Can't publish a reply with markdown audio`, async () => {
        const contentWithMarkdownAudio = "Reply with audio: ![track](https://example.com/track.ogg)";
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            content: contentWithMarkdownAudio
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_AUDIO
        });
    });

    it(`Can publish a post with plain text content`, async () => {
        const plainContent = "This is just plain text without any audio";
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: { content: plainContent }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can publish a post with markdown image (not audio)`, async () => {
        const contentWithImage = "Here is an image: ![img](https://example.com/photo.jpg)";
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: { content: contentWithImage }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can publish a post with direct link field to audio URL (not markdown content)`, async () => {
        const post = await generateMockPost({
            communityAddress: community.address,
            pkc: remotePKC,
            postProps: {
                link: "https://example.com/song.mp3",
                content: "Just text"
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't edit a comment to add markdown audio`, async () => {
        const contentWithMarkdownAudio = "Edited to include audio: ![song](https://example.com/new.mp3)";
        const commentEdit = await remotePKC.createCommentEdit({
            commentCid: publishedPost.cid!,
            content: contentWithMarkdownAudio,
            communityAddress: community.address,
            signer: publishedPost.signer
        });
        await publishWithExpectedResult({
            publication: commentEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_AUDIO
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

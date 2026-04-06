import {
    mockPKC,
    createSubWithNoChallenge,
    generateMockPost,
    generateMockComment,
    publishWithExpectedResult,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    publishRandomPost,
    publishRandomReply
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe.concurrent(`subplebbit.features.noSpoilerReplies`, async () => {
    let plebbit: PKC;
    let remotePKC: PKC;
    let subplebbit: LocalCommunity | RpcLocalCommunity;
    let publishedPost: Comment;
    let publishedReply: Comment;

    beforeAll(async () => {
        plebbit = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        // Publish a post and a reply first (before enabling the feature)
        publishedPost = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: remotePKC });
        publishedReply = await publishRandomReply({ parentComment: publishedPost as CommentIpfsWithCidDefined, plebbit: remotePKC });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePKC.destroy();
    });

    it.sequential(`Feature is updated correctly in props`, async () => {
        expect(subplebbit.features).to.be.undefined;
        await subplebbit.edit({ features: { ...subplebbit.features, noSpoilerReplies: true } });
        expect(subplebbit.features?.noSpoilerReplies).to.be.true;

        const remoteSub = await remotePKC.getCommunity({ address: subplebbit.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({ toUpdate: remoteSub, predicate: async () => remoteSub.features?.noSpoilerReplies === true });
        expect(remoteSub.features?.noSpoilerReplies).to.be.true;
        await remoteSub.stop();
    });

    it(`Can publish a post with spoiler=true (noSpoilerReplies only blocks replies)`, async () => {
        const post = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: remotePKC,
            postProps: {
                content: "Spoiler content",
                spoiler: true
            }
        });
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
    });

    it(`Can't publish a reply with spoiler=true`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            content: "Spoiler reply",
            spoiler: true
        });
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_HAS_SPOILER_ENABLED
        });
    });

    it(`Can publish a reply without spoiler`, async () => {
        const reply = await generateMockComment(publishedPost as CommentIpfsWithCidDefined, remotePKC, false, {
            content: "Normal reply"
        });
        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
    });

    it(`Can't edit a reply to set spoiler=true`, async () => {
        const commentEdit = await remotePKC.createCommentEdit({
            commentCid: publishedReply.cid!,
            spoiler: true,
            communityAddress: subplebbit.address,
            signer: publishedReply.signer
        });
        await publishWithExpectedResult({
            publication: commentEdit,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_HAS_SPOILER_ENABLED
        });
    });

    it(`Can edit a post to set spoiler=true (noSpoilerReplies doesn't affect posts)`, async () => {
        const commentEdit = await remotePKC.createCommentEdit({
            commentCid: publishedPost.cid!,
            spoiler: true,
            communityAddress: subplebbit.address,
            signer: publishedPost.signer
        });
        await publishWithExpectedResult({ publication: commentEdit, expectedChallengeSuccess: true });
    });
});

import signers from "../../../fixtures/signers.js";
import {
    publishRandomPost,
    publishRandomReply,
    iterateThroughPageCidToFindComment,
    generateMockComment,
    generateMockVote,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    getAvailablePKCConfigsToTestAgainst,
    iterateThroughPagesToFindCommentInParentPagesInstance
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import * as remeda from "remeda";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

const communityAddress = signers[8].address;
const roles = [
    { role: "owner", signer: signers[1] },
    { role: "admin", signer: signers[2] },
    { role: "mod", signer: signers[3] }
];

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent("Deleting a post - " + config.name, async () => {
        let pkc: PKC, postToDelete: Comment, modPostToDelete: Comment, postReply: Comment;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            [postToDelete, modPostToDelete] = await Promise.all([
                publishRandomPost({ communityAddress: communityAddress, pkc: pkc }),
                publishRandomPost({ communityAddress: communityAddress, pkc: pkc, postProps: { signer: roles[2].signer } })
            ]);
            postReply = await publishRandomReply({ parentComment: postToDelete as CommentIpfsWithCidDefined, pkc: pkc });
            await postToDelete.update();
            await modPostToDelete.update();
            await postReply.update();
        });

        afterAll(async () => {
            await pkc.destroy();
        });
        it(`Regular author can't mark a post that is not theirs as deleted`, async () => {
            const deleteEdit = await pkc.createCommentEdit({
                communityAddress: postToDelete.communityAddress,
                commentCid: postToDelete.cid,
                deleted: true,
                signer: await pkc.createSigner()
            });
            await publishWithExpectedResult({
                publication: deleteEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_EDIT_CAN_NOT_EDIT_COMMENT_IF_NOT_ORIGINAL_AUTHOR
            });
        });

        it(`Mod can't delete a post that is not theirs`, async () => {
            const deleteEdit = await pkc.createCommentEdit({
                communityAddress: postToDelete.communityAddress,
                commentCid: postToDelete.cid,
                deleted: true,
                signer: roles[2].signer
            });
            await publishWithExpectedResult({
                publication: deleteEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_EDIT_CAN_NOT_EDIT_COMMENT_IF_NOT_ORIGINAL_AUTHOR
            });
        });

        it.sequential(`Author of post can delete their own post`, async () => {
            const deleteEdit = await pkc.createCommentEdit({
                communityAddress: postToDelete.communityAddress,
                commentCid: postToDelete.cid,
                deleted: true,
                signer: postToDelete.signer,
                reason: "To test delete for author"
            });
            await publishWithExpectedResult({ publication: deleteEdit, expectedChallengeSuccess: true });
        });

        it.sequential(`A new CommentUpdate is published with deleted=true for author deleted post`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: postToDelete, predicate: async () => postToDelete.deleted === true });
            expect(postToDelete.deleted).to.be.true;
            expect((postToDelete.raw.commentUpdate as Record<string, unknown>).deleted).to.be.undefined;
            expect(postToDelete.raw.commentUpdate.edit.deleted).to.be.true;
            expect(postToDelete.reason).to.be.undefined; // reason is only for mod
            expect(postToDelete.edit.reason).to.equal("To test delete for author");
            expect(postToDelete.raw.commentUpdate.edit.reason).to.equal("To test delete for author");
            expect(postToDelete.raw.commentUpdate.reason).to.be.undefined;
        });

        it(`Deleted post is omitted from community.posts`, async () => {
            const sub = await pkc.createCommunity({ address: postToDelete.communityAddress });
            await sub.update();

            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const postInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(postToDelete.cid, sub.posts);
                    return postInPage === undefined;
                }
            });

            await sub.stop();

            if (Object.keys(sub.posts.pageCids).length > 0)
                for (const pageCid of Object.values(sub.posts.pageCids) as string[]) {
                    const postInPage = await iterateThroughPageCidToFindComment(postToDelete.cid, pageCid, sub.posts);

                    expect(postInPage).to.be.undefined;
                }
        });

        it(`Can't publish vote on deleted post`, async () => {
            const voteUnderDeletedPost = await generateMockVote(
                postToDelete as CommentIpfsWithCidDefined,
                1,
                pkc,
                remeda.sample(signers, 1)[0]
            );
            await publishWithExpectedResult({
                publication: voteUnderDeletedPost,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_DELETED
            });
        });

        it(`Can't publish reply under deleted post`, async () => {
            const replyUnderDeletedPost = await generateMockComment(postToDelete as CommentIpfsWithCidDefined, pkc, false, {
                signer: remeda.sample(signers, 1)[0]
            });
            await publishWithExpectedResult({
                publication: replyUnderDeletedPost,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_DELETED
            });
        });

        it(`Can't publish a reply under a reply of a deleted post`, async () => {
            const reply = await generateMockComment(postReply as CommentIpfsWithCidDefined, pkc, false, {
                signer: remeda.sample(signers, 1)[0]
            });
            await publishWithExpectedResult({
                publication: reply,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_POST_HAS_BEEN_DELETED
            });
        });

        it(`Can't publish a vote under a reply of a deleted post`, async () => {
            const vote = await generateMockVote(postReply as CommentIpfsWithCidDefined, 1, pkc, remeda.sample(signers, 1)[0]);
            await publishWithExpectedResult({
                publication: vote,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_POST_HAS_BEEN_DELETED
            });
        });
        it.sequential(`Mod can delete their own post`, async () => {
            const deleteEdit = await pkc.createCommentEdit({
                communityAddress: modPostToDelete.communityAddress,
                commentCid: modPostToDelete.cid,
                deleted: true,
                signer: modPostToDelete.signer,
                reason: "For mod to test deleting their own post"
            });
            await publishWithExpectedResult({ publication: deleteEdit, expectedChallengeSuccess: true });
        });

        it.sequential(`A new CommentUpdate is published with deleted=true for mod deleted post`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: modPostToDelete, predicate: async () => modPostToDelete.deleted === true });
            expect(modPostToDelete.deleted).to.be.true;
            expect((modPostToDelete.raw.commentUpdate as Record<string, unknown>).deleted).to.be.undefined;
            expect(modPostToDelete.raw.commentUpdate.edit.deleted).to.be.true;
            expect(modPostToDelete.reason).to.be.undefined; // .reason is for mod editing other authors posts
            expect(modPostToDelete.edit.reason).to.equal("For mod to test deleting their own post");
            expect(modPostToDelete.raw.commentUpdate.edit.reason).to.equal("For mod to test deleting their own post");
            expect(modPostToDelete.raw.commentUpdate.reason).to.be.undefined;
        });

        it(`Author can not undelete their own post`, async () => {
            const undeleteEdit = await pkc.createCommentEdit({
                communityAddress: postToDelete.communityAddress,
                commentCid: postToDelete.cid,
                deleted: false,
                signer: postToDelete.signer,
                reason: "For author to test undelete their own post"
            });
            await publishWithExpectedResult({
                publication: undeleteEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_DELETED
            });
        });

        it(`Mod can not undelete their own post`, async () => {
            const undeleteEdit = await pkc.createCommentEdit({
                communityAddress: modPostToDelete.communityAddress,
                commentCid: modPostToDelete.cid,
                deleted: false,
                signer: modPostToDelete.signer,
                reason: "For mod to test undeleting their own post"
            });
            await publishWithExpectedResult({
                publication: undeleteEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_DELETED
            });
        });
    });

    describe.concurrent("Deleting a reply - " + config.name, async () => {
        let pkc: PKC, replyToDelete: Comment, post: Comment, replyUnderDeletedReply: Comment;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            post = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            replyToDelete = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, pkc: pkc });
            replyUnderDeletedReply = await publishRandomReply({
                parentComment: replyToDelete as CommentIpfsWithCidDefined,
                pkc: pkc
            });
            await Promise.all([replyToDelete.update(), post.update()]);
        });
        afterAll(async () => {
            await post.stop();
            await replyToDelete.stop();
            await pkc.destroy();
        });

        it.sequential(`Author can delete their own reply`, async () => {
            const deleteEdit = await pkc.createCommentEdit({
                communityAddress: replyToDelete.communityAddress,
                commentCid: replyToDelete.cid,
                deleted: true,
                signer: replyToDelete.signer
            });
            await publishWithExpectedResult({ publication: deleteEdit, expectedChallengeSuccess: true });
        });
        it.sequential(`A new CommentUpdate is pushed for removing a reply`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: replyToDelete, predicate: async () => replyToDelete.deleted === true });
            expect(replyToDelete.deleted).to.be.true;
            expect(replyToDelete.reason).to.be.undefined;
        });
        it(`Deleted replies show in parent comment pages with 'deleted' = true`, async () => {
            const parentComment = await pkc.createComment({ cid: replyToDelete.parentCid });
            await parentComment.update();

            await resolveWhenConditionIsTrue({
                toUpdate: parentComment,
                predicate: async () => {
                    const deletedReplyUnderPost = await iterateThroughPagesToFindCommentInParentPagesInstance(
                        replyToDelete.cid,
                        parentComment.replies
                    );
                    return deletedReplyUnderPost?.deleted === true;
                }
            });

            // Need to test for all pages here

            await parentComment.stop();

            for (const pageCid of Object.values(parentComment.replies.pageCids) as string[]) {
                const replyInPage = await iterateThroughPageCidToFindComment(replyToDelete.cid, pageCid, parentComment.replies);
                expect(replyInPage.deleted).to.be.true;
            }
        });

        it(`Can publish a reply or vote under a reply of a deleted reply`, async () => {
            // post
            //   -- replyToDeleted (deleted=true)
            //     -- replyUnderDeletedReply (deleted = false)
            // We're testing publishing under replyUnderDeletedReply
            const [reply, vote] = [
                await generateMockComment(replyUnderDeletedReply as CommentIpfsWithCidDefined, pkc),
                await generateMockVote(replyUnderDeletedReply as CommentIpfsWithCidDefined, 1, pkc)
            ];
            await Promise.all([reply, vote].map((pub) => publishWithExpectedResult({ publication: pub, expectedChallengeSuccess: true })));
        });
    });
});

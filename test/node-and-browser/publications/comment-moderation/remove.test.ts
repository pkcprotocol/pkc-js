import signers from "../../../fixtures/signers.js";
import {
    publishRandomPost,
    publishRandomReply,
    generateMockComment,
    generateMockVote,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    getAvailablePKCConfigsToTestAgainst,
    iterateThroughPagesToFindCommentInParentPagesInstance,
    iterateThroughPageCidToFindComment
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import * as remeda from "remeda";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

const communityAddress = signers[7].address; // this sub is dedicated for removing
const roles = [
    { role: "owner", signer: signers[1] },
    { role: "admin", signer: signers[2] },
    { role: "mod", signer: signers[3] }
];

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`Removing post - ${config.name}`, async () => {
        let pkc: PKC, postToRemove: Comment, postReply: Comment;
        beforeAll(async () => {
            pkc = await config.plebbitInstancePromise();
            postToRemove = await publishRandomPost({
                communityAddress: communityAddress,
                plebbit: pkc,
                postProps: { content: "Post to be removed" }
            });
            postToRemove.on("updatingstatechange", console.log);
            postReply = await publishRandomReply({
                parentComment: postToRemove as CommentIpfsWithCidDefined,
                plebbit: pkc,
                commentProps: {
                    content: "reply under removed post"
                }
            });
            await postToRemove.update();
        });
        afterAll(async () => {
            await pkc.destroy();
        });

        it.sequential(`Mod can mark an author post as removed`, async () => {
            const removeEdit = await pkc.createCommentModeration({
                communityAddress: postToRemove.communityAddress,
                commentCid: postToRemove.cid,
                commentModeration: { reason: "To remove a post", removed: true },
                signer: roles[2].signer // Mod role
            });
            await publishWithExpectedResult({ publication: removeEdit, expectedChallengeSuccess: true });
        });

        it.sequential(`A new CommentUpdate is published with removed=true`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: postToRemove, predicate: async () => postToRemove.removed === true });
            expect(postToRemove.removed).to.be.true;
            expect(postToRemove.reason).to.equal("To remove a post");
            expect(postToRemove.raw.commentUpdate.removed).to.be.true;
            expect(postToRemove.raw.commentUpdate.reason).to.equal("To remove a post");
            expect(postToRemove.raw.commentUpdate.edit).to.be.undefined;
        });
        it(`Removed post don't show in community.posts`, async () => {
            const sub = await pkc.createCommunity({ address: communityAddress });
            await sub.update();

            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const removedPostInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(postToRemove.cid, sub.posts);
                    return removedPostInPage === undefined;
                }
            });

            await sub.stop();

            for (const pageCid of Object.values(sub.posts.pageCids) as string[]) {
                const removedPostInPage = await iterateThroughPageCidToFindComment(postToRemove.cid, pageCid, sub.posts);

                expect(removedPostInPage).to.be.undefined;
            }
        });

        it(`Sub rejects votes on removed post`, async () => {
            const vote = await generateMockVote(postToRemove as CommentIpfsWithCidDefined, 1, pkc, remeda.sample(signers, 1)[0]);
            await publishWithExpectedResult({
                publication: vote,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_REMOVED
            });
        });

        it(`Sub rejects replies on removed post`, async () => {
            const reply = await generateMockComment(postToRemove as CommentIpfsWithCidDefined, pkc, false, {
                signer: remeda.sample(signers, 1)[0]
            });
            await publishWithExpectedResult({
                publication: reply,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_REMOVED
            });
        });

        it(`Sub rejects votes on a reply of a removed post`, async () => {
            const vote = await generateMockVote(postReply as CommentIpfsWithCidDefined, 1, pkc, remeda.sample(signers, 1)[0]);
            await publishWithExpectedResult({
                publication: vote,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_POST_HAS_BEEN_REMOVED
            });
        });

        it(`Sub rejects replies on a reply of a removed post`, async () => {
            const reply = await generateMockComment(postReply as CommentIpfsWithCidDefined, pkc, false, {
                signer: remeda.sample(signers, 1)[0]
            });
            await publishWithExpectedResult({
                publication: reply,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_POST_HAS_BEEN_REMOVED
            });
        });

        it(`Author of post can't remove it`, async () => {
            const postToBeRemoved = await publishRandomPost({ communityAddress: communityAddress, plebbit: pkc });
            const removeEdit = await pkc.createCommentModeration({
                communityAddress: postToBeRemoved.communityAddress,
                commentCid: postToBeRemoved.cid,
                commentModeration: { reason: "To remove a post" + Date.now(), removed: true },
                signer: postToBeRemoved.signer
            });
            await publishWithExpectedResult({
                publication: removeEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_MODERATION_ATTEMPTED_WITHOUT_BEING_MODERATOR
            });
        });

        it.sequential(`Mod can unremove a post`, async () => {
            const unremoveEdit = await pkc.createCommentModeration({
                communityAddress: postToRemove.communityAddress,
                commentCid: postToRemove.cid,
                commentModeration: { reason: "To unremove a post", removed: false },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: unremoveEdit, expectedChallengeSuccess: true });
        });

        it.sequential(`A new CommentUpdate is published for unremoving a post`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: postToRemove, predicate: async () => postToRemove.removed === false });
            expect(postToRemove.removed).to.be.false;
            expect(postToRemove.reason).to.equal("To unremove a post");
            expect(postToRemove.raw.commentUpdate.removed).to.be.false;
            expect(postToRemove.raw.commentUpdate.reason).to.equal("To unremove a post");
            expect(postToRemove.raw.commentUpdate.edit).to.be.undefined;
        });

        it(`Unremoved post is included in community.posts with removed=false`, async () => {
            const sub = await pkc.createCommunity({ address: communityAddress });
            await sub.update();

            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const unremovedPostInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(postToRemove.cid, sub.posts);
                    return Boolean(unremovedPostInPage);
                }
            });

            await sub.stop();

            for (const pageCid of Object.values(sub.posts.pageCids) as string[]) {
                const unremovedPostInPage = await iterateThroughPageCidToFindComment(postToRemove.cid, pageCid, sub.posts);
                expect(unremovedPostInPage).to.exist;
                expect(unremovedPostInPage.removed).to.equal(false);
                expect(unremovedPostInPage.reason).to.equal("To unremove a post");
            }
        });
    });

    describe.concurrent(`Mods removing their own posts - ${config.name}`, async () => {
        let pkc: PKC, modPost: Comment;

        beforeAll(async () => {
            pkc = await config.plebbitInstancePromise();
            modPost = await publishRandomPost({
                communityAddress: communityAddress,
                plebbit: pkc,
                postProps: {
                    signer: roles[2].signer,
                    content: "mod removing their own post"
                }
            });
            await modPost.update();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it.sequential(`Mods can remove their own posts`, async () => {
            const removeEdit = await pkc.createCommentModeration({
                communityAddress: modPost.communityAddress,
                commentCid: modPost.cid,
                commentModeration: { reason: "For mods to remove their own post", removed: true },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: removeEdit, expectedChallengeSuccess: true });
        });

        it.sequential(`A new CommentUpdate is published with removed=true`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: modPost, predicate: async () => modPost.removed === true });
            expect(modPost.removed).to.be.true;
            expect(modPost.raw.commentUpdate.removed).to.be.true;
            expect(modPost.raw.commentUpdate.edit).to.be.undefined;
            expect(modPost.reason).to.equal("For mods to remove their own post");
            expect(modPost.raw.commentUpdate.reason).to.equal("For mods to remove their own post");
        });
    });

    describe.concurrent(`Removing reply`, async () => {
        let pkc: PKC, post: Comment, replyToBeRemoved: Comment, replyUnderRemovedReply: Comment;
        beforeAll(async () => {
            pkc = await config.plebbitInstancePromise();
            post = await publishRandomPost({
                communityAddress: communityAddress,
                plebbit: pkc,
                postProps: { content: "Post with removed reply under it" }
            });
            replyToBeRemoved = await publishRandomReply({
                parentComment: post as CommentIpfsWithCidDefined,
                plebbit: pkc,
                commentProps: { content: "reply to be removed" }
            });
            replyUnderRemovedReply = await publishRandomReply({
                parentComment: replyToBeRemoved as CommentIpfsWithCidDefined,
                plebbit: pkc,
                commentProps: {
                    content: "reply under removed reply"
                }
            });
            await Promise.all([
                replyToBeRemoved.update(),
                post.update(),
                resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => typeof post.updatedAt === "number" })
            ]);
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it.sequential(`Mod can remove a reply`, async () => {
            const removeEdit = await pkc.createCommentModeration({
                communityAddress: replyToBeRemoved.communityAddress,
                commentCid: replyToBeRemoved.cid,
                commentModeration: { reason: "To remove a reply", removed: true },
                signer: roles[2].signer // Mod role
            });
            await publishWithExpectedResult({ publication: removeEdit, expectedChallengeSuccess: true });
        });

        it.sequential(`A new CommentUpdate is published for removing a reply`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: replyToBeRemoved, predicate: async () => replyToBeRemoved.removed === true });
            expect(replyToBeRemoved.removed).to.be.true;
            expect(replyToBeRemoved.reason).to.equal("To remove a reply");
            expect(replyToBeRemoved.raw.commentUpdate.removed).to.be.true;
            expect(replyToBeRemoved.raw.commentUpdate.edit).to.be.undefined;
            expect(replyToBeRemoved.raw.commentUpdate.reason).to.equal("To remove a reply");
        });
        it(`Removed replies show in parent comment pages with 'removed' = true`, async () => {
            const recreatedPost = await pkc.createComment({ cid: post.cid });

            await recreatedPost.update();

            await resolveWhenConditionIsTrue({
                toUpdate: recreatedPost,
                predicate: async () => {
                    const removedReply = await iterateThroughPagesToFindCommentInParentPagesInstance(
                        replyToBeRemoved.cid,
                        recreatedPost.replies
                    );
                    return removedReply?.removed === true;
                }
            });

            await recreatedPost.stop();
            for (const pageCid of Object.values(recreatedPost.replies.pageCids) as string[]) {
                const removedReplyInPage = await iterateThroughPageCidToFindComment(replyToBeRemoved.cid, pageCid, recreatedPost.replies);
                expect(removedReplyInPage).to.exist;
                expect(removedReplyInPage.removed).to.be.true;
                expect(removedReplyInPage.reason).to.equal("To remove a reply");
            }
        });

        it(`Can publish a reply or vote under a reply of a removed reply`, async () => {
            // post
            //   -- replyToBeRemoved (removed=true)
            //     -- replyUnderRemovedReply (removed = false)
            // We're testing publishing under replyUnderRemovedReply
            const [reply, vote] = [
                await generateMockComment(replyUnderRemovedReply as CommentIpfsWithCidDefined, pkc, false, {
                    signer: remeda.sample(signers, 1)[0]
                }),
                await generateMockVote(replyUnderRemovedReply as CommentIpfsWithCidDefined, 1, pkc, remeda.sample(signers, 1)[0])
            ];
            await Promise.all([reply, vote].map((pub) => publishWithExpectedResult({ publication: pub, expectedChallengeSuccess: true })));
        });

        it(`Author can't unremove a reply`, async () => {
            const unremoveEdit = await pkc.createCommentModeration({
                communityAddress: replyToBeRemoved.communityAddress,
                commentCid: replyToBeRemoved.cid,
                commentModeration: { reason: "To unremove a reply by author" + Date.now(), removed: false },
                signer: replyToBeRemoved.signer
            });
            await publishWithExpectedResult({
                publication: unremoveEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_MODERATION_ATTEMPTED_WITHOUT_BEING_MODERATOR
            });
        });
        it.sequential("Mod can unremove a reply", async () => {
            const unremoveEdit = await pkc.createCommentModeration({
                communityAddress: replyToBeRemoved.communityAddress,
                commentCid: replyToBeRemoved.cid,
                commentModeration: { reason: "To unremove a reply", removed: false },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: unremoveEdit, expectedChallengeSuccess: true });
        });

        it.sequential(`A new CommentUpdate is published for unremoving a reply`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: replyToBeRemoved, predicate: async () => replyToBeRemoved.removed === false });
            expect(replyToBeRemoved.removed).to.be.false;
            expect(replyToBeRemoved.reason).to.equal("To unremove a reply");
            expect(replyToBeRemoved.raw.commentUpdate.removed).to.be.false;
            expect(replyToBeRemoved.raw.commentUpdate.edit).to.be.undefined;
            expect(replyToBeRemoved.raw.commentUpdate.reason).to.equal("To unremove a reply");
        });
    });
});

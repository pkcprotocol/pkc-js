import signers from "../../../fixtures/signers.js";
import {
    publishRandomPost,
    generateMockComment,
    generateMockVote,
    publishRandomReply,
    publishWithExpectedResult,
    mockRemotePKC,
    resolveWhenConditionIsTrue,
    getAvailablePKCConfigsToTestAgainst,
    iterateThroughPagesToFindCommentInParentPagesInstance,
    iterateThroughPageCidToFindComment
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";
import type { RemoteCommunity } from "../../../../dist/node/community/remote-community.js";

const communityAddress = signers[11].address;
const roles = [
    { role: "owner", signer: signers[1] },
    { role: "admin", signer: signers[2] },
    { role: "mod", signer: signers[3] }
];

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`Locking posts - ${config.name}`, async () => {
        let pkc: PKC, postToBeLocked: Comment, replyUnderPostToBeLocked: Comment, modPost: Comment, community: RemoteCommunity;
        beforeAll(async () => {
            pkc = await mockRemotePKC();
            community = await pkc.getCommunity({ address: communityAddress });
            await community.update();
            postToBeLocked = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            modPost = await publishRandomPost({
                communityAddress: communityAddress,
                pkc: pkc,
                postProps: { signer: roles[2].signer }
            });

            await postToBeLocked.update();
            replyUnderPostToBeLocked = await publishRandomReply({
                parentComment: postToBeLocked as CommentIpfsWithCidDefined,
                pkc: pkc
            });
            await modPost.update();
        });
        afterAll(async () => {
            await pkc.destroy();
        });
        it(`Author can't lock their own post`, async () => {
            const lockedEdit = await pkc.createCommentModeration({
                communityAddress: postToBeLocked.communityAddress,
                commentCid: postToBeLocked.cid,
                commentModeration: { locked: true },
                signer: postToBeLocked.signer
            });
            await publishWithExpectedResult({
                publication: lockedEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_MODERATION_ATTEMPTED_WITHOUT_BEING_MODERATOR
            });
        });
        it(`Regular author can't lock another author comment`, async () => {
            const lockedEdit = await pkc.createCommentModeration({
                communityAddress: postToBeLocked.communityAddress,
                commentCid: postToBeLocked.cid,
                commentModeration: { locked: true },
                signer: await pkc.createSigner()
            });
            await publishWithExpectedResult({
                publication: lockedEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_MODERATION_ATTEMPTED_WITHOUT_BEING_MODERATOR
            });
        });

        it(`Mod Can't lock a reply`, async () => {
            // This is prior to locking the post
            const lockedEdit = await pkc.createCommentModeration({
                communityAddress: replyUnderPostToBeLocked.communityAddress,
                commentCid: replyUnderPostToBeLocked.cid,
                commentModeration: { locked: true },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({
                publication: lockedEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_COMMENT_MOD_CAN_NOT_LOCK_REPLY
            });
        });

        it.sequential(`Mod can lock an author post`, async () => {
            const lockedEdit = await pkc.createCommentModeration({
                communityAddress: postToBeLocked.communityAddress,
                commentCid: postToBeLocked.cid,
                commentModeration: { locked: true, reason: "To lock an author post" },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: lockedEdit, expectedChallengeSuccess: true });
        });

        it.sequential(`A new CommentUpdate with locked=true is published`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: postToBeLocked, predicate: async () => postToBeLocked.locked === true });
            expect(postToBeLocked.locked).to.be.true;
            expect(postToBeLocked.reason).to.equal("To lock an author post");
            expect(postToBeLocked.raw.commentUpdate.reason).to.equal("To lock an author post");
            expect(postToBeLocked.raw.commentUpdate.locked).to.be.true;
            expect(postToBeLocked.raw.commentUpdate.edit).to.be.undefined;
        });

        it(`community.posts includes locked post with locked=true`, async () => {
            const community = await pkc.createCommunity({ address: postToBeLocked.communityAddress });

            await community.update();

            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => {
                    const lockedPostInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(
                        postToBeLocked.cid,
                        community.posts
                    );
                    return lockedPostInPage?.locked === true;
                }
            });

            await community.stop();

            for (const pageCid of Object.values(community.posts.pageCids) as string[]) {
                const lockedPostInPage = await iterateThroughPageCidToFindComment(postToBeLocked.cid, pageCid, community.posts);
                expect(lockedPostInPage.locked).to.be.true;
                expect(lockedPostInPage.reason).to.equal("To lock an author post");
            }
        });

        it(`locked=true for author post when it's locked by mod in pages of community`, async () => {
            const community = await pkc.createCommunity({ address: postToBeLocked.communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => {
                    const postInCommunityPage = await iterateThroughPagesToFindCommentInParentPagesInstance(
                        postToBeLocked.cid,
                        community.posts
                    );
                    return postInCommunityPage?.locked === true;
                }
            });
            const postInCommunityPage = await iterateThroughPagesToFindCommentInParentPagesInstance(postToBeLocked.cid, community.posts);
            expect(postInCommunityPage.locked).to.be.true;
            expect(postInCommunityPage.reason).to.equal("To lock an author post");
            await community.stop();
        });

        it.sequential(`Mod can lock their own post`, async () => {
            const lockedEdit = await pkc.createCommentModeration({
                communityAddress: modPost.communityAddress,
                commentCid: modPost.cid,
                commentModeration: { locked: true, reason: "To lock a mod post" },
                signer: modPost.signer
            });
            await publishWithExpectedResult({ publication: lockedEdit, expectedChallengeSuccess: true });
        });

        it.sequential(`A new CommentUpdate with locked=true is published`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: modPost, predicate: async () => modPost.locked === true });
            expect(modPost.locked).to.be.true;
            expect(modPost.reason).to.equal("To lock a mod post");
            expect(modPost.raw.commentUpdate.reason).to.equal("To lock a mod post");
            expect(postToBeLocked.raw.commentUpdate.locked).to.be.true;
            expect(postToBeLocked.raw.commentUpdate.edit).to.be.undefined;
        });

        it(`locked=true for mod post when it's locked by mod in getPage of community`, async () => {
            const community = await pkc.createCommunity({ address: modPost.communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => {
                    const postInCommunityPage = await iterateThroughPagesToFindCommentInParentPagesInstance(modPost.cid, community.posts);
                    return postInCommunityPage?.locked === true;
                }
            });
            const postInCommunityPage = await iterateThroughPagesToFindCommentInParentPagesInstance(modPost.cid, community.posts);
            expect(postInCommunityPage.locked).to.be.true;
            await community.stop();
        });

        it(`Can't publish a reply on a locked post`, async () => {
            const comment = await generateMockComment(postToBeLocked as CommentIpfsWithCidDefined, pkc, false);
            await publishWithExpectedResult({
                publication: comment,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_POST_IS_LOCKED
            });
        });

        it(`Can't vote on a locked post`, async () => {
            const vote = await generateMockVote(postToBeLocked as CommentIpfsWithCidDefined, 1, pkc);
            await publishWithExpectedResult({
                publication: vote,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_POST_IS_LOCKED
            });
        });

        it(`Can't vote on a reply of a locked post`, async () => {
            const vote = await generateMockVote(replyUnderPostToBeLocked as CommentIpfsWithCidDefined, 1, pkc);
            await publishWithExpectedResult({
                publication: vote,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_POST_IS_LOCKED
            });
        });

        it(`Can't reply on a reply of a locked post`, async () => {
            const reply = await generateMockComment(replyUnderPostToBeLocked as CommentIpfsWithCidDefined, pkc);
            await publishWithExpectedResult({
                publication: reply,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_POST_IS_LOCKED
            });
        });

        it.sequential(`Mod can unlock a post`, async () => {
            const unlockEdit = await pkc.createCommentModeration({
                communityAddress: postToBeLocked.communityAddress,
                commentCid: postToBeLocked.cid,
                commentModeration: { locked: false, reason: "To unlock an author post" },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: unlockEdit, expectedChallengeSuccess: true });
        });

        it.sequential(`A new CommentUpdate with locked=false is published`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: postToBeLocked, predicate: async () => postToBeLocked.locked === false });
            expect(postToBeLocked.locked).to.be.false;
            expect(postToBeLocked.reason).to.equal("To unlock an author post");
            expect(postToBeLocked.raw.commentUpdate.reason).to.equal("To unlock an author post");
            expect(postToBeLocked.raw.commentUpdate.locked).to.be.false;
            expect(postToBeLocked.raw.commentUpdate.edit).to.be.undefined;
        });

        it(`locked=false in getPage of community after the mod unlocks it`, async () => {
            const community = await pkc.createCommunity({ address: postToBeLocked.communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => {
                    const postInCommunityPage = await iterateThroughPagesToFindCommentInParentPagesInstance(
                        postToBeLocked.cid,
                        community.posts
                    );
                    return postInCommunityPage?.locked === false;
                }
            });
            const postInCommunityPage = await iterateThroughPagesToFindCommentInParentPagesInstance(postToBeLocked.cid, community.posts);
            expect(postInCommunityPage.locked).to.be.false;
            await community.stop();
        });

        it(`Unlocked post can receive replies`, async () => {
            const reply = await generateMockComment(replyUnderPostToBeLocked as CommentIpfsWithCidDefined, pkc);
            await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
        });
        it(`Unlocked post can receive votes `, async () => {
            const vote = await generateMockVote(replyUnderPostToBeLocked as CommentIpfsWithCidDefined, 1, pkc);
            await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true });
        });
    });
});

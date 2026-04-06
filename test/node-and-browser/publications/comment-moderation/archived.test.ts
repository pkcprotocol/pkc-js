import signers from "../../../fixtures/signers.js";
import {
    publishRandomPost,
    generateMockComment,
    generateMockVote,
    publishRandomReply,
    publishWithExpectedResult,
    mockRemotePlebbit,
    resolveWhenConditionIsTrue,
    getAvailablePlebbitConfigsToTestAgainst,
    iterateThroughPagesToFindCommentInParentPagesInstance,
    iterateThroughPageCidToFindComment
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";
import type { RemoteSubplebbit } from "../../../../dist/node/subplebbit/remote-subplebbit.js";

const subplebbitAddress = signers[11].address;
const roles = [
    { role: "owner", signer: signers[1] },
    { role: "admin", signer: signers[2] },
    { role: "mod", signer: signers[3] }
];

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.concurrent(`Archiving posts - ${config.name}`, async () => {
        let plebbit: Plebbit, postToBeArchived: Comment, replyUnderPostToBeArchived: Comment, sub: RemoteSubplebbit;
        beforeAll(async () => {
            plebbit = await mockRemotePlebbit();
            sub = await plebbit.getSubplebbit({ address: subplebbitAddress });
            await sub.update();
            postToBeArchived = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });

            await postToBeArchived.update();
            replyUnderPostToBeArchived = await publishRandomReply({
                parentComment: postToBeArchived as CommentIpfsWithCidDefined,
                plebbit: plebbit
            });
        });
        afterAll(async () => {
            await plebbit.destroy();
        });
        it(`Author can't archive their own post`, async () => {
            const archivedEdit = await plebbit.createCommentModeration({
                communityAddress: postToBeArchived.communityAddress,
                commentCid: postToBeArchived.cid,
                commentModeration: { archived: true },
                signer: postToBeArchived.signer
            });
            await publishWithExpectedResult({
                publication: archivedEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_MODERATION_ATTEMPTED_WITHOUT_BEING_MODERATOR
            });
        });
        it(`Regular author can't archive another author comment`, async () => {
            const archivedEdit = await plebbit.createCommentModeration({
                communityAddress: postToBeArchived.communityAddress,
                commentCid: postToBeArchived.cid,
                commentModeration: { archived: true },
                signer: await plebbit.createSigner()
            });
            await publishWithExpectedResult({
                publication: archivedEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_MODERATION_ATTEMPTED_WITHOUT_BEING_MODERATOR
            });
        });

        it(`Mod Can't archive a reply`, async () => {
            const archivedEdit = await plebbit.createCommentModeration({
                communityAddress: replyUnderPostToBeArchived.communityAddress,
                commentCid: replyUnderPostToBeArchived.cid,
                commentModeration: { archived: true },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({
                publication: archivedEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_COMMENT_MOD_CAN_NOT_ARCHIVE_REPLY
            });
        });

        it.sequential(`Mod can archive an author post`, async () => {
            const archivedEdit = await plebbit.createCommentModeration({
                communityAddress: postToBeArchived.communityAddress,
                commentCid: postToBeArchived.cid,
                commentModeration: { archived: true, reason: "To archive an author post" },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: archivedEdit, expectedChallengeSuccess: true });
        });

        it.sequential(`A new CommentUpdate with archived=true is published`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: postToBeArchived, predicate: async () => postToBeArchived.archived === true });
            expect(postToBeArchived.archived).to.be.true;
            expect(postToBeArchived.reason).to.equal("To archive an author post");
            expect(postToBeArchived.raw.commentUpdate.reason).to.equal("To archive an author post");
            expect(postToBeArchived.raw.commentUpdate.archived).to.be.true;
            expect(postToBeArchived.raw.commentUpdate.edit).to.be.undefined;
        });

        it(`subplebbit.posts includes archived post with archived=true`, async () => {
            const sub = await plebbit.createSubplebbit({ address: postToBeArchived.communityAddress });

            await sub.update();

            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const archivedPostInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(postToBeArchived.cid, sub.posts);
                    return archivedPostInPage?.archived === true;
                }
            });

            await sub.stop();

            for (const pageCid of Object.values(sub.posts.pageCids) as string[]) {
                const archivedPostInPage = await iterateThroughPageCidToFindComment(postToBeArchived.cid, pageCid, sub.posts);
                expect(archivedPostInPage.archived).to.be.true;
                expect(archivedPostInPage.reason).to.equal("To archive an author post");
            }
        });

        it(`Can't publish a reply on an archived post`, async () => {
            const comment = await generateMockComment(postToBeArchived as CommentIpfsWithCidDefined, plebbit, false);
            await publishWithExpectedResult({
                publication: comment,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_POST_IS_ARCHIVED
            });
        });

        it(`Can't vote on an archived post`, async () => {
            const vote = await generateMockVote(postToBeArchived as CommentIpfsWithCidDefined, 1, plebbit);
            await publishWithExpectedResult({
                publication: vote,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_POST_IS_ARCHIVED
            });
        });

        it(`Can't vote on a reply of an archived post`, async () => {
            const vote = await generateMockVote(replyUnderPostToBeArchived as CommentIpfsWithCidDefined, 1, plebbit);
            await publishWithExpectedResult({
                publication: vote,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_POST_IS_ARCHIVED
            });
        });

        it(`Can't reply on a reply of an archived post`, async () => {
            const reply = await generateMockComment(replyUnderPostToBeArchived as CommentIpfsWithCidDefined, plebbit);
            await publishWithExpectedResult({
                publication: reply,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_PUBLICATION_POST_IS_ARCHIVED
            });
        });

        it.sequential(`Mod can unarchive a post`, async () => {
            const unarchiveEdit = await plebbit.createCommentModeration({
                communityAddress: postToBeArchived.communityAddress,
                commentCid: postToBeArchived.cid,
                commentModeration: { archived: false, reason: "To unarchive an author post" },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: unarchiveEdit, expectedChallengeSuccess: true });
        });

        it.sequential(`A new CommentUpdate with archived=false is published`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: postToBeArchived, predicate: async () => postToBeArchived.archived === false });
            expect(postToBeArchived.archived).to.be.false;
            expect(postToBeArchived.reason).to.equal("To unarchive an author post");
            expect(postToBeArchived.raw.commentUpdate.reason).to.equal("To unarchive an author post");
            expect(postToBeArchived.raw.commentUpdate.archived).to.be.false;
            expect(postToBeArchived.raw.commentUpdate.edit).to.be.undefined;
        });

        it(`Unarchived post can receive replies`, async () => {
            const reply = await generateMockComment(replyUnderPostToBeArchived as CommentIpfsWithCidDefined, plebbit);
            await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
        });
        it(`Unarchived post can receive votes`, async () => {
            const vote = await generateMockVote(replyUnderPostToBeArchived as CommentIpfsWithCidDefined, 1, plebbit);
            await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true });
        });
    });
});

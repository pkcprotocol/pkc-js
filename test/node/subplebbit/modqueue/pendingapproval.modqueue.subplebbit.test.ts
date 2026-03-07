// comment.pendingApproval should not appear in postUpdates
// comments with pendingApproval should not show up in comment.replies, post.replies, subplebbit.posts

import {
    mockPlebbit,
    publishWithExpectedResult,
    processAllCommentsRecursively,
    resolveWhenConditionIsTrue,
    loadAllPages,
    getCommentWithCommentUpdateProps,
    mockGatewayPlebbit,
    publishRandomPost,
    forceLocalSubPagesToAlwaysGenerateMultipleChunks,
    publishToModQueueWithDepth,
    generateMockVote,
    generateMockComment,
    itSkipIfRpc,
    createPendingApprovalChallenge,
    describeSkipIfRpc
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit as PlebbitType } from "../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { SignerType } from "../../../../dist/node/signer/types.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";
import type { DecryptedChallengeVerificationMessageType } from "../../../../dist/node/pubsub-messages/types.js";

const depthsToTest = [0, 1, 2, 3, 10];
const pendingApprovalCommentProps = { challengeRequest: { challengeAnswers: ["pending"] } }; // this should get comment to be successful with challenge, thus sending it to modqueue

for (const commentInPendingApprovalDepth of depthsToTest) {
    // made it sequential because maybe it can stop failing in CI
    describeSkipIfRpc.sequential(`Pending approval of comments with depth ` + commentInPendingApprovalDepth, async () => {
        let plebbit: PlebbitType;
        let remotePlebbit: PlebbitType;
        let commentInPendingApproval: Comment;
        let modSigner: SignerType;
        let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;

        beforeAll(async () => {
            plebbit = await mockPlebbit();
            remotePlebbit = await mockGatewayPlebbit();
            subplebbit = (await plebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
            subplebbit.setMaxListeners(100);
            modSigner = await plebbit.createSigner();
            await subplebbit.edit({
                settings: { challenges: [createPendingApprovalChallenge()] },
                roles: {
                    [modSigner.address]: { role: "moderator" }
                }
            });

            await subplebbit.start();

            await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
        });

        afterAll(async () => {
            await subplebbit.delete();
            await plebbit.destroy();
            await remotePlebbit.destroy();
        });

        it.sequential("Should put failed comment in pending approval queue when challenge has pendingApproval: true", async () => {
            // TODO: Test that when a challenge with pendingApproval fails,
            // the publication goes to pending approval instead of being rejected
            await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

            const { comment, challengeVerification } = await publishToModQueueWithDepth({
                subplebbit,
                plebbit: remotePlebbit,
                depth: commentInPendingApprovalDepth,
                modCommentProps: { signer: modSigner },
                commentProps: pendingApprovalCommentProps
            });

            commentInPendingApproval = comment;

            const cv = challengeVerification as DecryptedChallengeVerificationMessageType;

            expect(comment.publishingState).to.equal("succeeded");
            expect(comment.cid).to.be.a("string");
            expect(cv.commentUpdate!.pendingApproval).to.be.true;
            expect(cv.commentUpdate!.number).to.be.undefined;
            expect(cv.commentUpdate!.postNumber).to.be.undefined;
            expect(comment.number).to.be.undefined;
            expect(comment.postNumber).to.be.undefined;
            expect(Object.keys(cv.commentUpdate!).sort()).to.deep.equal([
                "author",
                "cid",
                "pendingApproval",
                "protocolVersion",
                "signature"
            ]);
        });

        it.sequential("Should store pending approval comments in subplebbit.modQueue.pageCids.pendingApproval", async () => {
            // TODO: Test that pending comments are stored in correct location
            await resolveWhenConditionIsTrue({
                toUpdate: subplebbit,
                predicate: async () => Boolean(subplebbit.modQueue.pageCids?.pendingApproval)
            });
            const page = await subplebbit.modQueue.getPage({ cid: subplebbit.modQueue.pageCids.pendingApproval! });
            expect(page.comments.length).to.equal(1);
            const commentInPendingApprovalInPage = page.comments[0];
            expect(commentInPendingApprovalInPage.cid).to.equal(commentInPendingApproval.cid);
            // @ts-expect-error - updatedAt is not defined in CommentWithinModQueuePageJson
            expect(commentInPendingApprovalInPage.updatedAt).to.be.undefined;
            expect(commentInPendingApprovalInPage.pendingApproval).to.be.true;
        });

        if (commentInPendingApprovalDepth === 0)
            it(`pending post should not have postCid defined at its pages`, async () => {
                const pageRaw = JSON.parse(await plebbit.fetchCid({ cid: subplebbit.modQueue.pageCids?.pendingApproval! }));
                expect(pageRaw.comments[0].comment.postCid).to.be.undefined;
            });

        it(`pending comment should not appear in subplebbit.lastPostCid or subplebbit.lastCommentCid`, async () => {
            expect(subplebbit.lastPostCid).to.not.equal(commentInPendingApproval.cid);
            expect(subplebbit.lastCommentCid).to.not.equal(commentInPendingApproval.cid);
        });

        if (commentInPendingApprovalDepth === 0)
            it(`pending post should not appear in subplebbit.postUpdates`, async () => {
                expect(subplebbit.postUpdates).to.be.undefined;
            });

        it.sequential("pending approval comments do not affect number/postNumber for later approved posts", async () => {
            const approvedPost = await publishRandomPost({
                subplebbitAddress: subplebbit.address,
                plebbit: remotePlebbit,
                postProps: { signer: modSigner }
            });
            const approvedPostWithUpdate = await getCommentWithCommentUpdateProps({ cid: approvedPost.cid!, plebbit });
            const expectedCommentNumber = commentInPendingApprovalDepth + 1;
            const expectedPostNumber = commentInPendingApprovalDepth === 0 ? 1 : 2;

            expect(approvedPostWithUpdate.number).to.equal(expectedCommentNumber);
            expect(approvedPostWithUpdate.postNumber).to.equal(expectedPostNumber);
        });

        it(`Should not be able to publish a vote under a pending comment`, async () => {
            const vote = await generateMockVote(commentInPendingApproval as CommentIpfsWithCidDefined, 1, plebbit);
            await publishWithExpectedResult({
                publication: vote,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_USER_PUBLISHED_UNDER_PENDING_COMMENT
            });
        });
        it(`should not be able to publish a CommentEdit under a pending comment`, async () => {
            const edit = await plebbit.createCommentEdit({
                subplebbitAddress: commentInPendingApproval.subplebbitAddress,
                commentCid: commentInPendingApproval.cid!,
                reason: "random reason should fail",
                content: "text to edit on pending comment",
                signer: commentInPendingApproval.signer
            });
            await publishWithExpectedResult({
                publication: edit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_USER_PUBLISHED_UNDER_PENDING_COMMENT
            });
        });
        it(`Should not be able to publish a reply under a pending comment`, async () => {
            const reply = await generateMockComment(commentInPendingApproval as CommentIpfsWithCidDefined, plebbit, false);
            await publishWithExpectedResult({
                publication: reply,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_USER_PUBLISHED_UNDER_PENDING_COMMENT
            });
        });

        itSkipIfRpc(`Pending comment should not be pinned in ipfs node`, async () => {
            const kuboRpc = Object.values(plebbit.clients.kuboRpcClients)[0]._client;

            // Collect all pinned CIDs
            for await (const pin of kuboRpc.pin.ls()) {
                expect(pin.cid.toString()).to.not.equal(commentInPendingApproval.cid); // pending comment should not be pinned in kubo
            }
        });

        if (commentInPendingApprovalDepth > 0) {
            it.sequential(`pending approval reply does not show up in parentComment.replyCount`, async () => {
                expect((await getCommentWithCommentUpdateProps({ cid: commentInPendingApproval.parentCid!, plebbit })).replyCount).to.equal(
                    0
                );
            });

            it.sequential(`pending approval reply does not show up in parentComment.childCount`, async () => {
                expect((await getCommentWithCommentUpdateProps({ cid: commentInPendingApproval.parentCid!, plebbit })).childCount).to.equal(
                    0
                );
            });

            it.sequential(`pending approval reply does not show up in parentComment.lastChildCid`, async () => {
                expect((await getCommentWithCommentUpdateProps({ cid: commentInPendingApproval.parentCid!, plebbit })).lastChildCid).to.be
                    .undefined;
            });
            it.sequential(`pending approval reply does not show up in parentComment.lastReplyTimestamp`, async () => {
                expect((await getCommentWithCommentUpdateProps({ cid: commentInPendingApproval.parentCid!, plebbit })).lastReplyTimestamp)
                    .to.be.undefined;
            });
        }
        if (commentInPendingApprovalDepth === 0)
            it.sequential(`pending approval post does not show up in subplebbit.lastPostCid`, async () => {
                expect(subplebbit.lastPostCid).to.not.equal(commentInPendingApproval.cid);
            });

        it.sequential(`pending approval comment does not show up in subplebbit.lastCommentCid`, async () => {
            expect(subplebbit.lastCommentCid).to.not.equal(commentInPendingApproval.cid);
        });

        it.sequential(`A pending approval comment will not show up in subplebbit.posts`, async () => {
            let foundInPosts = false;
            processAllCommentsRecursively(subplebbit.posts.pages.hot?.comments || [], (comment) => {
                if (comment.cid === commentInPendingApproval.cid) {
                    foundInPosts = true;
                    return;
                }
            });
            expect(foundInPosts).to.be.false;

            await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
                subplebbit,
                subplebbitPostsCommentProps: { signer: modSigner, subplebbitAddress: subplebbit.address }
            }); // the goal of this is to force the subplebbit.posts to have all pages and page.cids

            expect(subplebbit.posts.pageCids).to.not.deep.equal({}); // should not be empty

            for (const pageCid of Object.values(subplebbit.posts.pageCids)) {
                const pageComments = await loadAllPages(pageCid, subplebbit.posts);
                expect(pageComments.length).to.be.greaterThan(0);

                processAllCommentsRecursively(pageComments, (comment) => {
                    if (comment.cid === commentInPendingApproval.cid) {
                        foundInPosts = true;
                        return;
                    }
                });
                expect(foundInPosts).to.be.false;
            }
        });

        if (commentInPendingApprovalDepth > 0)
            itSkipIfRpc.sequential("A pending approval comment will not show up in parentComment.replies", async () => {
                const parentComment = await plebbit.getComment({ cid: commentInPendingApproval.parentCid! });
                await parentComment.update();
                await resolveWhenConditionIsTrue({ toUpdate: parentComment, predicate: async () => Boolean(parentComment.updatedAt) });
                let foundInReplies = false;
                processAllCommentsRecursively(parentComment.replies.pages.best?.comments || [], (comment) => {
                    if (comment.cid === commentInPendingApproval.cid) {
                        foundInReplies = true;
                        return;
                    }
                });
                expect(foundInReplies).to.be.false;

                const { cleanup } = await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
                    subplebbit,
                    parentComment,
                    parentCommentReplyProps: { signer: modSigner }
                });
                try {
                    expect(parentComment.replies.pageCids).to.not.deep.equal({}); // should not be empty

                    for (const pageCid of Object.values(parentComment.replies.pageCids)) {
                        const pageComments = await loadAllPages(pageCid, parentComment.replies);

                        expect(pageComments.length).to.be.greaterThan(0);
                        processAllCommentsRecursively(pageComments, (comment) => {
                            if (comment.cid === commentInPendingApproval.cid) {
                                foundInReplies = true;
                                return;
                            }
                        });
                        expect(foundInReplies).to.be.false;
                    }
                } finally {
                    cleanup();
                }
                await parentComment.stop();
            });
        if (commentInPendingApprovalDepth > 0)
            itSkipIfRpc.sequential(`A pending approval comment will not show up in flat pages of post`, async () => {
                const postComment = await plebbit.getComment({ cid: commentInPendingApproval.postCid! });
                await postComment.update();
                await resolveWhenConditionIsTrue({ toUpdate: postComment, predicate: async () => Boolean(postComment.updatedAt) });
                const { cleanup } = await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
                    subplebbit,
                    parentComment: postComment,
                    parentCommentReplyProps: { signer: modSigner }
                });
                try {
                    const flatPageCids = [postComment.replies.pageCids.newFlat, postComment.replies.pageCids.oldFlat];

                    let foundInFlatPages = false;
                    for (const flatPageCid of flatPageCids) {
                        const flatPageComments = await loadAllPages(flatPageCid!, postComment.replies);

                        expect(flatPageComments.length).to.be.greaterThan(0);
                        processAllCommentsRecursively(flatPageComments, (comment) => {
                            if (comment.cid === commentInPendingApproval.cid) {
                                foundInFlatPages = true;
                                return;
                            }
                        });
                        expect(foundInFlatPages).to.be.false;
                    }
                } finally {
                    cleanup();
                }

                await postComment.stop();
            });

        it("Should not include pendingApproval in commentIpfs", async () => {
            // @ts-expect-error - pendingApproval is not defined in CommentIpfs
            expect(commentInPendingApproval.raw.comment!.pendingApproval).to.not.exist;
        });
    });
}

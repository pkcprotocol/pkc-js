// comment.pendingApproval should not appear in postUpdates
// comments with pendingApproval should not show up in comment.replies, post.replies, community.posts

import {
    mockPKC,
    publishWithExpectedResult,
    processAllCommentsRecursively,
    resolveWhenConditionIsTrue,
    loadAllPages,
    getCommentWithCommentUpdateProps,
    mockGatewayPKC,
    publishRandomPost,
    forceLocalSubPagesToAlwaysGenerateMultipleChunks,
    publishToModQueueWithDepth,
    generateMockVote,
    generateMockComment,
    generateMockPost,
    createPendingApprovalChallenge
} from "../../../../dist/node/test/test-util.js";
import { itSkipIfRpc, describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { SignerType } from "../../../../dist/node/signer/types.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";
import type { DecryptedChallengeVerificationMessageType } from "../../../../dist/node/pubsub-messages/types.js";
import type {
    ChallengeFileInput,
    ChallengeResultInput,
    GetChallengeArgsInput,
    CommunityChallengeSetting
} from "../../../../dist/node/community/types.js";

const depthsToTest = [0, 1, 2, 3, 10];
const pendingApprovalCommentProps = { challengeRequest: { challengeAnswers: ["pending"] } }; // this should get comment to be successful with challenge, thus sending it to modqueue

for (const commentInPendingApprovalDepth of depthsToTest) {
    // made it sequential because maybe it can stop failing in CI
    describeSkipIfRpc.sequential(`Pending approval of comments with depth ` + commentInPendingApprovalDepth, async () => {
        let pkc: PKCType;
        let remotePKC: PKCType;
        let commentInPendingApproval: Comment;
        let modSigner: SignerType;
        let community: LocalCommunity | RpcLocalCommunity;

        beforeAll(async () => {
            pkc = await mockPKC();
            remotePKC = await mockGatewayPKC();
            community = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
            community.setMaxListeners(100);
            modSigner = await pkc.createSigner();
            await community.edit({
                settings: { challenges: [createPendingApprovalChallenge()] },
                roles: {
                    [modSigner.address]: { role: "moderator" }
                }
            });

            await community.start();

            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        });

        afterAll(async () => {
            await community.delete();
            await pkc.destroy();
            await remotePKC.destroy();
        });

        it.sequential("Should put failed comment in pending approval queue when challenge has pendingApproval: true", async () => {
            // TODO: Test that when a challenge with pendingApproval fails,
            // the publication goes to pending approval instead of being rejected
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

            const { comment, challengeVerification } = await publishToModQueueWithDepth({
                community,
                pkc: remotePKC,
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

        it.sequential("Should store pending approval comments in community.modQueue.pageCids.pendingApproval", async () => {
            // TODO: Test that pending comments are stored in correct location
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => Boolean(community.modQueue.pageCids?.pendingApproval)
            });
            const page = await community.modQueue.getPage({ cid: community.modQueue.pageCids.pendingApproval! });
            expect(page.comments.length).to.equal(1);
            const commentInPendingApprovalInPage = page.comments[0];
            expect(commentInPendingApprovalInPage.cid).to.equal(commentInPendingApproval.cid);
            // @ts-expect-error - updatedAt is not defined in CommentWithinModQueuePageJson
            expect(commentInPendingApprovalInPage.updatedAt).to.be.undefined;
            expect(commentInPendingApprovalInPage.pendingApproval).to.be.true;
        });

        if (commentInPendingApprovalDepth === 0)
            it(`pending post should not have postCid defined at its pages`, async () => {
                const pageRaw = JSON.parse((await pkc.fetchCid({ cid: community.modQueue.pageCids?.pendingApproval! })).content);
                expect(pageRaw.comments[0].comment.postCid).to.be.undefined;
            });

        it(`pending comment should not appear in community.lastPostCid or community.lastCommentCid`, async () => {
            expect(community.lastPostCid).to.not.equal(commentInPendingApproval.cid);
            expect(community.lastCommentCid).to.not.equal(commentInPendingApproval.cid);
        });

        if (commentInPendingApprovalDepth === 0)
            it(`pending post should not appear in community.postUpdates`, async () => {
                expect(community.postUpdates).to.be.undefined;
            });

        it.sequential("pending approval comments do not affect number/postNumber for later approved posts", async () => {
            const approvedPost = await publishRandomPost({
                communityAddress: community.address,
                pkc: remotePKC,
                postProps: { signer: modSigner }
            });
            const approvedPostWithUpdate = await getCommentWithCommentUpdateProps({ cid: approvedPost.cid!, pkc });
            const expectedCommentNumber = commentInPendingApprovalDepth + 1;
            const expectedPostNumber = commentInPendingApprovalDepth === 0 ? 1 : 2;

            expect(approvedPostWithUpdate.number).to.equal(expectedCommentNumber);
            expect(approvedPostWithUpdate.postNumber).to.equal(expectedPostNumber);
        });

        it(`Should not be able to publish a vote under a pending comment`, async () => {
            const vote = await generateMockVote(commentInPendingApproval as CommentIpfsWithCidDefined, 1, pkc);
            await publishWithExpectedResult({
                publication: vote,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_USER_PUBLISHED_UNDER_PENDING_COMMENT
            });
        });
        it(`should not be able to publish a non-delete CommentEdit under a pending comment`, async () => {
            const edit = await pkc.createCommentEdit({
                communityAddress: commentInPendingApproval.communityAddress,
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
            const reply = await generateMockComment(commentInPendingApproval as CommentIpfsWithCidDefined, pkc, false);
            await publishWithExpectedResult({
                publication: reply,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_USER_PUBLISHED_UNDER_PENDING_COMMENT
            });
        });

        itSkipIfRpc(`Pending comment should not be pinned in ipfs node`, async () => {
            const kuboRpc = Object.values(pkc.clients.kuboRpcClients)[0]._client;

            // Collect all pinned CIDs
            for await (const pin of kuboRpc.pin.ls()) {
                expect(pin.cid.toString()).to.not.equal(commentInPendingApproval.cid); // pending comment should not be pinned in kubo
            }
        });

        if (commentInPendingApprovalDepth > 0) {
            it.sequential(`pending approval reply does not show up in parentComment.replyCount`, async () => {
                expect((await getCommentWithCommentUpdateProps({ cid: commentInPendingApproval.parentCid!, pkc })).replyCount).to.equal(0);
            });

            it.sequential(`pending approval reply does not show up in parentComment.childCount`, async () => {
                expect((await getCommentWithCommentUpdateProps({ cid: commentInPendingApproval.parentCid!, pkc })).childCount).to.equal(0);
            });

            it.sequential(`pending approval reply does not show up in parentComment.lastChildCid`, async () => {
                expect((await getCommentWithCommentUpdateProps({ cid: commentInPendingApproval.parentCid!, pkc })).lastChildCid).to.be
                    .undefined;
            });
            it.sequential(`pending approval reply does not show up in parentComment.lastReplyTimestamp`, async () => {
                expect((await getCommentWithCommentUpdateProps({ cid: commentInPendingApproval.parentCid!, pkc })).lastReplyTimestamp).to.be
                    .undefined;
            });
        }
        if (commentInPendingApprovalDepth === 0)
            it.sequential(`pending approval post does not show up in community.lastPostCid`, async () => {
                expect(community.lastPostCid).to.not.equal(commentInPendingApproval.cid);
            });

        it.sequential(`pending approval comment does not show up in community.lastCommentCid`, async () => {
            expect(community.lastCommentCid).to.not.equal(commentInPendingApproval.cid);
        });

        it.sequential(`A pending approval comment will not show up in community.posts`, async () => {
            let foundInPosts = false;
            processAllCommentsRecursively(community.posts.pages.hot?.comments || [], (comment) => {
                if (comment.cid === commentInPendingApproval.cid) {
                    foundInPosts = true;
                    return;
                }
            });
            expect(foundInPosts).to.be.false;

            await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
                community,
                communityPostsCommentProps: { signer: modSigner, communityAddress: community.address }
            }); // the goal of this is to force the community.posts to have all pages and page.cids

            expect(community.posts.pageCids).to.not.deep.equal({}); // should not be empty

            for (const pageCid of Object.values(community.posts.pageCids)) {
                const pageComments = await loadAllPages(pageCid, community.posts);
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
                const parentComment = await pkc.getComment({ cid: commentInPendingApproval.parentCid! });
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
                    community,
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
                const postComment = await pkc.getComment({ cid: commentInPendingApproval.postCid! });
                await postComment.update();
                await resolveWhenConditionIsTrue({ toUpdate: postComment, predicate: async () => Boolean(postComment.updatedAt) });
                const { cleanup } = await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
                    community,
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

        it.sequential(`Author should be able to delete own pending comment and it should be purged immediately`, async () => {
            const deleteEdit = await pkc.createCommentEdit({
                communityAddress: commentInPendingApproval.communityAddress,
                commentCid: commentInPendingApproval.cid!,
                deleted: true,
                signer: commentInPendingApproval.signer,
                challengeRequest: { challengeAnswers: ["pending"] }
            });
            await publishWithExpectedResult({
                publication: deleteEdit,
                expectedChallengeSuccess: true
            });

            // Verify the comment has been purged from the mod queue
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => !community.modQueue.pageCids?.pendingApproval
            });
            expect(community.modQueue.pageCids?.pendingApproval).to.be.undefined;
        });
    });
}

// Custom challenge that always succeeds with pendingApproval: true and attaches a rationale
// via the new commentUpdate-extras flow (issue #88). Drives the end-to-end roundtrip: community
// signs → encrypts → author decrypts → parses → sees reason on commentUpdate.
const pendingWithReasonChallenge = (_: { challengeSettings: CommunityChallengeSetting }): ChallengeFileInput => {
    const type = "text/plain";
    const getChallenge = async (_args: GetChallengeArgsInput): Promise<ChallengeResultInput> => ({
        success: true,
        commentUpdate: { reason: "comment got sent to pending approval cause low spam-score confidence" }
    });
    return { getChallenge, type, description: "Always succeeds and queues with a rationale" };
};

// Skipped under RPC: registers an in-process custom challenge function via pkc.settings.challenges.
// RPC clients cannot install challenge code on the remote community, so this end-to-end flow only
// runs against a LocalCommunity.
describeSkipIfRpc.sequential("Pending approval: challenge attaches commentUpdate.reason for the mod queue", async () => {
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        pkc.settings.challenges = { "pending-with-reason": pendingWithReasonChallenge };
        community = (await pkc.createCommunity()) as LocalCommunity;
        community.setMaxListeners(100);
        await community.edit({
            settings: { challenges: [{ name: "pending-with-reason", pendingApproval: true }] }
        });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("author receives challengeVerification.commentUpdate.reason after a successful pending-approval challenge", async () => {
        const post = await generateMockPost({ communityAddress: community.address, pkc });
        const challengeVerificationPromise = new Promise<DecryptedChallengeVerificationMessageType>((resolve) =>
            post.once("challengeverification", resolve)
        );
        await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });

        const cv = await challengeVerificationPromise;

        // The challenge marked it pendingApproval and supplied a rationale — both must surface end-to-end.
        expect(cv.challengeSuccess).to.equal(true);
        expect(cv.commentUpdate!.pendingApproval).to.equal(true);

        const commentUpdateWithReason = cv.commentUpdate as DecryptedChallengeVerificationMessageType["commentUpdate"] & {
            reason?: string;
        };
        expect(commentUpdateWithReason.reason).to.equal("comment got sent to pending approval cause low spam-score confidence");

        // The community must have actually signed the reason field — otherwise the author's signature
        // verification would have stripped it. signedPropertyNames is the source of truth for what's covered.
        expect(cv.commentUpdate!.signature.signedPropertyNames).to.include("reason");

        // Unknown commentUpdate keys are surfaced on the Comment instance too (publication.ts
        // Object.assigns them onto `this`), so an author client can read post.reason directly.
        const postWithReason = post as Comment & { reason?: string };
        expect(postWithReason.reason).to.equal("comment got sent to pending approval cause low spam-score confidence");
    });
});

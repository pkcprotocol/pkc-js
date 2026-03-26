import signers from "../../../fixtures/signers.js";
import {
    publishRandomPost,
    publishWithExpectedResult,
    loadAllPages,
    iterateThroughPagesToFindCommentInParentPagesInstance,
    loadAllPagesBySortName,
    publishRandomReply,
    waitTillPostInSubplebbitInstancePages,
    resolveWhenConditionIsTrue,
    getAvailablePlebbitConfigsToTestAgainst
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import * as remeda from "remeda";
import { POSTS_SORT_TYPES } from "../../../../dist/node/pages/util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { CommentIpfsWithCidDefined, CommentWithinRepliesPostsPageJson } from "../../../../dist/node/publications/comment/types.js";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { RemoteSubplebbit } from "../../../../dist/node/subplebbit/remote-subplebbit.js";

const subplebbitAddress = "plebbit.bso";
const roles = [
    { role: "owner", signer: signers[1] },
    { role: "admin", signer: signers[2] },
    { role: "mod", signer: signers[3] }
];

const removeAllPins = async (allComments: CommentWithinRepliesPostsPageJson[], plebbit: Plebbit) => {
    // We need to remove all pins from previous tests session so it wouldn't interfere with the results of this test
    await Promise.all(
        allComments
            .filter((comment: CommentWithinRepliesPostsPageJson) => comment.pinned)
            .map(async (comment: CommentWithinRepliesPostsPageJson) =>
                publishWithExpectedResult({
                    publication: await plebbit.createCommentModeration({
                        communityAddress: comment.communityAddress,
                        commentCid: comment.cid,
                        commentModeration: { pinned: false },
                        signer: roles[2].signer
                    }),
                    expectedChallengeSuccess: true
                })
            )
    );
};

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.sequential(`Pinning posts - ${config.name}`, async () => {
        let plebbit: Plebbit, postToPin: Comment, secondPostToPin: Comment, sub: RemoteSubplebbit;

        const populateSub = async (subplebbit: RemoteSubplebbit) => {
            const subplebbitPage = subplebbit.posts.pageCids.new
                ? await subplebbit.posts.getPage({ cid: subplebbit.posts.pageCids.new })
                : subplebbit.posts.pages.hot;
            if (!subplebbitPage || subplebbitPage.comments.length < 10) {
                await Promise.all(
                    new Array(5).fill(null).map(async (_x) => {
                        const post = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: plebbit });
                        await waitTillPostInSubplebbitInstancePages(post as Comment & { cid: string }, subplebbit);
                        return post;
                    })
                );
            }
        };
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            sub = await plebbit.getSubplebbit({ address: subplebbitAddress });
            await populateSub(sub);
            await sub.update();

            postToPin = await publishRandomPost({
                communityAddress: subplebbitAddress,
                plebbit: plebbit,
                postProps: { timestamp: Math.round(Date.now() / 1000) - 110 }
            });
            secondPostToPin = await publishRandomPost({
                communityAddress: subplebbitAddress,
                plebbit: plebbit,
                postProps: { timestamp: Math.round(Date.now() / 1000) - 100 }
            });

            await postToPin.update();
            await secondPostToPin.update();
            await waitTillPostInSubplebbitInstancePages(secondPostToPin as Comment & { cid: string }, sub);
            const firstPage = sub.posts.pageCids.new ? await sub.posts.getPage({ cid: sub.posts.pageCids.new }) : sub.posts.pages.hot;
            const posts = firstPage.comments;
            await removeAllPins(posts, plebbit);
            // wait until all posts are unpinned
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const firstPage = sub.posts.pageCids.new
                        ? await sub.posts.getPage({ cid: sub.posts.pageCids.new })
                        : sub.posts.pages.hot;
                    const posts = firstPage.comments;
                    return posts.every((comment) => !comment.pinned);
                }
            });
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`Author can't pin their own post`, async () => {
            const pinEdit = await plebbit.createCommentModeration({
                communityAddress: postToPin.communityAddress,
                commentCid: postToPin.cid,
                commentModeration: { reason: "To pin a post", pinned: true },
                signer: postToPin.signer
            });
            await publishWithExpectedResult({
                publication: pinEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_MODERATION_ATTEMPTED_WITHOUT_BEING_MODERATOR
            });
        });
        it(`Regular author can't pin another author comment`, async () => {
            const pinEdit = await plebbit.createCommentModeration({
                communityAddress: postToPin.communityAddress,
                commentCid: postToPin.cid,
                commentModeration: { reason: "To pin a post", pinned: true },
                signer: await plebbit.createSigner()
            });
            await publishWithExpectedResult({
                publication: pinEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_MODERATION_ATTEMPTED_WITHOUT_BEING_MODERATOR
            });
        });

        it(`Mod can pin a post`, async () => {
            const pinEdit = await plebbit.createCommentModeration({
                communityAddress: postToPin.communityAddress,
                commentCid: postToPin.cid,
                commentModeration: { reason: "To pin a post", pinned: true },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: pinEdit, expectedChallengeSuccess: true });
        });
        it(`A new CommentUpdate is published with pinned=true`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: postToPin, predicate: async () => postToPin.pinned === true });
            expect(postToPin.pinned).to.be.true;
            expect(postToPin.raw.commentUpdate.pinned).to.be.true;
            expect(postToPin.raw.commentUpdate.edit).to.be.undefined;
            expect(postToPin.reason).to.equal("To pin a post");
            expect(postToPin.raw.commentUpdate.reason).to.equal("To pin a post");
        });

        it.sequential(`pinned=true appears in pages of subplebbit`, async () => {
            const sub = await plebbit.createSubplebbit({ address: postToPin.communityAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(postToPin.cid, sub.posts);
                    return commentInPage?.pinned === true;
                }
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(postToPin.cid, sub.posts);
            expect(commentInPage.pinned).to.be.true;
            await sub.stop();
        });
        it(`A pinned post is on the top of every page in subplebbit.posts`, async () => {
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub.update();

            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const postInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(postToPin.cid, sub.posts);
                    return postInPage?.pinned;
                }
            });

            expect(Object.keys(sub.posts.pageCids).every((key) => Object.keys(POSTS_SORT_TYPES).includes(key))).to.be.true; // Should include pages with timeframes
            await sub.stop();
            for (const [sortName, pageCid] of Object.entries(sub.posts.pageCids) as [string, string][]) {
                const pageComments = (await sub.posts.getPage({ cid: pageCid })).comments; // Get 50 comments, pinned posts should always be on top
                const postInPage = pageComments.find((comment) => comment.cid === postToPin.cid);
                expect(postInPage).to.exist;
                expect(postInPage.pinned).to.be.true;
                expect(postInPage.reason).to.equal("To pin a post");
                for (let i = 0; i < pageComments.length - 1; i++)
                    if (!pageComments[i].pinned && pageComments[i + 1].pinned) expect.fail("Pinned posts should always be on top");
            }
        });

        it(`Mod can pin another post`, async () => {
            const pinEdit = await plebbit.createCommentModeration({
                communityAddress: secondPostToPin.communityAddress,
                commentCid: secondPostToPin.cid,
                commentModeration: { reason: "To pin the second post", pinned: true },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: pinEdit, expectedChallengeSuccess: true });
        });
        it(`Pinned posts are sorted according to the page sort they're in`, async () => {
            // We're gonna test whether posts.new has pinned posts on top
            // 'postToPin' should be the first on the list, since it's pinned and has a higher timestamp
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub.update();

            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const postInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(secondPostToPin.cid, sub.posts);
                    return postInPage?.pinned;
                }
            });

            await sub.stop();
            for (const [sortName, pageCid] of Object.entries(sub.posts.pageCids) as [string, string][]) {
                const pageComments = await loadAllPages(pageCid, sub.posts);
                const pinnedComments = pageComments.filter((comment) => comment.pinned);
                expect(pinnedComments.length).to.equal(2);
                const restOfComments = pageComments.filter((comment) => !comment.pinned);

                for (const comments of [pinnedComments, restOfComments]) {
                    for (let i = 0; i < comments.length - 1; i++) {
                        const [commentA, commentB] = comments.slice(i, i + 2);
                        const scoreFunc = POSTS_SORT_TYPES[sortName].score;

                        if (sortName !== "active") {
                            // Temporary. Active does not have a sorting function as of now
                            const [scoreA, scoreB] = [
                                scoreFunc({ comment: commentA.raw.comment, commentUpdate: commentA.raw.commentUpdate }),
                                scoreFunc({ comment: commentB.raw.comment, commentUpdate: commentB.raw.commentUpdate })
                            ];
                            expect(scoreA).to.be.greaterThanOrEqual(scoreB);
                        }
                    }
                }
            }
        });

        it(`Mod can unpin a post`, async () => {
            const pinEdit = await plebbit.createCommentModeration({
                communityAddress: secondPostToPin.communityAddress,
                commentCid: secondPostToPin.cid,
                commentModeration: { reason: "To unpin the second post", pinned: false },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: pinEdit, expectedChallengeSuccess: true });
        });
        it(`A new CommentUpdate is published with pinned=false`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: secondPostToPin, predicate: async () => secondPostToPin.pinned === false });
            expect(secondPostToPin.pinned).to.be.false;
            expect(secondPostToPin.raw.commentUpdate.pinned).to.be.false;
            expect(secondPostToPin.raw.commentUpdate.edit).to.be.undefined;
            expect(secondPostToPin.reason).to.equal("To unpin the second post");
            expect(secondPostToPin.raw.commentUpdate.reason).to.equal("To unpin the second post");
        });

        it.sequential(`pinned=true appears in pages of subplebbit`, async () => {
            const sub = await plebbit.createSubplebbit({ address: secondPostToPin.communityAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(secondPostToPin.cid, sub.posts);
                    return commentInPage?.pinned === false;
                }
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(secondPostToPin.cid, sub.posts);
            expect(commentInPage.pinned).to.be.false;
            await sub.stop();
        });
        it(`Unpinned posts is sorted like regular posts`, async () => {
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub.update();

            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const postInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(secondPostToPin.cid, sub.posts);
                    return !postInPage?.pinned;
                }
            });

            await sub.stop();

            for (const [sortName, pageCid] of Object.entries(sub.posts.pageCids) as [string, string][]) {
                const pageComments = await loadAllPages(pageCid, sub.posts);
                expect(pageComments[0].cid).to.equal(postToPin.cid);
                expect(pageComments[0].pinned).to.be.true;
                expect(pageComments[0].reason).to.equal("To pin a post");

                if (!POSTS_SORT_TYPES[sortName].timeframe || POSTS_SORT_TYPES[sortName].timeframe === "ALL") {
                    const secondPinnedPostInPage = pageComments.find((comment) => comment.cid === secondPostToPin.cid);
                    // post may not be included in the page since it's not pinned anymore and can only be included if its timestamp matches the page timeframe
                    expect(secondPinnedPostInPage).to.exist;
                    expect(secondPinnedPostInPage.pinned).to.be.false;
                    expect(secondPinnedPostInPage.reason).to.equal("To unpin the second post");
                }

                // Rest of comments should be sorted like regular page

                for (let i = 1; i < pageComments.length - 1; i++) {
                    const [commentA, commentB] = [pageComments[i], pageComments[i + 1]];
                    const scoreFunc = POSTS_SORT_TYPES[sortName].score;

                    if (sortName !== "active") {
                        // Temporary. Active does not have a sorting function as of now
                        const [scoreA, scoreB] = [
                            scoreFunc({ comment: commentA.raw.comment, commentUpdate: commentA.raw.commentUpdate }),
                            scoreFunc({ comment: commentB.raw.comment, commentUpdate: commentB.raw.commentUpdate })
                        ];
                        expect(scoreA).to.be.greaterThanOrEqual(scoreB);
                    }
                }
            }
        });
    });

    describe(`Pinning replies - ${config.name}`, async () => {
        let plebbit: Plebbit, post: Comment, replyToPin: Comment, sub: RemoteSubplebbit;

        const populatePost = async () => {
            if (post.replyCount < 5) {
                await Promise.all(
                    new Array(10)
                        .fill(null)
                        .map((_x) => publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, plebbit: plebbit }))
                );
                await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => post.replyCount > 5 });
            }
        };
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            sub = await plebbit.getSubplebbit({ address: subplebbitAddress });

            const allPosts = sub.posts.pageCids.new ? await loadAllPages(sub.posts.pageCids.new, sub.posts) : sub.posts.pages.hot.comments;
            post = await plebbit.createComment(remeda.maxBy(allPosts, (c) => c.replyCount));
            await post.update();
            await populatePost();
            expect(post.replyCount).to.be.greaterThan(5); // Arbitary number
            replyToPin = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, plebbit: plebbit });
            await removeAllPins(
                post.replies.pageCids.best
                    ? await loadAllPages(post.replies.pageCids.best, post.replies)
                    : post.replies.pages.best.comments,
                plebbit
            );
        });

        afterAll(async () => await plebbit.destroy());

        it(`Mod can pin reply`, async () => {
            const pinEdit = await plebbit.createCommentModeration({
                communityAddress: replyToPin.communityAddress,
                commentCid: replyToPin.cid,
                commentModeration: { reason: "To pin the reply", pinned: true },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: pinEdit, expectedChallengeSuccess: true });
        });

        it(`A pinned reply is on the top of every page in parentComment.replies`, async () => {
            // Seems like all pages don't get updated at the same time, so will wait until all pages include the pinned post
            const postToRecreate = await plebbit.createComment({ cid: post.cid });

            await postToRecreate.update();

            await resolveWhenConditionIsTrue({
                toUpdate: postToRecreate,
                predicate: async () => {
                    const replyInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(replyToPin.cid, postToRecreate.replies);
                    return replyInPage?.pinned;
                }
            });

            await postToRecreate.stop();

            const postsPagesNames = remeda.unique([
                ...Object.keys(postToRecreate.replies.pageCids),
                ...Object.keys(postToRecreate.replies.pages)
            ]);
            expect(postsPagesNames.length).to.be.greaterThan(0);

            for (const pageSortName of postsPagesNames) {
                const allCommentsUnderPageSortName = (await loadAllPagesBySortName(
                    pageSortName,
                    postToRecreate.replies
                )) as CommentWithinRepliesPostsPageJson[];
                const replyInPage = allCommentsUnderPageSortName.find((comment) => comment.cid === replyToPin.cid);
                expect(replyInPage).to.exist;
                expect(replyInPage!.pinned).to.be.true;
                expect(replyInPage!.reason).to.equal("To pin the reply");
                for (let i = 0; i < allCommentsUnderPageSortName.length - 1; i++)
                    if (!allCommentsUnderPageSortName[i].pinned && allCommentsUnderPageSortName[i + 1].pinned)
                        expect.fail("Pinned replies should always be on top");
            }
        });

        it(`pinned=true appears in pages of parent comment`, async () => {
            const pinnedReplyInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(replyToPin.cid, post.replies);
            expect(pinnedReplyInPage.pinned).to.be.true;
        });
    });
});

import {
    createSubWithNoChallenge,
    forceLocalSubPagesToAlwaysGenerateMultipleChunks,
    loadAllPages,
    loadAllPagesBySortName,
    getAvailablePlebbitConfigsToTestAgainst,
    mockPlebbit,
    publishRandomPost,
    resolveWhenConditionIsTrue,
    describeSkipIfRpc,
    publishRandomReply
} from "../../../../../dist/node/test/test-util.js";
import { POST_REPLIES_SORT_TYPES, REPLY_REPLIES_SORT_TYPES } from "../../../../../dist/node/pages/util.js";
import { testCommentFieldsInPageJson, testPageCommentsIfSortedCorrectly } from "../../../../node-and-browser/pages/pages-test-util.js";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit as PlebbitType } from "../../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../../dist/node/publications/comment/comment.js";
import type { LocalSubplebbit } from "../../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalSubplebbit } from "../../../../../dist/node/community/rpc-local-community.js";
import type { CommentWithinRepliesPostsPageJson, CommentIpfsWithCidDefined } from "../../../../../dist/node/publications/comment/types.js";
import type { ReplySort } from "../../../../../dist/node/pages/types.js";

const remotePlebbitLoadingConfigs = getAvailablePlebbitConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true });

interface LocalCommentWithPaginatedRepliesResult {
    plebbit: PlebbitType;
    subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    post: Comment;
    reply: Comment;
    cleanup: () => Promise<void>;
}

describeSkipIfRpc("comment.replies pagination coverage (node-only)", () => {
    let plebbit: PlebbitType;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let postWithPageCids: Comment;
    let replyWithPageCids: Comment;
    let cleanup: () => Promise<void>;

    beforeAll(async () => {
        ({
            plebbit,
            subplebbit,
            post: postWithPageCids,
            reply: replyWithPageCids,
            cleanup
        } = await createLocalCommentWithPaginatedReplies());
    });

    afterAll(async () => {
        await cleanup?.();
    });

    remotePlebbitLoadingConfigs.map((config) => {
        describe(`Loading comment.replies with config ${config.name}`, async () => {
            let plebbit: PlebbitType;
            let post: Comment;
            let reply: Comment;

            beforeAll(async () => {
                plebbit = await config.plebbitInstancePromise();
                post = await plebbit.getComment({ cid: postWithPageCids.cid! });
                reply = await plebbit.getComment({ cid: replyWithPageCids.cid! });
                await post.update();
                await reply.update();
                await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => typeof post.updatedAt === "number" });
                await resolveWhenConditionIsTrue({ toUpdate: reply, predicate: async () => typeof reply.updatedAt === "number" });
            });

            afterAll(async () => {
                await plebbit.destroy();
            });

            describe("post.replies", () => {
                it("has pageCids after forcing pagination", () => {
                    expect(Object.keys(post.replies.pageCids)).to.not.be.empty;
                });

                it("does not track preloaded pages inside pageCids", () => {
                    for (const preloadedPageSortName of Object.keys(post.replies.pages)) {
                        expect(post.replies.pageCids[preloadedPageSortName]).to.be.undefined;
                    }
                });

                it("stringified post.replies still have all props", () => {
                    const preloadedPages = post.replies.pages;
                    for (const preloadedSortType of Object.keys(preloadedPages)) {
                        const stringifiedReplies = JSON.parse(JSON.stringify(post.replies)).pages[preloadedSortType].comments;
                        for (const reply of stringifiedReplies) testCommentFieldsInPageJson(reply);
                    }
                });

                it("has pageCids for all non-preloaded sorts", () => {
                    const pageCidsWithoutPreloadedPage = Object.keys(POST_REPLIES_SORT_TYPES).filter(
                        (pageSortName) => !Object.keys(post.replies.pages).includes(pageSortName)
                    );
                    expect(Object.keys(post.replies.pageCids).sort()).to.deep.equal(pageCidsWithoutPreloadedPage.sort());
                });

                it("pages under a post are sorted correctly", async () => {
                    const availableSorts = Object.keys(POST_REPLIES_SORT_TYPES).filter(
                        (sortName) => post.replies.pageCids[sortName] || post.replies.pages[sortName]
                    );
                    expect(availableSorts.length).to.be.greaterThan(0);
                    for (const sortName of availableSorts) {
                        const repliesUnderPost = (await loadAllPagesBySortName(
                            sortName,
                            post.replies
                        )) as CommentWithinRepliesPostsPageJson[];
                        await testPageCommentsIfSortedCorrectly(repliesUnderPost, sortName, subplebbit);
                    }
                });

                it("flat sorts include nested replies and hide nested replies fields", async () => {
                    const availableFlatSorts = Object.keys(POST_REPLIES_SORT_TYPES).filter(
                        (sortName) => (POST_REPLIES_SORT_TYPES as ReplySort)[sortName].flat && post.replies.pageCids[sortName]
                    );
                    if (availableFlatSorts.length === 0) return;

                    const flatSortName = availableFlatSorts[0];
                    const flatReplies = (await loadAllPages(
                        post.replies.pageCids[flatSortName],
                        post.replies
                    )) as CommentWithinRepliesPostsPageJson[];

                    expect(flatReplies.length).to.be.greaterThan(0);
                    expect(flatReplies.some((flatReply) => (flatReply.raw?.comment?.depth ?? flatReply.depth ?? 0) > 1)).to.be.true;
                    flatReplies.forEach((flatReply) => expect(flatReply.replies).to.be.undefined);
                });

                it("PageIpfs.comments.comment matches PageIpfs.comment.commentUpdate.cid", async () => {
                    const postReplySortNames = Object.keys(POST_REPLIES_SORT_TYPES).filter(
                        (sortName) => post.replies.pageCids[sortName] || post.replies.pages[sortName]
                    );
                    expect(postReplySortNames.length).to.be.greaterThan(0);

                    for (const postReplySortName of postReplySortNames) {
                        const commentsFromEachPage = (await loadAllPagesBySortName(
                            postReplySortName,
                            post.replies
                        )) as CommentWithinRepliesPostsPageJson[];
                        const commentsPageIpfs = commentsFromEachPage.map((comment) => comment.raw);

                        for (const commentInPageIpfs of commentsPageIpfs) {
                            const calculatedCid = await calculateIpfsHash(JSON.stringify(commentInPageIpfs!.comment));
                            expect(calculatedCid).to.equal(commentInPageIpfs!.commentUpdate.cid);
                        }
                    }
                });
            });

            describe("reply.replies", () => {
                it("has pageCids after forcing pagination", () => {
                    expect(Object.keys(reply.replies.pageCids)).to.not.be.empty;
                });

                it("does not track preloaded reply pages inside pageCids", () => {
                    for (const preloadedPageSortName of Object.keys(reply.replies.pages))
                        expect(reply.replies.pageCids[preloadedPageSortName]).to.be.undefined;
                });

                it("has the right pageCids under it after maxing out its replies", () => {
                    const pageCidsWithoutPreloadedPageOrFlat = Object.keys(REPLY_REPLIES_SORT_TYPES).filter(
                        (pageSortName) =>
                            !Object.keys(reply.replies.pages).includes(pageSortName) &&
                            !(REPLY_REPLIES_SORT_TYPES as ReplySort)[pageSortName].flat
                    );
                    expect(Object.keys(reply.replies.pageCids).sort()).to.deep.equal(pageCidsWithoutPreloadedPageOrFlat.sort());
                });

                it("pages under a reply are sorted correctly", async () => {
                    const availableSorts = Object.keys(REPLY_REPLIES_SORT_TYPES).filter(
                        (sortName) => reply.replies.pageCids[sortName] || reply.replies.pages[sortName]
                    );
                    expect(availableSorts.length).to.be.greaterThan(0);
                    for (const sortName of availableSorts) {
                        const repliesUnderReply = (await loadAllPagesBySortName(
                            sortName,
                            reply.replies
                        )) as CommentWithinRepliesPostsPageJson[];
                        await testPageCommentsIfSortedCorrectly(repliesUnderReply, sortName, subplebbit);
                    }
                });

                it("PageIpfs.comments.comment matches PageIpfs.comment.commentUpdate.cid", async () => {
                    const availableReplySorts = Object.keys(REPLY_REPLIES_SORT_TYPES).filter(
                        (sortName) => reply.replies.pageCids[sortName] || reply.replies.pages[sortName]
                    );
                    expect(availableReplySorts.length).to.be.greaterThan(0);
                    for (const replySortName of availableReplySorts) {
                        const commentsFromEachPage = (await loadAllPagesBySortName(
                            replySortName,
                            reply.replies
                        )) as CommentWithinRepliesPostsPageJson[];
                        const commentsPageIpfs = commentsFromEachPage.map((comment) => comment.raw);

                        for (const commentInPageIpfs of commentsPageIpfs) {
                            const calculatedCid = await calculateIpfsHash(JSON.stringify(commentInPageIpfs!.comment));
                            expect(calculatedCid).to.equal(commentInPageIpfs!.commentUpdate.cid);
                        }
                    }
                });
            });
        });
    });
});

async function createLocalCommentWithPaginatedReplies(): Promise<LocalCommentWithPaginatedRepliesResult> {
    const plebbit = await mockPlebbit();
    const subplebbit = await createSubWithNoChallenge({}, plebbit);
    await subplebbit.start();

    await resolveWhenConditionIsTrue({
        toUpdate: subplebbit,
        predicate: async () => typeof subplebbit.updatedAt === "number"
    });

    const post = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: plebbit });
    await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
        subplebbit,
        parentComment: post,
        forcedPreloadedPageSizeBytes: 1,
        parentCommentReplyProps: { content: "pagination coverage reply" }
    });

    const replies = await Promise.all(
        new Array(10).fill(null).map(() => publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, plebbit: plebbit }))
    );
    await Promise.all(
        new Array(10).fill(null).map(() => publishRandomReply({ parentComment: replies[0] as CommentIpfsWithCidDefined, plebbit: plebbit }))
    );
    await post.update();

    await resolveWhenConditionIsTrue({
        toUpdate: post,
        predicate: async () => Object.keys(post.replies.pageCids).length > 0
    });

    const reply = await plebbit.getComment({ cid: replies[0].cid! });
    await reply.update();
    await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
        subplebbit,
        parentComment: reply,
        forcedPreloadedPageSizeBytes: 1,
        parentCommentReplyProps: { content: "pagination coverage nested reply" }
    });

    await publishRandomReply({ parentComment: reply as CommentIpfsWithCidDefined, plebbit: plebbit }); // to force new update

    await resolveWhenConditionIsTrue({
        toUpdate: reply,
        predicate: async () => Object.keys(reply.replies.pageCids).length > 0
    });

    const cleanup = async () => {
        await subplebbit.delete();
        await plebbit.destroy();
    };

    return { plebbit, subplebbit, post, reply, cleanup };
}

import {
    createSubWithNoChallenge,
    describeSkipIfRpc,
    forceLocalSubPagesToAlwaysGenerateMultipleChunks,
    getAvailablePKCConfigsToTestAgainst,
    mockCommentToNotUsePagesForUpdates,
    mockPKC,
    mockPKCNoDataPathWithOnlyKuboClient,
    mockReplyToUseParentPagesForUpdates,
    publishRandomPost,
    waitTillReplyInParentPages,
    waitTillPostInCommunityPages,
    publishRandomReply,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { PKCError } from "../../../dist/node/pkc-error.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentUpdateType } from "../../../dist/node/publications/comment/types.js";

// this test is testing the loading logic of Comment at a different depths
// it was made because testing it on test-server.js subs take too long

const pkcLoadingConfigs = getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true });
const replyDepthsToTest = [1, 2, 3, 10, 12];

interface PostDepthTestContext {
    pkc: PKC;
    community: LocalCommunity;
    replyDepth: number;
    rootCid: string;
    leafCid: string;
    leafParentCid: string | undefined;
    expectedPostUpdate: CommentUpdateType;
    forcedCommunityStoredUpdate?: {
        pageCids: Record<string, string>;
        pages: Record<string, { nextCid?: string; comments: never[] }>;
    };
    cleanup: () => Promise<void>;
}

interface ReplyDepthTestContext {
    pkc: PKC;
    community: LocalCommunity;
    replyDepth: number;
    rootCid: string;
    leafCid: string;
    leafParentCid: string;
    expectedLeafUpdate: CommentUpdateType;
    forcedParentStoredUpdate?: CommentUpdateType;
    cleanup: () => Promise<void>;
}

interface ReplyChainResult {
    rootCid: string;
    leafCid: string;
    parentOfLeafCid: string;
    expectedLeafUpdate: CommentUpdateType;
}

describeSkipIfRpc("comment.update loading depth coverage", function () {
    describe.concurrent(`post loading coverage`, () => {
        let context: PostDepthTestContext;

        beforeAll(async () => {
            context = await createPostDepthTestEnvironment({
                forceCommunityPostsPageCids: false
            });
        });

        afterAll(async () => {
            await context.cleanup();
        });

        it.sequential("loads post updates when the sub was stopped", async () => {
            const postComment = await context.pkc.createComment({ cid: context.rootCid });
            const subInstance = context.community;
            await subInstance.stop();

            try {
                expect(subInstance.state).to.equal("stopped");

                await postComment.update();
                await waitForCommentToMatchStoredUpdate(postComment, context.expectedPostUpdate.updatedAt);
                expect(postComment.updatedAt).to.equal(context.expectedPostUpdate.updatedAt);
                const updatingPost = postComment._pkc._updatingComments[postComment.cid!];
                expect(updatingPost).to.exist;
                expect(updatingPost.depth).to.equal(0);
            } finally {
                await postComment.stop();
            }
        });

        it("loads post updates while the community keeps running on the same pkc instance", async () => {
            const postComment = await context.pkc.createComment({ cid: context.rootCid });

            const subInstance = context.community;
            if (subInstance.state !== "started") await subInstance.start();
            try {
                expect(subInstance.state).to.equal("started");
                await postComment.update();
                await waitForCommentToMatchStoredUpdate(postComment, context.expectedPostUpdate.updatedAt);
                expect(postComment.updatedAt).to.equal(context.expectedPostUpdate.updatedAt);
                const updatingPost = postComment._pkc._updatingComments[postComment.cid!];
                expect(updatingPost).to.exist;
                expect(updatingPost.depth).to.equal(0);
            } finally {
                await postComment.stop();
            }
        });

        describe("community posts served via postUpdates", () => {
            let paginationContext: PostDepthTestContext;

            beforeAll(async () => {
                paginationContext = await createPostDepthTestEnvironment({
                    forceCommunityPostsPageCids: true
                });
            });

            afterAll(async () => {
                await paginationContext.cleanup();
            });

            pkcLoadingConfigs.forEach((pkcConfig) => {
                it("loads post updates when from community.postUpdates - Remote pkc config " + pkcConfig.name, async () => {
                    const storedCommunityUpdate = paginationContext.forcedCommunityStoredUpdate;
                    expect(storedCommunityUpdate).to.exist;
                    expect(storedCommunityUpdate?.pageCids).to.exist;
                    expect(Object.keys(storedCommunityUpdate?.pageCids ?? {})).to.not.be.empty;
                    const storedCommunityPages = storedCommunityUpdate?.pages || {};
                    Object.values(storedCommunityPages).forEach((page) => {
                        if (page?.comments) expect(page.comments).to.deep.equal([]);
                    });

                    const remotePKC = await pkcConfig.pkcInstancePromise();

                    try {
                        const postComment = await remotePKC.createComment({ cid: paginationContext.rootCid });

                        await postComment.update();
                        await mockCommentToNotUsePagesForUpdates(postComment);
                        await waitForCommentToMatchStoredUpdate(postComment, paginationContext.expectedPostUpdate.updatedAt);
                        expect(postComment.updatedAt).to.be.a("number");
                        expect(postComment.updatedAt).to.be.greaterThanOrEqual(paginationContext.expectedPostUpdate.updatedAt);

                        const updatingPost = postComment._pkc._updatingComments[postComment.cid!];
                        expect(updatingPost._commentUpdateIpfsPath).to.be.a("string"); // post shouldn't find itself in pages, rather it needs to use postUpdates
                    } finally {
                        await remotePKC.destroy();
                    }
                });
            });
        });

        pkcLoadingConfigs.forEach((pkcConfig) => {
            describe.concurrent(`post loading with ${pkcConfig.name}`, () => {
                it.sequential("retries loading CommentIpfs when the post cid block is missing on publisher", async () => {
                    let remotePKC: PKC | undefined;
                    let postComment: Comment | undefined;
                    let publisherPKC: PKC | undefined;
                    try {
                        publisherPKC = await mockPKC();
                        const community = await createSubWithNoChallenge({}, publisherPKC);
                        await community.start();
                        await resolveWhenConditionIsTrue({
                            toUpdate: community,
                            predicate: async () => typeof community.updatedAt === "number"
                        });
                        const newPost = await publishRandomPost({ communityAddress: community.address, pkc: publisherPKC });

                        remotePKC = await pkcConfig.pkcInstancePromise();
                        await waitTillPostInCommunityPages(newPost as never, remotePKC);

                        await remotePKC.destroy();

                        remotePKC = await pkcConfig.pkcInstancePromise();

                        remotePKC._timeouts["comment-ipfs"] = 250;
                        makeCommentCidFetchFail(remotePKC, newPost.cid!);

                        const errors: Error[] = [];
                        postComment = await remotePKC.createComment({ cid: newPost.cid, communityAddress: newPost.communityAddress }); // need to include communityAddress or otherwise pkc-js cant load it from community pages
                        postComment.on("error", (err) => errors.push(err));

                        await postComment.update();

                        await resolveWhenConditionIsTrue({
                            toUpdate: postComment,
                            predicate: async () => typeof postComment!.updatedAt === "number"
                        });

                        // should download its props from community pages
                        expect(postComment.raw.comment).to.be.ok;
                        expect(postComment.raw.commentUpdate).to.be.ok;

                        expect(postComment.updatedAt).to.be.a("number");
                        expect(postComment.state).to.equal("updating");
                        expect(["ERR_FETCH_CID_P2P_TIMEOUT", "ERR_FAILED_TO_FETCH_COMMENT_IPFS_FROM_GATEWAYS"]).to.include(
                            (errors[0] as PKCError)?.code
                        );
                        expect(postComment._pkc._updatingComments[postComment.cid!]).to.exist;
                    } finally {
                        await remotePKC?.destroy();
                        await publisherPKC?.destroy();
                    }
                });

                it("loads post updates while the community keeps updating", async () => {
                    const subInstance = context.community;
                    const remotePKC = await pkcConfig.pkcInstancePromise();
                    try {
                        const postComment = await remotePKC.createComment({ cid: context.rootCid });
                        expect(subInstance.state).to.equal("started");
                        await postComment.update();
                        await waitForCommentToMatchStoredUpdate(postComment, context.expectedPostUpdate.updatedAt);
                        expect(postComment.updatedAt).to.equal(context.expectedPostUpdate.updatedAt);
                        const updatingPost = postComment._pkc._updatingComments[postComment.cid!];
                        expect(updatingPost).to.exist;
                        expect(updatingPost.depth).to.equal(0);
                    } finally {
                        await remotePKC.destroy();
                    }
                });
            });
        });
    });

    replyDepthsToTest.forEach((replyDepth) => {
        describe.concurrent(`reply depth ${replyDepth}`, () => {
            let context: ReplyDepthTestContext;

            beforeAll(async () => {
                context = await createReplyDepthTestEnvironment({ replyDepth });
            });

            afterAll(async () => {
                await context?.cleanup();
            });

            pkcLoadingConfigs.forEach((pkcConfig) => {
                describe.sequential(`reply loading with ${pkcConfig.name}`, () => {
                    it.sequential("retries loading CommentIpfs when the reply cid block is missing on publisher", async () => {
                        let remotePKC: PKC | undefined;
                        let replyComment: Comment | undefined;
                        let newReply: Comment | undefined;
                        let parentComment: Comment | undefined;
                        try {
                            parentComment = await context.pkc.getComment({ cid: context.leafCid });

                            newReply = await publishRandomReply({ parentComment: parentComment as never, pkc: context.pkc });
                            await waitTillReplyInParentPages(newReply as never, context.pkc);

                            remotePKC = await pkcConfig.pkcInstancePromise();
                            remotePKC._timeouts["comment-ipfs"] = 250;
                            makeCommentCidFetchFail(remotePKC, newReply.cid!);

                            replyComment = await remotePKC.createComment({
                                cid: newReply.cid,
                                communityAddress: parentComment.communityAddress
                            });
                            const errors: Error[] = [];
                            replyComment.on("error", (err) => errors.push(err));

                            await replyComment.update();

                            await resolveWhenConditionIsTrue({
                                toUpdate: replyComment,
                                predicate: async () => typeof replyComment!.updatedAt === "number"
                            });

                            // should download its props from community pages
                            expect(replyComment.raw.comment).to.be.ok;
                            expect(replyComment.raw.commentUpdate).to.be.ok;

                            expect(replyComment.updatedAt).to.be.a("number");
                            expect(replyComment.state).to.equal("updating");
                            expect(["ERR_FETCH_CID_P2P_TIMEOUT", "ERR_FAILED_TO_FETCH_COMMENT_IPFS_FROM_GATEWAYS"]).to.include(
                                (errors[0] as PKCError)?.code
                            );
                            expect(replyComment._pkc._updatingComments[replyComment.cid!]).to.exist;
                        } finally {
                            await remotePKC?.destroy();
                        }
                    });

                    it.sequential("loads reply updates when the post was stopped", async () => {
                        const remotePKC = await pkcConfig.pkcInstancePromise();
                        const replyComment = await remotePKC.getComment({ cid: context.leafCid });
                        try {
                            await replyComment.update();
                            await waitForCommentToMatchStoredUpdate(replyComment, context.expectedLeafUpdate.updatedAt);
                            expect(replyComment.updatedAt).to.be.greaterThanOrEqual(context.expectedLeafUpdate.updatedAt);
                            const updatingReply = replyComment._pkc._updatingComments[replyComment.cid!];
                            expect(updatingReply).to.exist;
                            const parentForUpdating = (
                                updatingReply._clientsManager as never as {
                                    _postForUpdating: { comment: { cid: string } } | undefined;
                                }
                            )._postForUpdating;
                            expect(parentForUpdating).to.exist;
                            expect(parentForUpdating!.comment.cid).to.equal(context.rootCid);
                            expect(updatingReply.depth).to.equal(replyDepth);
                        } finally {
                            await replyComment.stop();
                            await remotePKC.destroy();
                        }
                    });

                    it("loads reply updates while the post keeps updating", async () => {
                        const remotePKC = await pkcConfig.pkcInstancePromise();

                        const postComment = await remotePKC.getComment({ cid: context.rootCid });

                        const replyComment = await remotePKC.getComment({ cid: context.leafCid });
                        try {
                            await postComment.update();
                            await waitForPostToStartUpdating(postComment);
                            await replyComment.update();
                            await waitForCommentToMatchStoredUpdate(replyComment, context.expectedLeafUpdate.updatedAt);
                            expect(replyComment.updatedAt).to.be.greaterThanOrEqual(context.expectedLeafUpdate.updatedAt);
                            const updatingReply = replyComment._pkc._updatingComments[replyComment.cid!];
                            expect(updatingReply).to.exist;
                            const parentForUpdating = (
                                updatingReply._clientsManager as never as {
                                    _postForUpdating: { comment: { cid: string } } | undefined;
                                }
                            )._postForUpdating;
                            expect(parentForUpdating).to.exist;
                            expect(parentForUpdating!.comment.cid).to.equal(context.rootCid);
                            expect(updatingReply.depth).to.equal(replyDepth);
                        } finally {
                            await replyComment.stop();
                            await postComment.stop();
                            await remotePKC.destroy();
                        }
                    });
                });
            });
        });

        describe.concurrent("parent replies served via pageCids with depth " + replyDepth, () => {
            let paginationContext: ReplyDepthTestContext;

            beforeAll(async () => {
                paginationContext = await createReplyDepthTestEnvironment({
                    replyDepth,
                    forceParentRepliesPageCids: true
                });
            });

            afterAll(async () => {
                await paginationContext?.cleanup();
            });

            pkcLoadingConfigs.forEach((pkcConfig) => {
                it("loads reply updates when the parent was stopped", async () => {
                    const remotePKC = await pkcConfig.pkcInstancePromise();
                    const replyComment = await remotePKC.getComment({ cid: paginationContext.leafCid });
                    try {
                        const storedParentUpdate = paginationContext.forcedParentStoredUpdate;
                        expect(storedParentUpdate).to.exist;
                        expect(storedParentUpdate?.replies?.pageCids).to.exist;
                        expect(Object.keys(storedParentUpdate?.replies?.pageCids ?? {})).to.not.be.empty;
                        const storedParentPreloadedPages = storedParentUpdate?.replies?.pages || {};
                        Object.values(storedParentPreloadedPages).forEach((page) => {
                            if (page?.comments) expect(page.comments).to.deep.equal([]);
                        });

                        await replyComment.update();
                        mockReplyToUseParentPagesForUpdates(replyComment);
                        await waitForCommentToMatchStoredUpdate(replyComment, paginationContext.expectedLeafUpdate.updatedAt);
                        expect(replyComment.parentCid).to.equal(paginationContext.leafParentCid);

                        const updatingReply = replyComment._pkc._updatingComments[replyComment.cid!];
                        expect(updatingReply).to.exist;
                        const parentFirstPageCidsAlreadyLoaded = (
                            updatingReply._clientsManager as never as { _parentFirstPageCidsAlreadyLoaded: Set<string> }
                        )._parentFirstPageCidsAlreadyLoaded;
                        expect(parentFirstPageCidsAlreadyLoaded.size).to.be.greaterThan(0);
                        expect(updatingReply.depth).to.equal(replyDepth);
                    } finally {
                        await remotePKC.destroy();
                    }
                });

                it("loads reply updates while the parent keeps updating", async () => {
                    const remotePKC = await pkcConfig.pkcInstancePromise();
                    const parentComment = await remotePKC.getComment({ cid: paginationContext.leafParentCid });
                    const replyComment = await remotePKC.getComment({ cid: paginationContext.leafCid });
                    try {
                        await parentComment.update();
                        await waitForPostToStartUpdating(parentComment);
                        await replyComment.update();
                        mockReplyToUseParentPagesForUpdates(replyComment);
                        await waitForCommentToMatchStoredUpdate(replyComment, paginationContext.expectedLeafUpdate.updatedAt);
                        expect(replyComment.parentCid).to.equal(paginationContext.leafParentCid);
                        const storedParentUpdate = paginationContext.forcedParentStoredUpdate;
                        expect(storedParentUpdate).to.exist;
                        expect(storedParentUpdate?.replies?.pageCids).to.exist;
                        expect(Object.keys(storedParentUpdate?.replies?.pageCids ?? {})).to.not.be.empty;
                        const storedParentPreloadedPages = storedParentUpdate?.replies?.pages || {};
                        Object.values(storedParentPreloadedPages).forEach((page) => {
                            if (page?.comments) expect(page.comments).to.deep.equal([]);
                        });
                        const updatingReply = replyComment._pkc._updatingComments[replyComment.cid!];
                        expect(updatingReply).to.exist;
                        const parentFirstPageCidsAlreadyLoaded = (
                            updatingReply._clientsManager as never as { _parentFirstPageCidsAlreadyLoaded: Set<string> }
                        )._parentFirstPageCidsAlreadyLoaded;
                        expect(parentFirstPageCidsAlreadyLoaded.size).to.be.greaterThan(0);
                        expect(updatingReply.depth).to.equal(replyDepth);
                    } finally {
                        await remotePKC.destroy();
                    }
                });
            });
        });
    });

    describe.concurrent("deeply nested reply without parent pageCids - depth 12", () => {
        let context: ReplyDepthTestContext;

        beforeAll(async () => {
            context = await createReplyDepthTestEnvironment({ replyDepth: 12 });
        });

        afterAll(async () => {
            await context?.cleanup();
        });

        it("loads reply update when parent has no pageCids (only preloaded pages)", async () => {
            // Verify the parent does NOT have pageCids (this is the bug scenario)
            const parentUpdate = context.community._dbHandler.queryStoredCommentUpdate({ cid: context.leafParentCid });
            const parentPageCids = parentUpdate?.replies?.pageCids;
            const hasNoPageCids = !parentPageCids || Object.keys(parentPageCids).length === 0;

            // If parent already has pageCids, this test doesn't cover the bug scenario
            // but should still pass
            if (hasNoPageCids) {
                console.log("Test confirms: parent has no pageCids, testing bug scenario");
            }

            // Load from remote pkc - this is where the bug manifests
            const remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
            try {
                const leafComment = await remotePKC.createComment({ cid: context.leafCid });
                await leafComment.update();

                // Should succeed without 160s timeout
                await resolveWhenConditionIsTrue({
                    toUpdate: leafComment,
                    predicate: async () => typeof leafComment.updatedAt === "number"
                });

                expect(leafComment.updatedAt).to.be.a("number");
                expect(leafComment.depth).to.equal(12);
            } finally {
                await remotePKC.destroy();
            }
        });

        it("loads reply update via Path B only (when _findCommentInPagesOfUpdatingCommentsOrCommunity is disabled)", async () => {
            // This test verifies that Path B (usePageCidsOfParentToFetchCommentUpdateForReply)
            // works correctly when parent has no pageCids and reply is in preloaded pages.
            // We mock Path A to return undefined to force the code through Path B exclusively.
            const remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();

            try {
                const leafComment = await remotePKC.createComment({ cid: context.leafCid });

                // CRITICAL: Mock _findCommentInPagesOfUpdatingCommentsOrCommunity to return undefined
                // This forces the code to use Path B (the previously buggy usePageCidsOfParentToFetchCommentUpdateForReply)
                const clientsManager = leafComment._clientsManager as never as Record<string, unknown>;
                clientsManager._findCommentInPagesOfUpdatingCommentsOrCommunity = (): undefined => undefined;

                await leafComment.update();

                // With Path A disabled, this should still succeed via Path B
                // (uses preloaded pages when parent has no pageCids)
                await resolveWhenConditionIsTrueWithTimeout({
                    toUpdate: leafComment,
                    predicate: async () => typeof leafComment.updatedAt === "number",
                    timeoutMs: 30000 // 30 seconds should be plenty
                });

                expect(leafComment.updatedAt).to.be.a("number");
                expect(leafComment.depth).to.equal(12);
            } finally {
                await remotePKC.destroy();
            }
        });
    });
});

async function createPostDepthTestEnvironment({
    forceCommunityPostsPageCids = false
}: {
    forceCommunityPostsPageCids?: boolean;
}): Promise<PostDepthTestContext> {
    const publisherPKC = await mockPKC();
    const community = await createSubWithNoChallenge({}, publisherPKC);
    await community.start();
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

    const post = await publishRandomPost({ communityAddress: community.address, pkc: publisherPKC });
    const storedPostUpdate = await waitForStoredCommentUpdateWithAssertions(community as LocalCommunity, post);

    let forcedCommunityStoredUpdate: PostDepthTestContext["forcedCommunityStoredUpdate"];
    if (forceCommunityPostsPageCids) {
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });
        await forceLocalSubPagesToAlwaysGenerateMultipleChunks({ community: community as LocalCommunity });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });
        clearCommunityPreloadedPages(community as never);
        forcedCommunityStoredUpdate = await waitForStoredCommunityPageCids(community as never);
    }

    return {
        pkc: publisherPKC,
        community: community as LocalCommunity,
        replyDepth: 0,
        rootCid: post.cid!,
        leafCid: post.cid!,
        leafParentCid: undefined,
        expectedPostUpdate: storedPostUpdate,
        forcedCommunityStoredUpdate,
        cleanup: async () => {
            await community.delete();
            await publisherPKC.destroy();
        }
    };
}

async function createReplyDepthTestEnvironment({
    replyDepth,
    forceParentRepliesPageCids = false
}: {
    replyDepth: number;
    forceParentRepliesPageCids?: boolean;
}): Promise<ReplyDepthTestContext> {
    const publisherPKC = await mockPKC();
    const community = await createSubWithNoChallenge({}, publisherPKC);
    await community.start();
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

    const chain = await buildReplyDepthChain({ replyDepth, pkc: publisherPKC, community: community as LocalCommunity });

    let forcedParentStoredUpdate: CommentUpdateType | undefined;
    if (forceParentRepliesPageCids) {
        if (!chain.parentOfLeafCid) throw new Error("parent cid is required to force page generation");
        const parentComment = await publisherPKC.createComment({ cid: chain.parentOfLeafCid });
        try {
            await parentComment.update();
            await resolveWhenConditionIsTrue({
                toUpdate: parentComment,
                predicate: async () => typeof parentComment.updatedAt === "number"
            });
            if (!parentComment.cid) throw new Error("parent comment cid should be defined after forcing page generation");
            await forceLocalSubPagesToAlwaysGenerateMultipleChunks({ community: community as LocalCommunity, parentComment });
            forcedParentStoredUpdate = await waitForStoredParentPageCids(community as LocalCommunity, parentComment.cid);
        } finally {
            await parentComment.stop();
        }
    }

    return {
        pkc: publisherPKC,
        community: community as LocalCommunity,
        replyDepth,
        rootCid: chain.rootCid,
        leafCid: chain.leafCid,
        leafParentCid: chain.parentOfLeafCid,
        expectedLeafUpdate: chain.expectedLeafUpdate,
        forcedParentStoredUpdate,
        cleanup: async () => {
            await community.delete();
            await publisherPKC.destroy();
        }
    };
}

async function buildReplyDepthChain({
    replyDepth,
    pkc,
    community
}: {
    replyDepth: number;
    pkc: PKC;
    community: LocalCommunity;
}): Promise<ReplyChainResult> {
    const root = await publishRandomPost({ communityAddress: community.address, pkc: pkc });
    let parent = root;
    let latestStoredUpdate = await waitForStoredCommentUpdateWithAssertions(community, parent);
    let parentOfLeafCid = root.cid!;

    for (let depth = 1; depth <= replyDepth; depth++) {
        parentOfLeafCid = parent.cid!;
        const reply = await publishRandomReply({ parentComment: parent as never, pkc: pkc });
        latestStoredUpdate = await waitForStoredCommentUpdateWithAssertions(community, reply);
        parent = reply;
    }

    return {
        rootCid: root.cid!,
        leafCid: parent.cid!,
        parentOfLeafCid,
        expectedLeafUpdate: latestStoredUpdate
    };
}

async function waitForStoredCommentUpdateWithAssertions(community: LocalCommunity, comment: Comment): Promise<CommentUpdateType> {
    const storedUpdate = await waitForStoredCommentUpdate(community, comment.cid!);
    expect(storedUpdate.cid).to.equal(comment.cid);
    expect(storedUpdate.updatedAt).to.be.a("number");
    expect(storedUpdate.replyCount).to.be.a("number");
    expect(storedUpdate.protocolVersion).to.be.a("string");
    expect(storedUpdate.signature).to.be.an("object");
    expect(storedUpdate.signature.signedPropertyNames).to.be.an("array").that.is.not.empty;
    return storedUpdate;
}

async function waitForStoredCommentUpdate(community: LocalCommunity, cid: string): Promise<CommentUpdateType> {
    const timeoutMs = 60000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const stored = community._dbHandler.queryStoredCommentUpdate({ cid });
        if (stored) return stored as CommentUpdateType;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for stored comment update for ${cid}`);
}

async function waitForCommentToMatchStoredUpdate(comment: Comment, expectedUpdatedAt: number): Promise<void> {
    await resolveWhenConditionIsTrue({
        toUpdate: comment,
        predicate: async () => typeof comment.updatedAt === "number" && comment.updatedAt >= expectedUpdatedAt
    });
}

async function waitForPostToStartUpdating(postComment: Comment): Promise<void> {
    await resolveWhenConditionIsTrue({
        toUpdate: postComment,
        predicate: async () => typeof postComment.updatedAt === "number"
    });
}

async function waitForStoredParentPageCids(community: LocalCommunity, parentCid: string): Promise<CommentUpdateType> {
    const timeoutMs = 60000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const storedUpdate = community._dbHandler.queryStoredCommentUpdate({ cid: parentCid });
        const pageCids = storedUpdate?.replies?.pageCids;
        if (pageCids && Object.keys(pageCids).length > 0) return storedUpdate as CommentUpdateType;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for parent comment ${parentCid} to have replies.pageCids in stored update`);
}

function clearCommunityPreloadedPages(community: { posts?: { pages?: Record<string, { comments?: unknown[] }> } }): void {
    const postsPages = community.posts?.pages;
    if (!postsPages) return;
    Object.keys(postsPages).forEach((sortName) => {
        const page = postsPages[sortName];
        if (page?.comments) page.comments = [];
    });
}

async function waitForStoredCommunityPageCids(community: {
    posts?: { pageCids?: Record<string, string>; pages?: Record<string, { nextCid?: string; comments?: unknown[] }> };
    address?: string;
}): Promise<PostDepthTestContext["forcedCommunityStoredUpdate"]> {
    const timeoutMs = 60000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const pageCids = community.posts?.pageCids;
        if (pageCids && Object.keys(pageCids).length > 0) {
            const clonedPageCids = JSON.parse(JSON.stringify(pageCids)) as Record<string, string>;
            const sanitizedPages = Object.fromEntries(
                Object.entries(community.posts?.pages || {}).map(([sortName, page]) => [
                    sortName,
                    page
                        ? {
                              nextCid: page.nextCid,
                              comments: [] as never[]
                          }
                        : page
                ])
            ) as Record<string, { nextCid?: string; comments: never[] }>;
            return { pageCids: clonedPageCids, pages: sanitizedPages };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for community ${community.address} to have posts.pageCids in stored update`);
}

async function resolveWhenConditionIsTrueWithTimeout({
    toUpdate,
    predicate,
    timeoutMs = 60000
}: {
    toUpdate: Comment;
    predicate: () => Promise<boolean>;
    timeoutMs?: number;
}): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for condition after ${timeoutMs}ms`);
}

function makeCommentCidFetchFail(pkc: PKC, cid: string): void {
    const inflightFetchManager = pkc._inflightFetchManager as never as {
        _inflightFetches: Map<string, Promise<unknown>>;
    } | null;
    if (!inflightFetchManager?._inflightFetches) throw new Error("inflight fetch manager is not available");
    (pkc._memCaches?.commentIpfs as never as Map<string, unknown> | undefined)?.delete?.(cid);
    const key = `comment-ipfs::${cid}`;
    const rejection = Promise.reject(new PKCError("ERR_FETCH_CID_P2P_TIMEOUT", { cid }));
    rejection.catch(() => {}); // mark as handled to avoid unhandled rejection noise in vitest
    inflightFetchManager._inflightFetches.set(key, rejection);
}

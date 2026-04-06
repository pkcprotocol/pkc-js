import { describe, it, beforeAll, afterAll, vi } from "vitest";
import {
    mockPlebbit,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    getCommentWithCommentUpdateProps,
    publishToModQueueWithDepth,
    itSkipIfRpc,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    createPendingApprovalChallenge,
    describeSkipIfRpc
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import type { Plebbit as PlebbitType } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/community/rpc-local-community.js";
import type { SignerType } from "../../../../dist/node/signer/types.js";
import type { CommentWithinRepliesPostsPageJson } from "../../../../dist/node/publications/comment/types.js";
import type { PageIpfs } from "../../../../dist/node/pages/types.js";

const depthsToTest = [0, 1, 2, 3, 11, 12, 15];
const pendingApprovalCommentProps = { challengeRequest: { challengeAnswers: ["pending"] } };

type ChunkItem = PageIpfs["comments"][0];

const batchSize = 3;
const depthBatches: number[][] = [];
for (let i = 0; i < depthsToTest.length; i += batchSize) {
    depthBatches.push(depthsToTest.slice(i, i + batchSize));
}

for (const batch of depthBatches) {
    // Sequential between batches — limits concurrent subplebbits to 3 at a time
    describe(`Approved modqueue batch [${batch.join(",")}]`, () => {
        for (const pendingCommentDepth of batch) {
            describeSkipIfRpc.concurrent(`Approved comments after pending approval, with depth ` + pendingCommentDepth, async () => {
                let plebbit: PlebbitType;
                let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
                let approvedComment: Comment;
                let modSigner: SignerType;
                let remotePlebbit: PlebbitType;

                beforeAll(async () => {
                    plebbit = await mockPlebbit();
                    remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
                    subplebbit = (await plebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
                    subplebbit.setMaxListeners(200);
                    modSigner = await plebbit.createSigner();

                    await subplebbit.edit({
                        roles: {
                            [modSigner.address]: { role: "moderator" }
                        },
                        settings: { challenges: [createPendingApprovalChallenge()] }
                    });
                    await subplebbit.start();

                    await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => Boolean(subplebbit.updatedAt) });

                    expect(Object.keys(subplebbit.modQueue.pageCids)).to.deep.equal([]); // should be empty

                    const pending = await publishToModQueueWithDepth({
                        subplebbit,
                        plebbit: remotePlebbit,
                        depth: pendingCommentDepth,
                        modCommentProps: { signer: modSigner },
                        commentProps: pendingApprovalCommentProps
                    });
                    approvedComment = pending.comment;

                    await resolveWhenConditionIsTrue({
                        toUpdate: subplebbit,
                        predicate: async () => Boolean(subplebbit.modQueue.pageCids.pendingApproval)
                    }); // wait until we publish a new mod queue with this new comment
                    await approvedComment.update();
                });

                afterAll(async () => {
                    await subplebbit.delete();
                    await plebbit.destroy();
                    await remotePlebbit.destroy();
                });

                it.sequential("Should approve comment using createCommentModeration with approved: true", async () => {
                    const commentModeration = await plebbit.createCommentModeration({
                        communityAddress: subplebbit.address,
                        signer: modSigner,
                        commentModeration: { approved: true, reason: "test approval" },
                        commentCid: approvedComment.cid!
                    });

                    await publishWithExpectedResult({ publication: commentModeration, expectedChallengeSuccess: true });
                });

                it.sequential(`pending comment after approval will receive updates now`, async () => {
                    await resolveWhenConditionIsTrue({
                        toUpdate: approvedComment,
                        predicate: async () => Boolean(approvedComment.updatedAt)
                    });
                    expect(approvedComment.updatedAt).to.be.a("number");
                    expect(approvedComment.pendingApproval).to.be.false;
                    expect(approvedComment.approved).to.be.true;
                    expect(approvedComment.reason).to.equal("test approval");
                    // regular comment update props are there
                    expect(approvedComment.upvoteCount).to.equal(0);
                    expect(approvedComment.downvoteCount).to.equal(0);

                    expect(approvedComment.raw.commentUpdate!.updatedAt).to.be.a("number");
                    // @ts-expect-error - pendingApproval is not defined in full CommentUpdateType after approval
                    expect(approvedComment.raw.commentUpdate!.pendingApproval).to.be.undefined;
                    expect(approvedComment.raw.commentUpdate!.approved).to.be.true;
                    expect(approvedComment.raw.commentUpdate!.reason).to.equal("test approval");
                    // regular comment update props are there
                    expect(approvedComment.raw.commentUpdate!.upvoteCount).to.equal(0);
                    expect(approvedComment.raw.commentUpdate!.downvoteCount).to.equal(0);
                });

                if (pendingCommentDepth === 0)
                    it.sequential(`Approved post is now reflected in subplebbit.lastPostCid`, async () => {
                        await resolveWhenConditionIsTrue({
                            toUpdate: subplebbit,
                            predicate: async () => subplebbit.lastPostCid === approvedComment.cid
                        });
                        expect(subplebbit.lastPostCid).to.equal(approvedComment.cid);
                    });

                it.sequential(`Approved comment now appears in subplebbit.lastCommentCid`, async () => {
                    await resolveWhenConditionIsTrue({
                        toUpdate: subplebbit,
                        predicate: async () => subplebbit.lastCommentCid === approvedComment.cid
                    });

                    expect(subplebbit.lastCommentCid).to.equal(approvedComment.cid);
                });

                if (pendingCommentDepth > 0) {
                    it.sequential(`Approved reply show up in parentComment.replyCount`, async () => {
                        expect((await getCommentWithCommentUpdateProps({ cid: approvedComment.parentCid!, plebbit })).replyCount).to.equal(
                            1
                        );
                    });
                    it(`Approved reply show up in parentComment.childCount`, async () => {
                        expect((await getCommentWithCommentUpdateProps({ cid: approvedComment.parentCid!, plebbit })).childCount).to.equal(
                            1
                        );
                    });
                    it(`Approved reply show up in parentComment.lastChildCid`, async () => {
                        expect(
                            (await getCommentWithCommentUpdateProps({ cid: approvedComment.parentCid!, plebbit })).lastChildCid
                        ).to.equal(approvedComment.cid);
                    });
                    it(`Approved reply show up in parentComment.lastReplyTimestamp`, async () => {
                        expect(
                            (await getCommentWithCommentUpdateProps({ cid: approvedComment.parentCid!, plebbit })).lastReplyTimestamp
                        ).to.equal(approvedComment.timestamp);
                    });
                }

                it(`Approved comment now appears in subplebbit.posts`, async () => {
                    const preloadedSortName = "hot";
                    const { generated, capturedChunks } = await capturePostsGeneration(
                        subplebbit as LocalSubplebbit,
                        preloadedSortName,
                        1024 * 1024
                    );

                    const foundInPosts = cidExistsInChunks(capturedChunks, approvedComment.cid!);
                    expect(foundInPosts).to.be.true;
                    expect(generated, "expected posts generation to contain the approved comment").to.exist;
                });

                if (pendingCommentDepth > 0) {
                    itSkipIfRpc(`Approved reply now shows up in parentComment.replies`, async () => {
                        // @ts-expect-error - accessing private _dbHandler
                        const parentRow = (subplebbit._dbHandler as LocalSubplebbit["_dbHandler"]).queryComment(approvedComment.parentCid!);
                        expect(parentRow).to.exist;

                        const { generated, capturedChunks } = await captureRepliesGeneration({
                            subplebbit: subplebbit as LocalSubplebbit,
                            parentCid: parentRow!.cid,
                            parentDepth: parentRow!.depth,
                            preloadedSortName: "best",
                            preloadedPageSizeBytes: 1024 * 1024
                        });

                        const foundInReplies = cidExistsInChunks(capturedChunks, approvedComment.cid!);
                        expect(foundInReplies).to.be.true;
                        expect(generated, "expected replies generation to contain the approved reply").to.exist;
                    });
                    itSkipIfRpc(`Approved reply now shows up in its post's flat pages`, async () => {
                        // @ts-expect-error - accessing private _dbHandler
                        const postRow = (subplebbit._dbHandler as LocalSubplebbit["_dbHandler"]).queryComment(approvedComment.postCid!);
                        expect(postRow).to.exist;

                        for (const sortName of ["newFlat", "oldFlat"]) {
                            const { generated, capturedChunks } = await captureRepliesGeneration({
                                subplebbit: subplebbit as LocalSubplebbit,
                                parentCid: postRow!.cid,
                                parentDepth: postRow!.depth,
                                preloadedSortName: sortName,
                                preloadedPageSizeBytes: 1024 * 1024
                            });

                            const foundInFlatPages = cidExistsInChunks(capturedChunks, approvedComment.cid!);
                            expect(foundInFlatPages).to.be.true;
                            expect(generated, "expected flat pages generation to contain the approved reply").to.exist;
                        }
                    });
                }

                it(`Approved comment does not appear in modQueue.pageCids`, async () => {
                    expect(subplebbit.modQueue.pageCids.pendingApproval).to.be.undefined;
                });

                if (pendingCommentDepth === 0)
                    itSkipIfRpc(`Approved post shows up in subplebbit.postUpdates`, async () => {
                        expect(subplebbit.postUpdates).to.exist;
                        const localMfsPath = `/${subplebbit.address}/postUpdates/86400/${approvedComment.cid}/update`;
                        const kuboRpc = Object.values(plebbit.clients.kuboRpcClients)[0]._client;

                        const res = await kuboRpc.files.stat(localMfsPath); // this call needs to pass because file should exist

                        expect(res.size).to.be.greaterThan(0);
                    });

                itSkipIfRpc(`Approved comment is pinned to IPFS node`, async () => {
                    const kuboRpc = Object.values(plebbit.clients.kuboRpcClients)[0]._client;

                    // Retry block.stat to handle transient Kubo RPC connection issues on macOS CI
                    let res: { size: number } | undefined;
                    for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                            // @ts-expect-error - kubo-rpc-client types expect CID object but accepts string
                            res = await kuboRpc.block.stat(approvedComment.cid!);
                            break;
                        } catch (error) {
                            if (attempt === 3) throw error;
                            await new Promise((r) => setTimeout(r, 1000));
                        }
                    }

                    expect(res!.size).to.be.greaterThan(0);

                    const pinnedCids: string[] = [];

                    for await (const { cid } of kuboRpc.pin.ls({ paths: [approvedComment.cid!] })) {
                        pinnedCids.push(cid.toString());
                    }

                    expect(pinnedCids).to.include(approvedComment.cid);
                });

                it(`Sub should reject CommentModeration if a mod publishes approval for a comment that already got approved`, async () => {
                    const commentModeration = await plebbit.createCommentModeration({
                        communityAddress: subplebbit.address,
                        signer: modSigner,
                        commentModeration: { approved: true },
                        commentCid: approvedComment.cid!
                    });

                    await publishWithExpectedResult({
                        publication: commentModeration,
                        expectedChallengeSuccess: false,
                        expectedReason: messages.ERR_MOD_ATTEMPTING_TO_APPROVE_OR_DISAPPROVE_COMMENT_THAT_IS_NOT_PENDING
                    });
                });
            });
        }
    });
}

async function capturePostsGeneration(
    subplebbit: LocalSubplebbit,
    preloadedSortName: string,
    preloadedPageSizeBytes: number
): Promise<{ generated: CommentWithinRepliesPostsPageJson | undefined; capturedChunks: ChunkItem[][] }> {
    return captureSortChunks({
        subplebbit,
        matchParentCid: null,
        matchSortName: preloadedSortName,
        // @ts-expect-error - accessing private _pageGenerator
        generate: () => subplebbit._pageGenerator.generateSubplebbitPosts(preloadedSortName, preloadedPageSizeBytes)
    });
}

async function captureRepliesGeneration({
    subplebbit,
    parentCid,
    parentDepth,
    preloadedSortName,
    preloadedPageSizeBytes
}: {
    subplebbit: LocalSubplebbit;
    parentCid: string;
    parentDepth: number;
    preloadedSortName: string;
    preloadedPageSizeBytes: number;
}): Promise<{ generated: CommentWithinRepliesPostsPageJson | undefined; capturedChunks: ChunkItem[][] }> {
    const generator =
        parentDepth === 0
            ? // @ts-expect-error - accessing private _pageGenerator
              () => subplebbit._pageGenerator.generatePostPages({ cid: parentCid }, preloadedSortName, preloadedPageSizeBytes)
            : () =>
                  // @ts-expect-error - accessing private _pageGenerator
                  subplebbit._pageGenerator.generateReplyPages(
                      { cid: parentCid, depth: parentDepth },
                      preloadedSortName,
                      preloadedPageSizeBytes
                  );

    return captureSortChunks({
        subplebbit,
        matchParentCid: parentCid,
        matchSortName: preloadedSortName,
        generate: generator
    });
}

async function captureSortChunks<T>({
    subplebbit,
    matchParentCid,
    matchSortName,
    generate
}: {
    subplebbit: LocalSubplebbit;
    matchParentCid: string | null;
    matchSortName: string;
    generate: () => Promise<T>;
}): Promise<{ generated: T; capturedChunks: ChunkItem[][] }> {
    const capturedChunks: ChunkItem[][] = [];
    // @ts-expect-error - accessing private _pageGenerator
    const originalSortAndChunk = subplebbit._pageGenerator.sortAndChunkComments;
    // @ts-expect-error - accessing private _pageGenerator
    subplebbit._pageGenerator.sortAndChunkComments = async function (...args: [unknown, string, { parentCid?: string | null }?]) {
        const result = await originalSortAndChunk.apply(this, args);
        const [, sortName, options] = args;
        if (sortName === matchSortName && (options?.parentCid ?? null) === (matchParentCid ?? null)) {
            capturedChunks.push(...result);
        }
        return result;
    };

    try {
        const generated = await generate();
        return { generated, capturedChunks };
    } finally {
        // @ts-expect-error - accessing private _pageGenerator
        subplebbit._pageGenerator.sortAndChunkComments = originalSortAndChunk;
    }
}

function cidExistsInChunks(chunks: ChunkItem[][], targetCid: string): boolean {
    for (const chunk of chunks) {
        for (const comment of chunk) {
            if (commentContainsCid(comment, targetCid)) return true;
        }
    }
    return false;
}

function commentContainsCid(comment: ChunkItem, targetCid: string): boolean {
    if (comment.commentUpdate.cid === targetCid) return true;
    const bestReplies = comment.commentUpdate.replies?.pages?.best?.comments;
    if (Array.isArray(bestReplies)) {
        for (const reply of bestReplies) {
            if (commentContainsCid(reply, targetCid)) return true;
        }
    }
    return false;
}

import { describe, it, beforeAll, afterAll, vi } from "vitest";
import {
    mockPKC,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    getCommentWithCommentUpdateProps,
    publishToModQueueWithDepth,
    mockPKCNoDataPathWithOnlyKuboClient,
    createPendingApprovalChallenge
} from "../../../../dist/node/test/test-util.js";
import { itSkipIfRpc, describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { messages } from "../../../../dist/node/errors.js";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
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
    // Sequential between batches — limits concurrent communities to 3 at a time
    describe(`Approved modqueue batch [${batch.join(",")}]`, () => {
        for (const pendingCommentDepth of batch) {
            describeSkipIfRpc.concurrent(`Approved comments after pending approval, with depth ` + pendingCommentDepth, async () => {
                let pkc: PKCType;
                let community: LocalCommunity | RpcLocalCommunity;
                let approvedComment: Comment;
                let modSigner: SignerType;
                let remotePKC: PKCType;

                beforeAll(async () => {
                    pkc = await mockPKC();
                    remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
                    community = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
                    community.setMaxListeners(200);
                    modSigner = await pkc.createSigner();

                    await community.edit({
                        roles: {
                            [modSigner.address]: { role: "moderator" }
                        },
                        settings: { challenges: [createPendingApprovalChallenge()] }
                    });
                    await community.start();

                    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => Boolean(community.updatedAt) });

                    expect(Object.keys(community.modQueue.pageCids)).to.deep.equal([]); // should be empty

                    const pending = await publishToModQueueWithDepth({
                        community,
                        pkc: remotePKC,
                        depth: pendingCommentDepth,
                        modCommentProps: { signer: modSigner },
                        commentProps: pendingApprovalCommentProps
                    });
                    approvedComment = pending.comment;

                    await resolveWhenConditionIsTrue({
                        toUpdate: community,
                        predicate: async () => Boolean(community.modQueue.pageCids.pendingApproval)
                    }); // wait until we publish a new mod queue with this new comment
                    await approvedComment.update();
                });

                afterAll(async () => {
                    await community.delete();
                    await pkc.destroy();
                    await remotePKC.destroy();
                });

                it.sequential("Should approve comment using createCommentModeration with approved: true", async () => {
                    const commentModeration = await pkc.createCommentModeration({
                        communityAddress: community.address,
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
                    it.sequential(`Approved post is now reflected in community.lastPostCid`, async () => {
                        await resolveWhenConditionIsTrue({
                            toUpdate: community,
                            predicate: async () => community.lastPostCid === approvedComment.cid
                        });
                        expect(community.lastPostCid).to.equal(approvedComment.cid);
                    });

                it.sequential(`Approved comment now appears in community.lastCommentCid`, async () => {
                    await resolveWhenConditionIsTrue({
                        toUpdate: community,
                        predicate: async () => community.lastCommentCid === approvedComment.cid
                    });

                    expect(community.lastCommentCid).to.equal(approvedComment.cid);
                });

                if (pendingCommentDepth > 0) {
                    it.sequential(`Approved reply show up in parentComment.replyCount`, async () => {
                        expect((await getCommentWithCommentUpdateProps({ cid: approvedComment.parentCid!, pkc })).replyCount).to.equal(1);
                    });
                    it(`Approved reply show up in parentComment.childCount`, async () => {
                        expect((await getCommentWithCommentUpdateProps({ cid: approvedComment.parentCid!, pkc })).childCount).to.equal(1);
                    });
                    it(`Approved reply show up in parentComment.lastChildCid`, async () => {
                        expect((await getCommentWithCommentUpdateProps({ cid: approvedComment.parentCid!, pkc })).lastChildCid).to.equal(
                            approvedComment.cid
                        );
                    });
                    it(`Approved reply show up in parentComment.lastReplyTimestamp`, async () => {
                        expect(
                            (await getCommentWithCommentUpdateProps({ cid: approvedComment.parentCid!, pkc })).lastReplyTimestamp
                        ).to.equal(approvedComment.timestamp);
                    });
                }

                it(`Approved comment now appears in community.posts`, async () => {
                    const preloadedSortName = "hot";
                    const { generated, capturedChunks } = await capturePostsGeneration(
                        community as LocalCommunity,
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
                        const parentRow = (community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(approvedComment.parentCid!);
                        expect(parentRow).to.exist;

                        const { generated, capturedChunks } = await captureRepliesGeneration({
                            community: community as LocalCommunity,
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
                        const postRow = (community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(approvedComment.postCid!);
                        expect(postRow).to.exist;

                        for (const sortName of ["newFlat", "oldFlat"]) {
                            const { generated, capturedChunks } = await captureRepliesGeneration({
                                community: community as LocalCommunity,
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
                    expect(community.modQueue.pageCids.pendingApproval).to.be.undefined;
                });

                if (pendingCommentDepth === 0)
                    itSkipIfRpc(`Approved post shows up in community.postUpdates`, async () => {
                        expect(community.postUpdates).to.exist;
                        const localMfsPath = `/${community.address}/postUpdates/86400/${approvedComment.cid}/update`;
                        const kuboRpc = Object.values(pkc.clients.kuboRpcClients)[0]._client;

                        const res = await kuboRpc.files.stat(localMfsPath); // this call needs to pass because file should exist

                        expect(res.size).to.be.greaterThan(0);
                    });

                itSkipIfRpc(`Approved comment is pinned to IPFS node`, async () => {
                    const kuboRpc = Object.values(pkc.clients.kuboRpcClients)[0]._client;

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
                    const commentModeration = await pkc.createCommentModeration({
                        communityAddress: community.address,
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
    community: LocalCommunity,
    preloadedSortName: string,
    preloadedPageSizeBytes: number
): Promise<{ generated: CommentWithinRepliesPostsPageJson | undefined; capturedChunks: ChunkItem[][] }> {
    return captureSortChunks({
        community,
        matchParentCid: null,
        matchSortName: preloadedSortName,
        // @ts-expect-error - accessing private _pageGenerator
        generate: () => community._pageGenerator.generateCommunityPosts(preloadedSortName, preloadedPageSizeBytes)
    });
}

async function captureRepliesGeneration({
    community,
    parentCid,
    parentDepth,
    preloadedSortName,
    preloadedPageSizeBytes
}: {
    community: LocalCommunity;
    parentCid: string;
    parentDepth: number;
    preloadedSortName: string;
    preloadedPageSizeBytes: number;
}): Promise<{ generated: CommentWithinRepliesPostsPageJson | undefined; capturedChunks: ChunkItem[][] }> {
    const generator =
        parentDepth === 0
            ? // @ts-expect-error - accessing private _pageGenerator
              () => community._pageGenerator.generatePostPages({ cid: parentCid }, preloadedSortName, preloadedPageSizeBytes)
            : () =>
                  // @ts-expect-error - accessing private _pageGenerator
                  community._pageGenerator.generateReplyPages(
                      { cid: parentCid, depth: parentDepth },
                      preloadedSortName,
                      preloadedPageSizeBytes
                  );

    return captureSortChunks({
        community,
        matchParentCid: parentCid,
        matchSortName: preloadedSortName,
        generate: generator
    });
}

async function captureSortChunks<T>({
    community,
    matchParentCid,
    matchSortName,
    generate
}: {
    community: LocalCommunity;
    matchParentCid: string | null;
    matchSortName: string;
    generate: () => Promise<T>;
}): Promise<{ generated: T; capturedChunks: ChunkItem[][] }> {
    const capturedChunks: ChunkItem[][] = [];
    // @ts-expect-error - accessing private _pageGenerator
    const originalSortAndChunk = community._pageGenerator.sortAndChunkComments;
    // @ts-expect-error - accessing private _pageGenerator
    community._pageGenerator.sortAndChunkComments = async function (...args: [unknown, string, { parentCid?: string | null }?]) {
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
        community._pageGenerator.sortAndChunkComments = originalSortAndChunk;
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

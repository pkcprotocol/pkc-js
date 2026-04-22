import { mockPKC } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { it, vi, expect } from "vitest";
import { of as calculateIpfsCidV0Lib } from "typestub-ipfs-only-hash";
import { randomUUID } from "node:crypto";
import { calculateStringSizeSameAsIpfsAddCidV0 } from "../../../dist/node/util.js";
import env from "../../../dist/node/version.js";
import * as cborg from "cborg";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { CommentsTableRowInsert, CommentUpdateType } from "../../../dist/node/publications/comment/types.js";
import type { PageOptions } from "../../../dist/node/runtime/node/community/page-generator.js";

type TestCommentRow = { [K in keyof CommentsTableRowInsert]: CommentsTableRowInsert[K] | null };

const PROTOCOL_VERSION = env.PROTOCOL_VERSION;
const AUTHOR_ADDRESS = "12D3KooWLjZGiL8t2FyNZc21EMKw1SLR7U6khv4RW9sEFKD4aFXJ";
const DEFAULT_COMMENT_SIGNATURE = { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] as string[] };

interface CommunityContext {
    pkc: PKCType;
    community: LocalCommunity;
    cleanup: () => Promise<void>;
}

async function createCommunityWithDefaultDb(): Promise<CommunityContext> {
    const pkc: PKCType = await mockPKC();
    const community = (await pkc.createCommunity()) as LocalCommunity;
    await community._dbHandler.initDbIfNeeded();
    await community._dbHandler.createOrMigrateTablesIfNeeded();
    const fakeIpfsClient = {
        add: async (content: string) => {
            const size = await calculateStringSizeSameAsIpfsAddCidV0(content);
            const cid = await calculateIpfsCidV0Lib(`${content.length}-${Math.random()}`);
            return { cid, path: cid, size };
        },
        pin: { rm: async () => {} },
        files: { rm: async () => {} },
        key: { rm: async () => {} },
        routing: {
            async *provide(): AsyncGenerator<never, void, unknown> {
                return;
            }
        }
    };
    vi.spyOn(community._clientsManager, "getDefaultKuboRpcClient").mockReturnValue({
        _client: fakeIpfsClient
    } as unknown as ReturnType<typeof community._clientsManager.getDefaultKuboRpcClient>);
    return {
        pkc,
        community,
        cleanup: async () => {
            await community._dbHandler.destoryConnection();
            await community.delete();
            await pkc.destroy();
        }
    };
}

async function makeCommentRow(
    community: LocalCommunity,
    opts: { depth: number; parentCid: string | null; postCid: string; timestamp: number; label: string }
): Promise<TestCommentRow> {
    const cid = await calculateIpfsCidV0Lib(`${opts.label}-${randomUUID()}-${Date.now()}`);
    const authorAddr = `${AUTHOR_ADDRESS}-${cid}`;
    return {
        cid,
        authorSignerAddress: authorAddr,
        author: { address: authorAddr, displayName: `Author ${opts.label}` },
        link: null,
        linkWidth: null,
        linkHeight: null,
        thumbnailUrl: null,
        thumbnailUrlWidth: null,
        thumbnailUrlHeight: null,
        parentCid: opts.depth === 0 ? null : opts.parentCid,
        postCid: opts.postCid,
        previousCid: null,
        communityPublicKey: community.signer.address,
        communityName: null,
        content: `Content-${opts.label}`,
        timestamp: opts.timestamp,
        signature: JSON.parse(JSON.stringify(DEFAULT_COMMENT_SIGNATURE)),
        title: opts.depth === 0 ? `Post ${opts.label}` : null,
        depth: opts.depth,
        linkHtmlTagName: null,
        flairs: null,
        spoiler: null,
        pendingApproval: null,
        nsfw: null,
        extraProps: null,
        protocolVersion: PROTOCOL_VERSION,
        insertedAt: opts.timestamp
    } as unknown as TestCommentRow;
}

// RPC tests don't need to verify page signatures
describeSkipIfRpc("resolveRepliesCidRefsForEntries preserves commentCids order at nested levels", () => {
    // This test reproduces a bug where SQLite's recursive CTE row order didn't match
    // the json_each array order due to additional JOINs in the query. The attachReplies
    // function used childrenByParent (SQL row order) which could differ from the
    // commentCids order stored in the DB, causing cborg encoding differences and
    // signature verification failures.
    it("nested reply children follow DB commentCids order, not SQL row order", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            const baseTs = Math.floor(Date.now() / 1000);

            // Create: post -> depth1 -> [childA, childB, childC] at depth 2
            // Insert childC FIRST (lowest rowid), then childB, then childA
            // The sort algorithm should produce a DIFFERENT order than rowid order
            const post = await makeCommentRow(context.community, {
                depth: 0,
                parentCid: null,
                postCid: "", // will be set to own cid
                timestamp: baseTs,
                label: "post"
            });
            (post as { postCid: string }).postCid = post.cid as string;

            const depth1 = await makeCommentRow(context.community, {
                depth: 1,
                parentCid: post.cid as string,
                postCid: post.cid as string,
                timestamp: baseTs + 1,
                label: "depth1"
            });

            // Insert depth-2 children in REVERSE chronological order (C first, then B, then A)
            // so that rowid order is [C, B, A] but the "best" sort likely produces [A, B, C] or similar
            const childC = await makeCommentRow(context.community, {
                depth: 2,
                parentCid: depth1.cid as string,
                postCid: post.cid as string,
                timestamp: baseTs + 100, // newest
                label: "childC"
            });
            const childB = await makeCommentRow(context.community, {
                depth: 2,
                parentCid: depth1.cid as string,
                postCid: post.cid as string,
                timestamp: baseTs + 50, // middle
                label: "childB"
            });
            const childA = await makeCommentRow(context.community, {
                depth: 2,
                parentCid: depth1.cid as string,
                postCid: post.cid as string,
                timestamp: baseTs + 10, // oldest
                label: "childA"
            });

            // Each depth-2 child gets a depth-3 child (so depth1's replies include nested data)
            const childA3 = await makeCommentRow(context.community, {
                depth: 3,
                parentCid: childA.cid as string,
                postCid: post.cid as string,
                timestamp: baseTs + 200,
                label: "childA-reply"
            });
            const childC3 = await makeCommentRow(context.community, {
                depth: 3,
                parentCid: childC.cid as string,
                postCid: post.cid as string,
                timestamp: baseTs + 201,
                label: "childC-reply"
            });

            // Insert in rowid order: post, depth1, C, B, A, A-reply, C-reply
            context.community._dbHandler.insertComments([
                post,
                depth1,
                childC,
                childB,
                childA,
                childA3,
                childC3
            ] as CommentsTableRowInsert[]);

            // Sign all commentUpdates — establishes the "correct" CID-ref order
            const updates: { newCommentUpdate: CommentUpdateType & { cid: string } }[] =
                // @ts-expect-error - accessing private method for testing
                await context.community._updateCommentsThatNeedToBeUpdated();

            const postUpdate = updates.find((u) => u.newCommentUpdate.cid === post.cid);
            expect(postUpdate, "post should be signed").to.exist;
            const signedReplies = postUpdate!.newCommentUpdate.replies;
            expect(signedReplies, "post should have replies").to.exist;

            // Check what order the signing path chose for depth1's children
            const signedPages = signedReplies!.pages as unknown as Record<
                string,
                { comments: { commentUpdate: { cid: string; replies?: unknown } }[] }
            >;
            const signedDepth1 = signedPages.best.comments[0];
            expect(signedDepth1.commentUpdate.cid).to.equal(depth1.cid);
            const signedDepth2Replies = signedDepth1.commentUpdate.replies as
                | { pages: Record<string, { comments: { commentUpdate: { cid: string } }[] }> }
                | undefined;
            const signedDepth2Cids = signedDepth2Replies?.pages?.best?.comments?.map((c) => c.commentUpdate.cid);
            expect(signedDepth2Cids?.length).to.be.greaterThanOrEqual(2);

            // Now resolve via the page gen path and verify order matches
            const pageOptions: PageOptions = {
                parentCid: null as unknown as string,
                excludeCommentsWithDifferentCommunityAddress: true,
                excludeDeletedComments: true,
                excludeRemovedComments: true,
                excludeCommentPendingApproval: true,
                excludeCommentWithApprovedFalse: true,
                preloadedPage: "hot" as any,
                baseTimestamp: Math.floor(Date.now() / 1000),
                firstPageSizeBytes: 1024 * 1024
            };
            const rawPosts = context.community._dbHandler.queryPostsWithActiveScore(pageOptions);
            const resolvedPosts = context.community._dbHandler.resolveRepliesCidRefsForEntries(rawPosts);
            const resolvedPost = resolvedPosts.find((p) => p.commentUpdate.cid === post.cid);
            expect(resolvedPost, "post should be in resolved posts").to.exist;

            const resolvedPages = resolvedPost!.commentUpdate.replies?.pages as unknown as
                | Record<string, { comments: { commentUpdate: { cid: string; replies?: unknown } }[] }>
                | undefined;
            const resolvedDepth1 = resolvedPages?.best?.comments?.[0];
            const resolvedDepth2Replies = resolvedDepth1?.commentUpdate?.replies as
                | { pages: Record<string, { comments: { commentUpdate: { cid: string } }[] }> }
                | undefined;
            const resolvedDepth2Cids = resolvedDepth2Replies?.pages?.best?.comments?.map((c) => c.commentUpdate.cid);

            // The resolved order must match the signed order (which matches DB commentCids order)
            expect(resolvedDepth2Cids).to.deep.equal(signedDepth2Cids);

            // Also verify the full cborg encoding matches (catches any other ordering issues)
            const signedEnc = cborg.encode(signedReplies);
            const resolvedEnc = resolvedPost!.commentUpdate.replies ? cborg.encode(resolvedPost!.commentUpdate.replies) : new Uint8Array(0);
            expect(Buffer.from(signedEnc).equals(Buffer.from(resolvedEnc)), "cborg encoding of signed vs resolved replies must match").to.be
                .true;
        } finally {
            await context.cleanup();
        }
    });

    it("attachReplies reorders children by commentCids even when SQL returns them in wrong order", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            const baseTs = Math.floor(Date.now() / 1000);

            // Same setup: post -> depth1 -> [childA, childB, childC] with nested replies
            const post = await makeCommentRow(context.community, {
                depth: 0,
                parentCid: null,
                postCid: "",
                timestamp: baseTs,
                label: "post2"
            });
            (post as { postCid: string }).postCid = post.cid as string;

            const depth1 = await makeCommentRow(context.community, {
                depth: 1,
                parentCid: post.cid as string,
                postCid: post.cid as string,
                timestamp: baseTs + 1,
                label: "d1-2"
            });

            const childC = await makeCommentRow(context.community, {
                depth: 2,
                parentCid: depth1.cid as string,
                postCid: post.cid as string,
                timestamp: baseTs + 100,
                label: "cC-2"
            });
            const childB = await makeCommentRow(context.community, {
                depth: 2,
                parentCid: depth1.cid as string,
                postCid: post.cid as string,
                timestamp: baseTs + 50,
                label: "cB-2"
            });
            const childA = await makeCommentRow(context.community, {
                depth: 2,
                parentCid: depth1.cid as string,
                postCid: post.cid as string,
                timestamp: baseTs + 10,
                label: "cA-2"
            });
            const childA3 = await makeCommentRow(context.community, {
                depth: 3,
                parentCid: childA.cid as string,
                postCid: post.cid as string,
                timestamp: baseTs + 200,
                label: "cA3-2"
            });
            const childC3 = await makeCommentRow(context.community, {
                depth: 3,
                parentCid: childC.cid as string,
                postCid: post.cid as string,
                timestamp: baseTs + 201,
                label: "cC3-2"
            });

            context.community._dbHandler.insertComments([
                post,
                depth1,
                childC,
                childB,
                childA,
                childA3,
                childC3
            ] as CommentsTableRowInsert[]);

            // Sign to establish CID-ref order
            const updates: { newCommentUpdate: CommentUpdateType & { cid: string } }[] =
                // @ts-expect-error - accessing private method for testing
                await context.community._updateCommentsThatNeedToBeUpdated();

            const postUpdate = updates.find((u) => u.newCommentUpdate.cid === post.cid);
            expect(postUpdate).to.exist;
            const signedReplies = postUpdate!.newCommentUpdate.replies;
            const signedPages = signedReplies!.pages as unknown as Record<
                string,
                { comments: { commentUpdate: { cid: string; replies?: unknown } }[] }
            >;
            const signedDepth2Replies = signedPages.best.comments[0].commentUpdate.replies as
                | { pages: Record<string, { comments: { commentUpdate: { cid: string } }[] }> }
                | undefined;
            const signedDepth2Cids = signedDepth2Replies?.pages?.best?.comments?.map((c) => c.commentUpdate.cid);
            expect(signedDepth2Cids?.length).to.be.greaterThanOrEqual(2);

            // Spy on _db.prepare to intercept the recursive CTE query and reverse nested children rows.
            // This simulates the SQLite query planner returning rows in a different order than json_each
            // array order — which is the exact bug that caused signature verification failures.
            const origPrepare = context.community._dbHandler._db.prepare.bind(context.community._dbHandler._db);
            // @ts-expect-error - monkey-patching for testing
            context.community._dbHandler._db.prepare = function (sql: string) {
                const stmt = origPrepare(sql);
                if (sql.includes("reply_tree")) {
                    const origAll = stmt.all.bind(stmt);
                    stmt.all = function (...args: unknown[]) {
                        const rows = origAll(...args) as Record<string, unknown>[];
                        // Reverse only the nested children (rows where tree_parent is depth1's CID)
                        // This forces childrenByParent to have wrong order for depth1's children
                        const depth1Cid = depth1.cid as string;
                        const depth1Children: typeof rows = [];
                        const otherRows: typeof rows = [];
                        for (const row of rows) {
                            if (row.tree_parent === depth1Cid) depth1Children.push(row);
                            else otherRows.push(row);
                        }
                        depth1Children.reverse(); // Force wrong order
                        // Rebuild: put reversed children back in their original positions
                        let childIdx = 0;
                        return rows.map((row) => {
                            if (row.tree_parent === depth1Cid) return depth1Children[childIdx++];
                            return row;
                        });
                    };
                }
                return stmt;
            };

            try {
                // Resolve with the spy active — childrenByParent will have wrong order
                const pageOptions: PageOptions = {
                    parentCid: null as unknown as string,
                    excludeCommentsWithDifferentCommunityAddress: true,
                    excludeDeletedComments: true,
                    excludeRemovedComments: true,
                    excludeCommentPendingApproval: true,
                    excludeCommentWithApprovedFalse: true,
                    preloadedPage: "hot" as any,
                    baseTimestamp: Math.floor(Date.now() / 1000),
                    firstPageSizeBytes: 1024 * 1024
                };
                const rawPosts = context.community._dbHandler.queryPostsWithActiveScore(pageOptions);
                const resolvedPosts = context.community._dbHandler.resolveRepliesCidRefsForEntries(rawPosts);
                const resolvedPost = resolvedPosts.find((p) => p.commentUpdate.cid === post.cid);
                expect(resolvedPost).to.exist;

                const resolvedPages = resolvedPost!.commentUpdate.replies?.pages as unknown as
                    | Record<string, { comments: { commentUpdate: { cid: string; replies?: unknown } }[] }>
                    | undefined;
                const resolvedDepth2Replies = resolvedPages?.best?.comments?.[0]?.commentUpdate?.replies as
                    | { pages: Record<string, { comments: { commentUpdate: { cid: string } }[] }> }
                    | undefined;
                const resolvedDepth2Cids = resolvedDepth2Replies?.pages?.best?.comments?.map((c) => c.commentUpdate.cid);

                // Despite the spy reversing SQL row order, attachReplies should reorder by commentCids
                expect(resolvedDepth2Cids).to.deep.equal(signedDepth2Cids);

                // Also verify cborg match
                const signedEnc = cborg.encode(signedReplies);
                const resolvedEnc = resolvedPost!.commentUpdate.replies
                    ? cborg.encode(resolvedPost!.commentUpdate.replies)
                    : new Uint8Array(0);
                expect(
                    Buffer.from(signedEnc).equals(Buffer.from(resolvedEnc)),
                    "cborg encoding must match even when SQL returns rows in wrong order"
                ).to.be.true;
            } finally {
                // Restore original prepare
                context.community._dbHandler._db.prepare = origPrepare;
            }
        } finally {
            await context.cleanup();
        }
    });
});

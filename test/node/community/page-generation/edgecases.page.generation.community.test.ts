import { describeSkipIfRpc, mockPKC } from "../../../../dist/node/test/test-util.js";
import { it, vi } from "vitest";
import { of as calculateIpfsCidV0Lib } from "typestub-ipfs-only-hash";
import { randomUUID } from "node:crypto";
import * as remeda from "remeda";
import { cleanUpBeforePublishing } from "../../../../dist/node/signer/signatures.js";
import { calculateExpectedSignatureSize } from "../../../../dist/node/runtime/node/util.js";
import { calculateStringSizeSameAsIpfsAddCidV0, timestamp } from "../../../../dist/node/util.js";
import env from "../../../../dist/node/version.js";
import { sha256 } from "js-sha256";
import { PKCError } from "../../../../dist/node/pkc-error.js";

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { CommentsTableRow, CommentsTableRowInsert, CommentUpdateType } from "../../../../dist/node/publications/comment/types.js";
import type { RepliesPagesTypeIpfs } from "../../../../dist/node/pages/types.js";
import type { MockInstance } from "vitest";

interface CommunityContext {
    plebbit: PKCType;
    subplebbit: LocalCommunity;
    cleanup: () => Promise<void>;
}

interface TreeNode {
    label: string;
    contentTargetBytes?: number;
    cid?: string;
    timestamp?: number;
    authorSignerAddress?: string;
    content?: string;
    author?: CommentsTableRow["author"];
    title?: string;
    insertedAt?: number;
    children?: TreeNode[];
}

// Internal row type for test fixtures that allows null for optional fields
// (as is typical in SQLite databases where NULL represents missing values)
type TestCommentRow = {
    [K in keyof CommentsTableRow]: CommentsTableRow[K] | null;
};

interface SeedHeavyDiscussionOverrides {
    primaryChainDepth?: number;
    extraChildrenPerDepth?: Record<number, number> | number[];
    extraPrimaryPosts?: number;
    contentBytesPerDepth?: number[];
}

interface HeavyTreeLabels {
    depthLabels: string[];
}

interface SeededComments {
    rows: TestCommentRow[];
    labelToCid: Map<string, string>;
}

interface CommentUpdateResult {
    newCommentUpdate: CommentUpdateType & { cid: string };
}

const MB = 1024 * 1024;
const MAX_COMMENT_SIZE_BYTES = 40 * 1024;
const HEAVY_COMMENT_BYTES = 10 * 1024;
const PROTOCOL_VERSION = env.PROTOCOL_VERSION;
const AUTHOR_ADDRESS = "12D3KooWLjZGiL8t2FyNZc21EMKw1SLR7U6khv4RW9sEFKD4aFXJ";
const DEFAULT_COMMENT_SIGNATURE = {
    type: "ed25519",
    signature: "sig",
    publicKey: "pk",
    signedPropertyNames: [] as string[]
};
const DEFAULT_PRIMARY_CHAIN_DEPTH = 20;

// TODO we need to test loading pageCids and make sure they're all 1mib or under
// TODO need to make this test faster

// Helper to access private _pageGenerator property
function getPageGenerator(subplebbit: LocalCommunity) {
    // @ts-expect-error - accessing private property for testing
    return subplebbit._pageGenerator as import("../../../../dist/node/runtime/node/community/page-generator.js").PageGenerator;
}

// 36s on describe.concurrent
// 38s without concurrency
describeSkipIfRpc.concurrent("page-generator disables oversized preloaded pages", function () {
    it("returns undefined when attempting to generate mod queue pages with no pending approvals", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            const pageGenerator = getPageGenerator(context.subplebbit);
            const generatedModQueue = await pageGenerator.generateModQueuePages();
            expect(generatedModQueue, "expected no mod queue payload when pending approvals are empty").to.be.undefined;
        } finally {
            await context.cleanup();
        }
    });

    it("splits mod queue pending approvals into multiple CIDs when the serialized payload would exceed 1mib", async () => {
        const context = await createCommunityWithDefaultDb();
        const HEAVY_PENDING_COUNT = 120;
        let addQueuedChunkSpy: MockInstance | undefined;
        try {
            await seedPendingApprovalComments(context.subplebbit, {
                pendingCount: HEAVY_PENDING_COUNT,
                contentBytes: MAX_COMMENT_SIZE_BYTES - 512
            });
            const pendingRows = context.subplebbit._dbHandler.queryCommentsPendingApproval();
            expect(pendingRows.length, "all mod queue rows should be pending approval").to.equal(HEAVY_PENDING_COUNT);

            const pageGenerator = getPageGenerator(context.subplebbit);
            // @ts-expect-error - accessing private method for testing
            const originalAddQueued = pageGenerator.addQueuedCommentChunksToIpfs as (
                chunks: TestCommentRow[][],
                sortName: string
            ) => Promise<unknown>;
            let capturedChunks: TestCommentRow[][] | undefined;
            addQueuedChunkSpy = vi
                // @ts-expect-error - spying on private method for testing
                .spyOn(pageGenerator, "addQueuedCommentChunksToIpfs");
            addQueuedChunkSpy.mockImplementation(async (chunks: TestCommentRow[][], sortName: string) => {
                capturedChunks = chunks;
                return originalAddQueued.call(pageGenerator, chunks, sortName);
            });

            const generatedModQueue = await pageGenerator.generateModQueuePages();

            expect(generatedModQueue, "expected mod queue data to be generated").to.exist;
            expect(generatedModQueue?.pageCids?.pendingApproval, "expected pageCid for pendingApproval").to.be.a("string");
            expect(generatedModQueue?.combinedHashOfCids, "expected combined hash of queued comment cids").to.be.a("string");

            const expectedChunkCount = 4;
            expect(capturedChunks, "expected chunked mod queue data").to.exist;
            expect(capturedChunks?.length, "expected serialized mod queue data to require more than one chunk").to.equal(
                expectedChunkCount
            );

            for (let chunkIndex = 0; chunkIndex < capturedChunks!.length; chunkIndex++) {
                const chunk = capturedChunks![chunkIndex];
                const serializedChunkSize = await calculateModQueueChunkSize(chunk, chunkIndex < capturedChunks!.length - 1);
                const maxChunkSize = chunkIndex === 0 ? MB : MB * Math.pow(2, chunkIndex - 1);
                expect(serializedChunkSize, `mod queue chunk ${chunkIndex} should stay under ${maxChunkSize} bytes`).to.be.at.most(
                    maxChunkSize
                );
            }

            const expectedCombinedHash = sha256(pendingRows.map((row) => row.cid).join(""));
            expect(generatedModQueue?.combinedHashOfCids).to.equal(expectedCombinedHash);
        } catch (e) {
            throw e;
        } finally {
            addQueuedChunkSpy?.mockRestore();
            await context.cleanup();
        }
    });

    it("keeps subplebbit.posts as a single preloaded page while deeper replies move best sort into pageCids", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            const { labelToCid, labels, rows } = await seedHeavyDiscussion(context.subplebbit, {
                primaryChainDepth: 110
            });
            // @ts-expect-error - accessing private method for testing
            const updates: CommentUpdateResult[] = await context.subplebbit._updateCommentsThatNeedToBeUpdated();
            expect(updates.length).to.equal(111); // if args to seedHeavyDiscussion changes you need to update this value
            await expectCommentUpdatesUnderLimit(updates);

            const rootLabel = labels.depthLabels[0];
            expect(rootLabel).to.be.a("string");
            assertParentAndPostCid(rows, labelToCid, rootLabel, null, rootLabel);
            const rootCid = labelToCid.get(rootLabel);
            const rootUpdate = updates.find(({ newCommentUpdate }) => newCommentUpdate.cid === rootCid);
            expect(rootUpdate, "post update missing from _updateCommentsThatNeedToBeUpdated result").to.exist;
            await expectCommentUpdateUnderLimit(rootUpdate!.newCommentUpdate, "root update should stay under 1mib");

            const replies = rootUpdate!.newCommentUpdate.replies;
            expect(replies, "expected replies to exist on top-level post").to.exist;
            expect(replies?.pages?.best?.comments.length).to.be.greaterThan(0);
            expect(replies?.pageCids?.best).to.be.undefined;
            expectExclusiveBestPreloadLocation(replies!, "subplebbit.posts root");

            const movedDepths = logCommentsThatMovedBestPreloadToPageCids(updates, rows, "subplebbit.posts");
            expect(movedDepths).to.deep.equal([85, 60, 35, 10]);

            const preloadedSortName = "hot";
            const availablePostsSize = await calculateAvailablePostsSizeForCommunity(context.subplebbit);
            const pageGenerator = getPageGenerator(context.subplebbit);
            const generatedPosts = await pageGenerator.generateCommunityPosts(preloadedSortName, availablePostsSize);

            expect(generatedPosts, "expected generateCommunityPosts to return posts data").to.exist;
            expect(generatedPosts).to.have.property("singlePreloadedPage"); // deeper comments should've gotten folded

            const postsPages = generatedPosts as {
                pageCids?: Record<string, string>;
                pages?: Record<string, unknown>;
                singlePreloadedPage?: unknown;
            };
            expect(postsPages.pageCids).to.be.undefined;
            expect(postsPages.pageCids?.[preloadedSortName], "expected subplebbit.posts to be only a single preloaded page").to.be
                .undefined;
            expect(postsPages.pages?.[preloadedSortName], "expected subplebbit.posts to be only a single preloaded page").to.be.undefined;
        } catch (e) {
            throw e;
        } finally {
            await context.cleanup();
        }
    });

    it("returns undefined when attempting to paginate an empty subplebbit", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            const availablePostsSize = await calculateAvailablePostsSizeForCommunity(context.subplebbit);
            expect(availablePostsSize, "expected available posts budget to remain positive").to.be.greaterThan(0);
            const pageGenerator = getPageGenerator(context.subplebbit);
            const generatedPosts = await pageGenerator.generateCommunityPosts("hot", availablePostsSize);
            expect(generatedPosts, "expected no pagination output when there are no posts").to.be.undefined;
        } finally {
            await context.cleanup();
        }
    });

    it("keeps subplebbit.posts hot preloaded under tight budget (tighter inline replies, no collapse)", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            context.subplebbit.description = "x".repeat(600 * 1024); // large metadata shrinks available posts budget
            const oversizedPostsConfig: SeedHeavyDiscussionOverrides = {
                primaryChainDepth: 60,
                extraChildrenPerDepth: { 0: 320 },
                contentBytesPerDepth: Array.from({ length: 5 }, (_, depth) =>
                    depth === 1 ? MAX_COMMENT_SIZE_BYTES - 10 * 1024 : HEAVY_COMMENT_BYTES
                )
            };
            const { labelToCid, labels, rows } = await seedHeavyDiscussion(context.subplebbit, oversizedPostsConfig);
            // @ts-expect-error - accessing private method for testing
            const updates: CommentUpdateResult[] = await context.subplebbit._updateCommentsThatNeedToBeUpdated();
            expect(updates.length).to.equal(381);
            await expectCommentUpdatesUnderLimit(updates);

            const rootLabel = labels.depthLabels[0];
            expect(rootLabel).to.be.a("string");
            assertParentAndPostCid(rows, labelToCid, rootLabel, null, rootLabel);
            const rootCid = labelToCid.get(rootLabel);
            const rootUpdate = updates.find(({ newCommentUpdate }) => newCommentUpdate.cid === rootCid);
            expect(rootUpdate, "post update missing from _updateCommentsThatNeedToBeUpdated result").to.exist;
            await expectCommentUpdateUnderLimit(rootUpdate!.newCommentUpdate, "root update should stay under 1mib");

            const movedDepths = logCommentsThatMovedBestPreloadToPageCids(updates, rows, "subplebbit.posts");
            expect(movedDepths).to.deep.equal([35, 10]);

            const preloadedSortName = "hot";
            const availablePostsSize = await calculateAvailablePostsSizeForCommunity(context.subplebbit);
            expect(availablePostsSize, "expected production budget to drop below 700kb due to oversized metadata").to.be.lessThan(0.7 * MB);
            const pageGenerator = getPageGenerator(context.subplebbit);
            const originalSortAndChunk = pageGenerator.sortAndChunkComments.bind(pageGenerator);
            let capturedFirstChunk: Array<{ comment: unknown; commentUpdate: { replyCount?: number } }> | undefined;
            vi.spyOn(pageGenerator, "sortAndChunkComments").mockImplementation(async (...args: Parameters<typeof originalSortAndChunk>) => {
                const result = await originalSortAndChunk(...args);
                if (!capturedFirstChunk) capturedFirstChunk = result[0];
                return result;
            });

            const generatedPosts = await pageGenerator.generateCommunityPosts(preloadedSortName, availablePostsSize);

            expect(capturedFirstChunk, "expected to capture first chunk from sortAndChunkComments").to.exist;
            const firstChunkSerializedSize = await calculateStringSizeSameAsIpfsAddCidV0(JSON.stringify({ comments: capturedFirstChunk }));
            expect(firstChunkSerializedSize, "first chunk should fit within production preloaded budget").to.be.at.most(availablePostsSize);

            expect(capturedFirstChunk![0].commentUpdate.replyCount).to.equal(updates.length - 1);

            expect(capturedFirstChunk?.length ?? 0).to.equal(1);

            expect(generatedPosts, "expected generateCommunityPosts to return posts data").to.exist;
            expect(generatedPosts).to.have.property("singlePreloadedPage");
            expect((generatedPosts as { pageCids?: unknown }).pageCids).to.be.undefined;

            const preloadedHot = (generatedPosts as { singlePreloadedPage?: Record<string, { comments?: unknown[] }> })
                .singlePreloadedPage?.[preloadedSortName];
            expect(preloadedHot?.comments?.length, "expected hot to remain preloaded").to.be.greaterThan(0);
            expect(
                (generatedPosts as { pageCids?: Record<string, string> }).pageCids?.[preloadedSortName],
                "hot sort should not collapse into pageCids"
            ).to.be.undefined;
            const preloadedPost = (preloadedHot as { comments: Array<{ commentUpdate: { replies?: RepliesPagesTypeIpfs } }> }).comments[0];
            expect(
                preloadedPost.commentUpdate.replies?.pageCids?.best || preloadedPost.commentUpdate.replies?.pages?.best,
                "expected replies best sort to remain addressable after tighter budget"
            ).to.exist;
        } catch (e) {
            throw e;
        } finally {
            await context.cleanup();
        }
    });

    it("errors instead of collapsing subplebbit.posts preloads when the budget is too small", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            const { rows } = await seedHeavyDiscussion(context.subplebbit, { primaryChainDepth: 60 });
            expect(rows.length, "expected at least one seeded post").to.be.greaterThan(0);
            // @ts-expect-error - accessing private method for testing
            await context.subplebbit._updateCommentsThatNeedToBeUpdated();

            const tinyBudgetBytes = 512; // force preloaded chunk over budget
            const pageGenerator = getPageGenerator(context.subplebbit);
            let caughtError: Error | undefined;
            try {
                await pageGenerator.generateCommunityPosts("hot", tinyBudgetBytes);
            } catch (e) {
                caughtError = e as Error;
            }

            expect(caughtError, "expected generateCommunityPosts to reject when budget is too small").to.exist;
            expect(caughtError).to.be.instanceOf(PKCError);
            expect((caughtError as PKCError).code).to.equal("ERR_PAGE_GENERATED_IS_OVER_EXPECTED_SIZE");
        } finally {
            await context.cleanup();
        }
    });

    it("A post.replies preloaded page page higher than 1mib should not be published a preload, instead it send preloaded sort into pageCids", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            const { labelToCid, labels, rows } = await seedHeavyDiscussion(context.subplebbit, {
                primaryChainDepth: 95,
                extraPrimaryPosts: 3 // 6 posts in total with primaryChainDepth reply chain
            });
            // @ts-expect-error - accessing private method for testing
            const updates: CommentUpdateResult[] = await context.subplebbit._updateCommentsThatNeedToBeUpdated();
            expect(updates.length).to.equal(384); // if you change args above you need to change expectation
            await expectCommentUpdatesUnderLimit(updates);

            const depthLabels = labels.depthLabels;
            const rootLabel = depthLabels[0];
            const rootCid = labelToCid.get(rootLabel);
            expect(rootCid).to.be.a("string");

            const cidToLabel = new Map(Array.from(labelToCid.entries()).map(([label, cid]) => [cid, label]));
            const postRows = rows.filter((row) => row.depth === 0);
            expect(postRows.length, "expected at least one post").to.equal(4);

            for (const { cid } of postRows) {
                const label = cidToLabel.get(cid) ?? cid;
                const postUpdate = updates.find(({ newCommentUpdate }) => newCommentUpdate.cid === cid);
                expect(postUpdate, `expected post update for ${label}`).to.exist;
                const replies = postUpdate!.newCommentUpdate.replies;
                expect(replies, `expected replies on post ${label}`).to.exist;
                expect(replies?.pageCids?.best, `expected replies.pageCids.best to be undefined for post ${label}`).to.be.undefined;
                expect(replies?.pages?.best?.comments.length, `expected replies.pages.best.comments for post ${label}`).to.be.greaterThan(
                    0
                );
                expectExclusiveBestPreloadLocation(replies!, `post.replies post ${label}`);
            }

            const movedDepths = logCommentsThatMovedBestPreloadToPageCids(updates, rows, "post.replies");
            expect(movedDepths.length, "expected at least one comment to move best sort to pageCids").to.be.greaterThan(0);
            movedDepths.forEach((depth) => expect(depth).to.be.a("number"));
        } catch (e) {
            throw e;
        } finally {
            await context.cleanup();
        }
    });

    it("A reply.replies preloaded page page higher than 1mib should not be published a preload, instead it send preloaded sort into pageCids", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            const { rows } = await seedHeavyDiscussion(context.subplebbit, {
                primaryChainDepth: 150
            });
            // @ts-expect-error - accessing private method for testing
            const updates: CommentUpdateResult[] = await context.subplebbit._updateCommentsThatNeedToBeUpdated();
            expect(updates.length).to.equal(151);
            await expectCommentUpdatesUnderLimit(updates);

            const replyRowsWithReplies = rows.filter((row) => row.depth >= 1);
            expect(replyRowsWithReplies.length, "expected at least one reply comment with replies").to.equal(150);

            for (const { cid, depth } of replyRowsWithReplies) {
                const nestedReplyUpdate = updates.find(({ newCommentUpdate }) => newCommentUpdate.cid === cid);
                expect(nestedReplyUpdate, `reply update missing for cid ${cid}`).to.exist;
                await expectCommentUpdateUnderLimit(
                    nestedReplyUpdate!.newCommentUpdate,
                    `comment update ${cid} (depth ${depth}) should stay under 1mib`
                );

                const replies = nestedReplyUpdate!.newCommentUpdate.replies;
                if (nestedReplyUpdate!.newCommentUpdate.replyCount > 0) {
                    expect(replies, `expected replies for depth ${depth} comment ${cid}`).to.exist;
                    // we can't run expect here because we don't know for sure if preloaded moved to pageCids or stayed as a preloaded page
                    expectExclusiveBestPreloadLocation(replies!, `reply.replies depth ${depth} cid ${cid}`);
                }
            }

            const movedDepths = logCommentsThatMovedBestPreloadToPageCids(updates, rows, "reply.replies");
            expect(movedDepths.length, "expected at least one comment to move best sort to pageCids").to.be.greaterThan(0);
            movedDepths.forEach((depth) => expect(depth).to.be.a("number"));
        } catch (e) {
            throw e;
        } finally {
            await context.cleanup();
        }
    });
});

async function seedHeavyDiscussion(
    subplebbit: LocalCommunity,
    overrides: SeedHeavyDiscussionOverrides = {}
): Promise<SeededComments & { labels: HeavyTreeLabels }> {
    const { trees, labels } = buildHeavyTreeStructure(overrides);
    const seeded = await seedCommunityComments(subplebbit, trees);
    return { ...seeded, labels };
}

function buildHeavyTreeStructure({
    primaryChainDepth = DEFAULT_PRIMARY_CHAIN_DEPTH,
    extraChildrenPerDepth,
    extraPrimaryPosts = 0,
    contentBytesPerDepth
}: SeedHeavyDiscussionOverrides = {}): { trees: TreeNode[]; labels: HeavyTreeLabels } {
    const normalizedExtraChildren = normalizeExtraChildrenPlan(extraChildrenPerDepth, primaryChainDepth);
    const rootLabel = `edgecase-root-${randomUUID()}`;
    const depthLabels: string[] = [];
    depthLabels[0] = rootLabel;

    const trees: TreeNode[] = [
        buildTree({
            rootLabel,
            primaryChainDepth,
            normalizedExtraChildren,
            contentBytesPerDepth,
            captureDepthLabels: true,
            depthLabels
        })
    ];

    for (let index = 0; index < extraPrimaryPosts; index++) {
        trees.push(
            buildTree({
                rootLabel: `${rootLabel}-extra-${index + 1}`,
                primaryChainDepth,
                normalizedExtraChildren,
                contentBytesPerDepth
            })
        );
    }

    return { trees, labels: { depthLabels } };
}

interface BuildTreeParams {
    rootLabel: string;
    primaryChainDepth: number;
    normalizedExtraChildren: number[];
    contentBytesPerDepth?: number[];
    captureDepthLabels?: boolean;
    depthLabels?: string[];
}

function buildTree({
    rootLabel,
    primaryChainDepth,
    normalizedExtraChildren,
    contentBytesPerDepth,
    captureDepthLabels,
    depthLabels
}: BuildTreeParams): TreeNode {
    function bytesForDepth(depth: number): number {
        const override = Array.isArray(contentBytesPerDepth) ? contentBytesPerDepth[depth] : undefined;
        return typeof override === "number" && override > 0 ? override : HEAVY_COMMENT_BYTES;
    }

    function buildNode(depth: number, label: string): TreeNode {
        if (captureDepthLabels && depthLabels && !depthLabels[depth]) depthLabels[depth] = label;
        const node: TreeNode = {
            label,
            contentTargetBytes: bytesForDepth(depth)
        };
        if (depth >= primaryChainDepth) return node;

        const children: TreeNode[] = [];
        const primaryChildLabel = captureDepthLabels ? `${depthLabels![0]}-depth-${depth + 1}` : `${label}-depth-${depth + 1}`;
        children.push(buildNode(depth + 1, primaryChildLabel));

        const extraChildrenCount = normalizedExtraChildren[depth] ?? 0;
        for (let i = 0; i < extraChildrenCount; i++) {
            children.push({
                label: `${label}-extra-depth-${depth + 1}-${i}`,
                contentTargetBytes: bytesForDepth(depth + 1)
            });
        }

        if (children.length > 0) node.children = children;
        return node;
    }

    return buildNode(0, rootLabel);
}

function normalizeExtraChildrenPlan(
    extraChildrenPerDepth: Record<number, number> | number[] | undefined,
    primaryChainDepth: number
): number[] {
    const normalized: number[] = Array.from({ length: Math.max(0, primaryChainDepth) }, () => 0);
    if (!extraChildrenPerDepth) return normalized;

    const assignValue = (depth: number, count: number) => {
        if (!Number.isFinite(depth) || depth < 0 || depth >= primaryChainDepth) return;
        normalized[depth] = Math.max(0, Number(count) || 0);
    };

    if (Array.isArray(extraChildrenPerDepth)) {
        extraChildrenPerDepth.forEach((count, depth) => assignValue(depth, count));
    } else if (typeof extraChildrenPerDepth === "object") {
        Object.entries(extraChildrenPerDepth).forEach(([depthKey, count]) => assignValue(Number(depthKey), count));
    }

    return normalized;
}

async function calculateAvailablePostsSizeForCommunity(subplebbit: LocalCommunity): Promise<number> {
    const latestPost = subplebbit._dbHandler.queryLatestPostCid();
    const latestComment = subplebbit._dbHandler.queryLatestCommentCid();
    const stats = subplebbit._dbHandler.queryCommunityStats();
    const statsCid = await calculateIpfsCidV0Lib(JSON.stringify(stats));

    const postUpdates = { "86400": "QmX4Yd14J12ckSfsBjBarbMndo37oDFPNF3apF1reUhcHK" };

    const updatedAt = timestamp();

    const baseCommunity = cleanUpBeforePublishing({
        // @ts-expect-error - accessing private method for testing
        ...remeda.omit(subplebbit._toJSONIpfsBaseNoPosts(), ["signature"]),
        lastPostCid: latestPost?.cid,
        lastCommentCid: latestComment?.cid,
        statsCid,
        updatedAt,
        postUpdates: postUpdates as Record<string, string>,
        protocolVersion: PROTOCOL_VERSION
    });

    const baseSize = await calculateStringSizeSameAsIpfsAddCidV0(JSON.stringify(baseCommunity));
    const expectedSignatureSize = calculateExpectedSignatureSize(baseCommunity);
    return 1024 * 1024 - baseSize - expectedSignatureSize - 1000;
}

async function createCommunityWithDefaultDb(): Promise<CommunityContext> {
    // Keep the disk-backed database configuration to avoid storing large fixtures in memory.
    const plebbit: PKCType = await mockPKC();
    const subplebbit = (await plebbit.createCommunity()) as LocalCommunity;
    await subplebbit._dbHandler.initDbIfNeeded();
    await subplebbit._dbHandler.createOrMigrateTablesIfNeeded();
    const fakeIpfsClient = createFakeIpfsClient();
    vi.spyOn(subplebbit._clientsManager, "getDefaultKuboRpcClient").mockReturnValue({ _client: fakeIpfsClient } as unknown as ReturnType<
        typeof subplebbit._clientsManager.getDefaultKuboRpcClient
    >);
    return {
        plebbit,
        subplebbit,
        cleanup: async () => {
            await subplebbit._dbHandler.destoryConnection();
            await subplebbit.delete();
            await plebbit.destroy();
        }
    };
}

interface FakeIpfsAddResult {
    cid: string;
    path: string;
    size: number;
}

interface FakeIpfsClient {
    add: (content: string) => Promise<FakeIpfsAddResult>;
    pin: {
        rm: (...args: unknown[]) => Promise<void>;
    };
    files: {
        rm: (...args: unknown[]) => Promise<void>;
    };
    key: {
        rm: (...args: unknown[]) => Promise<void>;
    };
    routing: {
        provide: () => AsyncGenerator<never, void, unknown>;
    };
}

function createFakeIpfsClient(): FakeIpfsClient {
    const noopAsync = async (): Promise<void> => {};
    return {
        add: async (content: string): Promise<FakeIpfsAddResult> => {
            const size = await calculateStringSizeSameAsIpfsAddCidV0(content);
            const cid = await calculateIpfsCidV0Lib(`${content.length}-${Math.random()}`);
            return { cid, path: cid, size };
        },
        pin: {
            rm: noopAsync
        },
        files: {
            rm: noopAsync
        },
        key: {
            rm: noopAsync
        },
        routing: {
            async *provide(): AsyncGenerator<never, void, unknown> {
                return;
            }
        }
    };
}

async function seedCommunityComments(subplebbit: LocalCommunity, commentTrees: TreeNode[]): Promise<SeededComments> {
    if (!Array.isArray(commentTrees) || commentTrees.length === 0) throw new Error("commentTrees array is required");
    const { rows, labelToCid } = await buildTestCommentRowsFromTrees({
        communityPublicKey: subplebbit.signer.address,
        trees: commentTrees
    });
    subplebbit._dbHandler.insertComments(rows as CommentsTableRowInsert[]);
    return { rows, labelToCid };
}

async function seedPendingApprovalComments(
    subplebbit: LocalCommunity,
    { pendingCount, contentBytes = HEAVY_COMMENT_BYTES }: { pendingCount: number; contentBytes?: number }
): Promise<TestCommentRow[]> {
    if (!Number.isFinite(pendingCount) || pendingCount <= 0) throw new Error("pendingCount must be a positive number");
    const trees: TreeNode[] = Array.from({ length: pendingCount }, (_, index) => ({
        label: `modqueue-root-${index}-${randomUUID()}`,
        contentTargetBytes: contentBytes
    }));
    const { rows } = await buildTestCommentRowsFromTrees({
        communityPublicKey: subplebbit.signer.address,
        trees
    });
    for (const row of rows) {
        (row as { pendingApproval: boolean }).pendingApproval = true;
    }
    subplebbit._dbHandler.insertComments(rows as CommentsTableRowInsert[]);
    return rows;
}

async function buildTestCommentRowsFromTrees({
    communityPublicKey,
    trees
}: {
    communityPublicKey: string;
    trees: TreeNode[];
}): Promise<{ rows: TestCommentRow[]; labelToCid: Map<string, string> }> {
    const rows: TestCommentRow[] = [];
    const labelToCid = new Map<string, string>();
    let timestampCursor = Math.floor(Date.now() / 1000);

    async function traverse(node: TreeNode, depth: number, parentCid: string | null, rootCid: string | null): Promise<void> {
        const label = node.label ?? `node-${depth}-${rows.length}`;
        const cid = node.cid ?? (await generateRandomCid(label));
        labelToCid.set(label, cid);
        const postCid = depth === 0 ? cid : rootCid ?? parentCid ?? cid;
        const nodeTimestamp = node.timestamp ?? timestampCursor++;
        const authorSignerAddress = node.authorSignerAddress ?? `${AUTHOR_ADDRESS}-${cid}`;
        const content = node.content ?? (await createCommentContent(label, node.contentTargetBytes ?? HEAVY_COMMENT_BYTES));
        const commentRow: TestCommentRow = {
            cid,
            authorSignerAddress,
            author: node.author ?? { address: authorSignerAddress, displayName: `Author ${label}` },
            link: null,
            linkWidth: null,
            linkHeight: null,
            thumbnailUrl: null,
            thumbnailUrlWidth: null,
            thumbnailUrlHeight: null,
            parentCid: depth === 0 ? null : parentCid,
            postCid,
            previousCid: null,
            communityPublicKey: communityPublicKey,
            communityName: null,
            content,
            timestamp: nodeTimestamp,
            signature: cloneDefaultSignature(),
            title: depth === 0 ? node.title ?? `title-${label}` : null,
            depth,
            linkHtmlTagName: null,
            flairs: null,
            spoiler: null,
            pendingApproval: null,
            nsfw: null,
            extraProps: null,
            protocolVersion: PROTOCOL_VERSION,
            insertedAt: node.insertedAt ?? nodeTimestamp
        };
        rows.push(commentRow);
        const children = node.children ?? [];
        for (const child of children) {
            await traverse(child, depth + 1, cid, rootCid ?? cid);
        }
    }

    for (const tree of trees) {
        await traverse(tree, 0, null, null);
    }

    return { rows, labelToCid };
}

async function createCommentContent(prefix: string, targetBytes: number = MAX_COMMENT_SIZE_BYTES / 2 - 512): Promise<string> {
    const unit = `${prefix}-chunk-`;
    const unitBytes = await calculateStringSizeSameAsIpfsAddCidV0(unit);
    const repeat = Math.max(1, Math.floor(targetBytes / unitBytes));
    return unit.repeat(repeat);
}

async function generateRandomCid(label: string = "comment"): Promise<string> {
    const seed = `${label}-${randomUUID()}-${Date.now()}`;
    return calculateIpfsCidV0Lib(seed);
}

function cloneDefaultSignature(): typeof DEFAULT_COMMENT_SIGNATURE {
    return JSON.parse(JSON.stringify(DEFAULT_COMMENT_SIGNATURE));
}

async function calculateModQueueChunkSize(comments: unknown[], hasNextCid: boolean): Promise<number> {
    const payload = hasNextCid
        ? { comments, nextCid: "QmModQueueNextChunkCid6kjQYbKs" }
        : {
              comments
          };
    return await calculateStringSizeSameAsIpfsAddCidV0(JSON.stringify(payload));
}

function assertParentAndPostCid(
    rows: TestCommentRow[],
    labelToCid: Map<string, string>,
    label: string,
    parentLabel: string | null,
    rootLabel: string
): void {
    const cid = labelToCid.get(label);
    expect(cid, `missing cid for label ${label}`).to.be.a("string");
    const row = rows.find((entry) => entry.cid === cid);
    expect(row, `missing comment row for ${label}`).to.exist;
    const rootCid = labelToCid.get(rootLabel);
    expect(rootCid, "missing root cid").to.be.a("string");
    if (parentLabel) {
        const parentCid = labelToCid.get(parentLabel);
        expect(row!.parentCid).to.equal(parentCid);
    } else {
        expect(row!.parentCid).to.equal(null);
    }
    expect(row!.postCid).to.equal(rootCid);
}

async function expectCommentUpdatesUnderLimit(updates: CommentUpdateResult[], limitBytes: number = MB): Promise<void> {
    for (const { newCommentUpdate } of updates) {
        await expectCommentUpdateUnderLimit(
            newCommentUpdate,
            `comment update ${newCommentUpdate?.cid ?? "unknown"} should stay under 1mib`,
            limitBytes
        );
    }
}

async function expectCommentUpdateUnderLimit(
    commentUpdate: CommentUpdateType & { cid: string },
    contextMessage: string,
    limitBytes: number = MB
): Promise<number> {
    expect(commentUpdate, `${contextMessage} (comment update missing)`).to.exist;
    const serialized = JSON.stringify(commentUpdate);
    const sizeBytes = await calculateStringSizeSameAsIpfsAddCidV0(serialized);
    expect(sizeBytes, contextMessage).to.be.lessThan(limitBytes);
    return sizeBytes;
}

function expectExclusiveBestPreloadLocation(replies: CommentUpdateType["replies"], contextMessage: string): void {
    const hasPages = Boolean(replies?.pages?.best);
    const hasPageCids = Boolean(replies?.pageCids?.best);
    const total = Number(hasPages) + Number(hasPageCids);
    expect(total, `${contextMessage} should define best preload in pages or pageCids, not both`).to.equal(1);
}

function logCommentsThatMovedBestPreloadToPageCids(updates: CommentUpdateResult[], rows: TestCommentRow[], contextLabel: string): number[] {
    const cidToDepth = new Map(rows.map((row) => [row.cid, row.depth]));
    const movedComments = updates
        .map(({ newCommentUpdate }) => newCommentUpdate)
        .filter((update) => {
            const replies = update.replies;
            return Boolean(replies?.pageCids?.best) && !replies?.pages?.best;
        });

    const depths = movedComments.map(({ cid }) => cidToDepth.get(cid)).filter((depth): depth is number => typeof depth === "number");

    console.log(`${contextLabel} comments that moved best preload into pageCids (depths):`, depths);
    return depths;
}

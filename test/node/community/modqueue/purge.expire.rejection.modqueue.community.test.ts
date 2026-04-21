import { beforeAll, afterAll, describe, it } from "vitest";
import {
    mockPKC,
    mockGatewayPKC,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    publishToModQueueWithDepth,
    createPendingApprovalChallenge
} from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { SignerType } from "../../../../dist/node/signer/types.js";
import type { CommentUpdateType, CommentUpdatesRow } from "../../../../dist/node/publications/comment/types.js";

const pendingApprovalCommentProps = { challengeRequest: { challengeAnswers: ["pending"] } };

const ONE_MINUTE = 60;
const DEFAULT_MOD_PROPS = { approved: false, reason: "Expired disapproval" };

interface TestContext {
    pkc: PKCType;
    remotePKC: PKCType;
    community: LocalCommunity | RpcLocalCommunity;
    modSigner: SignerType;
    retentionSeconds?: number;
    cleanup: () => Promise<void>;
}

async function createTestContext({ retentionSeconds }: { retentionSeconds?: number } = {}): Promise<TestContext> {
    const pkc = await mockPKC();
    const remotePKC = await mockGatewayPKC();
    const community = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
    community.setMaxListeners(100);
    await community.start();
    const modSigner = await pkc.createSigner();

    const initialSettings = JSON.parse(JSON.stringify(community.settings ?? {}));
    const mergedChallenges = [createPendingApprovalChallenge()];

    const editedSettings: Record<string, unknown> = {
        ...initialSettings,
        challenges: mergedChallenges
    };

    if (typeof retentionSeconds === "number") editedSettings.purgeDisapprovedCommentsOlderThan = retentionSeconds;
    else delete editedSettings.purgeDisapprovedCommentsOlderThan;

    const editArgs: { roles: Record<string, { role: string }>; settings: typeof editedSettings } = {
        roles: { [modSigner.address]: { role: "moderator" } },
        settings: editedSettings
    };

    if (initialSettings.purgeDisapprovedCommentsOlderThan === undefined && retentionSeconds === undefined)
        delete editArgs.settings.purgeDisapprovedCommentsOlderThan;

    await community.edit(editArgs);
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => Boolean(community.updatedAt) });

    async function cleanup() {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    }

    return { pkc, remotePKC, community, modSigner, retentionSeconds, cleanup };
}

async function createDisapprovedComment(
    ctx: TestContext,
    { depth = 1, moderationProps = DEFAULT_MOD_PROPS }: { depth?: number; moderationProps?: { approved: boolean; reason?: string } } = {}
): Promise<Comment> {
    const pending = await publishToModQueueWithDepth({
        community: ctx.community,
        pkc: ctx.remotePKC,
        depth,
        modCommentProps: { signer: ctx.modSigner },
        commentProps: pendingApprovalCommentProps
    });
    const pendingComment = pending.comment;
    await resolveWhenConditionIsTrue({
        toUpdate: ctx.community,
        predicate: async () => Boolean(ctx.community.modQueue?.pageCids?.pendingApproval)
    });

    const commentModeration = await ctx.pkc.createCommentModeration({
        communityAddress: ctx.community.address,
        signer: ctx.modSigner,
        commentModeration: moderationProps,
        commentCid: pendingComment.cid!
    });
    await publishWithExpectedResult({ publication: commentModeration, expectedChallengeSuccess: true });

    await resolveWhenConditionIsTrue({
        toUpdate: ctx.community,
        predicate: async () => {
            // @ts-expect-error - accessing private _dbHandler
            const storedUpdate = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryStoredCommentUpdate({
                cid: pendingComment.cid!
            });
            return Boolean(storedUpdate && storedUpdate.approved === false);
        }
    });

    return pendingComment;
}

async function createApprovedComment(ctx: TestContext, { depth = 1 }: { depth?: number } = {}): Promise<Comment> {
    const pending = await publishToModQueueWithDepth({
        community: ctx.community,
        pkc: ctx.remotePKC,
        depth,
        modCommentProps: { signer: ctx.modSigner },
        commentProps: pendingApprovalCommentProps
    });
    const pendingComment = pending.comment;
    await resolveWhenConditionIsTrue({
        toUpdate: ctx.community,
        predicate: async () => Boolean(ctx.community.modQueue?.pageCids?.pendingApproval)
    });

    const commentModeration = await ctx.pkc.createCommentModeration({
        communityAddress: ctx.community.address,
        signer: ctx.modSigner,
        commentModeration: { approved: true },
        commentCid: pendingComment.cid!
    });
    await publishWithExpectedResult({ publication: commentModeration, expectedChallengeSuccess: true });

    await resolveWhenConditionIsTrue({
        toUpdate: ctx.community,
        predicate: async () => {
            // @ts-expect-error - accessing private _dbHandler
            const storedUpdate = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryStoredCommentUpdate({
                cid: pendingComment.cid!
            });
            return Boolean(storedUpdate && storedUpdate.approved === true);
        }
    });

    return pendingComment;
}

async function setPendingApproval(ctx: TestContext, commentCid: string, pending = true): Promise<void> {
    // @ts-expect-error - accessing private _dbHandler._db
    (ctx.community._dbHandler as LocalCommunity["_dbHandler"])._db
        .prepare(`UPDATE comments SET pendingApproval = ? WHERE cid = ?`)
        .run(pending ? 1 : 0, commentCid);
    await resolveWhenConditionIsTrue({
        toUpdate: ctx.community,
        predicate: async () => {
            // @ts-expect-error - accessing private _dbHandler
            const comment = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(commentCid);
            return Boolean(comment && (pending ? comment.pendingApproval : !comment.pendingApproval));
        }
    });
}

function backdateAllDisapprovals(ctx: TestContext, commentCid: string, secondsAgo: number): number {
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - secondsAgo;
    // @ts-expect-error - accessing private _dbHandler._db
    (ctx.community._dbHandler as LocalCommunity["_dbHandler"])._db
        .prepare(`UPDATE commentModerations SET timestamp = ? WHERE commentCid = ?`)
        .run(cutoffTimestamp, commentCid);
    return cutoffTimestamp;
}

function updateSpecificModerationTimestamp(ctx: TestContext, commentCid: string, rowIndex: number, secondsAgo: number): number {
    // @ts-expect-error - accessing private _dbHandler._db
    const row = (ctx.community._dbHandler as LocalCommunity["_dbHandler"])._db
        .prepare(`SELECT rowid FROM commentModerations WHERE commentCid = ? ORDER BY rowid ASC LIMIT 1 OFFSET ?`)
        .get(commentCid, rowIndex) as { rowid: number } | undefined;
    if (!row) throw new Error(`Expected moderation row at index ${rowIndex}`);
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - secondsAgo;
    // @ts-expect-error - accessing private _dbHandler._db
    (ctx.community._dbHandler as LocalCommunity["_dbHandler"])._db
        .prepare(`UPDATE commentModerations SET timestamp = ? WHERE rowid = ?`)
        .run(cutoffTimestamp, row.rowid);
    return cutoffTimestamp;
}

function backdateCommentUpdate(ctx: TestContext, commentCid: string, secondsAgo: number): number {
    const cutoffTimestamp = Math.floor(Date.now() / 1000) - secondsAgo;
    // @ts-expect-error - accessing private _dbHandler._db
    (ctx.community._dbHandler as LocalCommunity["_dbHandler"])._db
        .prepare(`UPDATE commentUpdates SET updatedAt = ? WHERE cid = ?`)
        .run(cutoffTimestamp, commentCid);
    return cutoffTimestamp;
}

describeSkipIfRpc("purgeDisapprovedCommentsOlderThan expirations", function () {
    describe("default retention configuration", () => {
        let pkc: PKCType;
        let community: LocalCommunity | RpcLocalCommunity;

        beforeAll(async () => {
            pkc = await mockPKC();
            community = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
            community.setMaxListeners(100);
            await community.start();
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => Boolean(community.updatedAt) });
        });

        afterAll(async () => {
            if (community) await community.delete();
            if (pkc) await pkc.destroy();
        });

        it("applies two-week default when unset", () => {
            expect(community.settings!.purgeDisapprovedCommentsOlderThan).to.equal(1.21e6);
        });
    });

    describe("when the first disapproval exceeds the retention window", () => {
        const retentionSeconds = ONE_MINUTE;
        let ctx: TestContext;
        let disapprovedComment: Comment;
        let commentBeforePurge: ReturnType<LocalCommunity["_dbHandler"]["queryComment"]>;
        let parentCid: string | undefined;
        let parentUpdateBefore: CommentUpdatesRow | undefined;
        let parentUpdateAfterPurge: CommentUpdatesRow | undefined;
        let parentUpdateAfterRefresh: CommentUpdatesRow | undefined;

        beforeAll(async () => {
            ctx = await createTestContext({ retentionSeconds });
            disapprovedComment = await createDisapprovedComment(ctx);
            parentCid = disapprovedComment.parentCid;
            // @ts-expect-error - accessing private _dbHandler
            commentBeforePurge = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(disapprovedComment.cid!);
            if (parentCid)
                // @ts-expect-error - accessing private _dbHandler
                (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).markCommentsAsPublishedToPostUpdates([parentCid]);
            parentUpdateBefore = parentCid
                ? // @ts-expect-error - accessing private _dbHandler
                  (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryStoredCommentUpdate({ cid: parentCid })
                : undefined;
            backdateAllDisapprovals(ctx, disapprovedComment.cid!, retentionSeconds + 10);
            // @ts-expect-error - accessing private _dbHandler
            (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).purgeDisapprovedCommentsOlderThan(retentionSeconds);
            parentUpdateAfterPurge = parentCid
                ? // @ts-expect-error - accessing private _dbHandler
                  (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryStoredCommentUpdate({ cid: parentCid })
                : undefined;
            if (parentCid) {
                // @ts-expect-error - accessing private _updateCommentsThatNeedToBeUpdated
                await (ctx.community as LocalCommunity)._updateCommentsThatNeedToBeUpdated();
                // @ts-expect-error - accessing private _dbHandler
                parentUpdateAfterRefresh = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryStoredCommentUpdate({
                    cid: parentCid
                });
            }
        });

        afterAll(async () => {
            if (ctx) await ctx.cleanup();
        });

        it("purges the disapproved comment", () => {
            expect(commentBeforePurge).to.exist;
            // @ts-expect-error - accessing private _dbHandler
            const after = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(disapprovedComment.cid!);
            expect(after).to.be.undefined;
            // @ts-expect-error - accessing private _dbHandler
            const updateAfter = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryStoredCommentUpdate({
                cid: disapprovedComment.cid!
            });
            expect(updateAfter).to.be.undefined;
        });

        it("removes the purged comment from kubo pins", async () => {
            const kuboRpc = Object.values(ctx.pkc.clients.kuboRpcClients)[0]._client;
            for await (const pin of kuboRpc.pin.ls()) {
                expect(pin.cid.toString()).to.not.equal(disapprovedComment.cid);
            }
        });

        it("forces parent comment to republish", () => {
            if (!parentCid) return;
            expect(parentUpdateBefore).to.exist;
            expect(parentUpdateAfterPurge).to.exist;
            expect(parentUpdateAfterPurge?.publishedToPostUpdatesMFS).to.be.false;
        });

        it("refreshes parent metadata after regeneration", () => {
            if (!parentCid) return;
            expect(parentUpdateAfterRefresh).to.exist;
            if (typeof parentUpdateBefore?.updatedAt === "number" && typeof parentUpdateAfterRefresh?.updatedAt === "number")
                expect(parentUpdateAfterRefresh.updatedAt).to.not.equal(parentUpdateBefore.updatedAt);
            expect(parentUpdateAfterRefresh?.lastChildCid).to.not.equal(disapprovedComment.cid);
            const replies = parentUpdateAfterRefresh?.replies;
            if (replies?.pageCids) {
                Object.values(replies.pageCids).forEach((cid) => {
                    if (typeof cid === "string") expect(cid).to.not.equal(disapprovedComment.cid);
                });
            }
        });
    });

    describe("when moderation is strictly {approved:false}", () => {
        let ctx: TestContext;
        let commentCid: string;
        let parentCid: string | undefined;
        let commentBeforeModeration: ReturnType<LocalCommunity["_dbHandler"]["queryComment"]>;
        let parentUpdateAfterImmediatePurge: CommentUpdatesRow | undefined;

        beforeAll(async () => {
            ctx = await createTestContext({ retentionSeconds: ONE_MINUTE });
            const pending = await publishToModQueueWithDepth({
                community: ctx.community,
                pkc: ctx.remotePKC,
                depth: 1,
                modCommentProps: { signer: ctx.modSigner },
                commentProps: pendingApprovalCommentProps
            });
            commentCid = pending.comment.cid!;
            parentCid = pending.comment.parentCid;
            await resolveWhenConditionIsTrue({
                toUpdate: ctx.community,
                predicate: async () => Boolean(ctx.community.modQueue?.pageCids?.pendingApproval)
            });
            // @ts-expect-error - accessing private _dbHandler
            commentBeforeModeration = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(commentCid);

            const moderation = await ctx.pkc.createCommentModeration({
                communityAddress: ctx.community.address,
                signer: ctx.modSigner,
                commentModeration: { approved: false },
                commentCid
            });
            await publishWithExpectedResult({ publication: moderation, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: ctx.community,
                // @ts-expect-error - accessing private _dbHandler
                predicate: async () => !(ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(commentCid)
            });
            parentUpdateAfterImmediatePurge = parentCid
                ? // @ts-expect-error - accessing private _dbHandler
                  (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryStoredCommentUpdate({ cid: parentCid })
                : undefined;
        });

        afterAll(async () => {
            if (ctx) await ctx.cleanup();
        });

        it("stores the pending comment before moderation runs", () => {
            expect(commentBeforeModeration).to.exist;
            expect(commentBeforeModeration?.pendingApproval).to.be.true;
        });

        it("purges the comment immediately after moderation", () => {
            // @ts-expect-error - accessing private _dbHandler
            const commentAfter = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(commentCid);
            expect(commentAfter).to.be.undefined;
            // @ts-expect-error - accessing private _dbHandler
            const updateAfter = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryStoredCommentUpdate({ cid: commentCid });
            expect(updateAfter).to.be.undefined;
        });

        it("ensures immediately purged comment is not pinned in kubo", async () => {
            const kuboRpc = Object.values(ctx.pkc.clients.kuboRpcClients)[0]._client;
            for await (const pin of kuboRpc.pin.ls()) {
                expect(pin.cid.toString()).to.not.equal(commentCid);
            }
        });

        it("forces parent comment to refresh", () => {
            if (!parentCid) return;
            expect(parentUpdateAfterImmediatePurge).to.exist;
            expect(parentUpdateAfterImmediatePurge?.publishedToPostUpdatesMFS).to.be.false;
        });
    });

    describe("when the disapproved item is a post", () => {
        const retentionSeconds = ONE_MINUTE;
        let ctx: TestContext;
        let disapprovedPost: Comment;
        let postBeforePurge: ReturnType<LocalCommunity["_dbHandler"]["queryComment"]>;
        let postUpdatesBucket: number;
        let postUpdatesPath: string;

        beforeAll(async () => {
            ctx = await createTestContext({ retentionSeconds });
            disapprovedPost = await createDisapprovedComment(ctx, {
                depth: 0,
                moderationProps: { approved: false, reason: "post rejection" }
            });
            const dbHandler = (ctx.community as LocalCommunity)._dbHandler;
            postBeforePurge = dbHandler.queryComment(disapprovedPost.cid!);
            const storedUpdateBefore = dbHandler.queryStoredCommentUpdate({
                cid: disapprovedPost.cid!
            });
            expect(storedUpdateBefore?.postUpdatesBucket).to.be.a("number");
            postUpdatesBucket = storedUpdateBefore!.postUpdatesBucket!;
            postUpdatesPath = `/${ctx.community.address}/postUpdates/${postUpdatesBucket}/${disapprovedPost.cid}/update`;
            console.log("[debug] pre-purge postUpdates path", postUpdatesPath);

            const kuboClientBefore = (ctx.community as LocalCommunity)._clientsManager.getDefaultKuboRpcClient()._client;
            const statBefore = await kuboClientBefore.files.stat(postUpdatesPath);
            expect(statBefore.size).to.be.greaterThan(0);

            backdateAllDisapprovals(ctx, disapprovedPost.cid!, retentionSeconds + 10);
            // @ts-expect-error - accessing private _purgeDisapprovedCommentsOlderThan
            await (ctx.community as LocalCommunity)._purgeDisapprovedCommentsOlderThan();
        });

        afterAll(async () => {
            if (ctx) await ctx.cleanup();
        });

        it(" stores the post prior to purge", () => {
            expect(postBeforePurge).to.exist;
            expect(postBeforePurge?.depth).to.equal(0);
            expect(postUpdatesBucket).to.be.a("number");
        });

        it(" purges the post once retention is exceeded", async () => {
            await new Promise((resolve) => setTimeout(resolve, 2000)); // wait till new post updates is flushed
            const dbHandler = (ctx.community as LocalCommunity)._dbHandler;
            const after = dbHandler.queryComment(disapprovedPost.cid!);
            expect(after).to.be.undefined;
            const updateAfter = dbHandler.queryStoredCommentUpdate({
                cid: disapprovedPost.cid!
            });
            expect(updateAfter).to.be.undefined;
            const kuboClientAfter = (ctx.community as LocalCommunity)._clientsManager.getDefaultKuboRpcClient()._client;
            try {
                const res = await kuboClientAfter.files.stat(postUpdatesPath);
                expect.fail("should fail");
            } catch (error) {
                expect((error as Error).message).to.equal("file does not exist");
            }
        });
    });

    describe("when {approved:false} is published on a post", () => {
        let ctx: TestContext;
        let commentCid: string;
        let commentBeforeModeration: ReturnType<LocalCommunity["_dbHandler"]["queryComment"]>;

        beforeAll(async () => {
            ctx = await createTestContext({ retentionSeconds: ONE_MINUTE });
            const pending = await publishToModQueueWithDepth({
                community: ctx.community,
                pkc: ctx.remotePKC,
                depth: 0,
                commentProps: pendingApprovalCommentProps
            });
            commentCid = pending.comment.cid!;
            await resolveWhenConditionIsTrue({
                toUpdate: ctx.community,
                predicate: async () => Boolean(ctx.community.modQueue?.pageCids?.pendingApproval)
            });
            // @ts-expect-error - accessing private _dbHandler
            commentBeforeModeration = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(commentCid);

            const moderation = await ctx.pkc.createCommentModeration({
                communityAddress: ctx.community.address,
                signer: ctx.modSigner,
                commentModeration: { approved: false },
                commentCid
            });
            await publishWithExpectedResult({ publication: moderation, expectedChallengeSuccess: true });
            await resolveWhenConditionIsTrue({
                toUpdate: ctx.community,
                // @ts-expect-error - accessing private _dbHandler
                predicate: async () => !(ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(commentCid)
            });
        });

        afterAll(async () => {
            if (ctx) await ctx.cleanup();
        });

        it(" removes the post immediately", () => {
            expect(commentBeforeModeration).to.exist;
            expect(commentBeforeModeration?.depth).to.equal(0);
            const after = (ctx.community as LocalCommunity)._dbHandler.queryComment(commentCid);
            expect(after).to.be.undefined;
        });
    });

    describe("when a pending reply is approved", () => {
        const retentionSeconds = ONE_MINUTE;
        let ctx: TestContext;
        let commentCid: string;
        let commentBeforePurge: ReturnType<LocalCommunity["_dbHandler"]["queryComment"]>;
        let commentAfterPurge: ReturnType<LocalCommunity["_dbHandler"]["queryComment"]>;

        beforeAll(async () => {
            ctx = await createTestContext({ retentionSeconds });
            const approved = await createApprovedComment(ctx);
            commentCid = approved.cid!;
            // @ts-expect-error - accessing private _dbHandler
            commentBeforePurge = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(commentCid);
            backdateCommentUpdate(ctx, commentCid, retentionSeconds + 120);
            // @ts-expect-error - accessing private _dbHandler
            (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).purgeDisapprovedCommentsOlderThan(retentionSeconds);
            // @ts-expect-error - accessing private _dbHandler
            commentAfterPurge = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(commentCid);
        });

        afterAll(async () => {
            if (ctx) await ctx.cleanup();
        });

        it(" stores the reply after approval", () => {
            expect(commentBeforePurge).to.exist;
            expect(commentBeforePurge?.depth).to.be.greaterThan(0);
        });

        it(" keeps the reply in database after purge", () => {
            expect(commentAfterPurge).to.exist;
            const update = (ctx.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({ cid: commentCid });
            expect(update).to.exist;
            expect(update?.approved).to.equal(true);
        });
    });

    describe("when a pending post is approved", () => {
        const retentionSeconds = ONE_MINUTE;
        let ctx: TestContext;
        let commentCid: string;
        let commentBeforePurge: ReturnType<LocalCommunity["_dbHandler"]["queryComment"]>;
        let commentAfterPurge: ReturnType<LocalCommunity["_dbHandler"]["queryComment"]>;

        beforeAll(async () => {
            ctx = await createTestContext({ retentionSeconds });
            const approved = await createApprovedComment(ctx, { depth: 0 });
            commentCid = approved.cid!;
            // @ts-expect-error - accessing private _dbHandler
            commentBeforePurge = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(commentCid);
            backdateCommentUpdate(ctx, commentCid, retentionSeconds + 120);
            // @ts-expect-error - accessing private _dbHandler
            (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).purgeDisapprovedCommentsOlderThan(retentionSeconds);
            // @ts-expect-error - accessing private _dbHandler
            commentAfterPurge = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(commentCid);
        });

        afterAll(async () => {
            if (ctx) await ctx.cleanup();
        });

        it(" stores the post after approval", () => {
            expect(commentBeforePurge).to.exist;
            expect(commentBeforePurge?.depth).to.equal(0);
        });

        it(" keeps the post in database after purge", () => {
            expect(commentAfterPurge).to.exist;
            const update = (ctx.community as LocalCommunity)._dbHandler.queryStoredCommentUpdate({ cid: commentCid });
            expect(update).to.exist;
            expect(update?.approved).to.equal(true);
        });
    });

    describe("when the disapproval is still inside the retention window", () => {
        const retentionSeconds = ONE_MINUTE * 10;
        let ctx: TestContext;
        let disapprovedComment: Comment;

        beforeAll(async () => {
            ctx = await createTestContext({ retentionSeconds });
            disapprovedComment = await createDisapprovedComment(ctx);
            backdateAllDisapprovals(ctx, disapprovedComment.cid!, retentionSeconds - 5);
            // @ts-expect-error - accessing private _dbHandler
            (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).purgeDisapprovedCommentsOlderThan(retentionSeconds);
        });

        afterAll(async () => {
            if (ctx) await ctx.cleanup();
        });

        it("keeps the disapproved comment", () => {
            // @ts-expect-error - accessing private _dbHandler
            const stored = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(disapprovedComment.cid!);
            expect(stored).to.exist;
        });
    });

    describe("when retention is missing or invalid", () => {
        const retentionSeconds = ONE_MINUTE;
        let ctx: TestContext;
        let disapprovedComment: Comment;

        beforeAll(async () => {
            ctx = await createTestContext({ retentionSeconds });
            disapprovedComment = await createDisapprovedComment(ctx);
            backdateAllDisapprovals(ctx, disapprovedComment.cid!, retentionSeconds + 20);
        });

        afterAll(async () => {
            if (ctx) await ctx.cleanup();
        });

        it("does nothing when retention is undefined", () => {
            // @ts-expect-error - accessing private _dbHandler
            (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).purgeDisapprovedCommentsOlderThan(undefined);
            // @ts-expect-error - accessing private _dbHandler
            const stored = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(disapprovedComment.cid!);
            expect(stored).to.exist;
        });

        it("does nothing when retention is non-positive", () => {
            // @ts-expect-error - accessing private _dbHandler
            (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).purgeDisapprovedCommentsOlderThan(0);
            // @ts-expect-error - accessing private _dbHandler
            const stored = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(disapprovedComment.cid!);
            expect(stored).to.exist;
        });

        it("purges once a valid retention is provided", () => {
            // @ts-expect-error - accessing private _dbHandler
            (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).purgeDisapprovedCommentsOlderThan(retentionSeconds);
            // @ts-expect-error - accessing private _dbHandler
            const stored = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(disapprovedComment.cid!);
            expect(stored).to.be.undefined;
        });
    });

    describe("when multiple disapprovals are recorded", () => {
        const retentionSeconds = ONE_MINUTE;
        let ctx: TestContext;
        let disapprovedComment: Comment;

        beforeAll(async () => {
            ctx = await createTestContext({ retentionSeconds });
            disapprovedComment = await createDisapprovedComment(ctx, {
                moderationProps: { approved: false, reason: "first disapproval" }
            });

            await setPendingApproval(ctx, disapprovedComment.cid!, true);

            const secondModeration = await ctx.pkc.createCommentModeration({
                communityAddress: ctx.community.address,
                signer: ctx.modSigner,
                commentModeration: { approved: false, reason: "second disapproval" },
                commentCid: disapprovedComment.cid!
            });
            await publishWithExpectedResult({ publication: secondModeration, expectedChallengeSuccess: true });
            await resolveWhenConditionIsTrue({
                toUpdate: ctx.community,
                predicate: async () => {
                    // @ts-expect-error - accessing private _dbHandler._db
                    const updates = (ctx.community._dbHandler as LocalCommunity["_dbHandler"])._db
                        .prepare(`SELECT COUNT(1) as count FROM commentModerations WHERE commentCid = ?`)
                        .get(disapprovedComment.cid!) as { count: number };
                    return updates?.count >= 2;
                }
            });

            updateSpecificModerationTimestamp(ctx, disapprovedComment.cid!, 0, retentionSeconds + 15);
            updateSpecificModerationTimestamp(ctx, disapprovedComment.cid!, 1, 5);
            // @ts-expect-error - accessing private _dbHandler
            (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).purgeDisapprovedCommentsOlderThan(retentionSeconds);
        });

        afterAll(async () => {
            if (ctx) await ctx.cleanup();
        });

        it("uses the earliest disapproval timestamp for expiration", () => {
            // @ts-expect-error - accessing private _dbHandler
            const stored = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(disapprovedComment.cid!);
            expect(stored).to.be.undefined;
        });
    });

    describe("when a comment gets reapproved before the cutoff", () => {
        const retentionSeconds = ONE_MINUTE;
        let ctx: TestContext;
        let disapprovedComment: Comment;

        beforeAll(async () => {
            ctx = await createTestContext({ retentionSeconds });
            disapprovedComment = await createDisapprovedComment(ctx);
            await setPendingApproval(ctx, disapprovedComment.cid!, true);

            const approval = await ctx.pkc.createCommentModeration({
                communityAddress: ctx.community.address,
                signer: ctx.modSigner,
                commentModeration: { approved: true },
                commentCid: disapprovedComment.cid!
            });
            await publishWithExpectedResult({ publication: approval, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: ctx.community,
                predicate: async () => {
                    // @ts-expect-error - accessing private _dbHandler
                    const stored = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryStoredCommentUpdate({
                        cid: disapprovedComment.cid!
                    });
                    return Boolean(stored && stored.approved === true);
                }
            });

            backdateAllDisapprovals(ctx, disapprovedComment.cid!, retentionSeconds + 30);
            // @ts-expect-error - accessing private _dbHandler
            (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).purgeDisapprovedCommentsOlderThan(retentionSeconds);
        });

        afterAll(async () => {
            if (ctx) await ctx.cleanup();
        });

        it("keeps the comment because it is no longer disapproved", () => {
            // @ts-expect-error - accessing private _dbHandler
            const stored = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(disapprovedComment.cid!);
            expect(stored).to.exist;
        });
    });

    describe("when no moderation record exists", () => {
        const retentionSeconds = ONE_MINUTE;
        let ctx: TestContext;
        let disapprovedComment: Comment;

        beforeAll(async () => {
            ctx = await createTestContext({ retentionSeconds });
            disapprovedComment = await createDisapprovedComment(ctx);
            // @ts-expect-error - accessing private _dbHandler._db
            (ctx.community._dbHandler as LocalCommunity["_dbHandler"])._db
                .prepare(`DELETE FROM commentModerations WHERE commentCid = ?`)
                .run(disapprovedComment.cid!);
            backdateCommentUpdate(ctx, disapprovedComment.cid!, retentionSeconds + 25);
            // @ts-expect-error - accessing private _dbHandler
            (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).purgeDisapprovedCommentsOlderThan(retentionSeconds);
        });

        afterAll(async () => {
            if (ctx) await ctx.cleanup();
        });

        it("falls back to the comment update timestamp for expiration", () => {
            // @ts-expect-error - accessing private _dbHandler
            const stored = (ctx.community._dbHandler as LocalCommunity["_dbHandler"]).queryComment(disapprovedComment.cid!);
            expect(stored).to.be.undefined;
        });
    });
});

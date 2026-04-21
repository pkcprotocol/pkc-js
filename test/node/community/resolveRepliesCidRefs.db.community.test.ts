import { it, describe, beforeAll, afterAll, expect } from "vitest";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type Database from "better-sqlite3";

// ──────────────────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────────────────

const COMMUNITY_ADDRESS = "12D3KooWTestResolveReplies";
const now = Math.floor(Date.now() / 1000);

function fakeSignatureJson(signatureValue: string): string {
    return JSON.stringify({
        type: "ed25519",
        signature: signatureValue,
        publicKey: `pk-${signatureValue}`,
        signedPropertyNames: [
            "communityPublicKey",
            "communityName",
            "content",
            "author",
            "timestamp",
            "title",
            "link",
            "parentCid",
            "postCid",
            "flairs",
            "spoiler",
            "nsfw",
            "linkWidth",
            "linkHeight",
            "linkHtmlTagName",
            "quotedCids"
        ]
    });
}

function fakeCommentUpdateSignatureJson(signatureValue: string): string {
    return JSON.stringify({
        type: "ed25519",
        signature: signatureValue,
        publicKey: `pk-${signatureValue}`,
        signedPropertyNames: [
            "cid",
            "edit",
            "upvoteCount",
            "downvoteCount",
            "replyCount",
            "childCount",
            "flairs",
            "spoiler",
            "nsfw",
            "pinned",
            "locked",
            "archived",
            "removed",
            "approved",
            "reason",
            "updatedAt",
            "replies",
            "author",
            "lastChildCid",
            "lastReplyTimestamp"
        ]
    });
}

interface FakeCommunity {
    address: string;
    _pkc: { noData: boolean };
    _cidsToUnPin: Set<string>;
    _blocksToRm: string[];
    _mfsPathsToRemove: Set<string>;
    _clientsManager: object;
    _calculateLocalMfsPathForCommentUpdate: () => string;
    _addOldPageCidsToCidsToUnpin: () => Promise<void>;
    _addAllCidsUnderPurgedCommentToBeRemoved: () => void;
}

function createFakeCommunity(address: string): FakeCommunity {
    return {
        address,
        _pkc: { noData: true },
        _cidsToUnPin: new Set<string>(),
        _blocksToRm: [],
        _mfsPathsToRemove: new Set<string>(),
        _clientsManager: {},
        _calculateLocalMfsPathForCommentUpdate: () => "",
        _addOldPageCidsToCidsToUnpin: async () => {},
        _addAllCidsUnderPurgedCommentToBeRemoved: () => {}
    };
}

interface DbHandlerPrivate {
    _db: Database.Database;
    _purgeCommentsWithInvalidSchemaOrSignature: () => Promise<void>;
    _purgeCommentEditsWithInvalidSchemaOrSignature: () => Promise<void>;
    _purgePublicationTablesWithDuplicateSignatures: () => Promise<void>;
}

function getPrivate(handler: DbHandler): DbHandlerPrivate {
    return handler as unknown as DbHandlerPrivate;
}

function insertComment(
    db: Database.Database,
    opts: { cid: string; parentCid: string | null; postCid: string; depth: number; pendingApproval?: number }
) {
    db.prepare(
        `INSERT INTO comments (cid, authorSignerAddress, author, postCid, parentCid, communityPublicKey,
            content, timestamp, signature, depth, pendingApproval, protocolVersion, insertedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        opts.cid,
        "12D3KooWTestAuthor",
        JSON.stringify({ address: "12D3KooWTestAuthor" }),
        opts.postCid,
        opts.parentCid,
        COMMUNITY_ADDRESS,
        `content for ${opts.cid}`,
        now,
        fakeSignatureJson(`sig-${opts.cid}`),
        opts.depth,
        opts.pendingApproval ?? null,
        "1.0.0",
        now
    );
}

function insertCommentUpdate(
    db: Database.Database,
    opts: {
        cid: string;
        replies?: string;
        removed?: number;
        edit?: string;
        approved?: number;
    }
) {
    db.prepare(
        `INSERT INTO commentUpdates (cid, upvoteCount, downvoteCount, replyCount, childCount,
            updatedAt, protocolVersion, signature, replies, removed, edit, approved, publishedToPostUpdatesMFS, insertedAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        opts.cid,
        1, // upvoteCount
        0, // downvoteCount
        0, // replyCount
        0, // childCount
        now, // updatedAt
        "1.0.0",
        fakeCommentUpdateSignatureJson(`update-sig-${opts.cid}`),
        opts.replies ?? null,
        opts.removed ?? null,
        opts.edit ?? null,
        opts.approved ?? null,
        1, // publishedToPostUpdatesMFS
        now
    );
}

// ──────────────────────────────────────────────────────────────
// Tests for resolveRepliesCidRefsForEntries
// ──────────────────────────────────────────────────────────────

// This test uses DbHandler directly (Node-only) and cannot run under RPC
describeSkipIfRpc("resolveRepliesCidRefsForEntries", function () {
    let dbHandler: DbHandler | undefined;

    afterAll(() => {
        if (dbHandler) {
            dbHandler.destoryConnection();
            dbHandler = undefined;
        }
    });

    beforeAll(async () => {
        const fakeCommunity = createFakeCommunity(COMMUNITY_ADDRESS);
        dbHandler = new DbHandler(fakeCommunity as unknown as LocalCommunity);
        await dbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });

        const priv = getPrivate(dbHandler);

        // Stub out purge methods — they verify real crypto signatures
        priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
        priv._purgeCommentEditsWithInvalidSchemaOrSignature = async () => {};
        priv._purgePublicationTablesWithDuplicateSignatures = async () => {};

        await dbHandler.createOrMigrateTablesIfNeeded();

        const db = priv._db;

        // ── Shared test data ──

        // Post (root)
        insertComment(db, { cid: "QmPost1", parentCid: null, postCid: "QmPost1", depth: 0 });
        insertCommentUpdate(db, { cid: "QmPost1" });

        // ── Data for Gap 2: disablePreload (pageCids-only) ──
        // Post with replies that only have allPageCids (no commentCids)
        insertComment(db, { cid: "QmPostDisablePreload", parentCid: null, postCid: "QmPostDisablePreload", depth: 0 });
        insertCommentUpdate(db, {
            cid: "QmPostDisablePreload",
            replies: JSON.stringify({
                best: { allPageCids: ["QmBestPage1", "QmBestPage2"] },
                new: { allPageCids: ["QmNewPage1"] }
            })
        });

        // ── Data for Gap 3: mixed preloaded + non-preloaded sorts ──
        // Post must be inserted before child (FK constraint)
        insertComment(db, { cid: "QmPostMixed", parentCid: null, postCid: "QmPostMixed", depth: 0 });

        // A child comment that will be referenced by commentCids
        insertComment(db, { cid: "QmChild1", parentCid: "QmPostMixed", postCid: "QmPostMixed", depth: 1 });
        insertCommentUpdate(db, { cid: "QmChild1" });
        insertCommentUpdate(db, {
            cid: "QmPostMixed",
            replies: JSON.stringify({
                best: { commentCids: ["QmChild1"], allPageCids: ["QmMixedBestPage"] },
                controversial: { allPageCids: ["QmControPage"] }
            })
        });

        // ── Data for Gap 6: empty allPageCids ──
        insertComment(db, { cid: "QmPostEmptyPages", parentCid: null, postCid: "QmPostEmptyPages", depth: 0 });
        insertCommentUpdate(db, {
            cid: "QmPostEmptyPages",
            replies: JSON.stringify({
                best: { allPageCids: [] },
                new: { commentCids: ["QmChild1"], allPageCids: [] }
            })
        });
    });

    it("resolves disablePreload replies to pageCids-only wire format (Gap 2)", () => {
        const entries = [
            {
                comment: { cid: "QmPostDisablePreload" } as any,
                commentUpdate: {
                    cid: "QmPostDisablePreload",
                    replies: {
                        best: { allPageCids: ["QmBestPage1", "QmBestPage2"] },
                        new: { allPageCids: ["QmNewPage1"] }
                    }
                } as any
            }
        ];

        const resolved = dbHandler!.resolveRepliesCidRefsForEntries(entries);

        expect(resolved).to.have.length(1);
        const replies = resolved[0].commentUpdate.replies as any;
        // Should produce wire format with empty pages and pageCids
        expect(replies.pages).to.deep.equal({});
        expect(replies.pageCids).to.deep.equal({
            best: "QmBestPage1",
            new: "QmNewPage1"
        });
    });

    it("resolves mixed preloaded + non-preloaded sorts correctly (Gap 3)", () => {
        const entries = [
            {
                comment: { cid: "QmPostMixed" } as any,
                commentUpdate: {
                    cid: "QmPostMixed",
                    replies: {
                        best: { commentCids: ["QmChild1"], allPageCids: ["QmMixedBestPage"] },
                        controversial: { allPageCids: ["QmControPage"] }
                    }
                } as any
            }
        ];

        const resolved = dbHandler!.resolveRepliesCidRefsForEntries(entries);

        expect(resolved).to.have.length(1);
        const replies = resolved[0].commentUpdate.replies as any;

        // "best" sort should have resolved inline pages with the child comment
        expect(replies.pages.best).to.exist;
        expect(replies.pages.best.comments).to.have.length(1);
        expect(replies.pages.best.comments[0].commentUpdate.cid).to.equal("QmChild1");

        // "controversial" sort should NOT have inline pages (no commentCids)
        expect(replies.pages.controversial).to.not.exist;

        // Both sorts should have pageCids
        expect(replies.pageCids.best).to.equal("QmMixedBestPage");
        expect(replies.pageCids.controversial).to.equal("QmControPage");
    });

    it("handles empty allPageCids array without producing pageCids entries (Gap 6)", () => {
        const entries = [
            {
                comment: { cid: "QmPostEmptyPages" } as any,
                commentUpdate: {
                    cid: "QmPostEmptyPages",
                    replies: {
                        best: { allPageCids: [] },
                        new: { commentCids: ["QmChild1"], allPageCids: [] }
                    }
                } as any
            }
        ];

        const resolved = dbHandler!.resolveRepliesCidRefsForEntries(entries);

        expect(resolved).to.have.length(1);
        const replies = resolved[0].commentUpdate.replies as any;

        // "best" has empty allPageCids and no commentCids — should produce no pageCid for best
        expect(replies.pageCids?.best).to.not.exist;

        // "new" has commentCids but empty allPageCids — should resolve inline pages but no pageCid
        expect(replies.pages.new).to.exist;
        expect(replies.pages.new.comments).to.have.length(1);
        expect(replies.pageCids?.new).to.not.exist;

        // pages.new should not have nextCid since allPageCids is empty
        expect(replies.pages.new.nextCid).to.not.exist;
    });

    it("passes through entries without CID-ref replies unchanged", () => {
        // Entry with wire-format replies (not DB CID-ref format) should be returned as-is
        const wireReplies = {
            pages: { best: { comments: [] as any[] } },
            pageCids: { best: "QmSomeCid" }
        };
        const entries = [
            {
                comment: { cid: "QmPost1" } as any,
                commentUpdate: {
                    cid: "QmPost1",
                    replies: wireReplies
                } as any
            }
        ];

        const resolved = dbHandler!.resolveRepliesCidRefsForEntries(entries);
        expect(resolved[0].commentUpdate.replies).to.deep.equal(wireReplies);
    });

    it("passes through entries with no replies unchanged", () => {
        const entries = [
            {
                comment: { cid: "QmPost1" } as any,
                commentUpdate: {
                    cid: "QmPost1"
                } as any
            }
        ];

        const resolved = dbHandler!.resolveRepliesCidRefsForEntries(entries);
        expect(resolved[0].commentUpdate.replies).to.be.undefined;
    });
});

// ──────────────────────────────────────────────────────────────
// Tests for queryFlattenedPageReplies recursive CTE filters
// ──────────────────────────────────────────────────────────────

// This test uses DbHandler directly (Node-only) and cannot run under RPC
describeSkipIfRpc("queryFlattenedPageReplies recursive CTE filters (Gap 4)", function () {
    let dbHandler: DbHandler | undefined;

    afterAll(() => {
        if (dbHandler) {
            dbHandler.destoryConnection();
            dbHandler = undefined;
        }
    });

    beforeAll(async () => {
        const fakeCommunity = createFakeCommunity(COMMUNITY_ADDRESS);
        dbHandler = new DbHandler(fakeCommunity as unknown as LocalCommunity);
        await dbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });

        const priv = getPrivate(dbHandler);
        priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
        priv._purgeCommentEditsWithInvalidSchemaOrSignature = async () => {};
        priv._purgePublicationTablesWithDuplicateSignatures = async () => {};

        await dbHandler.createOrMigrateTablesIfNeeded();

        const db = priv._db;

        // Build a tree: Post → Reply1 → Reply2 → Reply3
        // Post
        insertComment(db, { cid: "QmCtePost", parentCid: null, postCid: "QmCtePost", depth: 0 });
        insertCommentUpdate(db, { cid: "QmCtePost" });

        // Reply1 (normal)
        insertComment(db, { cid: "QmCteReply1", parentCid: "QmCtePost", postCid: "QmCtePost", depth: 1 });
        insertCommentUpdate(db, { cid: "QmCteReply1" });

        // Reply2 (will be marked removed)
        insertComment(db, { cid: "QmCteReply2", parentCid: "QmCteReply1", postCid: "QmCtePost", depth: 2 });
        insertCommentUpdate(db, { cid: "QmCteReply2", removed: 1 });

        // Reply3 (child of removed Reply2 — should also be excluded when parent is filtered)
        insertComment(db, { cid: "QmCteReply3", parentCid: "QmCteReply2", postCid: "QmCtePost", depth: 3 });
        insertCommentUpdate(db, { cid: "QmCteReply3" });

        // Reply4 (sibling of Reply2, under Reply1, marked deleted via edit)
        insertComment(db, { cid: "QmCteReply4", parentCid: "QmCteReply1", postCid: "QmCtePost", depth: 2 });
        insertCommentUpdate(db, { cid: "QmCteReply4", edit: JSON.stringify({ deleted: true }) });

        // Reply5 (sibling of Reply1, under Post, marked pendingApproval)
        insertComment(db, { cid: "QmCteReply5", parentCid: "QmCtePost", postCid: "QmCtePost", depth: 1, pendingApproval: 1 });
        insertCommentUpdate(db, { cid: "QmCteReply5" });

        // Reply6 (sibling of Reply1, under Post, with approved=0)
        insertComment(db, { cid: "QmCteReply6", parentCid: "QmCtePost", postCid: "QmCtePost", depth: 1 });
        insertCommentUpdate(db, { cid: "QmCteReply6", approved: 0 });

        // Reply7 (normal, under Post)
        insertComment(db, { cid: "QmCteReply7", parentCid: "QmCtePost", postCid: "QmCtePost", depth: 1 });
        insertCommentUpdate(db, { cid: "QmCteReply7" });
    });

    it("excludes removed comments from recursive tree", () => {
        const results = dbHandler!.queryFlattenedPageReplies({
            parentCid: "QmCtePost",
            excludeRemovedComments: true,
            excludeDeletedComments: false,
            excludeCommentPendingApproval: false,
            excludeCommentWithApprovedFalse: false,
            excludeCommentsWithDifferentCommunityAddress: false,
            preloadedPage: "best",
            baseTimestamp: now + 100
        });

        const cids = results.map((r) => r.commentUpdate.cid);
        expect(cids).to.include("QmCteReply1");
        expect(cids).to.not.include("QmCteReply2"); // removed
        // Reply3 is child of removed Reply2 — excluded because its parent is filtered out of the tree
        expect(cids).to.not.include("QmCteReply3");
        expect(cids).to.include("QmCteReply7");
    });

    it("excludes deleted comments from recursive tree", () => {
        const results = dbHandler!.queryFlattenedPageReplies({
            parentCid: "QmCtePost",
            excludeRemovedComments: false,
            excludeDeletedComments: true,
            excludeCommentPendingApproval: false,
            excludeCommentWithApprovedFalse: false,
            excludeCommentsWithDifferentCommunityAddress: false,
            preloadedPage: "best",
            baseTimestamp: now + 100
        });

        const cids = results.map((r) => r.commentUpdate.cid);
        expect(cids).to.include("QmCteReply1");
        expect(cids).to.not.include("QmCteReply4"); // deleted
        expect(cids).to.include("QmCteReply7");
    });

    it("excludes pendingApproval comments from recursive tree", () => {
        const results = dbHandler!.queryFlattenedPageReplies({
            parentCid: "QmCtePost",
            excludeRemovedComments: false,
            excludeDeletedComments: false,
            excludeCommentPendingApproval: true,
            excludeCommentWithApprovedFalse: false,
            excludeCommentsWithDifferentCommunityAddress: false,
            preloadedPage: "best",
            baseTimestamp: now + 100
        });

        const cids = results.map((r) => r.commentUpdate.cid);
        expect(cids).to.include("QmCteReply1");
        expect(cids).to.not.include("QmCteReply5"); // pendingApproval
        expect(cids).to.include("QmCteReply7");
    });

    it("excludes approved=false comments from recursive tree", () => {
        const results = dbHandler!.queryFlattenedPageReplies({
            parentCid: "QmCtePost",
            excludeRemovedComments: false,
            excludeDeletedComments: false,
            excludeCommentPendingApproval: false,
            excludeCommentWithApprovedFalse: true,
            excludeCommentsWithDifferentCommunityAddress: false,
            preloadedPage: "best",
            baseTimestamp: now + 100
        });

        const cids = results.map((r) => r.commentUpdate.cid);
        expect(cids).to.include("QmCteReply1");
        expect(cids).to.not.include("QmCteReply6"); // approved=0
        expect(cids).to.include("QmCteReply7");
    });

    it("applies all filters together in recursive tree", () => {
        const results = dbHandler!.queryFlattenedPageReplies({
            parentCid: "QmCtePost",
            excludeRemovedComments: true,
            excludeDeletedComments: true,
            excludeCommentPendingApproval: true,
            excludeCommentWithApprovedFalse: true,
            excludeCommentsWithDifferentCommunityAddress: false,
            preloadedPage: "best",
            baseTimestamp: now + 100
        });

        const cids = results.map((r) => r.commentUpdate.cid);
        // Only Reply1 and Reply7 should remain
        expect(cids).to.include("QmCteReply1");
        expect(cids).to.include("QmCteReply7");
        expect(cids).to.not.include("QmCteReply2"); // removed
        expect(cids).to.not.include("QmCteReply3"); // child of removed
        expect(cids).to.not.include("QmCteReply4"); // deleted
        expect(cids).to.not.include("QmCteReply5"); // pendingApproval
        expect(cids).to.not.include("QmCteReply6"); // approved=0
    });
});

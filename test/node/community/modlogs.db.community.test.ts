import { beforeEach, afterEach, describe, it } from "vitest";
import assert from "assert";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { CommentModerationPubsubMessagePublicationSchema } from "../../../dist/node/publications/comment-moderation/schema.js";
import { cleanWireAuthor } from "../../../dist/node/publications/publication-author.js";
import type { CommentModerationsTableRowInsert } from "../../../dist/node/publications/comment-moderation/types.js";
import { JsonSignatureSchema } from "../../../dist/node/schema/schema.js";
import { ExportCommunityModLogsOptionsSchema } from "../../../dist/node/community/schema.js";
import type { z } from "zod";

type JsonSignature = z.infer<typeof JsonSignatureSchema>;

const PROTOCOL_VERSION = "1.0.0";
// Two valid CIDv0s so we can test the commentCid filter (CID_A is referenced by two rows).
const CID_A = "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f";
const CID_B = "QmX7yV8dWgyMUiw5DSBt5ABToBWqi55GVEtnidAbNGGFoG";

function buildSignature(): JsonSignature {
    return {
        type: "ed25519",
        signature: "test-signature",
        publicKey: "test-public-key",
        signedPropertyNames: ["author", "commentModeration", "commentCid", "timestamp", "protocolVersion"]
    };
}

// DbHandler is a Node-only internal that is never reachable over RPC, so this DB-level suite that
// directly exercises queryAllCommentModerations (the query backing community.exportCommunityModLogs)
// is embedded-only.
describeSkipIfRpc("dbHandler.queryAllCommentModerations (exportCommunityModLogs backing query)", () => {
    let _dbHandler: DbHandler | undefined;
    let communityAddress: string;

    async function createTestDbHandler(): Promise<DbHandler> {
        communityAddress = `test-sub-${Date.now()}-${Math.random()}`;
        const fakePKC = { noData: true };
        const fakeCommunity = { address: communityAddress, _pkc: fakePKC };
        const handler = new DbHandler(fakeCommunity as never);
        await handler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await handler.createOrMigrateTablesIfNeeded();
        return handler;
    }

    function buildModRow(opts: {
        commentCid: string;
        timestamp: number;
        removed?: boolean;
        reason?: string;
        extraProps?: Record<string, unknown>;
    }): CommentModerationsTableRowInsert {
        const raw = {
            author: { name: "mod-author.eth" },
            commentCid: opts.commentCid,
            commentModeration: { removed: opts.removed ?? true, reason: opts.reason ?? "spam" },
            communityAddress,
            timestamp: opts.timestamp,
            signature: buildSignature(),
            protocolVersion: PROTOCOL_VERSION
        };
        // Mirror the strip + cleanWireAuthor pipeline local-community.ts storeCommentModeration applies before insert.
        const stripped = CommentModerationPubsubMessagePublicationSchema.strip().parse(raw);
        stripped.author = cleanWireAuthor(stripped.author);
        return {
            ...stripped,
            modSignerAddress: "12D3KooWModSigner",
            insertedAt: opts.timestamp,
            ...(opts.extraProps ? { extraProps: opts.extraProps } : {})
        } as CommentModerationsTableRowInsert;
    }

    function seedRows() {
        assert(_dbHandler, "DbHandler not initialised");
        _dbHandler.insertCommentModerations([
            buildModRow({ commentCid: CID_A, timestamp: 100, removed: true, reason: "first" }),
            buildModRow({ commentCid: CID_B, timestamp: 200, removed: false, reason: "second" }),
            buildModRow({ commentCid: CID_A, timestamp: 300, removed: true, reason: "third" })
        ]);
    }

    beforeEach(async () => {
        _dbHandler = await createTestDbHandler();
        assert(_dbHandler, "Failed to initialise DbHandler");
    });

    afterEach(async () => {
        if (_dbHandler) {
            await _dbHandler.destoryConnection();
            _dbHandler = undefined;
        }
    });

    it("returns JSON columns parsed into objects (not strings)", () => {
        assert(_dbHandler);
        seedRows();
        const rows = _dbHandler.queryAllCommentModerations();
        expect(rows.length).to.equal(3);
        const row = rows[0]; // newest (timestamp 300, reason "third", removed true)
        expect(row.commentModeration).to.be.an("object");
        expect(row.commentModeration).to.not.be.a("string");
        expect(row.commentModeration.removed).to.equal(true);
        expect(row.commentModeration.reason).to.equal("third");
        expect(row.signature).to.be.an("object");
        expect(row.signature).to.not.be.a("string");
        expect(row.author).to.be.an("object");
        expect(row.author).to.have.property("name", "mod-author.eth");
    });

    it("orders newest-first by default (timestamp DESC) and ASC when requested", () => {
        assert(_dbHandler);
        seedRows();
        const desc = _dbHandler.queryAllCommentModerations();
        expect(desc.map((r) => r.timestamp)).to.deep.equal([300, 200, 100]);
        const asc = _dbHandler.queryAllCommentModerations({ order: "ASC" });
        expect(asc.map((r) => r.timestamp)).to.deep.equal([100, 200, 300]);
    });

    it("filters by startTimestamp / endTimestamp window", () => {
        assert(_dbHandler);
        seedRows();
        const fromMid = _dbHandler.queryAllCommentModerations({ startTimestamp: 200 });
        expect(fromMid.map((r) => r.timestamp)).to.deep.equal([300, 200]);
        const untilMid = _dbHandler.queryAllCommentModerations({ endTimestamp: 200 });
        expect(untilMid.map((r) => r.timestamp)).to.deep.equal([200, 100]);
        const exact = _dbHandler.queryAllCommentModerations({ startTimestamp: 200, endTimestamp: 200 });
        expect(exact.map((r) => r.timestamp)).to.deep.equal([200]);
    });

    it("filters by commentCid", () => {
        assert(_dbHandler);
        seedRows();
        const cidA = _dbHandler.queryAllCommentModerations({ commentCid: CID_A });
        expect(cidA.map((r) => r.timestamp)).to.deep.equal([300, 100]);
        cidA.forEach((r) => expect(r.commentCid).to.equal(CID_A));
    });

    it("caps results with limit, applied after ordering", () => {
        assert(_dbHandler);
        seedRows();
        const newest = _dbHandler.queryAllCommentModerations({ limit: 1 });
        expect(newest.map((r) => r.timestamp)).to.deep.equal([300]);
        const oldest = _dbHandler.queryAllCommentModerations({ limit: 1, order: "ASC" });
        expect(oldest.map((r) => r.timestamp)).to.deep.equal([100]);
    });

    it("returns an empty array when there are no moderations", () => {
        assert(_dbHandler);
        expect(_dbHandler.queryAllCommentModerations()).to.deep.equal([]);
    });

    it("composes commentCid + timestamp window + order + limit filters in a single query (AND semantics)", () => {
        assert(_dbHandler);
        // Extra CID_A rows at timestamps 150 and 250 so the window can slice within one CID.
        _dbHandler.insertCommentModerations([
            buildModRow({ commentCid: CID_A, timestamp: 100, reason: "a-100" }),
            buildModRow({ commentCid: CID_B, timestamp: 150, reason: "b-150" }), // excluded by commentCid
            buildModRow({ commentCid: CID_A, timestamp: 200, reason: "a-200" }),
            buildModRow({ commentCid: CID_A, timestamp: 300, reason: "a-300" }), // excluded by endTimestamp
            buildModRow({ commentCid: CID_A, timestamp: 250, reason: "a-250" })
        ]);
        // CID_A AND 150 <= timestamp <= 250, ASC → [200, 250]; CID_B@150 and CID_A@{100,300} all excluded.
        const rows = _dbHandler.queryAllCommentModerations({
            commentCid: CID_A,
            startTimestamp: 150,
            endTimestamp: 250,
            order: "ASC"
        });
        expect(rows.map((r) => r.timestamp)).to.deep.equal([200, 250]);
        rows.forEach((r) => expect(r.commentCid).to.equal(CID_A));
        // limit applies after the combined WHERE + ORDER BY.
        const limited = _dbHandler.queryAllCommentModerations({
            commentCid: CID_A,
            startTimestamp: 150,
            endTimestamp: 250,
            order: "ASC",
            limit: 1
        });
        expect(limited.map((r) => r.timestamp)).to.deep.equal([200]);
    });

    it("round-trips extraProps as a parsed object (not a string)", () => {
        assert(_dbHandler);
        _dbHandler.insertCommentModerations([
            buildModRow({ commentCid: CID_A, timestamp: 100, extraProps: { customField: "hello", nested: { n: 1 } } })
        ]);
        const rows = _dbHandler.queryAllCommentModerations();
        expect(rows.length).to.equal(1);
        expect(rows[0].extraProps).to.be.an("object");
        expect(rows[0].extraProps).to.not.be.a("string");
        expect(rows[0].extraProps).to.deep.equal({ customField: "hello", nested: { n: 1 } });
    });

    // limit is a runtime option, so the public ExportCommunityModLogsOptionsSchema is what guards it.
    it("schema rejects non-positive limit and accepts a positive integer or omission", () => {
        // omit → unlimited (valid)
        expect(ExportCommunityModLogsOptionsSchema.safeParse({}).success).to.equal(true);
        expect(ExportCommunityModLogsOptionsSchema.safeParse({ limit: 1 }).success).to.equal(true);
        // 0 used to be accepted (nonnegative) and silently returned zero rows via SQL LIMIT 0 — now rejected.
        expect(ExportCommunityModLogsOptionsSchema.safeParse({ limit: 0 }).success).to.equal(false);
        expect(ExportCommunityModLogsOptionsSchema.safeParse({ limit: -5 }).success).to.equal(false);
        expect(ExportCommunityModLogsOptionsSchema.safeParse({ limit: 1.5 }).success).to.equal(false);
    });
});

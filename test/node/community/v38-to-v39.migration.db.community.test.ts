import { it, describe, beforeAll, afterAll, expect } from "vitest";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type Database from "better-sqlite3";

// ──────────────────────────────────────────────────────────────
// v38 table schemas (old column names for pseudonymityAliases)
// ──────────────────────────────────────────────────────────────

const V38_CREATE_COMMENTS = `
    CREATE TABLE IF NOT EXISTS comments (
        cid TEXT NOT NULL PRIMARY KEY UNIQUE,
        authorSignerAddress TEXT NOT NULL,
        author TEXT NULLABLE,
        link TEXT NULLABLE,
        linkWidth INTEGER NULLABLE,
        linkHeight INTEGER NULLABLE,
        thumbnailUrl TEXT NULLABLE,
        thumbnailUrlWidth INTEGER NULLABLE,
        thumbnailUrlHeight INTEGER NULLABLE,
        parentCid TEXT NULLABLE REFERENCES comments(cid),
        postCid TEXT NOT NULL REFERENCES comments(cid),
        previousCid TEXT NULLABLE,
        communityPublicKey TEXT,
        communityName TEXT,
        content TEXT NULLABLE,
        timestamp INTEGER NOT NULL,
        signature TEXT NOT NULL,
        originalCommentSignatureEncoded TEXT NULLABLE,
        title TEXT NULLABLE,
        depth INTEGER NOT NULL,
        linkHtmlTagName TEXT NULLABLE,
        flairs TEXT NULLABLE,
        spoiler INTEGER NULLABLE,
        pendingApproval INTEGER NULLABLE,
        number INTEGER NULLABLE,
        postNumber INTEGER NULLABLE,
        nsfw INTEGER NULLABLE,
        pseudonymityMode TEXT NULLABLE,
        quotedCids TEXT NULLABLE,
        extraProps TEXT NULLABLE,
        protocolVersion TEXT NOT NULL,
        insertedAt INTEGER NOT NULL
    )
`;

const V38_CREATE_COMMENT_UPDATES = `
    CREATE TABLE IF NOT EXISTS commentUpdates (
        cid TEXT NOT NULL PRIMARY KEY UNIQUE REFERENCES comments(cid),
        edit TEXT NULLABLE,
        upvoteCount INTEGER NOT NULL,
        downvoteCount INTEGER NOT NULL,
        replyCount INTEGER NOT NULL,
        childCount INTEGER NOT NULL,
        number INTEGER NULLABLE,
        postNumber INTEGER NULLABLE,
        flairs TEXT NULLABLE,
        spoiler INTEGER NULLABLE,
        nsfw INTEGER NULLABLE,
        pinned INTEGER NULLABLE,
        locked INTEGER NULLABLE,
        archived INTEGER NULLABLE,
        removed INTEGER NULLABLE,
        approved INTEGER NULLABLE,
        reason TEXT NULLABLE,
        updatedAt INTEGER NOT NULL CHECK(updatedAt > 0),
        protocolVersion TEXT NOT NULL,
        signature TEXT NOT NULL,
        author TEXT NULLABLE,
        replies TEXT NULLABLE,
        lastChildCid TEXT NULLABLE,
        lastReplyTimestamp INTEGER NULLABLE,
        postUpdatesBucket INTEGER NULLABLE,
        publishedToPostUpdatesMFS INTEGER NOT NULL,
        insertedAt INTEGER NOT NULL
    )
`;

const V38_CREATE_VOTES = `
    CREATE TABLE IF NOT EXISTS votes (
        commentCid TEXT NOT NULL REFERENCES comments(cid),
        authorSignerAddress TEXT NOT NULL,
        timestamp INTEGER CHECK(timestamp > 0) NOT NULL,
        vote INTEGER CHECK(vote BETWEEN -1 AND 1) NOT NULL,
        protocolVersion TEXT NOT NULL,
        insertedAt INTEGER NOT NULL,
        extraProps TEXT NULLABLE,
        PRIMARY KEY (commentCid, authorSignerAddress)
    )
`;

const V38_CREATE_COMMENT_EDITS = `
    CREATE TABLE IF NOT EXISTS commentEdits (
        commentCid TEXT NOT NULL REFERENCES comments(cid),
        authorSignerAddress TEXT NOT NULL,
        author TEXT NULLABLE,
        signature TEXT NOT NULL,
        protocolVersion TEXT NOT NULL,
        communityPublicKey TEXT,
        communityName TEXT,
        timestamp INTEGER CHECK(timestamp > 0) NOT NULL,
        content TEXT NULLABLE,
        reason TEXT NULLABLE,
        deleted INTEGER NULLABLE,
        spoiler INTEGER NULLABLE,
        nsfw INTEGER NULLABLE,
        flairs TEXT NULLABLE,
        isAuthorEdit INTEGER NOT NULL,
        insertedAt INTEGER NOT NULL,
        extraProps TEXT NULLABLE
    )
`;

const V38_CREATE_COMMENT_MODERATIONS = `
    CREATE TABLE IF NOT EXISTS commentModerations (
        commentCid TEXT NOT NULL REFERENCES comments(cid),
        author TEXT NULLABLE,
        signature TEXT NOT NULL,
        modSignerAddress TEXT NOT NULL,
        protocolVersion TEXT NOT NULL,
        communityPublicKey TEXT,
        communityName TEXT,
        timestamp INTEGER CHECK(timestamp > 0) NOT NULL,
        commentModeration TEXT NOT NULL,
        insertedAt INTEGER NOT NULL,
        extraProps TEXT NULLABLE,
        targetAuthorSignerAddress TEXT NULLABLE,
        targetAuthorDomain TEXT NULLABLE
    )
`;

// Old v38 schema with originalAuthorSignerPublicKey and originalAuthorDomain
const V38_CREATE_PSEUDONYMITY_ALIASES = `
    CREATE TABLE IF NOT EXISTS pseudonymityAliases (
        commentCid TEXT NOT NULL PRIMARY KEY UNIQUE REFERENCES comments(cid) ON DELETE CASCADE,
        aliasPrivateKey TEXT NOT NULL,
        originalAuthorSignerPublicKey TEXT NOT NULL,
        originalAuthorDomain TEXT NULLABLE,
        mode TEXT NOT NULL CHECK(mode IN ('per-post', 'per-reply', 'per-author')),
        insertedAt INTEGER NOT NULL
    )
`;

// ──────────────────────────────────────────────────────────────
// Test helpers
// ──────────────────────────────────────────────────────────────

const COMMUNITY_ADDRESS = "12D3KooWTestCommunityAddress";
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

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

// This test uses DbHandler directly (Node-only) and cannot run under RPC
describeSkipIfRpc("v38 → v39 DB migration (pseudonymityAliases column renames)", function () {
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
        const db = priv._db;

        // Create all v38 tables
        db.exec(V38_CREATE_COMMENTS);
        db.exec(V38_CREATE_COMMENT_UPDATES);
        db.exec(V38_CREATE_VOTES);
        db.exec(V38_CREATE_COMMENT_EDITS);
        db.exec(V38_CREATE_COMMENT_MODERATIONS);
        db.exec(V38_CREATE_PSEUDONYMITY_ALIASES);

        // Insert a post so the pseudonymity alias foreign key is satisfied
        db.prepare(
            `
            INSERT INTO comments (cid, authorSignerAddress, author, postCid, communityPublicKey,
                content, timestamp, signature, depth, protocolVersion, insertedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            "QmPost1",
            "12D3KooWAliasAuthor",
            JSON.stringify({ address: "12D3KooWAliasAuthor" }),
            "QmPost1",
            COMMUNITY_ADDRESS,
            "post content",
            now,
            fakeSignatureJson("sig-post1"),
            0,
            "1.0.0",
            now
        );

        // Insert a second post for the alias with a domain
        db.prepare(
            `
            INSERT INTO comments (cid, authorSignerAddress, author, postCid, communityPublicKey,
                content, timestamp, signature, depth, protocolVersion, insertedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            "QmPost2",
            "12D3KooWAliasAuthor2",
            JSON.stringify({ address: "12D3KooWAliasAuthor2" }),
            "QmPost2",
            COMMUNITY_ADDRESS,
            "post content 2",
            now,
            fakeSignatureJson("sig-post2"),
            0,
            "1.0.0",
            now
        );

        // Insert pseudonymity alias with old column names (no domain)
        db.prepare(
            `
            INSERT INTO pseudonymityAliases (commentCid, aliasPrivateKey, originalAuthorSignerPublicKey, originalAuthorDomain, mode, insertedAt)
            VALUES (?, ?, ?, ?, ?, ?)
        `
        ).run("QmPost1", "alias-private-key-1", "original-public-key-1", null, "per-post", now);

        // Insert pseudonymity alias with old column names (with domain)
        db.prepare(
            `
            INSERT INTO pseudonymityAliases (commentCid, aliasPrivateKey, originalAuthorSignerPublicKey, originalAuthorDomain, mode, insertedAt)
            VALUES (?, ?, ?, ?, ?, ?)
        `
        ).run("QmPost2", "alias-private-key-2", "original-public-key-2", "author.bso", "per-author", now);

        // Set the DB version to v38 to trigger migration
        db.pragma("user_version = 38");

        // Stub out the purge methods — they verify real crypto signatures,
        // which our fake data cannot satisfy
        priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
        priv._purgeCommentEditsWithInvalidSchemaOrSignature = async () => {};
        priv._purgePublicationTablesWithDuplicateSignatures = async () => {};

        // Run migration
        await dbHandler.createOrMigrateTablesIfNeeded();
    });

    it("pseudonymityAliases table has new column names", () => {
        const priv = getPrivate(dbHandler!);
        const columns = (priv._db.pragma("table_info(pseudonymityAliases)") as { name: string }[]).map((c) => c.name);
        expect(columns).to.include("originalAuthorPublicKey");
        expect(columns).to.include("originalAuthorName");
        expect(columns).not.to.include("originalAuthorSignerPublicKey");
        expect(columns).not.to.include("originalAuthorDomain");
    });

    it("alias without domain is migrated correctly", () => {
        const priv = getPrivate(dbHandler!);
        const row = priv._db.prepare("SELECT * FROM pseudonymityAliases WHERE commentCid = ?").get("QmPost1") as Record<string, unknown>;
        expect(row).to.exist;
        expect(row.originalAuthorPublicKey).to.equal("original-public-key-1");
        expect(row.originalAuthorName).to.be.null;
        expect(row.aliasPrivateKey).to.equal("alias-private-key-1");
        expect(row.mode).to.equal("per-post");
    });

    it("alias with domain is migrated correctly", () => {
        const priv = getPrivate(dbHandler!);
        const row = priv._db.prepare("SELECT * FROM pseudonymityAliases WHERE commentCid = ?").get("QmPost2") as Record<string, unknown>;
        expect(row).to.exist;
        expect(row.originalAuthorPublicKey).to.equal("original-public-key-2");
        expect(row.originalAuthorName).to.equal("author.bso");
        expect(row.aliasPrivateKey).to.equal("alias-private-key-2");
        expect(row.mode).to.equal("per-author");
    });
});

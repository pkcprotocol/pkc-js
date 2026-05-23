import { it, describe, beforeAll, afterAll, expect } from "vitest";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type Database from "better-sqlite3";

// v39 comments table — same as v40 minus the new `challengeCommentUpdate` column.
const V39_CREATE_COMMENTS = `
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

const V39_CREATE_COMMENT_UPDATES = `
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

const V39_CREATE_VOTES = `
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

const V39_CREATE_COMMENT_EDITS = `
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

const V39_CREATE_COMMENT_MODERATIONS = `
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

const V39_CREATE_PSEUDONYMITY_ALIASES = `
    CREATE TABLE IF NOT EXISTS pseudonymityAliases (
        commentCid TEXT NOT NULL PRIMARY KEY UNIQUE REFERENCES comments(cid) ON DELETE CASCADE,
        aliasPrivateKey TEXT NOT NULL,
        originalAuthorPublicKey TEXT NOT NULL,
        originalAuthorName TEXT NULLABLE,
        mode TEXT NOT NULL CHECK(mode IN ('per-post', 'per-reply', 'per-author')),
        insertedAt INTEGER NOT NULL
    )
`;

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

// Uses DbHandler directly (Node-only) — cannot run under RPC.
describeSkipIfRpc("v39 → v40 DB migration (challengeCommentUpdate column on comments)", function () {
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

        db.exec(V39_CREATE_COMMENTS);
        db.exec(V39_CREATE_COMMENT_UPDATES);
        db.exec(V39_CREATE_VOTES);
        db.exec(V39_CREATE_COMMENT_EDITS);
        db.exec(V39_CREATE_COMMENT_MODERATIONS);
        db.exec(V39_CREATE_PSEUDONYMITY_ALIASES);

        // Insert a representative pre-migration post (no challengeCommentUpdate column exists yet).
        db.prepare(
            `
            INSERT INTO comments (cid, authorSignerAddress, author, postCid, communityPublicKey,
                content, timestamp, signature, depth, protocolVersion, insertedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
        ).run(
            "QmLegacyPost",
            "12D3KooWLegacy",
            JSON.stringify({ address: "12D3KooWLegacy" }),
            "QmLegacyPost",
            COMMUNITY_ADDRESS,
            "pre-v40 content",
            now,
            fakeSignatureJson("sig-legacy"),
            0,
            "1.0.0",
            now
        );

        db.pragma("user_version = 39");

        priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
        priv._purgeCommentEditsWithInvalidSchemaOrSignature = async () => {};
        priv._purgePublicationTablesWithDuplicateSignatures = async () => {};

        await dbHandler.createOrMigrateTablesIfNeeded();
    });

    it("comments table has the new challengeCommentUpdate column", () => {
        const priv = getPrivate(dbHandler!);
        const columns = (priv._db.pragma("table_info(comments)") as { name: string }[]).map((c) => c.name);
        expect(columns).to.include("challengeCommentUpdate");
    });

    it("legacy rows are migrated with challengeCommentUpdate = NULL", () => {
        const priv = getPrivate(dbHandler!);
        const row = priv._db.prepare("SELECT challengeCommentUpdate FROM comments WHERE cid = ?").get("QmLegacyPost") as {
            challengeCommentUpdate: unknown;
        };
        expect(row).to.exist;
        expect(row.challengeCommentUpdate).to.be.null;
    });

    it("DB version was bumped to 40", () => {
        const priv = getPrivate(dbHandler!);
        const userVersion = priv._db.pragma("user_version", { simple: true }) as number;
        expect(userVersion).to.equal(40);
    });

    it("new rows can write/read challengeCommentUpdate JSON", () => {
        const priv = getPrivate(dbHandler!);
        priv._db
            .prepare(
                `
                INSERT INTO comments (cid, authorSignerAddress, author, postCid, communityPublicKey,
                    content, timestamp, signature, depth, protocolVersion, insertedAt, challengeCommentUpdate)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            )
            .run(
                "QmNewPost",
                "12D3KooWNew",
                JSON.stringify({ address: "12D3KooWNew" }),
                "QmNewPost",
                COMMUNITY_ADDRESS,
                "post-migration content",
                now + 1,
                fakeSignatureJson("sig-new"),
                0,
                "1.0.0",
                now + 1,
                JSON.stringify({ reason: "Verified country", countryCode: "FR" })
            );

        const row = priv._db.prepare("SELECT challengeCommentUpdate FROM comments WHERE cid = ?").get("QmNewPost") as {
            challengeCommentUpdate: string;
        };
        expect(row.challengeCommentUpdate).to.be.a("string");
        const parsed = JSON.parse(row.challengeCommentUpdate) as Record<string, unknown>;
        expect(parsed).to.deep.equal({ reason: "Verified country", countryCode: "FR" });
    });
});

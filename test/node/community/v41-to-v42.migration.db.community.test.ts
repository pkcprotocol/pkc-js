import { it, describe, beforeAll, afterAll, expect } from "vitest";
import env from "../../../dist/node/version.js";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { getPKCAddressFromPublicKeySync } from "../../../dist/node/signer/util.js";

// v41 tables: the comments table with crosspost, the commentUpdates table before `wireReplies` (issue #351).
const V41_CREATE_COMMENTS = `
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
        crosspost TEXT NULLABLE,
        extraProps TEXT NULLABLE,
        challengeCommentUpdate TEXT NULLABLE,
        protocolVersion TEXT NOT NULL,
        insertedAt INTEGER NOT NULL
    )
`;

const V41_CREATE_COMMENT_UPDATES = `
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

const V41_CREATE_VOTES = `
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

const V41_CREATE_COMMENT_EDITS = `
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

const V41_CREATE_COMMENT_MODERATIONS = `
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

const V41_CREATE_PSEUDONYMITY_ALIASES = `
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
const LEGACY_ALIAS_PUBLIC_KEY = (
    JSON.parse(
        readFileSync(new URL("../../fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json", import.meta.url), "utf8")
    ) as {
        signature: { publicKey: string };
    }
).signature.publicKey;
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
describeSkipIfRpc("v41 → v42 DB migration (wireReplies column on commentUpdates, comment tree indexes)", function () {
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

        db.exec(V41_CREATE_COMMENTS);
        db.exec(V41_CREATE_COMMENT_UPDATES);
        db.exec(V41_CREATE_VOTES);
        db.exec(V41_CREATE_COMMENT_EDITS);
        db.exec(V41_CREATE_COMMENT_MODERATIONS);
        db.exec(V41_CREATE_PSEUDONYMITY_ALIASES);

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
            "pre-v42 content",
            now,
            fakeSignatureJson("sig-legacy"),
            0,
            "1.0.0",
            now
        );

        // A pre-migration alias row: the column the reverse lookup indexes did not exist yet
        db.prepare(
            `INSERT INTO pseudonymityAliases (commentCid, aliasPrivateKey, originalAuthorPublicKey, originalAuthorName, mode, insertedAt)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).run("QmLegacyPost", "alias-private-key", LEGACY_ALIAS_PUBLIC_KEY, null, "per-post", now);

        db.pragma("user_version = 41");

        priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
        priv._purgeCommentEditsWithInvalidSchemaOrSignature = async () => {};
        priv._purgePublicationTablesWithDuplicateSignatures = async () => {};

        await dbHandler.createOrMigrateTablesIfNeeded();
    });

    it("commentUpdates table has the new wireReplies column", () => {
        const priv = getPrivate(dbHandler!);
        const columns = (priv._db.pragma("table_info(commentUpdates)") as { name: string }[]).map((c) => c.name);
        expect(columns).to.include("wireReplies");
        expect(columns).to.include("replies"); // the CID-ref column stays for stale_replies and unpinning
    });

    it("comments table carries the parentCid, postCid and authorSignerAddress indexes", () => {
        const priv = getPrivate(dbHandler!);
        const indexes = (priv._db.pragma("index_list(comments)") as { name: string }[]).map((i) => i.name);
        expect(indexes).to.include("idx_comments_parentCid");
        expect(indexes).to.include("idx_comments_postCid");
        expect(indexes).to.include("idx_comments_authorSignerAddress");
    });

    it("legacy alias rows get originalAuthorSignerAddress derived from their public key, and the column is indexed", () => {
        const priv = getPrivate(dbHandler!);
        const row = priv._db
            .prepare("SELECT originalAuthorPublicKey, originalAuthorSignerAddress, mode FROM pseudonymityAliases WHERE commentCid = ?")
            .get("QmLegacyPost") as { originalAuthorPublicKey: string; originalAuthorSignerAddress: string | null; mode: string };
        expect(row.originalAuthorPublicKey).to.equal(LEGACY_ALIAS_PUBLIC_KEY);
        expect(row.originalAuthorSignerAddress).to.equal(getPKCAddressFromPublicKeySync(LEGACY_ALIAS_PUBLIC_KEY));
        expect(row.mode).to.equal("per-post");
        const indexes = (priv._db.pragma("index_list(pseudonymityAliases)") as { name: string }[]).map((i) => i.name);
        expect(indexes).to.include("idx_pseudonymityAliases_originalAuthorSignerAddress");
    });

    it("commentEdits and commentModerations are indexed by commentCid", () => {
        const priv = getPrivate(dbHandler!);
        const names = (table: string) => (priv._db.pragma(`index_list(${table})`) as { name: string }[]).map((i) => i.name);
        expect(names("commentEdits")).to.include("idx_commentEdits_commentCid");
        expect(names("commentModerations")).to.include("idx_commentModerations_commentCid");
    });

    it("queryCommunityAuthor reaches an author's alias comments through the derived column", () => {
        const priv = getPrivate(dbHandler!);
        // The legacy post is signed by the alias (its authorSignerAddress); the original author owns it through the alias row
        const originalAddress = getPKCAddressFromPublicKeySync(LEGACY_ALIAS_PUBLIC_KEY);
        priv._db.prepare("UPDATE comments SET authorSignerAddress = ? WHERE cid = ?").run("12D3KooWAliasSigner", "QmLegacyPost");
        const author = dbHandler!.queryCommunityAuthor(originalAddress);
        expect(author?.lastCommentCid).to.equal("QmLegacyPost");
    });

    it("legacy row content is preserved through the migration", () => {
        const priv = getPrivate(dbHandler!);
        const row = priv._db.prepare("SELECT content, depth, timestamp, crosspost FROM comments WHERE cid = ?").get("QmLegacyPost") as {
            content: string;
            depth: number;
            timestamp: number;
            crosspost: unknown;
        };
        expect(row.content).to.equal("pre-v42 content");
        expect(row.depth).to.equal(0);
        expect(row.timestamp).to.equal(now);
        expect(row.crosspost).to.be.null;
    });

    it("DB version was bumped to the latest", () => {
        const priv = getPrivate(dbHandler!);
        const userVersion = priv._db.pragma("user_version", { simple: true }) as number;
        expect(userVersion).to.equal(env.DB_VERSION);
    });

    it("new CommentUpdate rows write and read wireReplies through the handler", () => {
        const wireReplies = JSON.stringify({ pages: { best: { comments: [] } } });
        dbHandler!.upsertCommentUpdates([
            {
                cid: "QmLegacyPost",
                upvoteCount: 0,
                downvoteCount: 0,
                replyCount: 0,
                childCount: 0,
                updatedAt: now,
                protocolVersion: "1.0.0",
                signature: JSON.parse(fakeSignatureJson("sig-update")) as Record<string, unknown>,
                author: { community: {} },
                replies: { best: { commentCids: [] } },
                wireReplies,
                publishedToPostUpdatesMFS: false,
                insertedAt: now
            } as unknown as Parameters<DbHandler["upsertCommentUpdates"]>[0][number]
        ]);
        const priv = getPrivate(dbHandler!);
        const row = priv._db.prepare("SELECT wireReplies FROM commentUpdates WHERE cid = ?").get("QmLegacyPost") as {
            wireReplies: string | null;
        };
        expect(row.wireReplies).to.equal(wireReplies);
        expect(dbHandler!.queryWireReplies(["QmLegacyPost", "QmMissing"])).to.deep.equal(new Map([["QmLegacyPost", wireReplies]]));
    });
});

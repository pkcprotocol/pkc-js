import { it, describe, beforeAll, afterAll, expect } from "vitest";
import env from "../../../dist/node/version.js";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { commentUpdateToDbRow } from "../../../dist/node/runtime/node/community/comment-update-row.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { CommentUpdateType } from "../../../dist/node/publications/comment/types.js";
import type Database from "better-sqlite3";

// v45 -> v46 adds the commentUpdates.extraProps JSON column (issue #572): the unknown keys of the signed CommentUpdate
// (a challenge's `commentUpdate` extras), so a page entry rebuilt from the row is the record that was signed.
// commentUpdates is dropped and rebuilt on every version bump, so no row is migrated: the update cycle recomputes each
// record, and comments.challengeCommentUpdate, the durable source of the extras, survives untouched.

const V45_CREATE_COMMENTS = `
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
        gallery TEXT NULLABLE,
        extraProps TEXT NULLABLE,
        challengeCommentUpdate TEXT NULLABLE,
        protocolVersion TEXT NOT NULL,
        insertedAt INTEGER NOT NULL
    )
`;

const V45_CREATE_COMMENT_UPDATES = `
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

const V45_CREATE_VOTES = `
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

const V45_CREATE_COMMENT_EDITS = `
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

const V45_CREATE_COMMENT_MODERATIONS = `
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

const V45_CREATE_PSEUDONYMITY_ALIASES = `
    CREATE TABLE IF NOT EXISTS pseudonymityAliases (
        commentCid TEXT NOT NULL PRIMARY KEY UNIQUE REFERENCES comments(cid) ON DELETE CASCADE,
        aliasPrivateKey TEXT NOT NULL,
        originalAuthorPublicKey TEXT NOT NULL,
        originalAuthorSignerAddress TEXT NULLABLE,
        originalAuthorName TEXT NULLABLE,
        mode TEXT NOT NULL CHECK(mode IN ('per-post', 'per-reply', 'per-author')),
        insertedAt INTEGER NOT NULL
    )
`;

const COMMUNITY_ADDRESS = "12D3KooWTestCommunityAddressV46";
const now = Math.floor(Date.now() / 1000);
const POST_CID = "QmV46PostWithChallengeExtras";
const OTHER_POST_CID = "QmV46PostWithoutChallengeExtras";
const author = { address: "12D3KooWAuthorV46" };
const challengeCommentUpdate = { myExtraKey: "hello", tip: { chainId: 1, txHash: "0xabc" } };
const signature = {
    type: "ed25519",
    signature: "sig",
    publicKey: "pk",
    signedPropertyNames: ["communityPublicKey", "author", "timestamp"]
};

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
describeSkipIfRpc("v45 → v46 DB migration (commentUpdates.extraProps column)", function () {
    let dbHandler: DbHandler | undefined;

    afterAll(() => {
        if (dbHandler) {
            dbHandler.destoryConnection();
            dbHandler = undefined;
        }
    });

    beforeAll(async () => {
        dbHandler = new DbHandler(createFakeCommunity(COMMUNITY_ADDRESS) as unknown as LocalCommunity);
        await dbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });

        const priv = getPrivate(dbHandler);
        const db = priv._db;
        db.exec(V45_CREATE_COMMENTS);
        db.exec(V45_CREATE_COMMENT_UPDATES);
        db.exec(V45_CREATE_VOTES);
        db.exec(V45_CREATE_COMMENT_EDITS);
        db.exec(V45_CREATE_COMMENT_MODERATIONS);
        db.exec(V45_CREATE_PSEUDONYMITY_ALIASES);

        const insertPost = db.prepare(
            `INSERT INTO comments (cid, authorSignerAddress, author, postCid, communityPublicKey, content, title, timestamp, signature,
                depth, challengeCommentUpdate, protocolVersion, insertedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, '1.0.0', ?)`
        );
        insertPost.run(
            POST_CID,
            author.address,
            JSON.stringify(author),
            POST_CID,
            COMMUNITY_ADDRESS,
            "content",
            "title",
            now - 300,
            JSON.stringify(signature),
            JSON.stringify(challengeCommentUpdate),
            now - 300
        );
        insertPost.run(
            OTHER_POST_CID,
            author.address,
            JSON.stringify(author),
            OTHER_POST_CID,
            COMMUNITY_ADDRESS,
            "content",
            "title",
            now - 200,
            JSON.stringify({ ...signature, signature: "sig2" }),
            null,
            now - 200
        );
        // the stale updates the old version had stored: one of them is the CommentUpdate a pre-fix community computed for the
        // post with extras, which carried no extras
        const insertUpdate = db.prepare(
            `INSERT INTO commentUpdates (cid, upvoteCount, downvoteCount, replyCount, childCount, updatedAt, protocolVersion, signature,
                publishedToPostUpdatesMFS, insertedAt)
             VALUES (?, 1, 0, 0, 0, ?, '1.0.0', ?, 1, ?)`
        );
        insertUpdate.run(POST_CID, now - 100, JSON.stringify(signature), now - 100);
        insertUpdate.run(OTHER_POST_CID, now - 100, JSON.stringify(signature), now - 100);

        db.pragma("user_version = 45");

        priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
        priv._purgeCommentEditsWithInvalidSchemaOrSignature = async () => {};
        priv._purgePublicationTablesWithDuplicateSignatures = async () => {};

        await dbHandler.createOrMigrateTablesIfNeeded();
    });

    it("the commentUpdates table has an extraProps column", () => {
        const columns = (getPrivate(dbHandler!)._db.prepare("PRAGMA table_info(commentUpdates)").all() as { name: string }[]).map(
            (c) => c.name
        );
        expect(columns).to.include("extraProps");
    });

    it("commentUpdates is rebuilt empty: the update cycle recomputes every record", () => {
        const count = getPrivate(dbHandler!)._db.prepare("SELECT COUNT(*) AS n FROM commentUpdates").get() as { n: number };
        expect(count.n).to.equal(0);
    });

    it("comments.challengeCommentUpdate, the durable source of the extras, survives the migration", () => {
        const withExtras = dbHandler!.queryComment(POST_CID)!;
        expect(withExtras.challengeCommentUpdate).to.deep.equal(challengeCommentUpdate);
        const without = dbHandler!.queryComment(OTHER_POST_CID)!;
        expect(without.challengeCommentUpdate).to.be.undefined;
    });

    it("the other comment columns survive the migration", () => {
        const row = dbHandler!.queryComment(POST_CID)!;
        expect(row.cid).to.equal(POST_CID);
        expect(row.content).to.equal("content");
        expect(row.title).to.equal("title");
        expect(row.author).to.deep.equal(author);
        expect(row.timestamp).to.equal(now - 300);
    });

    it("a recomputed record with extras is stored in extraProps and read back whole", () => {
        const update = {
            cid: POST_CID,
            upvoteCount: 1,
            downvoteCount: 0,
            replyCount: 0,
            childCount: 0,
            updatedAt: now,
            protocolVersion: "1.0.0",
            signature: { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] },
            ...challengeCommentUpdate
        } as unknown as CommentUpdateType;
        dbHandler!.upsertCommentUpdates([
            commentUpdateToDbRow({ update, dbOnlyFields: { publishedToPostUpdatesMFS: false, insertedAt: now } })
        ]);
        const stored = dbHandler!.queryStoredCommentUpdate({ cid: POST_CID })!;
        expect(stored.extraProps).to.deep.equal(challengeCommentUpdate);
        expect(stored.upvoteCount).to.equal(1);
    });

    it("DB version was bumped to the latest", () => {
        const userVersion = getPrivate(dbHandler!)._db.pragma("user_version", { simple: true }) as number;
        expect(userVersion).to.equal(env.DB_VERSION);
        expect(env.DB_VERSION).to.be.greaterThanOrEqual(46);
    });
});

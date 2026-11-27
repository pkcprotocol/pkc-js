import { it, describe, beforeAll, afterAll, expect } from "vitest";
import Logger from "@pkcprotocol/pkc-logger";
import env from "../../../dist/node/version.js";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type Database from "better-sqlite3";

// Local-community helpers log through community._log (issue #493); fakes get the process-default root
const testLog = Logger({ namespace: "pkc-js:test:v43-to-v44" });

// v43 tables: v43 added originalAuthorSignerAddress to the aliases table and indexes (issue #351), no other column.
// v43 -> v44 changes no table schema. It exists so the migration drops commentUpdates and the next update cycle
// recalculates every CommentUpdate under the reply-counting rule of #403/#405. Without it, a quiet thread kept the
// replyCount and lastReplyTimestamp it was last signed with: the update cycle never compares those two with the query.

const V43_CREATE_COMMENTS = `
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

const V43_CREATE_COMMENT_UPDATES = `
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

const V43_CREATE_VOTES = `
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

const V43_CREATE_COMMENT_EDITS = `
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

const V43_CREATE_COMMENT_MODERATIONS = `
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

const V43_CREATE_PSEUDONYMITY_ALIASES = `
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

const COMMUNITY_ADDRESS = "12D3KooWTestCommunityAddressV44";
const now = Math.floor(Date.now() / 1000);
const POST_CID = "QmStalePost";
const REMOVED_REPLY_CID = "QmRemovedReply";
const PRESENT_REPLY_CID = "QmPresentUnderRemoved";

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
    _log: typeof testLog;
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
        _log: testLog,
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
describeSkipIfRpc("v43 → v44 DB migration (recalculate every CommentUpdate for the #403/#405 reply rule)", function () {
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

        db.exec(V43_CREATE_COMMENTS);
        db.exec(V43_CREATE_COMMENT_UPDATES);
        db.exec(V43_CREATE_VOTES);
        db.exec(V43_CREATE_COMMENT_EDITS);
        db.exec(V43_CREATE_COMMENT_MODERATIONS);
        db.exec(V43_CREATE_PSEUDONYMITY_ALIASES);

        const insertComment = db.prepare(
            `INSERT INTO comments (cid, authorSignerAddress, author, parentCid, postCid, communityPublicKey,
                content, timestamp, signature, depth, protocolVersion, insertedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const author = JSON.stringify({ address: "12D3KooWAuthor" });
        insertComment.run(
            POST_CID,
            "12D3KooWAuthor",
            author,
            null,
            POST_CID,
            COMMUNITY_ADDRESS,
            "post",
            now - 300,
            fakeSignatureJson("sig-post"),
            0,
            "1.0.0",
            now - 300
        );
        insertComment.run(
            REMOVED_REPLY_CID,
            "12D3KooWAuthor",
            author,
            POST_CID,
            POST_CID,
            COMMUNITY_ADDRESS,
            "spam",
            now - 200,
            fakeSignatureJson("sig-removed"),
            1,
            "1.0.0",
            now - 200
        );
        insertComment.run(
            PRESENT_REPLY_CID,
            "12D3KooWAuthor",
            author,
            REMOVED_REPLY_CID,
            POST_CID,
            COMMUNITY_ADDRESS,
            "live",
            now - 250,
            fakeSignatureJson("sig-present"),
            2,
            "1.0.0",
            now - 250
        );

        // The CommentUpdates as the pre-#403/#405 code signed them, all published and newer than every publication:
        // the post's lastReplyTimestamp is the removed reply's (#403) and its replyCount leaves out the present reply
        // under the removed one (#405). Every childCount and lastChildCid is already right (the removed reply's own counts
        // were never affected), so before v44 no selection arm flags the post.
        const insertUpdate = db.prepare(
            `INSERT INTO commentUpdates (cid, upvoteCount, downvoteCount, replyCount, childCount, removed, updatedAt,
                protocolVersion, signature, lastChildCid, lastReplyTimestamp, publishedToPostUpdatesMFS, insertedAt)
             VALUES (?, 0, 0, ?, ?, ?, ?, '1.0.0', ?, ?, ?, 1, ?)`
        );
        insertUpdate.run(POST_CID, 0, 0, null, now - 100, fakeSignatureJson("sig-cu-post"), null, now - 200, now - 100);
        insertUpdate.run(
            REMOVED_REPLY_CID,
            1,
            1,
            1,
            now - 110,
            fakeSignatureJson("sig-cu-removed"),
            PRESENT_REPLY_CID,
            now - 250,
            now - 110
        );
        insertUpdate.run(PRESENT_REPLY_CID, 0, 0, null, now - 120, fakeSignatureJson("sig-cu-present"), null, null, now - 120);

        db.pragma("user_version = 43");

        priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
        priv._purgeCommentEditsWithInvalidSchemaOrSignature = async () => {};
        priv._purgePublicationTablesWithDuplicateSignatures = async () => {};

        await dbHandler.createOrMigrateTablesIfNeeded();
    });

    it("the stale CommentUpdates are dropped", () => {
        const priv = getPrivate(dbHandler!);
        const count = priv._db.prepare("SELECT COUNT(*) AS count FROM commentUpdates").get() as { count: number };
        expect(count.count).to.equal(0);
    });

    it("the post with the stale replyCount and lastReplyTimestamp is flagged for recalculation", () => {
        const cids = dbHandler!.queryCommentsToBeUpdated().map((row) => row.cid);
        expect(cids).to.include(POST_CID);
    });

    it("comments survive the migration", () => {
        const priv = getPrivate(dbHandler!);
        const cids = (priv._db.prepare("SELECT cid FROM comments ORDER BY depth").all() as { cid: string }[]).map((r) => r.cid);
        expect(cids).to.deep.equal([POST_CID, REMOVED_REPLY_CID, PRESENT_REPLY_CID]);
    });

    it("DB version was bumped to the latest", () => {
        const priv = getPrivate(dbHandler!);
        const userVersion = priv._db.pragma("user_version", { simple: true }) as number;
        expect(userVersion).to.equal(env.DB_VERSION);
    });
});

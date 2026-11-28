import { it, describe, beforeAll, afterAll, expect } from "vitest";
import env from "../../../dist/node/version.js";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { commentUpdateToDbRow } from "../../../dist/node/runtime/node/community/comment-update-row.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { CommentUpdateType } from "../../../dist/node/publications/comment/types.js";
import type Database from "better-sqlite3";
import Logger from "@pkcprotocol/pkc-logger";

// DbHandler and the community helpers log through community._log (issue #493); fakes get the process-default root
const testLog = Logger({ namespace: "pkc-js:test:v48-to-v49" });

// v48 -> v49 adds the commentUpdates.pseudonymityAuthorTag column (issue #381): the own-post recognition
// tag on comments the community aliased. commentUpdates is dropped and rebuilt on every version bump, so
// no update row is migrated; the update cycle recomputes every record and tags each aliased comment from
// the surviving pseudonymityAliases table, which is how existing comments get tagged on upgrade.

const V48_CREATE_COMMENTS = `
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

// v48 commentUpdates: includes authorBanExpiresAt (issue #363), and NO pseudonymityAuthorTag yet.
const V48_CREATE_COMMENT_UPDATES = `
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
        authorBanExpiresAt INTEGER NULLABLE,
        updatedAt INTEGER NOT NULL CHECK(updatedAt > 0),
        protocolVersion TEXT NOT NULL,
        signature TEXT NOT NULL,
        author TEXT NULLABLE,
        replies TEXT NULLABLE,
        lastChildCid TEXT NULLABLE,
        lastReplyTimestamp INTEGER NULLABLE,
        postUpdatesBucket INTEGER NULLABLE,
        publishedToPostUpdatesMFS INTEGER NOT NULL,
        insertedAt INTEGER NOT NULL,
        extraProps TEXT NULLABLE
    )
`;

const V48_CREATE_VOTES = `
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

const V48_CREATE_COMMENT_EDITS = `
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

const V48_CREATE_COMMENT_MODERATIONS = `
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

const V48_CREATE_PSEUDONYMITY_ALIASES = `
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

const COMMUNITY_ADDRESS = "12D3KooWTestCommunityAddressV49";
const now = Math.floor(Date.now() / 1000);
const ALIASED_POST_CID = "QmV49AliasedPost";
const PLAIN_POST_CID = "QmV49PlainPost";
const author = { address: "12D3KooWAuthorV49" };
const ALIAS_AUTHOR_PUBLIC_KEY = "C7w0aldmfDgBIL2cf9flHSxf3+o3zS9b9AWyxr9vLXg";
const signature = {
    type: "ed25519",
    signature: "sig",
    publicKey: "pk",
    signedPropertyNames: ["communityPublicKey", "author", "timestamp"]
};

interface FakeCommunity {
    address: string;
    _log: typeof testLog;
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
        _log: testLog,
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
describeSkipIfRpc("v48 → v49 DB migration (commentUpdates.pseudonymityAuthorTag column)", function () {
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
        db.exec(V48_CREATE_COMMENTS);
        db.exec(V48_CREATE_COMMENT_UPDATES);
        db.exec(V48_CREATE_VOTES);
        db.exec(V48_CREATE_COMMENT_EDITS);
        db.exec(V48_CREATE_COMMENT_MODERATIONS);
        db.exec(V48_CREATE_PSEUDONYMITY_ALIASES);

        const insertPost = db.prepare(
            `INSERT INTO comments (cid, authorSignerAddress, author, postCid, communityPublicKey, content, title, timestamp, signature,
                depth, protocolVersion, insertedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '1.0.0', ?)`
        );
        insertPost.run(
            ALIASED_POST_CID,
            author.address,
            JSON.stringify(author),
            ALIASED_POST_CID,
            COMMUNITY_ADDRESS,
            "content",
            "title",
            now - 300,
            JSON.stringify(signature),
            now - 300
        );
        insertPost.run(
            PLAIN_POST_CID,
            author.address,
            JSON.stringify(author),
            PLAIN_POST_CID,
            COMMUNITY_ADDRESS,
            "content",
            "title",
            now - 200,
            JSON.stringify({ ...signature, signature: "sig2" }),
            now - 200
        );

        // The aliased post has an alias row; the plain post does not.
        db.prepare(
            `INSERT INTO pseudonymityAliases (commentCid, aliasPrivateKey, originalAuthorPublicKey, originalAuthorSignerAddress, mode, insertedAt)
             VALUES (?, ?, ?, ?, 'per-post', ?)`
        ).run(ALIASED_POST_CID, "aliasPrivKey", ALIAS_AUTHOR_PUBLIC_KEY, author.address, now - 300);

        // Old update rows the pre-v49 community had stored (carry no tag).
        const insertUpdate = db.prepare(
            `INSERT INTO commentUpdates (cid, upvoteCount, downvoteCount, replyCount, childCount, updatedAt, protocolVersion, signature,
                publishedToPostUpdatesMFS, insertedAt)
             VALUES (?, 1, 0, 0, 0, ?, '1.0.0', ?, 1, ?)`
        );
        insertUpdate.run(ALIASED_POST_CID, now - 100, JSON.stringify(signature), now - 100);
        insertUpdate.run(PLAIN_POST_CID, now - 100, JSON.stringify(signature), now - 100);

        db.pragma("user_version = 48");

        priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
        priv._purgeCommentEditsWithInvalidSchemaOrSignature = async () => {};
        priv._purgePublicationTablesWithDuplicateSignatures = async () => {};

        await dbHandler.createOrMigrateTablesIfNeeded();
    });

    it("the commentUpdates table has a pseudonymityAuthorTag column", () => {
        const columns = (getPrivate(dbHandler!)._db.prepare("PRAGMA table_info(commentUpdates)").all() as { name: string }[]).map(
            (c) => c.name
        );
        expect(columns).to.include("pseudonymityAuthorTag");
    });

    it("commentUpdates is rebuilt empty: the update cycle recomputes every record and tags the aliased ones", () => {
        const count = getPrivate(dbHandler!)._db.prepare("SELECT COUNT(*) AS n FROM commentUpdates").get() as { n: number };
        expect(count.n).to.equal(0);
    });

    it("the pseudonymityAliases row survives, so the aliased comment can be retagged on recompute", () => {
        const alias = dbHandler!.queryPseudonymityAliasByCommentCid(ALIASED_POST_CID);
        expect(alias?.originalAuthorPublicKey).to.equal(ALIAS_AUTHOR_PUBLIC_KEY);
        expect(dbHandler!.queryPseudonymityAliasByCommentCid(PLAIN_POST_CID)).to.be.undefined;
    });

    it("comments survive the migration", () => {
        const row = dbHandler!.queryComment(ALIASED_POST_CID)!;
        expect(row.cid).to.equal(ALIASED_POST_CID);
        expect(row.author).to.deep.equal(author);
    });

    it("a recomputed record with a tag round-trips through the new column", () => {
        const update = {
            cid: ALIASED_POST_CID,
            upvoteCount: 1,
            downvoteCount: 0,
            replyCount: 0,
            childCount: 0,
            updatedAt: now,
            protocolVersion: "1.0.0",
            signature: { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] },
            pseudonymityAuthorTag: "nBUe3DGZKQ8fBcP6YGnpRQ"
        } as unknown as CommentUpdateType;
        dbHandler!.upsertCommentUpdates([
            commentUpdateToDbRow({ update, dbOnlyFields: { publishedToPostUpdatesMFS: false, insertedAt: now } })
        ]);
        const stored = dbHandler!.queryStoredCommentUpdate({ cid: ALIASED_POST_CID })!;
        expect(stored.pseudonymityAuthorTag).to.equal("nBUe3DGZKQ8fBcP6YGnpRQ");
    });

    it("DB version was bumped to the latest", () => {
        const userVersion = getPrivate(dbHandler!)._db.pragma("user_version", { simple: true }) as number;
        expect(userVersion).to.equal(env.DB_VERSION);
        expect(env.DB_VERSION).to.equal(49);
    });
});

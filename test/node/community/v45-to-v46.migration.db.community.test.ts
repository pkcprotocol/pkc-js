import { it, describe, beforeAll, afterAll, expect } from "vitest";
import env from "../../../dist/node/version.js";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type Database from "better-sqlite3";

// v45 -> v46 adds the commentUpdates.authorBanExpiresAt column (issue #363): the ban a mod published on that comment.
// Like every migration this one drops the commentUpdates table, so nothing is backfilled into rows; the mark comes
// from the commentModerations rows, which are kept, the next time each CommentUpdate is calculated. A ban published
// before the upgrade therefore marks its comment after it.

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
const BANNED_POST_CID = "QmPostTheBanWasPublishedOn";
const OTHER_POST_CID = "QmOtherPostOfTheBannedAuthor";
const BAN_EXPIRES_AT = now + 100_000;
const author = { address: "12D3KooWBannedAuthor" };
const signature = (name: string) => ({
    type: "ed25519",
    signature: `sig-${name}`,
    publicKey: `pk-${name}`,
    signedPropertyNames: [] as string[]
});

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

// Uses DbHandler directly (Node-only), so it cannot run under RPC.
describeSkipIfRpc("v45 → v46 DB migration (commentUpdates.authorBanExpiresAt column)", function () {
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

        db.exec(V45_CREATE_COMMENTS);
        db.exec(V45_CREATE_COMMENT_UPDATES);
        db.exec(V45_CREATE_VOTES);
        db.exec(V45_CREATE_COMMENT_EDITS);
        db.exec(V45_CREATE_COMMENT_MODERATIONS);
        db.exec(V45_CREATE_PSEUDONYMITY_ALIASES);

        const insertComment = db.prepare(
            `INSERT INTO comments (cid, authorSignerAddress, author, postCid, communityPublicKey, content, title, timestamp, signature,
                depth, number, postNumber, protocolVersion, insertedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const insertCommentUpdate = db.prepare(
            `INSERT INTO commentUpdates (cid, upvoteCount, downvoteCount, replyCount, childCount, updatedAt, protocolVersion, signature,
                author, postUpdatesBucket, publishedToPostUpdatesMFS, insertedAt)
             VALUES (?, 0, 0, 0, 0, ?, '1.0.0', ?, ?, 0, 1, ?)`
        );
        [BANNED_POST_CID, OTHER_POST_CID].forEach((cid, index) => {
            const timestamp = now - 300 + index;
            insertComment.run(
                cid,
                author.address,
                JSON.stringify(author),
                cid,
                COMMUNITY_ADDRESS,
                `content of ${cid}`,
                `title of ${cid}`,
                timestamp,
                JSON.stringify(signature(cid)),
                0,
                index + 1,
                index + 1,
                "1.0.0",
                timestamp
            );
            // What a v45 community stored: the author aggregate on both posts, nothing saying which one the ban was on
            insertCommentUpdate.run(
                cid,
                now - 100,
                JSON.stringify(signature(`update-${cid}`)),
                JSON.stringify({
                    community: {
                        postScore: 0,
                        replyScore: 0,
                        firstCommentTimestamp: now - 300,
                        lastCommentCid: OTHER_POST_CID,
                        banExpiresAt: BAN_EXPIRES_AT
                    }
                }),
                now - 100
            );
        });
        db.prepare(
            `INSERT INTO commentModerations (commentCid, author, signature, modSignerAddress, protocolVersion, communityPublicKey,
                timestamp, commentModeration, insertedAt, targetAuthorSignerAddress)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            BANNED_POST_CID,
            JSON.stringify({ address: "12D3KooWMod" }),
            JSON.stringify(signature("ban")),
            "12D3KooWMod",
            "1.0.0",
            COMMUNITY_ADDRESS,
            now - 200,
            JSON.stringify({ author: { banExpiresAt: BAN_EXPIRES_AT }, reason: "banned before the upgrade" }),
            now - 200,
            author.address
        );

        db.pragma("user_version = 45");

        priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
        priv._purgeCommentEditsWithInvalidSchemaOrSignature = async () => {};
        priv._purgePublicationTablesWithDuplicateSignatures = async () => {};

        await dbHandler.createOrMigrateTablesIfNeeded();
    });

    it("the commentUpdates table has an authorBanExpiresAt column", () => {
        const columns = (getPrivate(dbHandler!)._db.prepare("PRAGMA table_info(commentUpdates)").all() as { name: string }[]).map(
            (c) => c.name
        );
        expect(columns).to.include("authorBanExpiresAt");
    });

    it("the commentUpdates rows are dropped to be recalculated, the comments and the ban moderation are kept", () => {
        const db = getPrivate(dbHandler!)._db;
        expect((db.prepare("SELECT COUNT(*) AS count FROM commentUpdates").get() as { count: number }).count).to.equal(0);
        expect((db.prepare("SELECT COUNT(*) AS count FROM comments").get() as { count: number }).count).to.equal(2);
        const moderations = dbHandler!.queryAllCommentModerations();
        expect(moderations).to.have.length(1);
        expect(moderations[0].commentCid).to.equal(BANNED_POST_CID);
        expect(moderations[0].commentModeration.author?.banExpiresAt).to.equal(BAN_EXPIRES_AT);
    });

    it("a ban published before the upgrade marks the comment it was published on, and only that one", () => {
        const banned = dbHandler!.queryCalculatedCommentUpdate({ comment: dbHandler!.queryComment(BANNED_POST_CID)! });
        const other = dbHandler!.queryCalculatedCommentUpdate({ comment: dbHandler!.queryComment(OTHER_POST_CID)! });
        expect(banned.authorBanExpiresAt).to.equal(BAN_EXPIRES_AT);
        expect(banned.reason).to.equal("banned before the upgrade");
        expect(other.authorBanExpiresAt).to.be.undefined;
        expect(banned.author.community.banExpiresAt).to.equal(BAN_EXPIRES_AT);
        expect(other.author.community.banExpiresAt).to.equal(BAN_EXPIRES_AT);
    });

    it("DB version was bumped to the latest", () => {
        const userVersion = getPrivate(dbHandler!)._db.pragma("user_version", { simple: true }) as number;
        expect(userVersion).to.equal(env.DB_VERSION);
        expect(env.DB_VERSION).to.be.at.least(46);
    });
});

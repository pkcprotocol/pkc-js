import { it, describe, beforeAll, afterAll, expect } from "vitest";
import env from "../../../dist/node/version.js";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { deriveCommentIpfsFromCommentTableRow } from "../../../dist/node/runtime/node/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type Database from "better-sqlite3";

// v44 tables are the v43 ones. v44 -> v45 adds the comments.gallery JSON column (issue #436). Old rows are not
// rewritten: a link post keeps rebuilding into the CommentIpfs it was signed as, with no gallery key, and a row an
// older community stored with an unknown `gallery` prop keeps it in extraProps, where reconstruction still finds it.

const V44_CREATE_COMMENTS = `
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

const V44_CREATE_COMMENT_UPDATES = `
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

const V44_CREATE_VOTES = `
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

const V44_CREATE_COMMENT_EDITS = `
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

const V44_CREATE_COMMENT_MODERATIONS = `
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

const V44_CREATE_PSEUDONYMITY_ALIASES = `
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

const COMMUNITY_ADDRESS = "12D3KooWTestCommunityAddressV45";
const now = Math.floor(Date.now() / 1000);
const LINK_POST_CID = "QmOldLinkPost";
const EXTRA_PROPS_GALLERY_POST_CID = "QmOldCommunityGalleryPost";

const linkSignature = {
    type: "ed25519",
    signature: "sig-link-post",
    publicKey: "pk-link-post",
    signedPropertyNames: [
        "communityPublicKey",
        "content",
        "author",
        "timestamp",
        "title",
        "link",
        "linkWidth",
        "linkHeight",
        "linkHtmlTagName"
    ]
};
const extraPropsGallerySignature = {
    type: "ed25519",
    signature: "sig-gallery-post",
    publicKey: "pk-gallery-post",
    signedPropertyNames: ["communityPublicKey", "author", "timestamp", "gallery"]
};
const extraPropsGallery = [{ url: "https://example.com/a.png", htmlTagName: "img" }];
const author = { address: "12D3KooWAuthor" };

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
describeSkipIfRpc("v44 → v45 DB migration (comments.gallery column)", function () {
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

        db.exec(V44_CREATE_COMMENTS);
        db.exec(V44_CREATE_COMMENT_UPDATES);
        db.exec(V44_CREATE_VOTES);
        db.exec(V44_CREATE_COMMENT_EDITS);
        db.exec(V44_CREATE_COMMENT_MODERATIONS);
        db.exec(V44_CREATE_PSEUDONYMITY_ALIASES);

        db.prepare(
            `INSERT INTO comments (cid, authorSignerAddress, author, link, linkWidth, linkHeight, linkHtmlTagName, thumbnailUrl,
                thumbnailUrlWidth, thumbnailUrlHeight, postCid, communityPublicKey, content, title, timestamp, signature, depth,
                protocolVersion, insertedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            LINK_POST_CID,
            author.address,
            JSON.stringify(author),
            "https://example.com/cover.png",
            800,
            600,
            "img",
            "https://example.com/cover.png",
            800,
            600,
            LINK_POST_CID,
            COMMUNITY_ADDRESS,
            "a link post",
            "title",
            now - 300,
            JSON.stringify(linkSignature),
            0,
            "1.0.0",
            now - 300
        );
        db.prepare(
            `INSERT INTO comments (cid, authorSignerAddress, author, postCid, communityPublicKey, timestamp, signature, depth,
                extraProps, protocolVersion, insertedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
            EXTRA_PROPS_GALLERY_POST_CID,
            author.address,
            JSON.stringify(author),
            EXTRA_PROPS_GALLERY_POST_CID,
            COMMUNITY_ADDRESS,
            now - 200,
            JSON.stringify(extraPropsGallerySignature),
            0,
            JSON.stringify({ gallery: extraPropsGallery }),
            "1.0.0",
            now - 200
        );

        db.pragma("user_version = 44");

        priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
        priv._purgeCommentEditsWithInvalidSchemaOrSignature = async () => {};
        priv._purgePublicationTablesWithDuplicateSignatures = async () => {};

        await dbHandler.createOrMigrateTablesIfNeeded();
    });

    it("the comments table has a gallery column", () => {
        const columns = (getPrivate(dbHandler!)._db.prepare("PRAGMA table_info(comments)").all() as { name: string }[]).map((c) => c.name);
        expect(columns).to.include("gallery");
    });

    it("old rows are not backfilled", () => {
        const rows = getPrivate(dbHandler!)._db.prepare("SELECT gallery FROM comments").all() as { gallery: string | null }[];
        expect(rows.map((r) => r.gallery)).to.deep.equal([null, null]);
    });

    it("an old link post still rebuilds into the same CommentIpfs", () => {
        const rebuilt = deriveCommentIpfsFromCommentTableRow(dbHandler!.queryComment(LINK_POST_CID)!);
        expect(rebuilt).to.deep.equal({
            author,
            link: "https://example.com/cover.png",
            linkWidth: 800,
            linkHeight: 600,
            linkHtmlTagName: "img",
            thumbnailUrl: "https://example.com/cover.png",
            thumbnailUrlWidth: 800,
            thumbnailUrlHeight: 600,
            communityPublicKey: COMMUNITY_ADDRESS,
            content: "a link post",
            title: "title",
            timestamp: now - 300,
            signature: linkSignature,
            depth: 0,
            protocolVersion: "1.0.0"
        });
        expect(rebuilt).to.not.have.property("gallery");
    });

    it("a gallery an older community kept in extraProps still rebuilds into the CommentIpfs", () => {
        const row = dbHandler!.queryComment(EXTRA_PROPS_GALLERY_POST_CID)!;
        expect(row.gallery).to.be.undefined;
        const rebuilt = deriveCommentIpfsFromCommentTableRow(row);
        expect(rebuilt).to.deep.equal({
            author,
            communityPublicKey: COMMUNITY_ADDRESS,
            timestamp: now - 200,
            signature: extraPropsGallerySignature,
            depth: 0,
            protocolVersion: "1.0.0",
            gallery: extraPropsGallery
        });
    });

    it("DB version was bumped to the latest", () => {
        const userVersion = getPrivate(dbHandler!)._db.pragma("user_version", { simple: true }) as number;
        expect(userVersion).to.equal(env.DB_VERSION);
    });
});

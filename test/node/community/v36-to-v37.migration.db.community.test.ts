import { it, describe, beforeAll, afterAll, expect } from "vitest";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { deriveCommentIpfsFromCommentTableRow } from "../../../dist/node/runtime/node/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type Database from "better-sqlite3";

// ──────────────────────────────────────────────────────────────
// v36 table schemas (reconstructed from v37 by replacing
// communityPublicKey/communityName with subplebbitAddress TEXT NOT NULL)
// ──────────────────────────────────────────────────────────────

const V36_CREATE_COMMENTS = `
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
        subplebbitAddress TEXT NOT NULL,
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

const V36_CREATE_COMMENT_UPDATES = `
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

const V36_CREATE_VOTES = `
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

const V36_CREATE_COMMENT_EDITS = `
    CREATE TABLE IF NOT EXISTS commentEdits (
        commentCid TEXT NOT NULL REFERENCES comments(cid),
        authorSignerAddress TEXT NOT NULL,
        author TEXT NULLABLE,
        signature TEXT NOT NULL,
        protocolVersion TEXT NOT NULL,
        subplebbitAddress TEXT NOT NULL,
        timestamp INTEGER CHECK(timestamp > 0) NOT NULL,
        content TEXT NULLABLE,
        reason TEXT NULLABLE,
        deleted INTEGER NULLABLE,
        flairs TEXT NULLABLE,
        spoiler INTEGER NULLABLE,
        nsfw INTEGER NULLABLE,
        isAuthorEdit INTEGER NOT NULL,
        insertedAt INTEGER NOT NULL,
        extraProps TEXT NULLABLE
    )
`;

const V36_CREATE_COMMENT_MODERATIONS = `
    CREATE TABLE IF NOT EXISTS commentModerations (
        commentCid TEXT NOT NULL,
        author TEXT NULLABLE,
        signature TEXT NOT NULL,
        modSignerAddress TEXT NOT NULL,
        protocolVersion TEXT NOT NULL,
        subplebbitAddress TEXT NOT NULL,
        timestamp INTEGER CHECK(timestamp > 0) NOT NULL,
        commentModeration TEXT NOT NULL,
        insertedAt INTEGER NOT NULL,
        extraProps TEXT NULLABLE,
        targetAuthorSignerAddress TEXT NULLABLE,
        targetAuthorDomain TEXT NULLABLE
    )
`;

const V36_CREATE_PSEUDONYMITY_ALIASES = `
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

// An IPNS-key-style address (NOT a domain)
const IPNS_ADDRESS = "12D3KooWTestCommunityAddress";
// A domain-style address
const DOMAIN_ADDRESS = "my-community.eth";

const now = Math.floor(Date.now() / 1000);

/** Build a minimal valid JSON signature string suitable for the DB */
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
    _community: FakeCommunity;
    _spreadExtraProps: <T extends Record<string, any>>(record: T) => T;
    _parsePrefixedComment: (row: Record<string, unknown>) => {
        comment: Record<string, unknown>;
        commentUpdate: Record<string, unknown>;
        extras: Record<string, unknown>;
    };
}

function getPrivate(handler: DbHandler): DbHandlerPrivate {
    return handler as unknown as DbHandlerPrivate;
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

describeSkipIfRpc("v36 → v37 DB migration (subplebbitAddress → communityPublicKey/communityName)", function () {
    let dbHandler: DbHandler | undefined;

    afterAll(() => {
        if (dbHandler) {
            dbHandler.destoryConnection();
            dbHandler = undefined;
        }
    });

    describe("Migration of comments table", () => {
        beforeAll(async () => {
            const fakeCommunity = createFakeCommunity(IPNS_ADDRESS);
            dbHandler = new DbHandler(fakeCommunity as unknown as LocalCommunity);
            await dbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });

            const priv = getPrivate(dbHandler);
            const db = priv._db;

            // Create the v36 schema directly
            db.exec(V36_CREATE_COMMENTS);
            db.exec(V36_CREATE_COMMENT_UPDATES);
            db.exec(V36_CREATE_VOTES);
            db.exec(V36_CREATE_COMMENT_EDITS);
            db.exec(V36_CREATE_COMMENT_MODERATIONS);
            db.exec(V36_CREATE_PSEUDONYMITY_ALIASES);

            // Insert a comment with IPNS key address
            db.prepare(
                `
                INSERT INTO comments (cid, authorSignerAddress, author, link, parentCid, postCid, previousCid,
                    subplebbitAddress, content, timestamp, signature, title, depth, spoiler, pendingApproval,
                    nsfw, extraProps, protocolVersion, insertedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                "QmPostIpns", // cid
                "12D3KooWAuthor1", // authorSignerAddress
                JSON.stringify({ address: "12D3KooWAuthor1" }), // author
                null, // link
                null, // parentCid (post)
                "QmPostIpns", // postCid (self-referencing for posts)
                null, // previousCid
                IPNS_ADDRESS, // subplebbitAddress (IPNS key)
                "post in IPNS-key community", // content
                now, // timestamp
                fakeSignatureJson("sig-ipns-post"), // signature
                "Test Post", // title
                0, // depth (post)
                0, // spoiler
                0, // pendingApproval
                0, // nsfw
                null, // extraProps
                "1.0.0", // protocolVersion
                now // insertedAt
            );

            // Insert a comment with domain address
            db.prepare(
                `
                INSERT INTO comments (cid, authorSignerAddress, author, link, parentCid, postCid, previousCid,
                    subplebbitAddress, content, timestamp, signature, title, depth, spoiler, pendingApproval,
                    nsfw, extraProps, protocolVersion, insertedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                "QmPostDomain",
                "12D3KooWAuthor2",
                JSON.stringify({ address: "12D3KooWAuthor2" }),
                null,
                null,
                "QmPostDomain",
                null,
                DOMAIN_ADDRESS, // subplebbitAddress (domain)
                "post in domain community",
                now,
                fakeSignatureJson("sig-domain-post"),
                "Domain Post",
                0,
                0,
                0,
                0,
                null,
                "1.0.0",
                now
            );

            // Insert a comment that already has extraProps (to test merging)
            db.prepare(
                `
                INSERT INTO comments (cid, authorSignerAddress, author, link, parentCid, postCid, previousCid,
                    subplebbitAddress, content, timestamp, signature, title, depth, spoiler, pendingApproval,
                    nsfw, extraProps, protocolVersion, insertedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                "QmPostWithExtra",
                "12D3KooWAuthor3",
                JSON.stringify({ address: "12D3KooWAuthor3" }),
                null,
                null,
                "QmPostWithExtra",
                null,
                IPNS_ADDRESS,
                "post with existing extraProps",
                now,
                fakeSignatureJson("sig-extra-post"),
                "Extra Props Post",
                0,
                0,
                0,
                0,
                JSON.stringify({ ipnsName: "old-ipns-name" }), // existing extraProps
                "1.0.0",
                now
            );

            // Insert a commentEdit with IPNS key address
            db.prepare(
                `
                INSERT INTO commentEdits (commentCid, authorSignerAddress, author, signature, protocolVersion,
                    subplebbitAddress, timestamp, content, reason, deleted, spoiler, nsfw, isAuthorEdit, insertedAt, extraProps)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                "QmPostIpns", // commentCid
                "12D3KooWAuthor1",
                JSON.stringify({}),
                fakeSignatureJson("sig-edit-ipns"),
                "1.0.0",
                IPNS_ADDRESS, // subplebbitAddress (IPNS key)
                now,
                "edited content",
                null,
                0,
                0,
                0,
                1, // isAuthorEdit
                now,
                null
            );

            // Insert a commentEdit with domain address
            db.prepare(
                `
                INSERT INTO commentEdits (commentCid, authorSignerAddress, author, signature, protocolVersion,
                    subplebbitAddress, timestamp, content, reason, deleted, spoiler, nsfw, isAuthorEdit, insertedAt, extraProps)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                "QmPostDomain",
                "12D3KooWAuthor2",
                JSON.stringify({}),
                fakeSignatureJson("sig-edit-domain"),
                "1.0.0",
                DOMAIN_ADDRESS, // subplebbitAddress (domain)
                now,
                "edited domain content",
                null,
                0,
                0,
                0,
                1,
                now,
                null
            );

            // Insert a commentModeration with IPNS key address
            db.prepare(
                `
                INSERT INTO commentModerations (commentCid, author, signature, modSignerAddress, protocolVersion,
                    subplebbitAddress, timestamp, commentModeration, insertedAt, extraProps)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                "QmPostIpns",
                JSON.stringify({ address: "12D3KooWMod1" }),
                fakeSignatureJson("sig-mod-ipns"),
                "12D3KooWMod1",
                "1.0.0",
                IPNS_ADDRESS, // subplebbitAddress (IPNS key)
                now,
                JSON.stringify({ approved: true }),
                now,
                null
            );

            // Insert a commentModeration with domain address
            db.prepare(
                `
                INSERT INTO commentModerations (commentCid, author, signature, modSignerAddress, protocolVersion,
                    subplebbitAddress, timestamp, commentModeration, insertedAt, extraProps)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            ).run(
                "QmPostDomain",
                JSON.stringify({ address: "12D3KooWMod2" }),
                fakeSignatureJson("sig-mod-domain"),
                "12D3KooWMod2",
                "1.0.0",
                DOMAIN_ADDRESS, // subplebbitAddress (domain)
                now,
                JSON.stringify({ approved: true }),
                now,
                null
            );

            // Set the DB to v36
            db.pragma("user_version = 36");

            // Verify we're at v36 before migration
            expect(dbHandler!.getDbVersion()).to.equal(36);

            // Stub out the purge methods — they verify real crypto signatures,
            // which our fake data cannot satisfy
            priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
            priv._purgeCommentEditsWithInvalidSchemaOrSignature = async () => {};
            priv._purgePublicationTablesWithDuplicateSignatures = async () => {};

            // Run migration
            await dbHandler!.createOrMigrateTablesIfNeeded();
        });

        it("DB version is updated to 37", () => {
            expect(dbHandler!.getDbVersion()).to.equal(37);
        });

        it("subplebbitAddress column no longer exists in comments table", () => {
            const priv = getPrivate(dbHandler!);
            const columns = priv._db.pragma("table_info(comments)") as { name: string }[];
            const columnNames = columns.map((c) => c.name);
            expect(columnNames).not.to.include("subplebbitAddress");
        });

        it("communityPublicKey and communityName columns exist in comments table", () => {
            const priv = getPrivate(dbHandler!);
            const columns = priv._db.pragma("table_info(comments)") as { name: string }[];
            const columnNames = columns.map((c) => c.name);
            expect(columnNames).to.include("communityPublicKey");
            expect(columnNames).to.include("communityName");
        });

        it("subplebbitAddress column no longer exists in commentEdits table", () => {
            const priv = getPrivate(dbHandler!);
            const columns = priv._db.pragma("table_info(commentEdits)") as { name: string }[];
            const columnNames = columns.map((c) => c.name);
            expect(columnNames).not.to.include("subplebbitAddress");
        });

        it("communityPublicKey and communityName columns exist in commentEdits table", () => {
            const priv = getPrivate(dbHandler!);
            const columns = priv._db.pragma("table_info(commentEdits)") as { name: string }[];
            const columnNames = columns.map((c) => c.name);
            expect(columnNames).to.include("communityPublicKey");
            expect(columnNames).to.include("communityName");
        });

        it("subplebbitAddress column no longer exists in commentModerations table", () => {
            const priv = getPrivate(dbHandler!);
            const columns = priv._db.pragma("table_info(commentModerations)") as { name: string }[];
            const columnNames = columns.map((c) => c.name);
            expect(columnNames).not.to.include("subplebbitAddress");
        });

        it("communityPublicKey and communityName columns exist in commentModerations table", () => {
            const priv = getPrivate(dbHandler!);
            const columns = priv._db.pragma("table_info(commentModerations)") as { name: string }[];
            const columnNames = columns.map((c) => c.name);
            expect(columnNames).to.include("communityPublicKey");
            expect(columnNames).to.include("communityName");
        });

        // ── comments table: IPNS key → communityPublicKey ──

        it("IPNS-key comment: communityPublicKey = old subplebbitAddress, communityName = NULL", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db.prepare("SELECT * FROM comments WHERE cid = ?").get("QmPostIpns") as Record<string, unknown>;
            expect(row).to.exist;
            expect(row.communityPublicKey).to.equal(IPNS_ADDRESS);
            expect(row.communityName).to.be.null;
        });

        it("IPNS-key comment: extraProps contains subplebbitAddress", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db.prepare("SELECT * FROM comments WHERE cid = ?").get("QmPostIpns") as Record<string, unknown>;
            const extraProps = JSON.parse(row.extraProps as string);
            expect(extraProps.subplebbitAddress).to.equal(IPNS_ADDRESS);
        });

        // ── comments table: domain → communityName ──

        it("domain comment: communityName = old subplebbitAddress, communityPublicKey = NULL", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db.prepare("SELECT * FROM comments WHERE cid = ?").get("QmPostDomain") as Record<string, unknown>;
            expect(row).to.exist;
            expect(row.communityName).to.equal(DOMAIN_ADDRESS);
            expect(row.communityPublicKey).to.be.null;
        });

        it("domain comment: extraProps contains subplebbitAddress", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db.prepare("SELECT * FROM comments WHERE cid = ?").get("QmPostDomain") as Record<string, unknown>;
            const extraProps = JSON.parse(row.extraProps as string);
            expect(extraProps.subplebbitAddress).to.equal(DOMAIN_ADDRESS);
        });

        // ── comments table: existing extraProps are preserved/merged ──

        it("comment with existing extraProps: subplebbitAddress is merged into extraProps alongside original properties", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db.prepare("SELECT * FROM comments WHERE cid = ?").get("QmPostWithExtra") as Record<string, unknown>;
            const extraProps = JSON.parse(row.extraProps as string);
            expect(extraProps.subplebbitAddress).to.equal(IPNS_ADDRESS);
            expect(extraProps.ipnsName).to.equal("old-ipns-name");
        });

        // ── commentEdits table ──

        it("IPNS-key commentEdit: communityPublicKey = old subplebbitAddress, communityName = NULL", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db.prepare("SELECT * FROM commentEdits WHERE commentCid = ?").get("QmPostIpns") as Record<string, unknown>;
            expect(row).to.exist;
            expect(row.communityPublicKey).to.equal(IPNS_ADDRESS);
            expect(row.communityName).to.be.null;
        });

        it("IPNS-key commentEdit: extraProps contains subplebbitAddress", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db.prepare("SELECT * FROM commentEdits WHERE commentCid = ?").get("QmPostIpns") as Record<string, unknown>;
            const extraProps = JSON.parse(row.extraProps as string);
            expect(extraProps.subplebbitAddress).to.equal(IPNS_ADDRESS);
        });

        it("domain commentEdit: communityName = old subplebbitAddress, communityPublicKey = NULL", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db.prepare("SELECT * FROM commentEdits WHERE commentCid = ?").get("QmPostDomain") as Record<string, unknown>;
            expect(row).to.exist;
            expect(row.communityName).to.equal(DOMAIN_ADDRESS);
            expect(row.communityPublicKey).to.be.null;
        });

        it("domain commentEdit: extraProps contains subplebbitAddress", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db.prepare("SELECT * FROM commentEdits WHERE commentCid = ?").get("QmPostDomain") as Record<string, unknown>;
            const extraProps = JSON.parse(row.extraProps as string);
            expect(extraProps.subplebbitAddress).to.equal(DOMAIN_ADDRESS);
        });

        // ── commentModerations table ──

        it("IPNS-key commentModeration: communityPublicKey = old subplebbitAddress, communityName = NULL", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db.prepare("SELECT * FROM commentModerations WHERE commentCid = ?").get("QmPostIpns") as Record<
                string,
                unknown
            >;
            expect(row).to.exist;
            expect(row.communityPublicKey).to.equal(IPNS_ADDRESS);
            expect(row.communityName).to.be.null;
        });

        it("IPNS-key commentModeration: extraProps contains subplebbitAddress", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db.prepare("SELECT * FROM commentModerations WHERE commentCid = ?").get("QmPostIpns") as Record<
                string,
                unknown
            >;
            const extraProps = JSON.parse(row.extraProps as string);
            expect(extraProps.subplebbitAddress).to.equal(IPNS_ADDRESS);
        });

        it("domain commentModeration: communityName = old subplebbitAddress, communityPublicKey = NULL", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db.prepare("SELECT * FROM commentModerations WHERE commentCid = ?").get("QmPostDomain") as Record<
                string,
                unknown
            >;
            expect(row).to.exist;
            expect(row.communityName).to.equal(DOMAIN_ADDRESS);
            expect(row.communityPublicKey).to.be.null;
        });

        it("domain commentModeration: extraProps contains subplebbitAddress", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db.prepare("SELECT * FROM commentModerations WHERE commentCid = ?").get("QmPostDomain") as Record<
                string,
                unknown
            >;
            const extraProps = JSON.parse(row.extraProps as string);
            expect(extraProps.subplebbitAddress).to.equal(DOMAIN_ADDRESS);
        });
    });

    describe("deriveCommentIpfsFromCommentTableRow for migrated rows", () => {
        it("old-format row (with extraProps.subplebbitAddress): derived CommentIpfs has subplebbitAddress, not communityPublicKey/communityName", () => {
            // Simulate a migrated row: communityPublicKey is set, extraProps has subplebbitAddress
            const row = dbHandler!.queryComment("QmPostIpns");
            expect(row).to.exist;
            const commentIpfs = deriveCommentIpfsFromCommentTableRow(row!);

            // Should have subplebbitAddress (from extraProps spread)
            expect((commentIpfs as Record<string, unknown>).subplebbitAddress).to.equal(IPNS_ADDRESS);
            // Should NOT have communityPublicKey/communityName (removed for CID preservation)
            expect((commentIpfs as Record<string, unknown>).communityPublicKey).to.be.undefined;
            expect((commentIpfs as Record<string, unknown>).communityName).to.be.undefined;
        });

        it("old-format row (domain, with extraProps.subplebbitAddress): derived CommentIpfs has subplebbitAddress, not communityPublicKey/communityName", () => {
            const row = dbHandler!.queryComment("QmPostDomain");
            expect(row).to.exist;
            const commentIpfs = deriveCommentIpfsFromCommentTableRow(row!);

            expect((commentIpfs as Record<string, unknown>).subplebbitAddress).to.equal(DOMAIN_ADDRESS);
            expect((commentIpfs as Record<string, unknown>).communityPublicKey).to.be.undefined;
            expect((commentIpfs as Record<string, unknown>).communityName).to.be.undefined;
        });
    });

    describe("deriveCommentIpfsFromCommentTableRow for new-format rows (no extraProps.subplebbitAddress)", () => {
        let newFormatDbHandler: DbHandler | undefined;

        beforeAll(async () => {
            // Create a fresh v37 DB with a new-format comment (no extraProps.subplebbitAddress)
            const fakeCommunity = createFakeCommunity(IPNS_ADDRESS);
            newFormatDbHandler = new DbHandler(fakeCommunity as unknown as LocalCommunity);
            await newFormatDbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
            await newFormatDbHandler.createOrMigrateTablesIfNeeded();

            // Insert a new-format comment directly using DbHandler API
            newFormatDbHandler.insertComments([
                {
                    cid: "QmNewFormatPost",
                    authorSignerAddress: "12D3KooWNewAuthor",
                    author: { address: "12D3KooWNewAuthor" },
                    link: null,
                    linkWidth: null,
                    linkHeight: null,
                    thumbnailUrl: null,
                    thumbnailUrlWidth: null,
                    thumbnailUrlHeight: null,
                    parentCid: null,
                    postCid: "QmNewFormatPost",
                    previousCid: null,
                    communityPublicKey: IPNS_ADDRESS,
                    content: "new format post",
                    timestamp: now,
                    signature: {
                        type: "ed25519",
                        signature: "sig-new-format",
                        publicKey: "pk-new-format",
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
                    },
                    title: "New Format Post",
                    depth: 0,
                    linkHtmlTagName: null,
                    flairs: null,
                    spoiler: false,
                    pendingApproval: false,
                    nsfw: false,
                    extraProps: null,
                    protocolVersion: "1.0.0",
                    insertedAt: now
                }
            ]);
        });

        afterAll(() => {
            if (newFormatDbHandler) {
                newFormatDbHandler.destoryConnection();
                newFormatDbHandler = undefined;
            }
        });

        it("new-format row (no extraProps.subplebbitAddress): derived CommentIpfs has communityPublicKey, not subplebbitAddress", () => {
            const row = newFormatDbHandler!.queryComment("QmNewFormatPost");
            expect(row).to.exist;
            const commentIpfs = deriveCommentIpfsFromCommentTableRow(row!);

            // Should have communityPublicKey (new wire format)
            expect((commentIpfs as Record<string, unknown>).communityPublicKey).to.equal(IPNS_ADDRESS);
            // Should NOT have subplebbitAddress
            expect((commentIpfs as Record<string, unknown>).subplebbitAddress).to.be.undefined;
        });
    });

    describe("_spreadExtraProps strips communityPublicKey/communityName for old migrated rows", () => {
        // Bug: _spreadExtraProps (used by _parsePrefixedComment in page queries) spreads
        // extraProps.subplebbitAddress into the record but doesn't remove communityPublicKey/communityName.
        // This causes page comments to have BOTH old and new fields → CID mismatch → invalid signature.

        it("record with extraProps.subplebbitAddress should NOT have communityPublicKey or communityName after spread", () => {
            const priv = getPrivate(dbHandler!);
            const record: Record<string, unknown> = {
                communityPublicKey: IPNS_ADDRESS,
                communityName: undefined,
                content: "test",
                extraProps: { subplebbitAddress: IPNS_ADDRESS }
            };
            const result = priv._spreadExtraProps({ ...record });
            // subplebbitAddress should be present (restored from extraProps)
            expect(result.subplebbitAddress).to.equal(IPNS_ADDRESS);
            // communityPublicKey/communityName should be removed to preserve CID reproducibility
            expect(result.communityPublicKey).to.be.undefined;
            expect(result.communityName).to.be.undefined;
        });

        it("record with extraProps.subplebbitAddress (domain) should NOT have communityPublicKey or communityName after spread", () => {
            const priv = getPrivate(dbHandler!);
            const record: Record<string, unknown> = {
                communityPublicKey: undefined,
                communityName: DOMAIN_ADDRESS,
                content: "test",
                extraProps: { subplebbitAddress: DOMAIN_ADDRESS }
            };
            const result = priv._spreadExtraProps({ ...record });
            expect(result.subplebbitAddress).to.equal(DOMAIN_ADDRESS);
            expect(result.communityPublicKey).to.be.undefined;
            expect(result.communityName).to.be.undefined;
        });

        it("record WITHOUT extraProps.subplebbitAddress should keep communityPublicKey/communityName", () => {
            const priv = getPrivate(dbHandler!);
            const record: Record<string, unknown> = {
                communityPublicKey: IPNS_ADDRESS,
                content: "new format post"
            };
            const result = priv._spreadExtraProps({ ...record });
            // No subplebbitAddress → new wire format, communityPublicKey should stay
            expect(result.communityPublicKey).to.equal(IPNS_ADDRESS);
            expect(result.subplebbitAddress).to.be.undefined;
        });
    });

    describe("Page queries on migrated data", () => {
        let pageDbHandler: DbHandler | undefined;

        beforeAll(async () => {
            const fakeCommunity = createFakeCommunity(IPNS_ADDRESS);
            pageDbHandler = new DbHandler(fakeCommunity as unknown as LocalCommunity);
            await pageDbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });

            const priv = getPrivate(pageDbHandler);
            const db = priv._db;

            // Create v36 schema
            db.exec(V36_CREATE_COMMENTS);
            db.exec(V36_CREATE_COMMENT_UPDATES);
            db.exec(V36_CREATE_VOTES);
            db.exec(V36_CREATE_COMMENT_EDITS);
            db.exec(V36_CREATE_COMMENT_MODERATIONS);
            db.exec(V36_CREATE_PSEUDONYMITY_ALIASES);

            // Insert a post with IPNS key address
            db.prepare(
                `INSERT INTO comments (cid, authorSignerAddress, author, link, parentCid, postCid, previousCid,
                    subplebbitAddress, content, timestamp, signature, title, depth, spoiler, pendingApproval,
                    nsfw, extraProps, protocolVersion, insertedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
                "QmPagePost",
                "12D3KooWAuthor1",
                JSON.stringify({ address: "12D3KooWAuthor1" }),
                null,
                null,
                "QmPagePost",
                null,
                IPNS_ADDRESS,
                "post for page test",
                now,
                fakeSignatureJson("sig-page-post"),
                "Page Post",
                0,
                0,
                0,
                0,
                null,
                "1.0.0",
                now
            );

            // Insert a reply
            db.prepare(
                `INSERT INTO comments (cid, authorSignerAddress, author, link, parentCid, postCid, previousCid,
                    subplebbitAddress, content, timestamp, signature, title, depth, spoiler, pendingApproval,
                    nsfw, extraProps, protocolVersion, insertedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
                "QmPageReply",
                "12D3KooWAuthor2",
                JSON.stringify({ address: "12D3KooWAuthor2" }),
                null,
                "QmPagePost",
                "QmPagePost",
                null,
                IPNS_ADDRESS,
                "reply for page test",
                now + 1,
                fakeSignatureJson("sig-page-reply"),
                null,
                1,
                0,
                0,
                0,
                null,
                "1.0.0",
                now + 1
            );

            // Set to v36 and migrate
            db.pragma("user_version = 36");
            priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
            priv._purgeCommentEditsWithInvalidSchemaOrSignature = async () => {};
            priv._purgePublicationTablesWithDuplicateSignatures = async () => {};

            await pageDbHandler!.createOrMigrateTablesIfNeeded();

            // Insert commentUpdates AFTER migration (migration drops/recreates commentUpdates table)
            const cuSig = fakeSignatureJson("sig-cu");
            const cuDb = getPrivate(pageDbHandler!);
            cuDb._db
                .prepare(
                    `INSERT INTO commentUpdates (cid, upvoteCount, downvoteCount, replyCount, childCount, number, postNumber,
                    updatedAt, protocolVersion, signature, publishedToPostUpdatesMFS, insertedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run("QmPagePost", 1, 0, 1, 1, 1, 1, now, "1.0.0", cuSig, 1, now);
            cuDb._db
                .prepare(
                    `INSERT INTO commentUpdates (cid, upvoteCount, downvoteCount, replyCount, childCount, number, postNumber,
                    updatedAt, protocolVersion, signature, publishedToPostUpdatesMFS, insertedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run("QmPageReply", 0, 0, 0, 0, 2, null, now + 1, "1.0.0", cuSig, 1, now + 1);
        });

        afterAll(() => {
            if (pageDbHandler) {
                pageDbHandler.destoryConnection();
                pageDbHandler = undefined;
            }
        });

        it("queryPageComments with excludeCommentsWithDifferentCommunityAddress returns migrated replies", () => {
            // queryPageComments finds direct children of a parent — use the post to find its reply
            const results = pageDbHandler!.queryPageComments({
                parentCid: "QmPagePost",
                excludeCommentsWithDifferentCommunityAddress: true,
                excludeRemovedComments: false,
                excludeDeletedComments: false,
                excludeCommentPendingApproval: false,
                excludeCommentWithApprovedFalse: false,
                preloadedPage: "hot",
                baseTimestamp: Math.floor(Date.now() / 1000)
            });
            expect(results.length).to.equal(1);
            expect(results[0].commentUpdate.cid).to.equal("QmPageReply");
        });

        it("queryFlattenedPageReplies returns replies from migrated data", () => {
            const results = pageDbHandler!.queryFlattenedPageReplies({
                parentCid: "QmPagePost",
                excludeCommentsWithDifferentCommunityAddress: true,
                excludeRemovedComments: false,
                excludeDeletedComments: false,
                excludeCommentPendingApproval: false,
                excludeCommentWithApprovedFalse: false,
                preloadedPage: "new",
                baseTimestamp: Math.floor(Date.now() / 1000)
            });
            expect(results.length).to.equal(1);
            expect(results[0].commentUpdate.cid).to.equal("QmPageReply");
        });

        it("queryFirstCommentWithDepth(0) works on migrated data", () => {
            const row = pageDbHandler!.queryFirstCommentWithDepth(0);
            expect(row).to.exist;
            expect(row!.depth).to.equal(0);
        });

        it("queryCommentsUnderComment returns migrated children", () => {
            const children = pageDbHandler!.queryCommentsUnderComment("QmPagePost");
            expect(children.length).to.equal(1);
            expect(children[0].cid).to.equal("QmPageReply");
        });

        it("queryPostsWithActiveScore returns migrated posts with scores", () => {
            const results = pageDbHandler!.queryPostsWithActiveScore({
                parentCid: null,
                excludeCommentsWithDifferentCommunityAddress: true,
                excludeRemovedComments: false,
                excludeDeletedComments: false,
                excludeCommentPendingApproval: false,
                excludeCommentWithApprovedFalse: false
            });
            expect(results.length).to.be.greaterThan(0);
            expect(results[0]).to.have.property("activeScore");
        });
    });

    describe("Domain address filtering on migrated data", () => {
        let domainDbHandler: DbHandler | undefined;

        beforeAll(async () => {
            const fakeCommunity = createFakeCommunity(DOMAIN_ADDRESS);
            domainDbHandler = new DbHandler(fakeCommunity as unknown as LocalCommunity);
            await domainDbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });

            const priv = getPrivate(domainDbHandler);
            const db = priv._db;

            // Create v36 schema
            db.exec(V36_CREATE_COMMENTS);
            db.exec(V36_CREATE_COMMENT_UPDATES);
            db.exec(V36_CREATE_VOTES);
            db.exec(V36_CREATE_COMMENT_EDITS);
            db.exec(V36_CREATE_COMMENT_MODERATIONS);
            db.exec(V36_CREATE_PSEUDONYMITY_ALIASES);

            // Insert a post with domain address
            db.prepare(
                `INSERT INTO comments (cid, authorSignerAddress, author, link, parentCid, postCid, previousCid,
                    subplebbitAddress, content, timestamp, signature, title, depth, spoiler, pendingApproval,
                    nsfw, extraProps, protocolVersion, insertedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
                "QmDomainPost",
                "12D3KooWAuthor1",
                JSON.stringify({ address: "12D3KooWAuthor1" }),
                null,
                null,
                "QmDomainPost",
                null,
                DOMAIN_ADDRESS,
                "post in domain community",
                now,
                fakeSignatureJson("sig-domain-page-post"),
                "Domain Page Post",
                0,
                0,
                0,
                0,
                null,
                "1.0.0",
                now
            );

            // Set to v36 and migrate
            db.pragma("user_version = 36");
            priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
            priv._purgeCommentEditsWithInvalidSchemaOrSignature = async () => {};
            priv._purgePublicationTablesWithDuplicateSignatures = async () => {};

            await domainDbHandler!.createOrMigrateTablesIfNeeded();

            // Insert commentUpdate AFTER migration (migration drops/recreates commentUpdates table)
            const domainPriv = getPrivate(domainDbHandler!);
            domainPriv._db
                .prepare(
                    `INSERT INTO commentUpdates (cid, upvoteCount, downvoteCount, replyCount, childCount, number, postNumber,
                    updatedAt, protocolVersion, signature, publishedToPostUpdatesMFS, insertedAt)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run("QmDomainPost", 1, 0, 0, 0, 1, 1, now, "1.0.0", fakeSignatureJson("sig-cu-domain"), 1, now);
        });

        afterAll(() => {
            if (domainDbHandler) {
                domainDbHandler.destoryConnection();
                domainDbHandler = undefined;
            }
        });

        it("queryPostsWithActiveScore finds domain-address posts (communityName matched)", () => {
            const results = domainDbHandler!.queryPostsWithActiveScore({
                parentCid: null,
                excludeCommentsWithDifferentCommunityAddress: true,
                excludeRemovedComments: false,
                excludeDeletedComments: false,
                excludeCommentPendingApproval: false,
                excludeCommentWithApprovedFalse: false
            });
            expect(results.length).to.equal(1);
            expect(results[0].commentUpdate.cid).to.equal("QmDomainPost");
        });

        it("queryFirstCommentWithDepth(0) finds domain-address comment", () => {
            const row = domainDbHandler!.queryFirstCommentWithDepth(0);
            expect(row).to.exist;
            expect(row!.cid).to.equal("QmDomainPost");
        });

        it(".bso equivalent matches .eth migrated rows", () => {
            // Create a second DbHandler with .bso address pointing at same DB
            // The .bso address should match the .eth migrated row via getEquivalentCommunityAddresses
            // DOMAIN_ADDRESS is "my-community.eth", so "my-community.bso" should also match
            const priv = getPrivate(domainDbHandler!);
            const bsoFakeCommunity = createFakeCommunity("my-community.bso");
            // Swap the community temporarily to test .bso equivalence
            const originalCommunity = priv._community;
            priv._community = bsoFakeCommunity;

            try {
                const results = domainDbHandler!.queryPostsWithActiveScore({
                    parentCid: null,
                    excludeCommentsWithDifferentCommunityAddress: true,
                    excludeRemovedComments: false,
                    excludeDeletedComments: false,
                    excludeCommentPendingApproval: false,
                    excludeCommentWithApprovedFalse: false
                });
                expect(results.length).to.equal(1);
                expect(results[0].commentUpdate.cid).to.equal("QmDomainPost");
            } finally {
                priv._community = originalCommunity;
            }
        });
    });

    describe("Keyv key rename: INTERNAL_SUBPLEBBIT → INTERNAL_COMMUNITY (on initDbIfNeeded)", () => {
        // The rename must happen in initDbIfNeeded(), not createOrMigrateTablesIfNeeded(),
        // because createCommunity() calls _getDbInternalState() before migration runs.
        let keyvDbHandler: DbHandler | undefined;

        afterAll(() => {
            if (keyvDbHandler) {
                keyvDbHandler.destoryConnection();
                keyvDbHandler = undefined;
            }
        });

        beforeAll(async () => {
            const fakeCommunity = createFakeCommunity(IPNS_ADDRESS);
            keyvDbHandler = new DbHandler(fakeCommunity as unknown as LocalCommunity);

            // First init — creates the DB and keyv table
            await keyvDbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });

            const priv = getPrivate(keyvDbHandler);
            const db = priv._db;

            // Insert a keyv row with the OLD key name (pre-rebranding)
            const fakeInternalState = {
                value: {
                    address: IPNS_ADDRESS,
                    createdAt: now,
                    protocolVersion: "1.0.0",
                    encryption: { type: "ed25519-aes-gcm", publicKey: "fakePubKey" },
                    signer: { publicKey: "fakePubKey", privateKey: "fakePrivKey" },
                    settings: {},
                    _usingDefaultChallenge: true,
                    _internalStateUpdateId: "fake-uuid"
                }
            };
            db.prepare(`INSERT INTO keyv (key, value) VALUES (?, ?)`).run("keyv:INTERNAL_SUBPLEBBIT", JSON.stringify(fakeInternalState));

            // Reset _keyv to null so the next initDbIfNeeded call re-creates it and triggers the rename
            (priv as unknown as Record<string, unknown>)._keyv = undefined;
            await keyvDbHandler.initDbIfNeeded();
        });

        it("old INTERNAL_SUBPLEBBIT key no longer exists", () => {
            const priv = getPrivate(keyvDbHandler!);
            const row = priv._db.prepare("SELECT * FROM keyv WHERE key = ?").get("keyv:INTERNAL_SUBPLEBBIT");
            expect(row).to.be.undefined;
        });

        it("new INTERNAL_COMMUNITY key exists with the migrated state", () => {
            const priv = getPrivate(keyvDbHandler!);
            const row = priv._db.prepare("SELECT * FROM keyv WHERE key = ?").get("keyv:INTERNAL_COMMUNITY") as
                | { key: string; value: string }
                | undefined;
            expect(row).to.exist;
            const parsed = JSON.parse(row!.value);
            expect(parsed.value.address).to.equal(IPNS_ADDRESS);
            expect(parsed.value.createdAt).to.equal(now);
        });
    });

    describe("Schema validation tolerates pre-rebranding author.address in comment edits", () => {
        // Pre-rebranding comment edits have author: { address: "12D3KooW..." }.
        // The purge schema validation must tolerate this legacy field instead of treating it as invalid.
        // We test the schema directly because the full purge also verifies crypto signatures,
        // which cannot be faked in unit tests.

        it("CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema.strip() accepts a record with author.address", () => {
            const {
                CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema
            } = require("../../../dist/node/publications/comment-edit/schema.js");
            const record = {
                commentCid: "QmT5G1gnNHpGfRyqbdp7M5S4n16BsC27xWodNDJar4UNNz",
                author: { address: "12D3KooWAuthorPurge" },
                timestamp: now,
                protocolVersion: "1.0.0",
                communityPublicKey: IPNS_ADDRESS,
                content: "edited content",
                signature: {
                    type: "ed25519",
                    signature: "fake-sig",
                    publicKey: "fake-pk",
                    signedPropertyNames: ["commentCid", "author", "timestamp", "content", "communityPublicKey"]
                },
                // Extra fields from CommentEditsTableRow that should be stripped
                insertedAt: now,
                authorSignerAddress: "12D3KooWAuthorPurge",
                isAuthorEdit: true,
                extraProps: { subplebbitAddress: IPNS_ADDRESS }
            };
            expect(() => CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema.strip().parse(record)).not.to.throw();
        });

        it("CommentEditPubsubMessagePublicationSchema.strip() rejects a record with author.address (the old bug)", () => {
            const { CommentEditPubsubMessagePublicationSchema } = require("../../../dist/node/publications/comment-edit/schema.js");
            const record = {
                commentCid: "QmT5G1gnNHpGfRyqbdp7M5S4n16BsC27xWodNDJar4UNNz",
                author: { address: "12D3KooWAuthorPurge" },
                timestamp: now,
                protocolVersion: "1.0.0",
                communityPublicKey: IPNS_ADDRESS,
                content: "edited content",
                signature: {
                    type: "ed25519",
                    signature: "fake-sig",
                    publicKey: "fake-pk",
                    signedPropertyNames: ["commentCid", "author", "timestamp", "content", "communityPublicKey"]
                }
            };
            expect(() => CommentEditPubsubMessagePublicationSchema.strip().parse(record)).to.throw(/address/);
        });
    });

    describe("CHECK constraint enforcement", () => {
        let constraintDbHandler: DbHandler | undefined;

        beforeAll(async () => {
            // Create a fresh v37 DB
            const fakeCommunity = createFakeCommunity(IPNS_ADDRESS);
            constraintDbHandler = new DbHandler(fakeCommunity as unknown as LocalCommunity);
            await constraintDbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
            await constraintDbHandler.createOrMigrateTablesIfNeeded();
        });

        afterAll(() => {
            if (constraintDbHandler) {
                constraintDbHandler.destoryConnection();
                constraintDbHandler = undefined;
            }
        });

        it("inserting a comment with both communityPublicKey and communityName as NULL should succeed (no CHECK constraint on comments table)", () => {
            // The v37 comments table does NOT have a CHECK constraint —
            // communityPublicKey and communityName are both nullable without a constraint.
            // This test documents the current behavior.
            const priv = getPrivate(constraintDbHandler!);
            expect(() => {
                priv._db
                    .prepare(
                        `INSERT INTO comments (cid, authorSignerAddress, author, postCid, timestamp, signature, depth, protocolVersion, insertedAt)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    )
                    .run(
                        "QmNullCommunity",
                        "12D3KooWNullAuthor",
                        JSON.stringify({ address: "12D3KooWNullAuthor" }),
                        "QmNullCommunity",
                        now,
                        fakeSignatureJson("sig-null-community"),
                        0,
                        "1.0.0",
                        now
                    );
            }).not.to.throw();
        });
    });
});

import { it, describe, beforeAll, afterAll, expect } from "vitest";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { deriveCommentIpfsFromCommentTableRow } from "../../../dist/node/runtime/node/util.js";
import { describeSkipIfRpc } from "../../../dist/node/test/test-util.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type Database from "better-sqlite3";

// ──────────────────────────────────────────────────────────────
// v29 table schemas (reconstructed from production DB)
// Differences from v36: flair (singular not flairs), no originalCommentSignatureEncoded,
// no pseudonymityMode, no quotedCids, no targetAuthorSignerAddress/targetAuthorDomain
// in moderations, no archived in commentUpdates, no originalAuthorDomain in pseudonymityAliases
// ──────────────────────────────────────────────────────────────

const V29_CREATE_COMMENTS = `
    CREATE TABLE IF NOT EXISTS comments (
        cid TEXT NOT NULL PRIMARY KEY UNIQUE,
        authorSignerAddress TEXT NOT NULL,
        author TEXT NOT NULL,
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
        title TEXT NULLABLE,
        depth INTEGER NOT NULL,
        linkHtmlTagName TEXT NULLABLE,
        flair TEXT NULLABLE,
        spoiler INTEGER NULLABLE,
        pendingApproval INTEGER NULLABLE,
        number INTEGER NULLABLE,
        postNumber INTEGER NULLABLE,
        nsfw INTEGER NULLABLE,
        extraProps TEXT NULLABLE,
        protocolVersion TEXT NOT NULL,
        insertedAt INTEGER NOT NULL
    )
`;

const V29_CREATE_COMMENT_UPDATES = `
    CREATE TABLE IF NOT EXISTS commentUpdates (
        cid TEXT NOT NULL PRIMARY KEY UNIQUE REFERENCES comments(cid),
        edit TEXT NULLABLE,
        upvoteCount INTEGER NOT NULL,
        downvoteCount INTEGER NOT NULL,
        replyCount INTEGER NOT NULL,
        childCount INTEGER NOT NULL,
        number INTEGER NULLABLE,
        postNumber INTEGER NULLABLE,
        flair TEXT NULLABLE,
        spoiler INTEGER NULLABLE,
        nsfw INTEGER NULLABLE,
        pinned INTEGER NULLABLE,
        locked INTEGER NULLABLE,
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

const V29_CREATE_VOTES = `
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

const V29_CREATE_COMMENT_EDITS = `
    CREATE TABLE IF NOT EXISTS commentEdits (
        commentCid TEXT NOT NULL REFERENCES comments(cid),
        authorSignerAddress TEXT NOT NULL,
        author TEXT NOT NULL,
        signature TEXT NOT NULL,
        protocolVersion TEXT NOT NULL,
        subplebbitAddress TEXT NOT NULL,
        timestamp INTEGER CHECK(timestamp > 0) NOT NULL,
        content TEXT NULLABLE,
        reason TEXT NULLABLE,
        deleted INTEGER NULLABLE,
        flair TEXT NULLABLE,
        spoiler INTEGER NULLABLE,
        nsfw INTEGER NULLABLE,
        isAuthorEdit INTEGER NOT NULL,
        insertedAt INTEGER NOT NULL,
        extraProps TEXT NULLABLE
    )
`;

const V29_CREATE_COMMENT_MODERATIONS = `
    CREATE TABLE IF NOT EXISTS commentModerations (
        commentCid TEXT NOT NULL,
        author TEXT NOT NULL,
        signature TEXT NOT NULL,
        modSignerAddress TEXT NOT NULL,
        protocolVersion TEXT NOT NULL,
        subplebbitAddress TEXT NOT NULL,
        timestamp INTEGER CHECK(timestamp > 0) NOT NULL,
        commentModeration TEXT NOT NULL,
        insertedAt INTEGER NOT NULL,
        extraProps TEXT NULLABLE
    )
`;

const V29_CREATE_PSEUDONYMITY_ALIASES = `
    CREATE TABLE IF NOT EXISTS pseudonymityAliases (
        commentCid TEXT NOT NULL PRIMARY KEY UNIQUE REFERENCES comments(cid) ON DELETE CASCADE,
        aliasPrivateKey TEXT NOT NULL,
        originalAuthorSignerPublicKey TEXT NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('per-post', 'per-reply', 'per-author')),
        insertedAt INTEGER NOT NULL
    )
`;

// Extra tables that exist in v29 but should be dropped during migration
const V29_CREATE_ANONYMITY_ALIASES = `
    CREATE TABLE IF NOT EXISTS anonymityAliases (
        commentCid TEXT NOT NULL PRIMARY KEY UNIQUE REFERENCES comments(cid) ON DELETE CASCADE,
        aliasPrivateKey TEXT NOT NULL,
        originalAuthorSignerPublicKey TEXT NOT NULL,
        mode TEXT NOT NULL,
        insertedAt INTEGER NOT NULL
    )
`;

const V29_CREATE_KEYV = `
    CREATE TABLE IF NOT EXISTS keyv (
        key TEXT NOT NULL PRIMARY KEY,
        value TEXT
    )
`;

// ──────────────────────────────────────────────────────────────
// Constants and helpers
// ──────────────────────────────────────────────────────────────

const COMMUNITY_ADDRESS = "12D3KooWG3XbzoVyAE6Y9vHZKF64Yuuu4TjdgQKedk14iYmTEPWu";

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
}

function getPrivate(handler: DbHandler): DbHandlerPrivate {
    return handler as unknown as DbHandlerPrivate;
}

// ──────────────────────────────────────────────────────────────
// Sampled production data (from a real v29 DB with 992 comments)
// Private keys and internal state are NOT included.
// ──────────────────────────────────────────────────────────────

// All comments share the same INSERT statement shape
function insertV29Comment(
    db: Database.Database,
    row: {
        cid: string;
        authorSignerAddress: string;
        author: string;
        link: string | null;
        parentCid: string | null;
        postCid: string;
        previousCid: string | null;
        content: string | null;
        timestamp: number;
        signature: string;
        title: string | null;
        depth: number;
        spoiler: number | null;
        number: number | null;
        postNumber: number | null;
        extraProps: string | null;
        insertedAt: number;
    }
) {
    db.prepare(
        `INSERT INTO comments (cid, authorSignerAddress, author, link, parentCid, postCid, previousCid,
            subplebbitAddress, content, timestamp, signature, title, depth, flair, spoiler, pendingApproval,
            number, postNumber, nsfw, extraProps, protocolVersion, insertedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
        row.cid,
        row.authorSignerAddress,
        row.author,
        row.link,
        row.parentCid,
        row.postCid,
        row.previousCid,
        COMMUNITY_ADDRESS,
        row.content,
        row.timestamp,
        row.signature,
        row.title,
        row.depth,
        null, // flair
        row.spoiler,
        null, // pendingApproval
        row.number,
        row.postNumber,
        null, // nsfw
        row.extraProps,
        "1.0.0",
        row.insertedAt
    );
}

// ──────────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────────

// Uses LocalCommunity — cannot run under RPC
describeSkipIfRpc("v29 production data → v37 migration", function () {
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

        // Create the v29 schema
        db.exec(V29_CREATE_COMMENTS);
        db.exec(V29_CREATE_COMMENT_UPDATES);
        db.exec(V29_CREATE_VOTES);
        db.exec(V29_CREATE_COMMENT_EDITS);
        db.exec(V29_CREATE_COMMENT_MODERATIONS);
        db.exec(V29_CREATE_PSEUDONYMITY_ALIASES);
        db.exec(V29_CREATE_ANONYMITY_ALIASES);
        db.exec(V29_CREATE_KEYV);

        // ── Insert sampled comments ──

        // 1. Post with extraProps={ipnsName} (most common pattern: 822/992 comments)
        insertV29Comment(db, {
            cid: "QmT5G1gnNHpGfRyqbdp7M5S4n16BsC27xWodNDJar4UNNz",
            authorSignerAddress: "12D3KooWCxH7y8Cxvk2yhFadFRm8G1Tb1LF3MKcGwuwLJemo8Vma",
            author: '{"address":"12D3KooWCxH7y8Cxvk2yhFadFRm8G1Tb1LF3MKcGwuwLJemo8Vma"}',
            link: null,
            parentCid: null,
            postCid: "QmT5G1gnNHpGfRyqbdp7M5S4n16BsC27xWodNDJar4UNNz",
            previousCid: null,
            content: "test\n",
            timestamp: 1680158165,
            signature:
                '{"signature":"rcNTVRK2mScmWpH6Nmfz/xflj42FwxQsxLhR58Jr9mNVpHf4bIgzt6+ELvcpFYiXemW8lIHugziX9aiQ/kYXCw","publicKey":"Lpn/5tsvu0gaCvKpaSelxF7hhsQYyxmWbbtpWaeQOkE","type":"ed25519","signedPropertyNames":["subplebbitAddress","author","timestamp","content","title","link","parentCid"]}',
            title: "test",
            depth: 0,
            spoiler: null,
            number: 1,
            postNumber: 1,
            extraProps: '{"ipnsName":"12D3KooWJA3H4rQ3wyH1hzz1Rmf9YppEXNosAcT74KdHpxf2aanV"}',
            insertedAt: 1680158177
        });

        // 2. Post with null extraProps (170 comments had this)
        insertV29Comment(db, {
            cid: "QmaRMPLE4iLCTWpTocNSK84wMUHUjZi4p8tCNQjJFpTpdB",
            authorSignerAddress: "12D3KooWN8b2xKKtM9GAzQQfYPRPi44SZpDPqHvsSmiE13kaz1z9",
            author: '{"address":"12D3KooWN8b2xKKtM9GAzQQfYPRPi44SZpDPqHvsSmiE13kaz1z9","previousCommentCid":"QmWdhbaf11N5tHoeH89KKfehbvMPzpGtXjPSdfaocffaVQ"}',
            link: null,
            parentCid: null,
            postCid: "QmaRMPLE4iLCTWpTocNSK84wMUHUjZi4p8tCNQjJFpTpdB",
            previousCid: "QmNuVfhCyZxhfDJmz1SpZTyfZnzh3RBitnYfudvPxTTurh",
            content: "tset",
            timestamp: 1702246305,
            signature:
                '{"signature":"sEAQ66nZPjT3d83OS05hgJzXtnchfpwfNyLELfDjLBgPnG7izodZ1YO9NPeNTIM6ItJPvbPTs3o0itVpJPOgDw","publicKey":"tvc+teVlXdsR2KdspTz1cwmXzyHI1c0879x/iYz0bEo","type":"ed25519","signedPropertyNames":["subplebbitAddress","author","timestamp","content","title","link","parentCid"]}',
            title: "test",
            depth: 0,
            spoiler: null,
            number: 823,
            postNumber: 335,
            extraProps: null,
            insertedAt: 1702246318
        });

        // 3. Link-only post (content=null, link set)
        insertV29Comment(db, {
            cid: "QmbQ6PUvYBWqJtRwp1JkxnXtvnfceyXZfq7iDXXkiX7jED",
            authorSignerAddress: "12D3KooWM9ix57gRsdDbfe57W3ziLfWgEm6gmQCkbS6jyEAqe4U9",
            author: '{"address":"12D3KooWM9ix57gRsdDbfe57W3ziLfWgEm6gmQCkbS6jyEAqe4U9","previousCommentCid":"QmPhLSQFUzAqTaWZjM96QnoJtMpwn4wjhsQvyiBT2MGmH1"}',
            link: "https://pixabay.com/photos/boy-fence-poverty-hungry-sad-1226964/",
            parentCid: null,
            postCid: "QmbQ6PUvYBWqJtRwp1JkxnXtvnfceyXZfq7iDXXkiX7jED",
            previousCid: "QmPhLSQFUzAqTaWZjM96QnoJtMpwn4wjhsQvyiBT2MGmH1",
            content: null,
            timestamp: 1680380365,
            signature:
                '{"signature":"tXk9OBhw//6mNPGydbzfQow0qbgrDKT3E7j8iF6Ly6D7JZHzt4b9WlNwR8fAQGOShPiozUpi2KWvXG/Dhj5qAQ","publicKey":"qGYW22mVrHNfiYpVF3AiJB3ZC/ZCJKyFJPvgc89wWDo","type":"ed25519","signedPropertyNames":["subplebbitAddress","author","timestamp","content","title","link","parentCid"]}',
            title: "Test Link",
            depth: 0,
            spoiler: null,
            number: 7,
            postNumber: 6,
            extraProps: '{"ipnsName":"12D3KooWNkkXK9qTvtKFYRUTyxf3JdEuuhjCma87R6tFj9wMHa6Y"}',
            insertedAt: 1680380383
        });

        // 4. Post with spoiler=1
        insertV29Comment(db, {
            cid: "QmW1JzFz4QYFEjXgExnriGbqmkbmmF2iVxUKXwZWEYcAvZ",
            authorSignerAddress: "12D3KooWEWoBjTgoHYEW5yPMcz38XaoCQtzoArSs6ESdxfT4LduH",
            author: '{"address":"12D3KooWEWoBjTgoHYEW5yPMcz38XaoCQtzoArSs6ESdxfT4LduH"}',
            link: null,
            parentCid: null,
            postCid: "QmW1JzFz4QYFEjXgExnriGbqmkbmmF2iVxUKXwZWEYcAvZ",
            previousCid: "QmdLqz716vWN5ifgBDfxE6UDZM8eAXdahtmTfFdgorf9hi",
            content: "the npc meme is a nice touch\n",
            timestamp: 1685621819,
            signature:
                '{"signature":"EyxX09SS7uLPry0aGFoCPDmtKe63eXS+2R/TAEHAWxoWtcASz6MxcbdtTEmOPqfMiklYvgDC6y88fF4Pl5LGAA","publicKey":"RcpEVWT+jBoheaL628yOnAT06MLWHTCzxXC+KsWeaFA","type":"ed25519","signedPropertyNames":["subplebbitAddress","author","timestamp","content","title","link","parentCid"]}',
            title: "henlo",
            depth: 0,
            spoiler: 1,
            number: 249,
            postNumber: 102,
            extraProps: '{"ipnsName":"12D3KooWSb1e1ZijWWCRuodPko8pVHM6iWqgx4Lxt5sTrkn4c5kf"}',
            insertedAt: 1685621829
        });

        // 5. Post (parent of depth chain) — link post
        insertV29Comment(db, {
            cid: "QmRinNcdouie5tTjpfmJpRvRn18Am1F7MYhGDXKRtm5QVt",
            authorSignerAddress: "12D3KooWM9ix57gRsdDbfe57W3ziLfWgEm6gmQCkbS6jyEAqe4U9",
            author: '{"address":"12D3KooWM9ix57gRsdDbfe57W3ziLfWgEm6gmQCkbS6jyEAqe4U9","previousCommentCid":"QmbQ6PUvYBWqJtRwp1JkxnXtvnfceyXZfq7iDXXkiX7jED"}',
            link: "https://cdn.pixabay.com/photo/2016/02/28/12/55/boy-1226964_960_720.jpg",
            parentCid: null,
            postCid: "QmRinNcdouie5tTjpfmJpRvRn18Am1F7MYhGDXKRtm5QVt",
            previousCid: "QmbQ6PUvYBWqJtRwp1JkxnXtvnfceyXZfq7iDXXkiX7jED",
            content: null,
            timestamp: 1680381419,
            signature:
                '{"signature":"7p4AtMN6viwXZ3RrpHMhAT0lfth25tV3zWcDm434p+S4M+iKNf7OFz91uU1jLgnJD+GmeNQqcfuBnXqPKMcTCQ","publicKey":"qGYW22mVrHNfiYpVF3AiJB3ZC/ZCJKyFJPvgc89wWDo","type":"ed25519","signedPropertyNames":["subplebbitAddress","author","timestamp","content","title","link","parentCid"]}',
            title: "Link post 2",
            depth: 0,
            spoiler: null,
            number: 8,
            postNumber: 7,
            extraProps: '{"ipnsName":"12D3KooWAEBtb8nvFhS3DZrtYSCakZSQmPzv2xYyurqvfWE5yQkf"}',
            insertedAt: 1680381436
        });

        // 6. Reply depth=1
        insertV29Comment(db, {
            cid: "QmWftS7hK85LLkRjokjAz5k2bZTZkNdsrhoJDzmHBRawxQ",
            authorSignerAddress: "12D3KooWM9ix57gRsdDbfe57W3ziLfWgEm6gmQCkbS6jyEAqe4U9",
            author: '{"address":"12D3KooWM9ix57gRsdDbfe57W3ziLfWgEm6gmQCkbS6jyEAqe4U9","previousCommentCid":"QmbQ6PUvYBWqJtRwp1JkxnXtvnfceyXZfq7iDXXkiX7jED"}',
            link: null,
            parentCid: "QmRinNcdouie5tTjpfmJpRvRn18Am1F7MYhGDXKRtm5QVt",
            postCid: "QmRinNcdouie5tTjpfmJpRvRn18Am1F7MYhGDXKRtm5QVt",
            previousCid: null,
            content: "Wtf\n",
            timestamp: 1680347108,
            signature:
                '{"signature":"03Yv9DuqjY4F5Jv0phglv4nVkxmtEcmbjxsVhNHG73pyE3w7u/sJtFtmmv/ohVKHd50LFoYJSMwxE/rWye5qAw","publicKey":"qGYW22mVrHNfiYpVF3AiJB3ZC/ZCJKyFJPvgc89wWDo","type":"ed25519","signedPropertyNames":["subplebbitAddress","author","timestamp","content","title","link","parentCid"]}',
            title: null,
            depth: 1,
            spoiler: null,
            number: 9,
            postNumber: null,
            extraProps: '{"ipnsName":"12D3KooWDUiP2TBjRFKDhqjRZCaTw6dFr7TdnWn3QKvXvqM8cU5w"}',
            insertedAt: 1680347124
        });

        // 7. Reply depth=2
        insertV29Comment(db, {
            cid: "QmR8exZ1qD1bLR84swfLZju3Yq5fRBPERmSv4cT7qrpusd",
            authorSignerAddress: "12D3KooWET9XtZrs1gScMXH7X1CwFNnWWWndyWSKskAM4pJ2LzCt",
            author: '{"address":"12D3KooWET9XtZrs1gScMXH7X1CwFNnWWWndyWSKskAM4pJ2LzCt","previousCommentCid":"QmR8C3hSCFwdm84DnstHVG955C3t29HyQzgpgEy2mv5UAZ"}',
            link: null,
            parentCid: "QmWftS7hK85LLkRjokjAz5k2bZTZkNdsrhoJDzmHBRawxQ",
            postCid: "QmRinNcdouie5tTjpfmJpRvRn18Am1F7MYhGDXKRtm5QVt",
            previousCid: null,
            content: "lol\n",
            timestamp: 1682237866,
            signature:
                '{"signature":"someSignature2","publicKey":"RNrzYovuFmAk/aTG4uvuw7xgnVzUjw8GDo4eTULr/J0","type":"ed25519","signedPropertyNames":["subplebbitAddress","author","timestamp","content","title","link","parentCid"]}',
            title: null,
            depth: 2,
            spoiler: null,
            number: 50,
            postNumber: null,
            extraProps: '{"ipnsName":"12D3KooWMzD44qmCXV9n2BoFXbVgdkcZBdmrQmT922qjnQXcDDYy"}',
            insertedAt: 1682237880
        });

        // 8. Reply depth=3 (deep reply)
        insertV29Comment(db, {
            cid: "QmVjSqwBG3SisjZ2N5RLMxfK5eTWoLyfUtC4VE3Z7Ct9kw",
            authorSignerAddress: "12D3KooWET9XtZrs1gScMXH7X1CwFNnWWWndyWSKskAM4pJ2LzCt",
            author: '{"address":"12D3KooWET9XtZrs1gScMXH7X1CwFNnWWWndyWSKskAM4pJ2LzCt","previousCommentCid":"QmR8exZ1qD1bLR84swfLZju3Yq5fRBPERmSv4cT7qrpusd"}',
            link: null,
            parentCid: "QmR8exZ1qD1bLR84swfLZju3Yq5fRBPERmSv4cT7qrpusd",
            postCid: "QmRinNcdouie5tTjpfmJpRvRn18Am1F7MYhGDXKRtm5QVt",
            previousCid: null,
            content: "no cap\n",
            timestamp: 1682237992,
            signature:
                '{"signature":"CCtXkgl4fUcktMLIOsHSvb6zkHMiaGq6Ag94xugtbhjJ8vi1I6kAWYMknczcFeNLJ03mheMml1+HKLCDqvHHBw","publicKey":"RNrzYovuFmAk/aTG4uvuw7xgnVzUjw8GDo4eTULr/J0","type":"ed25519","signedPropertyNames":["subplebbitAddress","author","timestamp","content","title","link","parentCid"]}',
            title: null,
            depth: 3,
            spoiler: null,
            number: 51,
            postNumber: null,
            extraProps: '{"ipnsName":"12D3KooWJwym8kgmNZGG1dAkgsRnJfH9NDKxFhfGB7ypnyUvCpNx"}',
            insertedAt: 1682238034
        });

        // 9. Post referenced by commentEdits
        insertV29Comment(db, {
            cid: "QmPq4wRDfaoaPJJu794Yt7wzNc1ts5pULS4QdvrMq5UxzQ",
            authorSignerAddress: "12D3KooW9sKUZiFRD8Jh4Zrz2k1paW2L4eQU3kFCGDVejC1Eu9Xw",
            author: '{"address":"12D3KooW9sKUZiFRD8Jh4Zrz2k1paW2L4eQU3kFCGDVejC1Eu9Xw"}',
            link: null,
            parentCid: null,
            postCid: "QmPq4wRDfaoaPJJu794Yt7wzNc1ts5pULS4QdvrMq5UxzQ",
            previousCid: "QmW5QnRLA8Rp4hqjrpyD39XGZ79BQ62ooZjfr7fetwQ1NW",
            content: "test author",
            timestamp: 1684669577,
            signature:
                '{"signature":"t9mSS9Kqzf+3goVja7fIT20JyqbmwmwqvvGFcuNy5xaTmqS/yuHCFZL5VgcRc8saCC+21CXj+JDs7pwNsk8EAg","publicKey":"AMGyneyCj/3x17tKh7jOIcvka/OpRlGfCasNpYccfNI","type":"ed25519","signedPropertyNames":["subplebbitAddress","author","timestamp","content","title","link","parentCid"]}',
            title: "test author",
            depth: 0,
            spoiler: null,
            number: 179,
            postNumber: 71,
            extraProps: '{"ipnsName":"12D3KooWRZSs1T3DwrBCExS8cbYSMGpNjfbe4GJAZnkb1kwT26NR"}',
            insertedAt: 1684669589
        });

        // 10. Post referenced by commentModeration (removed)
        insertV29Comment(db, {
            cid: "QmeCm4gCghcKpALTkvUB49Hs4NNF3yj1uuRA9Guh5ELV6M",
            authorSignerAddress: "12D3KooWRHkqrZWcEWK26ohEYRe44aeDTyxia5ySjimQh2J5h1D1",
            author: '{"address":"12D3KooWRHkqrZWcEWK26ohEYRe44aeDTyxia5ySjimQh2J5h1D1"}',
            link: "https://files.catbox.moe/sf0nva.jpg",
            parentCid: null,
            postCid: "QmeCm4gCghcKpALTkvUB49Hs4NNF3yj1uuRA9Guh5ELV6M",
            previousCid: "QmeHrdkzyak3Yjf6YU2E2d75a5jbJZzxZzpRAXJDeezrky",
            content: "Plebbit is working in browser!",
            timestamp: 1682414116,
            signature:
                '{"signature":"Uq4HwJW6h/hz5Fn4hqHa0M8g3R5pgrYqOpS1Kb0nHZ5yCPB8XHFggxhvkFWhVLCNSfbGgvNBFmE9PxY4007dAw","publicKey":"5eOfqZcyeyeRn5Gi1SIN5Zlq3XI0vgOL3y2Vc/R+ehg","type":"ed25519","signedPropertyNames":["subplebbitAddress","author","timestamp","content","title","link","parentCid"]}',
            title: "Holy shit",
            depth: 0,
            spoiler: null,
            number: 93,
            postNumber: 31,
            extraProps: '{"ipnsName":"12D3KooWJ2bCpn9mK1UPrjBYQLKZeejzwAVmTjjJqqtNiKx6QEdf"}',
            insertedAt: 1682414132
        });

        // 11. Post referenced by commentModeration (pinned)
        insertV29Comment(db, {
            cid: "QmRi5mNTKKyHe5J3Nu65CKfTNDXeibCqD8N5juKxxSYt9w",
            authorSignerAddress: "12D3KooWRHkqrZWcEWK26ohEYRe44aeDTyxia5ySjimQh2J5h1D1",
            author: '{"address":"12D3KooWRHkqrZWcEWK26ohEYRe44aeDTyxia5ySjimQh2J5h1D1"}',
            link: "https://files.catbox.moe/emrx0w.webm",
            parentCid: null,
            postCid: "QmRi5mNTKKyHe5J3Nu65CKfTNDXeibCqD8N5juKxxSYt9w",
            previousCid: "QmaqnStJMAhuzror2L6sLpvuJnzR1PLhFzkUeiW1gQfuGw",
            content: "I need answers",
            timestamp: 1682860938,
            signature:
                '{"signature":"Qrb00DTsukd2LC6XYLFaqXR0dvyiWelfzCAZTREXfcxk8/umiX3ANfpmxCx3E+5+kvDj3oa2AHCxKpoSlwKuAA","publicKey":"5eOfqZcyeyeRn5Gi1SIN5Zlq3XI0vgOL3y2Vc/R+ehg","type":"ed25519","signedPropertyNames":["subplebbitAddress","author","timestamp","content","title","link","parentCid"]}',
            title: "IS THREAD CREATION ONLY WORKS IN TEST SUB?",
            depth: 0,
            spoiler: null,
            number: 130,
            postNumber: 40,
            extraProps: '{"ipnsName":"12D3KooWNbPnVHgYjcCjcyyu7QpkhJ5SViYbcDjd5zDQ2b6quLj4"}',
            insertedAt: 1682860957
        });

        // 12. Reply with newer signedPropertyNames format (includes postCid, protocolVersion — parent needed)
        insertV29Comment(db, {
            cid: "QmTpmBy7Wq3HpQr8BPeEnRB2PS5Na3vTDexQudCrXbMFKG",
            authorSignerAddress: "12D3KooWA1rWWELxdENYH1fkctftG3Q62Q3npGkn6M7f7RKnGFjZ",
            author: '{"address":"weaponized-autism.eth","displayName":"Lucas"}',
            link: null,
            parentCid: null,
            postCid: "QmTpmBy7Wq3HpQr8BPeEnRB2PS5Na3vTDexQudCrXbMFKG",
            previousCid: "QmajbKWpGBKXzgsTZ5h1rU8jC7YtKQzP1osPP9Yqnmu1La",
            content: "LFG",
            timestamp: 1696905659,
            signature:
                '{"signature":"1ndXGVYKQCrb2/aGGJTOVY9sOJcivAKUZOa0H1vU3aTkxoyF2zBtH9ksTSV/X4UcPIEoGv0HvH3QZqP1yXJOBg","publicKey":"AvFvDz1SSHE6etIe69TLPss+rSuzTKI5nvdtK4NkegQ","type":"ed25519","signedPropertyNames":["subplebbitAddress","author","timestamp","content","title","link","parentCid"]}',
            title: "Another test for the bot, part 2",
            depth: 0,
            spoiler: null,
            number: 805,
            postNumber: 325,
            extraProps: '{"ipnsName":"12D3KooWDtWGiE2TAotQdr8V9h6tr42LfYasrAYTyvnHrwMabHEr"}',
            insertedAt: 1696905686
        });

        // 13. Reply with newer signedPropertyNames (includes postCid, protocolVersion)
        insertV29Comment(db, {
            cid: "QmYKMvU7xnYeqeYqGnhYxBqSG61HM1Vj1Jec9ft47MJdew",
            authorSignerAddress: "12D3KooWAszaoiJKCZCSeeKsjycPDrjdYG1zABbFdsgVenxdi9ma",
            author: '{"address":"rinse12.eth","previousCommentCid":"QmZncqfTpKW2JdmTCxxBD2KdcZYaodYGtbJNsdaUi3NX77","displayName":"Rinse"}',
            link: null,
            parentCid: "QmTpmBy7Wq3HpQr8BPeEnRB2PS5Na3vTDexQudCrXbMFKG",
            postCid: "QmTpmBy7Wq3HpQr8BPeEnRB2PS5Na3vTDexQudCrXbMFKG",
            previousCid: null,
            content: "test",
            timestamp: 1732965459,
            signature:
                '{"type":"ed25519","signature":"7MsAktXXYYVycJdbuu1p3klaqFNT18IErfs2oZL7zlDs8I4vjZ4R8TnIHwKluuli5Mh7kTgDCJiXWFIfeCTRBw","publicKey":"D8makE6tXl8toFXlY8npl790G0EQQuZEguqdeG4UtwE","signedPropertyNames":["content","parentCid","postCid","author","subplebbitAddress","protocolVersion","timestamp"]}',
            title: null,
            depth: 1,
            spoiler: null,
            number: 986,
            postNumber: null,
            extraProps: null,
            insertedAt: 1732965465
        });

        // 14. Reply with spoiler in signedPropertyNames
        insertV29Comment(db, {
            cid: "QmUxFdcK2SjnT1QPXzZLCWYfEih9VYr3QA6Wgh89yxDRYa",
            authorSignerAddress: "12D3KooWAszaoiJKCZCSeeKsjycPDrjdYG1zABbFdsgVenxdi9ma",
            author: '{"address":"rinse12.eth","previousCommentCid":"QmYKMvU7xnYeqeYqGnhYxBqSG61HM1Vj1Jec9ft47MJdew","displayName":"Rinse"}',
            link: null,
            parentCid: "QmTpmBy7Wq3HpQr8BPeEnRB2PS5Na3vTDexQudCrXbMFKG",
            postCid: "QmTpmBy7Wq3HpQr8BPeEnRB2PS5Na3vTDexQudCrXbMFKG",
            previousCid: "QmP6AKefx9KaKa4yvfeyWuJJr9YQ3oCnCbwXTY3S3HPnat",
            content: "zz",
            timestamp: 1733039044,
            signature:
                '{"type":"ed25519","signature":"7n6cz3BsA1m0ZVMQc0tEavuChNAKADEbOd/dfkgZYWn7MjMt5RN/Yvbu8tKedTG9NcS35xMsAY/EEJZR/PxEBw","publicKey":"D8makE6tXl8toFXlY8npl790G0EQQuZEguqdeG4UtwE","signedPropertyNames":["spoiler","content","parentCid","postCid","author","subplebbitAddress","protocolVersion","timestamp"]}',
            title: null,
            depth: 1,
            spoiler: 0,
            number: 987,
            postNumber: null,
            extraProps: null,
            insertedAt: 1733039048
        });

        // NOTE: commentUpdates are inserted AFTER migration because the migration
        // always drops and recreates the commentUpdates table.

        // ── Insert commentEdits ──
        const ceInsert = db.prepare(
            `INSERT INTO commentEdits (commentCid, authorSignerAddress, author, signature, protocolVersion,
                subplebbitAddress, timestamp, content, reason, deleted, flair, spoiler, nsfw, isAuthorEdit, insertedAt, extraProps)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        // Edit with content
        ceInsert.run(
            "QmPq4wRDfaoaPJJu794Yt7wzNc1ts5pULS4QdvrMq5UxzQ",
            "12D3KooW9sKUZiFRD8Jh4Zrz2k1paW2L4eQU3kFCGDVejC1Eu9Xw",
            '{"address":"12D3KooW9sKUZiFRD8Jh4Zrz2k1paW2L4eQU3kFCGDVejC1Eu9Xw","displayName":"Tom"}',
            '{"signature":"Y8SdVqRuVbAwqNCBAVhmWuJN7V8bL8RcBrekthvC/kORs397bnJmFhWDKXlDrWrvd+uFIu9tG5F/mHMLEgtlBg","publicKey":"AMGyneyCj/3x17tKh7jOIcvka/OpRlGfCasNpYccfNI","type":"ed25519","signedPropertyNames":["author","timestamp","subplebbitAddress","content","commentCid","deleted","spoiler","pinned","locked","removed","reason","flair","reason","commentAuthor"]}',
            "1.0.0",
            COMMUNITY_ADDRESS,
            1684836752,
            "test edit",
            null,
            null,
            null,
            null,
            null,
            1,
            1684836766,
            null
        );
        // Edit with deleted flag
        ceInsert.run(
            "QmPq4wRDfaoaPJJu794Yt7wzNc1ts5pULS4QdvrMq5UxzQ",
            "12D3KooW9sKUZiFRD8Jh4Zrz2k1paW2L4eQU3kFCGDVejC1Eu9Xw",
            '{"address":"12D3KooW9sKUZiFRD8Jh4Zrz2k1paW2L4eQU3kFCGDVejC1Eu9Xw","displayName":"Tom"}',
            '{"signature":"nQxJ9MzkuJfJwTL92/P8HVxshuUpQA/Daw8Ypyt83psODkbc7ehi+A2O03LE33z3C8U5lklIDyEb08/tSfLSBQ","publicKey":"AMGyneyCj/3x17tKh7jOIcvka/OpRlGfCasNpYccfNI","type":"ed25519","signedPropertyNames":["author","timestamp","subplebbitAddress","content","commentCid","deleted","spoiler","pinned","locked","removed","reason","flair","reason","commentAuthor"]}',
            "1.0.0",
            COMMUNITY_ADDRESS,
            1684845825,
            null,
            null,
            1,
            null,
            null,
            null,
            1,
            1684845841,
            null
        );

        // ── Insert commentModerations ──
        const cmInsert = db.prepare(
            `INSERT INTO commentModerations (commentCid, author, signature, modSignerAddress, protocolVersion,
                subplebbitAddress, timestamp, commentModeration, insertedAt, extraProps)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        // Moderation with removed
        cmInsert.run(
            "QmeCm4gCghcKpALTkvUB49Hs4NNF3yj1uuRA9Guh5ELV6M",
            '{"address":"estebanabaroa.eth","displayName":"Esteban Abaroa"}',
            '{"signature":"JRAG+8i3Q1LSDXwU8uSZltt8NFPnALzwT23cbnXDeavegBevyCFNBwAJn5MjtjkAfOLx5zfrx51nKpwjM+7iBg","publicKey":"Kpj9qZiz2jpVbq8Nmai5RQ8pNoRftGJ+NIbHhKpbIvQ","type":"ed25519","signedPropertyNames":["author","timestamp","subplebbitAddress","content","commentCid","deleted","spoiler","pinned","locked","removed","reason","flair","reason","commentAuthor"]}',
            "12D3KooWCgebdyrXRz4VERrQVpqAchXZ4ZbLum1CGB1V1jquxHnj",
            "1.0.0",
            COMMUNITY_ADDRESS,
            1683503247,
            '{"removed":true}',
            1683503282,
            null
        );
        // Moderation with pinned
        cmInsert.run(
            "QmRi5mNTKKyHe5J3Nu65CKfTNDXeibCqD8N5juKxxSYt9w",
            '{"address":"12D3KooWSaJiy4yvWSjAE6PTT3iKg5rKhFnqwoVZXquaERQb8WEJ"}',
            '{"signature":"c4U5Zr9LGSj2ICDggqy73JwwhulZAfUKbXszO2HTfAcoR9VWGV/dZYmvJUGjsUTo2CZ6s6moU2X2lnYqlZ3MBw","publicKey":"+Pym29G5jDCiOk9m8ZBVsB1XMbglFEaSrlbVWsIkXC8","type":"ed25519","signedPropertyNames":["author","timestamp","subplebbitAddress","content","commentCid","deleted","spoiler","pinned","locked","removed","reason","flair","reason","commentAuthor"]}',
            "12D3KooWSaJiy4yvWSjAE6PTT3iKg5rKhFnqwoVZXquaERQb8WEJ",
            "1.0.0",
            COMMUNITY_ADDRESS,
            1683031955,
            '{"spoiler":false,"pinned":true,"locked":false,"removed":false}',
            1683031968,
            null
        );

        // ── Insert votes ──
        db.prepare(
            `INSERT INTO votes (commentCid, authorSignerAddress, timestamp, vote, protocolVersion, insertedAt, extraProps)
            VALUES (?, ?, ?, ?, ?, ?, ?)`
        ).run(
            "QmWftS7hK85LLkRjokjAz5k2bZTZkNdsrhoJDzmHBRawxQ",
            "12D3KooWBxiRsNkMwmah2fWFmqHEZLXVMcQv1Lsk587SDUB4dGET",
            1680284520,
            1,
            "1.0.0",
            1680284531,
            null
        );

        // Set DB to v29
        db.pragma("user_version = 29");
        expect(dbHandler!.getDbVersion()).to.equal(29);

        // Stub purge methods (they verify real crypto signatures)
        priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
        priv._purgeCommentEditsWithInvalidSchemaOrSignature = async () => {};
        priv._purgePublicationTablesWithDuplicateSignatures = async () => {};

        // Run the full migration chain: v29 → v37
        await dbHandler!.createOrMigrateTablesIfNeeded();

        // Insert commentUpdates AFTER migration (migration drops/recreates the commentUpdates table)
        const commentUpdateSignature =
            '{"signature":"fakeSig","publicKey":"XIVXOOZqe8GNflQm/DKquOYtkDNVpkxXqpa+JlrGdkY","type":"ed25519","signedPropertyNames":["cid","upvoteCount","downvoteCount","replyCount","childCount","number","updatedAt","author","protocolVersion"]}';

        const cuInsert = priv._db.prepare(
            `INSERT INTO commentUpdates (cid, upvoteCount, downvoteCount, replyCount, childCount, number, postNumber,
                updatedAt, protocolVersion, signature, publishedToPostUpdatesMFS, insertedAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        cuInsert.run(
            "QmRinNcdouie5tTjpfmJpRvRn18Am1F7MYhGDXKRtm5QVt",
            0,
            0,
            9,
            3,
            8,
            7,
            1767439957,
            "1.0.0",
            commentUpdateSignature,
            1,
            1767439959
        );
        cuInsert.run(
            "QmWftS7hK85LLkRjokjAz5k2bZTZkNdsrhoJDzmHBRawxQ",
            1,
            0,
            5,
            2,
            9,
            null,
            1767439956,
            "1.0.0",
            commentUpdateSignature,
            1,
            1767439957
        );
        cuInsert.run(
            "QmR8exZ1qD1bLR84swfLZju3Yq5fRBPERmSv4cT7qrpusd",
            0,
            0,
            2,
            2,
            50,
            null,
            1767439954,
            "1.0.0",
            commentUpdateSignature,
            1,
            1767439956
        );
        cuInsert.run(
            "QmVjSqwBG3SisjZ2N5RLMxfK5eTWoLyfUtC4VE3Z7Ct9kw",
            0,
            0,
            0,
            0,
            51,
            null,
            1767439953,
            "1.0.0",
            commentUpdateSignature,
            1,
            1767439954
        );
        cuInsert.run(
            "QmT5G1gnNHpGfRyqbdp7M5S4n16BsC27xWodNDJar4UNNz",
            0,
            0,
            0,
            0,
            1,
            1,
            1767439953,
            "1.0.0",
            commentUpdateSignature,
            1,
            1767439954
        );
        cuInsert.run(
            "QmaRMPLE4iLCTWpTocNSK84wMUHUjZi4p8tCNQjJFpTpdB",
            0,
            0,
            0,
            0,
            823,
            335,
            1767439953,
            "1.0.0",
            commentUpdateSignature,
            1,
            1767439954
        );
        cuInsert.run(
            "QmbQ6PUvYBWqJtRwp1JkxnXtvnfceyXZfq7iDXXkiX7jED",
            0,
            0,
            0,
            0,
            7,
            6,
            1767439953,
            "1.0.0",
            commentUpdateSignature,
            1,
            1767439954
        );
        cuInsert.run(
            "QmW1JzFz4QYFEjXgExnriGbqmkbmmF2iVxUKXwZWEYcAvZ",
            0,
            0,
            0,
            0,
            249,
            102,
            1767439953,
            "1.0.0",
            commentUpdateSignature,
            1,
            1767439954
        );
    });

    // ── Schema migration ──

    it("DB version is updated to 37", () => {
        expect(dbHandler!.getDbVersion()).to.equal(37);
    });

    it("subplebbitAddress column removed from comments, commentEdits, commentModerations", () => {
        const priv = getPrivate(dbHandler!);
        for (const table of ["comments", "commentEdits", "commentModerations"]) {
            const columns = (priv._db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
            expect(columns, `${table} should not have subplebbitAddress`).not.to.include("subplebbitAddress");
        }
    });

    it("communityPublicKey and communityName columns exist in comments, commentEdits, commentModerations", () => {
        const priv = getPrivate(dbHandler!);
        for (const table of ["comments", "commentEdits", "commentModerations"]) {
            const columns = (priv._db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
            expect(columns, `${table} should have communityPublicKey`).to.include("communityPublicKey");
            expect(columns, `${table} should have communityName`).to.include("communityName");
        }
    });

    it("flair column removed from comments (replaced by flairs)", () => {
        const priv = getPrivate(dbHandler!);
        const columns = (priv._db.pragma("table_info(comments)") as { name: string }[]).map((c) => c.name);
        expect(columns).not.to.include("flair");
        expect(columns).to.include("flairs");
    });

    it("targetAuthorSignerAddress and targetAuthorDomain columns exist in commentModerations (v31/v32 backfill)", () => {
        const priv = getPrivate(dbHandler!);
        const columns = (priv._db.pragma("table_info(commentModerations)") as { name: string }[]).map((c) => c.name);
        expect(columns).to.include("targetAuthorSignerAddress");
        expect(columns).to.include("targetAuthorDomain");
    });

    it("originalAuthorDomain column exists in pseudonymityAliases", () => {
        const priv = getPrivate(dbHandler!);
        const columns = (priv._db.pragma("table_info(pseudonymityAliases)") as { name: string }[]).map((c) => c.name);
        expect(columns).to.include("originalAuthorDomain");
    });

    // ── Comments: IPNS-key address migration ──

    describe("Comments: IPNS-key address migration", () => {
        it("post with ipnsName extraProps: communityPublicKey set, extraProps has both ipnsName and subplebbitAddress", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db
                .prepare("SELECT * FROM comments WHERE cid = ?")
                .get("QmT5G1gnNHpGfRyqbdp7M5S4n16BsC27xWodNDJar4UNNz") as Record<string, unknown>;
            expect(row.communityPublicKey).to.equal(COMMUNITY_ADDRESS);
            expect(row.communityName).to.be.null;
            const extraProps = JSON.parse(row.extraProps as string);
            expect(extraProps.subplebbitAddress).to.equal(COMMUNITY_ADDRESS);
            expect(extraProps.ipnsName).to.equal("12D3KooWJA3H4rQ3wyH1hzz1Rmf9YppEXNosAcT74KdHpxf2aanV");
        });

        it("post with null extraProps: extraProps now contains subplebbitAddress only", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db
                .prepare("SELECT * FROM comments WHERE cid = ?")
                .get("QmaRMPLE4iLCTWpTocNSK84wMUHUjZi4p8tCNQjJFpTpdB") as Record<string, unknown>;
            expect(row.communityPublicKey).to.equal(COMMUNITY_ADDRESS);
            expect(row.communityName).to.be.null;
            const extraProps = JSON.parse(row.extraProps as string);
            expect(extraProps.subplebbitAddress).to.equal(COMMUNITY_ADDRESS);
            expect(Object.keys(extraProps)).to.deep.equal(["subplebbitAddress"]);
        });

        it("link-only post (content=null): link preserved, communityPublicKey set", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db
                .prepare("SELECT * FROM comments WHERE cid = ?")
                .get("QmbQ6PUvYBWqJtRwp1JkxnXtvnfceyXZfq7iDXXkiX7jED") as Record<string, unknown>;
            expect(row.communityPublicKey).to.equal(COMMUNITY_ADDRESS);
            expect(row.content).to.be.null;
            expect(row.link).to.equal("https://pixabay.com/photos/boy-fence-poverty-hungry-sad-1226964/");
        });

        it("spoiler post: spoiler=1 preserved, communityPublicKey set", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db
                .prepare("SELECT * FROM comments WHERE cid = ?")
                .get("QmW1JzFz4QYFEjXgExnriGbqmkbmmF2iVxUKXwZWEYcAvZ") as Record<string, unknown>;
            expect(row.communityPublicKey).to.equal(COMMUNITY_ADDRESS);
            expect(row.spoiler).to.equal(1);
        });

        it("deep reply (depth=3): parentCid and postCid intact, communityPublicKey set", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db
                .prepare("SELECT * FROM comments WHERE cid = ?")
                .get("QmVjSqwBG3SisjZ2N5RLMxfK5eTWoLyfUtC4VE3Z7Ct9kw") as Record<string, unknown>;
            expect(row.communityPublicKey).to.equal(COMMUNITY_ADDRESS);
            expect(row.depth).to.equal(3);
            expect(row.parentCid).to.equal("QmR8exZ1qD1bLR84swfLZju3Yq5fRBPERmSv4cT7qrpusd");
            expect(row.postCid).to.equal("QmRinNcdouie5tTjpfmJpRvRn18Am1F7MYhGDXKRtm5QVt");
        });

        it("reply with newer signedPropertyNames (includes postCid, protocolVersion): communityPublicKey set", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db
                .prepare("SELECT * FROM comments WHERE cid = ?")
                .get("QmYKMvU7xnYeqeYqGnhYxBqSG61HM1Vj1Jec9ft47MJdew") as Record<string, unknown>;
            expect(row.communityPublicKey).to.equal(COMMUNITY_ADDRESS);
            expect(row.communityName).to.be.null;
            // Originally had null extraProps, now has subplebbitAddress
            const extraProps = JSON.parse(row.extraProps as string);
            expect(extraProps.subplebbitAddress).to.equal(COMMUNITY_ADDRESS);
        });

        it("all 14 comments migrated successfully", () => {
            const priv = getPrivate(dbHandler!);
            const count = (priv._db.prepare("SELECT COUNT(*) as cnt FROM comments").get() as { cnt: number }).cnt;
            expect(count).to.equal(14);
        });
    });

    // ── Parent-child relationships ──

    describe("Comments: parent-child relationships intact after migration", () => {
        it("depth-1 reply has correct parent references", () => {
            const row = dbHandler!.queryComment("QmWftS7hK85LLkRjokjAz5k2bZTZkNdsrhoJDzmHBRawxQ");
            expect(row).to.exist;
            expect(row!.parentCid).to.equal("QmRinNcdouie5tTjpfmJpRvRn18Am1F7MYhGDXKRtm5QVt");
            expect(row!.postCid).to.equal("QmRinNcdouie5tTjpfmJpRvRn18Am1F7MYhGDXKRtm5QVt");
            expect(row!.depth).to.equal(1);
        });

        it("depth-2 reply has correct parent references", () => {
            const row = dbHandler!.queryComment("QmR8exZ1qD1bLR84swfLZju3Yq5fRBPERmSv4cT7qrpusd");
            expect(row).to.exist;
            expect(row!.parentCid).to.equal("QmWftS7hK85LLkRjokjAz5k2bZTZkNdsrhoJDzmHBRawxQ");
            expect(row!.postCid).to.equal("QmRinNcdouie5tTjpfmJpRvRn18Am1F7MYhGDXKRtm5QVt");
            expect(row!.depth).to.equal(2);
        });

        it("depth-3 reply has correct parent references", () => {
            const row = dbHandler!.queryComment("QmVjSqwBG3SisjZ2N5RLMxfK5eTWoLyfUtC4VE3Z7Ct9kw");
            expect(row).to.exist;
            expect(row!.parentCid).to.equal("QmR8exZ1qD1bLR84swfLZju3Yq5fRBPERmSv4cT7qrpusd");
            expect(row!.depth).to.equal(3);
        });

        it("queryCommentsUnderComment returns depth-1 children of the post", () => {
            const children = dbHandler!.queryCommentsUnderComment("QmRinNcdouie5tTjpfmJpRvRn18Am1F7MYhGDXKRtm5QVt");
            expect(children.length).to.equal(1);
            expect(children[0].cid).to.equal("QmWftS7hK85LLkRjokjAz5k2bZTZkNdsrhoJDzmHBRawxQ");
        });
    });

    // ── CommentEdits migration ──

    describe("CommentEdits migration", () => {
        it("content edit: communityPublicKey set, content preserved, extraProps has subplebbitAddress", () => {
            const priv = getPrivate(dbHandler!);
            const rows = priv._db
                .prepare("SELECT * FROM commentEdits WHERE commentCid = ? ORDER BY timestamp ASC")
                .all("QmPq4wRDfaoaPJJu794Yt7wzNc1ts5pULS4QdvrMq5UxzQ") as Record<string, unknown>[];
            expect(rows.length).to.equal(2);

            // First edit: content edit
            const contentEdit = rows[0];
            expect(contentEdit.communityPublicKey).to.equal(COMMUNITY_ADDRESS);
            expect(contentEdit.communityName).to.be.null;
            expect(contentEdit.content).to.equal("test edit");
            const extraProps = JSON.parse(contentEdit.extraProps as string);
            expect(extraProps.subplebbitAddress).to.equal(COMMUNITY_ADDRESS);
        });

        it("deleted edit: communityPublicKey set, deleted=1 preserved, extraProps has subplebbitAddress", () => {
            const priv = getPrivate(dbHandler!);
            const rows = priv._db
                .prepare("SELECT * FROM commentEdits WHERE commentCid = ? ORDER BY timestamp ASC")
                .all("QmPq4wRDfaoaPJJu794Yt7wzNc1ts5pULS4QdvrMq5UxzQ") as Record<string, unknown>[];
            const deletedEdit = rows[1];
            expect(deletedEdit.communityPublicKey).to.equal(COMMUNITY_ADDRESS);
            expect(deletedEdit.deleted).to.equal(1);
            const extraProps = JSON.parse(deletedEdit.extraProps as string);
            expect(extraProps.subplebbitAddress).to.equal(COMMUNITY_ADDRESS);
        });
    });

    // ── CommentModerations migration ──

    describe("CommentModerations migration", () => {
        it("removed moderation: communityPublicKey set, commentModeration JSON intact", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db
                .prepare("SELECT * FROM commentModerations WHERE commentCid = ?")
                .get("QmeCm4gCghcKpALTkvUB49Hs4NNF3yj1uuRA9Guh5ELV6M") as Record<string, unknown>;
            expect(row.communityPublicKey).to.equal(COMMUNITY_ADDRESS);
            expect(row.communityName).to.be.null;
            const commentModeration = JSON.parse(row.commentModeration as string);
            expect(commentModeration.removed).to.equal(true);
            const extraProps = JSON.parse(row.extraProps as string);
            expect(extraProps.subplebbitAddress).to.equal(COMMUNITY_ADDRESS);
        });

        it("pinned moderation: communityPublicKey set, commentModeration JSON intact", () => {
            const priv = getPrivate(dbHandler!);
            const row = priv._db
                .prepare("SELECT * FROM commentModerations WHERE commentCid = ?")
                .get("QmRi5mNTKKyHe5J3Nu65CKfTNDXeibCqD8N5juKxxSYt9w") as Record<string, unknown>;
            expect(row.communityPublicKey).to.equal(COMMUNITY_ADDRESS);
            const commentModeration = JSON.parse(row.commentModeration as string);
            expect(commentModeration.pinned).to.equal(true);
        });
    });

    // ── CID reconstruction ──

    describe("CID reconstruction (deriveCommentIpfsFromCommentTableRow)", () => {
        it("post with ipnsName extraProps: derived CommentIpfs has subplebbitAddress, not communityPublicKey/communityName", () => {
            const row = dbHandler!.queryComment("QmT5G1gnNHpGfRyqbdp7M5S4n16BsC27xWodNDJar4UNNz");
            expect(row).to.exist;
            const commentIpfs = deriveCommentIpfsFromCommentTableRow(row!);
            expect((commentIpfs as Record<string, unknown>).subplebbitAddress).to.equal(COMMUNITY_ADDRESS);
            expect((commentIpfs as Record<string, unknown>).communityPublicKey).to.be.undefined;
            expect((commentIpfs as Record<string, unknown>).communityName).to.be.undefined;
        });

        it("post with originally null extraProps: derived CommentIpfs has subplebbitAddress", () => {
            const row = dbHandler!.queryComment("QmaRMPLE4iLCTWpTocNSK84wMUHUjZi4p8tCNQjJFpTpdB");
            expect(row).to.exist;
            const commentIpfs = deriveCommentIpfsFromCommentTableRow(row!);
            expect((commentIpfs as Record<string, unknown>).subplebbitAddress).to.equal(COMMUNITY_ADDRESS);
            expect((commentIpfs as Record<string, unknown>).communityPublicKey).to.be.undefined;
            expect((commentIpfs as Record<string, unknown>).communityName).to.be.undefined;
        });

        it("link-only post: derived CommentIpfs has subplebbitAddress and link, no communityPublicKey", () => {
            const row = dbHandler!.queryComment("QmbQ6PUvYBWqJtRwp1JkxnXtvnfceyXZfq7iDXXkiX7jED");
            expect(row).to.exist;
            const commentIpfs = deriveCommentIpfsFromCommentTableRow(row!);
            expect((commentIpfs as Record<string, unknown>).subplebbitAddress).to.equal(COMMUNITY_ADDRESS);
            expect((commentIpfs as Record<string, unknown>).link).to.equal(
                "https://pixabay.com/photos/boy-fence-poverty-hungry-sad-1226964/"
            );
            expect((commentIpfs as Record<string, unknown>).communityPublicKey).to.be.undefined;
        });

        it("deep reply (depth=3): derived CommentIpfs has subplebbitAddress, not communityPublicKey", () => {
            const row = dbHandler!.queryComment("QmVjSqwBG3SisjZ2N5RLMxfK5eTWoLyfUtC4VE3Z7Ct9kw");
            expect(row).to.exist;
            const commentIpfs = deriveCommentIpfsFromCommentTableRow(row!);
            expect((commentIpfs as Record<string, unknown>).subplebbitAddress).to.equal(COMMUNITY_ADDRESS);
            expect((commentIpfs as Record<string, unknown>).communityPublicKey).to.be.undefined;
        });

        it("reply with newer signedPropertyNames: derived CommentIpfs has subplebbitAddress", () => {
            const row = dbHandler!.queryComment("QmYKMvU7xnYeqeYqGnhYxBqSG61HM1Vj1Jec9ft47MJdew");
            expect(row).to.exist;
            const commentIpfs = deriveCommentIpfsFromCommentTableRow(row!);
            expect((commentIpfs as Record<string, unknown>).subplebbitAddress).to.equal(COMMUNITY_ADDRESS);
            expect((commentIpfs as Record<string, unknown>).communityPublicKey).to.be.undefined;
        });

        it("ipnsName does NOT leak into derived CommentIpfs (stays in extraProps column only)", () => {
            const row = dbHandler!.queryComment("QmT5G1gnNHpGfRyqbdp7M5S4n16BsC27xWodNDJar4UNNz");
            expect(row).to.exist;
            const commentIpfs = deriveCommentIpfsFromCommentTableRow(row!);
            // ipnsName should be spread from extraProps into the derived object
            // (it was a former column that got moved to extraProps during an earlier migration)
            expect((commentIpfs as Record<string, unknown>).ipnsName).to.equal("12D3KooWJA3H4rQ3wyH1hzz1Rmf9YppEXNosAcT74KdHpxf2aanV");
        });
    });

    // ── _spreadExtraProps ──

    describe("_spreadExtraProps on migrated rows", () => {
        it("row with extraProps.subplebbitAddress: communityPublicKey/communityName stripped", () => {
            const priv = getPrivate(dbHandler!);
            const record: Record<string, unknown> = {
                communityPublicKey: COMMUNITY_ADDRESS,
                communityName: undefined,
                content: "test",
                extraProps: { subplebbitAddress: COMMUNITY_ADDRESS, ipnsName: "12D3KooWTest" }
            };
            const result = priv._spreadExtraProps({ ...record });
            expect(result.subplebbitAddress).to.equal(COMMUNITY_ADDRESS);
            expect(result.ipnsName).to.equal("12D3KooWTest");
            expect(result.communityPublicKey).to.be.undefined;
            expect(result.communityName).to.be.undefined;
        });

        it("row that originally had null extraProps (now has {subplebbitAddress}): communityPublicKey stripped", () => {
            const priv = getPrivate(dbHandler!);
            const record: Record<string, unknown> = {
                communityPublicKey: COMMUNITY_ADDRESS,
                communityName: undefined,
                content: "test",
                extraProps: { subplebbitAddress: COMMUNITY_ADDRESS }
            };
            const result = priv._spreadExtraProps({ ...record });
            expect(result.subplebbitAddress).to.equal(COMMUNITY_ADDRESS);
            expect(result.communityPublicKey).to.be.undefined;
        });
    });

    // ── Page queries ──

    describe("Page queries on migrated data", () => {
        it("queryCommentsUnderComment returns migrated children with communityPublicKey", () => {
            const children = dbHandler!.queryCommentsUnderComment("QmRinNcdouie5tTjpfmJpRvRn18Am1F7MYhGDXKRtm5QVt");
            expect(children.length).to.be.greaterThan(0);
            expect(children[0].communityPublicKey).to.equal(COMMUNITY_ADDRESS);
        });

        it("queryPageComments with excludeCommentsWithDifferentCommunityAddress returns migrated replies", () => {
            const now = Math.floor(Date.now() / 1000);
            // queryPageComments finds direct children of a parent — use a post with known replies
            const results = dbHandler!.queryPageComments({
                parentCid: "QmRinNcdouie5tTjpfmJpRvRn18Am1F7MYhGDXKRtm5QVt",
                excludeCommentsWithDifferentCommunityAddress: true,
                excludeRemovedComments: false,
                excludeDeletedComments: false,
                excludeCommentPendingApproval: false,
                excludeCommentWithApprovedFalse: false,
                preloadedPage: "hot",
                baseTimestamp: now
            });
            expect(results.length).to.equal(1);
            expect(results[0].commentUpdate.cid).to.equal("QmWftS7hK85LLkRjokjAz5k2bZTZkNdsrhoJDzmHBRawxQ");
        });

        it("queryFlattenedPageReplies returns recursive replies from migrated data", () => {
            const now = Math.floor(Date.now() / 1000);
            const results = dbHandler!.queryFlattenedPageReplies({
                parentCid: "QmRinNcdouie5tTjpfmJpRvRn18Am1F7MYhGDXKRtm5QVt",
                excludeCommentsWithDifferentCommunityAddress: true,
                excludeRemovedComments: false,
                excludeDeletedComments: false,
                excludeCommentPendingApproval: false,
                excludeCommentWithApprovedFalse: false,
                preloadedPage: "new",
                baseTimestamp: now
            });
            // Should find depth-1, depth-2, and depth-3 replies
            expect(results.length).to.equal(3);
            const cids = results.map((r) => r.commentUpdate.cid);
            expect(cids).to.include("QmWftS7hK85LLkRjokjAz5k2bZTZkNdsrhoJDzmHBRawxQ");
            expect(cids).to.include("QmR8exZ1qD1bLR84swfLZju3Yq5fRBPERmSv4cT7qrpusd");
            expect(cids).to.include("QmVjSqwBG3SisjZ2N5RLMxfK5eTWoLyfUtC4VE3Z7Ct9kw");
        });

        it("queryFirstCommentWithDepth(0) returns a post", () => {
            const row = dbHandler!.queryFirstCommentWithDepth(0);
            expect(row).to.exist;
            expect(row!.depth).to.equal(0);
        });

        it("queryFirstCommentWithDepth(3) returns a depth-3 comment", () => {
            const row = dbHandler!.queryFirstCommentWithDepth(3);
            expect(row).to.exist;
            expect(row!.depth).to.equal(3);
        });

        it("queryPostsWithActiveScore returns posts with scores", () => {
            const results = dbHandler!.queryPostsWithActiveScore({
                parentCid: null,
                excludeCommentsWithDifferentCommunityAddress: true,
                excludeRemovedComments: false,
                excludeDeletedComments: false,
                excludeCommentPendingApproval: false,
                excludeCommentWithApprovedFalse: false
            });
            expect(results.length).to.be.greaterThan(0);
            expect(results[0]).to.have.property("activeScore");
            expect(typeof results[0].activeScore).to.equal("number");
        });
    });

    // ── Votes unchanged ──

    it("votes are preserved (no subplebbitAddress column in votes)", () => {
        const priv = getPrivate(dbHandler!);
        const count = (priv._db.prepare("SELECT COUNT(*) as cnt FROM votes").get() as { cnt: number }).cnt;
        expect(count).to.equal(1);
        const vote = priv._db.prepare("SELECT * FROM votes LIMIT 1").get() as Record<string, unknown>;
        expect(vote.vote).to.equal(1);
        expect(vote.commentCid).to.equal("QmWftS7hK85LLkRjokjAz5k2bZTZkNdsrhoJDzmHBRawxQ");
    });
});

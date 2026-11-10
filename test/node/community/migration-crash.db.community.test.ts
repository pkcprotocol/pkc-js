import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { v4 as uuidV4 } from "uuid";
import Database from "better-sqlite3";
import env from "../../../dist/node/version.js";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// A migration rebuilds each table as <table>_<DB_VERSION>_new, copies the rows over, drops the old table and renames
// the new one in its place. user_version is only bumped once every table is done. When the process died between the
// DROP and the RENAME, the next start found the table missing, created it empty and finished the migration: every
// comment (or vote, edit, ...) of that table was gone, with the rows left in an orphaned _new table nothing read.
// The process death is simulated by failing the RENAME, which is the statement the kill interrupted.

const OLD_DB_VERSION = env.DB_VERSION - 1;
const TEMP_COMMENTS_TABLE = `comments_${env.DB_VERSION}_new`;

const V44_TABLES = [
    `CREATE TABLE comments (
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
    )`,
    `CREATE TABLE votes (
        commentCid TEXT NOT NULL REFERENCES comments(cid),
        authorSignerAddress TEXT NOT NULL,
        timestamp INTEGER CHECK(timestamp > 0) NOT NULL,
        vote INTEGER CHECK(vote BETWEEN -1 AND 1) NOT NULL,
        protocolVersion TEXT NOT NULL,
        insertedAt INTEGER NOT NULL,
        extraProps TEXT NULLABLE,
        PRIMARY KEY (commentCid, authorSignerAddress)
    )`
];

const now = Math.floor(Date.now() / 1000);
const POST_CIDS = ["QmMigrationCrashPost1", "QmMigrationCrashPost2", "QmMigrationCrashPost3"];

interface FakeCommunity {
    address: string;
    _pkc: { dataPath: string; noData: boolean };
    _cidsToUnPin: Set<string>;
    _blocksToRm: string[];
    _mfsPathsToRemove: Set<string>;
    _clientsManager: object;
    _calculateLocalMfsPathForCommentUpdate: () => string;
    _addOldPageCidsToCidsToUnpin: () => Promise<void>;
    _addAllCidsUnderPurgedCommentToBeRemoved: () => void;
}

interface DbHandlerPrivate {
    _purgeCommentsWithInvalidSchemaOrSignature: () => Promise<void>;
    _purgeCommentEditsWithInvalidSchemaOrSignature: () => Promise<void>;
    _purgePublicationTablesWithDuplicateSignatures: () => Promise<void>;
}

function createDbHandler({ dataPath, address }: { dataPath: string; address: string }): DbHandler {
    const fakeCommunity: FakeCommunity = {
        address,
        _pkc: { dataPath, noData: false },
        _cidsToUnPin: new Set<string>(),
        _blocksToRm: [],
        _mfsPathsToRemove: new Set<string>(),
        _clientsManager: {},
        _calculateLocalMfsPathForCommentUpdate: () => "",
        _addOldPageCidsToCidsToUnpin: async () => {},
        _addAllCidsUnderPurgedCommentToBeRemoved: () => {}
    };
    const dbHandler = new DbHandler(fakeCommunity as unknown as LocalCommunity);
    // The fixture rows carry placeholder signatures, which the post-migration sweeps would purge
    const priv = dbHandler as unknown as DbHandlerPrivate;
    priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
    priv._purgeCommentEditsWithInvalidSchemaOrSignature = async () => {};
    priv._purgePublicationTablesWithDuplicateSignatures = async () => {};
    return dbHandler;
}

function createOldVersionDb(dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const db = new Database(dbPath);
    try {
        db.pragma("journal_mode = WAL");
        for (const createTable of V44_TABLES) db.exec(createTable);
        const insertComment = db.prepare(
            `INSERT INTO comments (cid, authorSignerAddress, author, postCid, communityPublicKey, content, title, timestamp, signature,
                depth, protocolVersion, insertedAt)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        const insertVote = db.prepare(
            `INSERT INTO votes (commentCid, authorSignerAddress, timestamp, vote, protocolVersion, insertedAt) VALUES (?, ?, ?, ?, ?, ?)`
        );
        POST_CIDS.forEach((cid, i) => {
            insertComment.run(
                cid,
                "12D3KooWAuthor",
                JSON.stringify({ address: "12D3KooWAuthor" }),
                cid,
                "12D3KooWCommunity",
                `post ${i}`,
                `title ${i}`,
                now - 100 + i,
                JSON.stringify({ type: "ed25519", signature: `sig-${i}`, publicKey: "pk", signedPropertyNames: [] }),
                0,
                "1.0.0",
                now - 100 + i
            );
            insertVote.run(cid, "12D3KooWVoter", now - 50 + i, 1, "1.0.0", now - 50 + i);
        });
        db.pragma(`user_version = ${OLD_DB_VERSION}`);
    } finally {
        db.close();
    }
}

function readTables(dbPath: string): { tables: string[]; commentCids: string[] | undefined; userVersion: number } {
    const db = new Database(dbPath, { readonly: true });
    try {
        const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
            (row) => row.name
        );
        const commentCids = tables.includes("comments")
            ? (db.prepare("SELECT cid FROM comments ORDER BY cid").all() as { cid: string }[]).map((row) => row.cid)
            : undefined;
        return { tables, commentCids, userVersion: db.pragma("user_version", { simple: true }) as number };
    } finally {
        db.close();
    }
}

// Rewrites a DB into the state an interrupted migration from before this fix left behind: the comments table dropped and
// its migrated copy, in the latest schema, still under its temporary name. The latest schema is read from a DB the
// current code created, so the copy is exactly what that run had built.
async function leaveDbAsInterruptedBetweenDropAndRename({ dataPath, dbPath }: { dataPath: string; dbPath: string }) {
    const scratchAddress = `latest-schema-${uuidV4()}`;
    const scratchHandler = createDbHandler({ dataPath, address: scratchAddress });
    await scratchHandler.initDbIfNeeded({ fileMustExist: false });
    await scratchHandler.createOrMigrateTablesIfNeeded();
    const latestCommentsSql = (
        scratchHandler._db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'comments'").get() as { sql: string }
    ).sql;
    scratchHandler.destoryConnection();

    const db = new Database(dbPath);
    try {
        db.pragma("foreign_keys = OFF"); // as the migration runs
        db.exec(latestCommentsSql.replace(/^CREATE TABLE (IF NOT EXISTS )?"?comments"?/, `CREATE TABLE ${TEMP_COMMENTS_TABLE}`));
        const tempColumns = (db.pragma(`table_info(${TEMP_COMMENTS_TABLE})`) as { name: string }[]).map((col) => col.name);
        const oldColumns = (db.pragma("table_info(comments)") as { name: string }[]).map((col) => col.name);
        const sharedColumns = tempColumns.filter((column) => oldColumns.includes(column));
        db.exec(
            `INSERT INTO ${TEMP_COMMENTS_TABLE} (rowid, ${sharedColumns.join(", ")}) SELECT rowid, ${sharedColumns.join(", ")} FROM comments`
        );
        db.exec("DROP TABLE comments");
    } finally {
        db.close();
    }
}

// Uses DbHandler directly on a DB file (Node-only), not reachable over RPC
describeSkipIfRpc("DB migration interrupted between dropping a table and renaming its migrated copy", () => {
    let dataPath: string;
    let address: string;
    let dbPath: string;

    beforeEach(() => {
        dataPath = path.join(process.cwd(), ".tmp", "migration-crash", uuidV4());
        address = `12D3KooWMigrationCrash${uuidV4().slice(0, 8)}`;
        dbPath = path.join(dataPath, "communities", address);
        createOldVersionDb(dbPath);
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await fs.promises.rm(dataPath, { recursive: true, force: true });
    });

    it("leaves the old table in place, so the next start migrates every row", async () => {
        const realExec = Database.prototype.exec;
        vi.spyOn(Database.prototype, "exec").mockImplementation(function (this: Database.Database, sql: string) {
            if (sql.startsWith(`ALTER TABLE ${TEMP_COMMENTS_TABLE} RENAME`)) throw new Error("simulated process death before the rename");
            return realExec.call(this, sql);
        });
        const interrupted = createDbHandler({ dataPath, address });
        await interrupted.initDbIfNeeded();
        await expect(interrupted.createOrMigrateTablesIfNeeded()).rejects.toThrow("simulated process death before the rename");
        vi.restoreAllMocks();

        const afterCrash = readTables(dbPath);
        expect(afterCrash.userVersion).to.equal(OLD_DB_VERSION);
        expect(afterCrash.tables).to.include("comments");
        expect(afterCrash.commentCids).to.deep.equal([...POST_CIDS].sort());

        const restarted = createDbHandler({ dataPath, address });
        await restarted.initDbIfNeeded();
        await restarted.createOrMigrateTablesIfNeeded();
        restarted.destoryConnection();

        const afterRestart = readTables(dbPath);
        expect(afterRestart.userVersion).to.equal(env.DB_VERSION);
        expect(afterRestart.commentCids).to.deep.equal([...POST_CIDS].sort());
        expect(afterRestart.tables).to.not.include(TEMP_COMMENTS_TABLE);
    });

    it("restores a table an earlier interrupted migration left only under its temporary name", async () => {
        await leaveDbAsInterruptedBetweenDropAndRename({ dataPath, dbPath });
        const broken = readTables(dbPath);
        expect(broken.tables).to.not.include("comments");
        expect(broken.tables).to.include(TEMP_COMMENTS_TABLE);
        expect(broken.userVersion).to.equal(OLD_DB_VERSION);

        const restarted = createDbHandler({ dataPath, address });
        await restarted.initDbIfNeeded();
        await restarted.createOrMigrateTablesIfNeeded();
        restarted.destoryConnection();

        const afterRestart = readTables(dbPath);
        expect(afterRestart.userVersion).to.equal(env.DB_VERSION);
        expect(afterRestart.commentCids).to.deep.equal([...POST_CIDS].sort());
        expect(afterRestart.tables).to.not.include(TEMP_COMMENTS_TABLE);
    });
});

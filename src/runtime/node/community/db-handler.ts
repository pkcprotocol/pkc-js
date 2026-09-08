import {
    getEquivalentCommunityAddresses,
    hideClassPrivateProps,
    isStringDomain,
    removeNullUndefinedValues,
    timestamp,
    withSortedKeys
} from "../../../util.js";
import { PKCError } from "../../../pkc-error.js";
import path from "path";
import assert from "assert";
import fs from "fs";
import os from "os";
import Logger from "../../../logger.js";
import { deleteOldCommunityInWindows, deriveCommentIpfsFromCommentTableRow, getDefaultCommunityDbConfig } from "../util.js";
import env from "../../../version.js";
import Database, { type Database as BetterSqlite3Database, type Statement } from "better-sqlite3";
import { sha256 } from "js-sha256";

import lockfile from "@pkcprotocol/proper-lock-file";
import type { PageOptions } from "./page-generator.js";
import type {
    InternalCommunityRecordAfterFirstUpdateType,
    InternalCommunityRecordBeforeFirstUpdateType,
    CommunityStats,
    ExportCommunityModLogsOptions
} from "../../../community/types.js";
import { LocalCommunity } from "./local-community.js";
import { isDefaultChallengeStructure } from "./local-community/defaults.js";
import { addAllCidsUnderPurgedCommentToBeRemoved } from "./local-community/cleanup.js";
import { updateDbInternalState } from "./local-community/db-state.js";
import { getPKCAddressFromPublicKey, getPKCAddressFromPublicKeySync } from "../../../signer/util.js";
import { clone, entries as remedaEntries, firstBy, isPlainObject, keys, mapToObj, mapValues, omit, pick, sumBy, uniqueBy } from "remeda";
import type {
    CommentEditPubsubMessagePublication,
    CommentEditSignature,
    CommentEditsTableRow,
    CommentEditsTableRowInsert
} from "../../../publications/comment-edit/types.js";
import type {
    CommentIpfsType,
    CommentsTableRow,
    CommentsTableRowInsert,
    CommentUpdatesRow,
    CommentUpdatesTableRowInsert,
    CommentUpdateType,
    CommunityAuthor,
    DbRepliesSortEntry
} from "../../../publications/comment/types.js";
import { CommentIpfsSchema, CommentUpdateSchema } from "../../../publications/comment/schema.js";
import { verifyCommentEdit, verifyCommentIpfs } from "../../../signer/signatures.js";
import type { PageIpfs, RepliesPagesTypeIpfs } from "../../../pages/types.js";
import type { CommentModerationsTableRowInsert, CommentModerationTableRow } from "../../../publications/comment-moderation/types.js";
import { getCommunityChallengeFromCommunityChallengeSettings, pkcJsChallenges } from "./challenges/index.js";
import KeyvBetterSqlite3 from "./keyv-better-sqlite3.js";

import { STORAGE_KEYS } from "../../../constants.js";
import {
    CommentEditPubsubMessagePublicationSchema,
    CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema
} from "../../../publications/comment-edit/schema.js";
import { TIMEFRAMES_TO_SECONDS } from "../../../pages/util.js";
import type { VotesTableRow, VotesTableRowInsert } from "../../../publications/vote/types.js";
import {
    parseCommentEditsRow,
    parseCommentUpdateRow,
    parseCommentsTableRow,
    parseVoteRow,
    parseCommentModerationRow,
    createPositionalCommentRowMapper,
    type PositionalCommentRowMapper
} from "./db-row-parser.js";
import { ZodError } from "zod";
import { messages } from "../../../errors.js";
import type { PseudonymityAliasRow, PurgedCommentTableRows } from "./db-handler-types.js";
import { getAuthorNameFromWire } from "../../../publications/publication-author.js";
import type { PageSortReplyEntry } from "../../../pages/types.js";

// What the update cycle calculates per comment (issue #352): everything of a CommentUpdate but the signature, the
// timestamp, the reply pages and the protocol version
export type CalculatedCommentUpdate = Omit<CommentUpdateType, "signature" | "updatedAt" | "replies" | "protocolVersion">;
export type CommentUpdateCalculationInput = Pick<CommentsTableRow, "cid" | "authorSignerAddress" | "timestamp"> & {
    challengeCommentUpdate?: Record<string, unknown>;
};
// One cycle's author aggregates, keyed by the address set and domain they were computed for
export type CommunityAuthorMemo = Map<string, CommunityAuthor | undefined>;

const TABLES = Object.freeze({
    COMMENTS: "comments",
    COMMENT_UPDATES: "commentUpdates",
    VOTES: "votes",
    COMMENT_MODERATIONS: "commentModerations",
    COMMENT_EDITS: "commentEdits",
    PSEUDONYMITY_ALIASES: "pseudonymityAliases"
});

// The address an alias row's original public key derives to, or null when the key is malformed (kept, never looked up)
function deriveAliasOriginalAuthorSignerAddress(originalAuthorPublicKey: string): string | null {
    try {
        return getPKCAddressFromPublicKeySync(originalAuthorPublicKey);
    } catch {
        return null;
    }
}

export class DbHandler {
    _db!: BetterSqlite3Database;
    private _community!: LocalCommunity;
    private _transactionDepth!: number;
    private _dbConfig!: { filename: string } & Database.Options;
    private _keyv!: KeyvBetterSqlite3;
    private _createdTables: boolean;
    private _columnNamesByTable: Record<string, string[]>;
    private _positionalMappers: Map<string, PositionalCommentRowMapper>;
    private _preparedStatements: Map<string, Statement>;

    constructor(community: DbHandler["_community"]) {
        this._community = community;
        this._transactionDepth = 0;
        this._createdTables = false;
        this._columnNamesByTable = {};
        this._positionalMappers = new Map();
        this._preparedStatements = new Map();
        hideClassPrivateProps(this);
    }

    // Statements the update cycle runs per comment, compiled once per connection: preparing the SQL again on every
    // call cost more than running some of them (issue #351). A cached statement keeps the mode (raw, pluck) its call
    // site sets, so one SQL string belongs to one call site.
    private _prepareCached(sql: string): Statement {
        let statement = this._preparedStatements.get(sql);
        if (!statement) {
            statement = this._db.prepare(sql);
            this._preparedStatements.set(sql, statement);
        }
        return statement;
    }

    private _parseCommentsTableRow(row: unknown): CommentsTableRow {
        const parsed = parseCommentsTableRow(row);
        return removeNullUndefinedValues(parsed) as CommentsTableRow;
    }

    private _parseCommentUpdatesRow(row: unknown): CommentUpdatesRow {
        const parsed = parseCommentUpdateRow(row);
        return removeNullUndefinedValues(parsed) as CommentUpdatesRow;
    }

    private _parseCommentEditsRow(row: unknown): CommentEditsTableRow & {
        commentAuthor?: string;
        pendingApproval?: boolean;
        id?: number | string;
    } {
        const parsedRow = parseCommentEditsRow(row);
        const parsed = removeNullUndefinedValues(parsedRow) as CommentEditsTableRow & {
            commentAuthor?: string;
            pendingApproval?: boolean;
            id?: number | string;
        };

        if (typeof parsed.id === "string") {
            const numericId = Number(parsed.id);
            if (!Number.isNaN(numericId)) parsed.id = numericId;
        }

        return parsed;
    }

    private _parseVoteRow(row: unknown): VotesTableRow {
        const parsed = parseVoteRow(row);
        return removeNullUndefinedValues(parsed) as VotesTableRow;
    }

    private _parseCommentModerationRow(row: unknown): CommentModerationTableRow {
        const parsed = parseCommentModerationRow(row);
        return removeNullUndefinedValues(parsed) as CommentModerationTableRow;
    }

    async initDbConfigIfNeeded() {
        if (!this._dbConfig) this._dbConfig = await getDefaultCommunityDbConfig(this._community.address, this._community._pkc);
    }

    toJSON() {
        return undefined;
    }

    async initDbIfNeeded(dbConfigOptions?: Partial<DbHandler["_dbConfig"]>) {
        const log = Logger("pkc-js:local-community:db-handler:initDbIfNeeded");
        assert(
            typeof this._community.address === "string" && this._community.address.length > 0,
            `DbHandler needs to be an instantiated with a Community that has a valid address, (${this._community.address}) was provided`
        );
        await this.initDbConfigIfNeeded();
        const dbFilePath = this._dbConfig.filename;
        if (!this._db || !this._db.open) {
            this._columnNamesByTable = {}; // a reopened file may have been migrated by another process
            this._preparedStatements.clear();
            this._db = new Database(dbFilePath, { ...this._dbConfig, ...dbConfigOptions });
            if (!this._db.readonly) {
                this._db.pragma("journal_mode = WAL");
            }
            log("initialized a new connection to db", dbFilePath);
        }
        if (!this._keyv) {
            this._keyv = new KeyvBetterSqlite3(this._db, this._db.readonly ? { createTable: false } : undefined);
            if (!this._db.readonly) {
                // Rename old keyv keys from pre-rebranding databases (subplebbit → community)
                this._db.exec(`UPDATE keyv SET key = 'keyv:INTERNAL_COMMUNITY' WHERE key = 'keyv:INTERNAL_SUBPLEBBIT'`);
            }
        }
    }

    async createOrMigrateTablesIfNeeded() {
        const log = Logger("pkc-js:local-community:db-handler:createOrMigrateTablesIfNeeded");
        if (this._createdTables) return;

        try {
            await this._createOrMigrateTablesIfNeeded();
        } catch (e) {
            await this.initDbIfNeeded();
            log.error(
                `Community (${this._community.address}) failed to create/migrate tables. Current db version (${this.getDbVersion()}), latest db version (${env.DB_VERSION}). Error`,
                e
            );
            await this.destoryConnection();
            throw e;
        }
        hideClassPrivateProps(this);
    }

    getDbConfig() {
        return this._dbConfig;
    }

    keyvGet<Value>(key: string): Value | undefined {
        try {
            const res = this._keyv.get<Value>(key);
            return res;
        } catch (e: any) {
            e.details = { ...e.details, key };
            throw e;
        }
    }

    keyvSet(key: string, value: any, ttl?: number) {
        return this._keyv.set(key, value, ttl);
    }

    keyvDelete(key: string) {
        return this._keyv.delete(key);
    }

    keyvHas(key: string) {
        return this._keyv.has(key);
    }

    destoryConnection() {
        const log = Logger("pkc-js:local-community:dbHandler:destroyConnection");
        this._preparedStatements.clear(); // statements belong to the connection
        if (this._db && this._db.open) {
            if (!this._db.readonly) {
                this._db.exec("PRAGMA wal_checkpoint"); // write all wal to disk
            }
            this._db.close();
        }
        if (this._keyv) this._keyv.disconnect();

        //@ts-expect-error
        this._db = this._keyv = undefined;
        this._transactionDepth = 0;

        log("Destroyed DB connection to community", this._community.address, "successfully");
    }

    createTransaction(): void {
        if (this._transactionDepth === 0) {
            this._db.exec("BEGIN");
        }
        this._transactionDepth++;
    }

    commitTransaction(): void {
        if (this._transactionDepth > 0) {
            this._transactionDepth--;
            if (this._transactionDepth === 0) {
                this._db.exec("COMMIT");
            }
        }
    }

    rollbackTransaction(): void {
        const log = Logger("pkc-js:local-community:db-handler:rollbackTransaction");
        if (this._transactionDepth > 0) {
            if (this._transactionDepth === 1) {
                try {
                    this._db.exec("ROLLBACK");
                } catch (e) {
                    log.error(`Failed to rollback transaction due to error`, e);
                }
            }
            this._transactionDepth--;
        } else if (this._db && this._db.open && this._db.inTransaction) {
            log(`Transaction depth was 0, but DB was in transaction. Attempting rollback.`);
            try {
                this._db.exec("ROLLBACK");
            } catch (e) {
                log.error(`Failed to rollback transaction (fallback) due to error`, e);
            }
        }
        if (this._transactionDepth < 0) this._transactionDepth = 0;
        log.trace(`Rolledback transaction, this._transactionDepth = ${this._transactionDepth}`);
    }

    async rollbackAllTransactions() {
        const log = Logger("pkc-js:local-community:db-handler:rollbackAllTransactions");
        let initialDepth = this._transactionDepth;
        while (this._transactionDepth > 0) {
            this.rollbackTransaction();
        }
        if (initialDepth > 0) {
            log.trace(`Rolled back all transactions. Initial depth was ${initialDepth}, now ${this._transactionDepth}.`);
        }
    }

    private _createCommentsTable(tableName: string) {
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS ${tableName} (
                cid TEXT NOT NULL PRIMARY KEY UNIQUE,
                authorSignerAddress TEXT NOT NULL,
                author TEXT NULLABLE, -- JSON
                link TEXT NULLABLE,
                linkWidth INTEGER NULLABLE,
                linkHeight INTEGER NULLABLE,
                thumbnailUrl TEXT NULLABLE,
                thumbnailUrlWidth INTEGER NULLABLE,
                thumbnailUrlHeight INTEGER NULLABLE,
                parentCid TEXT NULLABLE REFERENCES ${TABLES.COMMENTS}(cid),
                postCid TEXT NOT NULL REFERENCES ${TABLES.COMMENTS}(cid),
                previousCid TEXT NULLABLE,
                communityPublicKey TEXT,
                communityName TEXT,
                content TEXT NULLABLE,
                timestamp INTEGER NOT NULL, 
                signature TEXT NOT NULL, -- JSON
                originalCommentSignatureEncoded TEXT NULLABLE, -- original publication signature before local anonymization
                title TEXT NULLABLE,
                depth INTEGER NOT NULL,
                linkHtmlTagName TEXT NULLABLE,
                flairs TEXT NULLABLE, -- JSON
                spoiler INTEGER NULLABLE, -- BOOLEAN (0/1)
                pendingApproval INTEGER NULLABLE, -- BOOLEAN (0/1)
                number INTEGER NULLABLE,
                postNumber INTEGER NULLABLE,
                nsfw INTEGER NULLABLE, -- BOOLEAN (0/1)
                pseudonymityMode TEXT NULLABLE,
                quotedCids TEXT NULLABLE, -- JSON array
                crosspost TEXT NULLABLE, -- JSON: {cid, comment} of the comment this one reposts, stored verbatim so the embedded record keeps reproducing its cid
                extraProps TEXT NULLABLE, -- JSON
                challengeCommentUpdate TEXT NULLABLE, -- JSON: challenge-supplied partial CommentUpdate seeded into queryCalculatedCommentUpdate with lowest priority
                protocolVersion TEXT NOT NULL,
                insertedAt INTEGER NOT NULL
            )
        `);
    }

    private _createCommentUpdatesTable(tableName: string) {
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS ${tableName} (
                cid TEXT NOT NULL PRIMARY KEY UNIQUE REFERENCES ${TABLES.COMMENTS}(cid),
                edit TEXT NULLABLE, -- JSON
                upvoteCount INTEGER NOT NULL,
                downvoteCount INTEGER NOT NULL,
                replyCount INTEGER NOT NULL,
                childCount INTEGER NOT NULL,
                number INTEGER NULLABLE,
                postNumber INTEGER NULLABLE,
                flairs TEXT NULLABLE, -- JSON
                spoiler INTEGER NULLABLE, -- BOOLEAN (0/1)
                nsfw INTEGER NULLABLE, -- BOOLEAN (0/1)
                pinned INTEGER NULLABLE, -- BOOLEAN (0/1)
                locked INTEGER NULLABLE, -- BOOLEAN (0/1)
                archived INTEGER NULLABLE, -- BOOLEAN (0/1)
                removed INTEGER NULLABLE, -- BOOLEAN (0/1)
                approved INTEGER NULLABLE, -- BOOLEAN (0/1)
                reason TEXT NULLABLE,
                updatedAt INTEGER NOT NULL CHECK(updatedAt > 0), 
                protocolVersion TEXT NOT NULL,
                signature TEXT NOT NULL, -- JSON
                author TEXT NULLABLE, -- JSON
                replies TEXT NULLABLE, -- JSON: CID refs per sort (DbRepliesSchema)
                lastChildCid TEXT NULLABLE,
                lastReplyTimestamp INTEGER NULLABLE, 
                postUpdatesBucket INTEGER NULLABLE,
                publishedToPostUpdatesMFS INTEGER NOT NULL, -- BOOLEAN (0/1)
                insertedAt INTEGER NOT NULL 
            )
        `);
    }

    // The comment tree lookups every page and update cycle runs: children of a comment (reply pages, stale_replies),
    // every reply under a post (requireReplies sorts). Without them each is a full scan of the comments table.
    private _createCommentsIndexes() {
        this._db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_parentCid ON ${TABLES.COMMENTS}(parentCid)`);
        this._db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_postCid ON ${TABLES.COMMENTS}(postCid)`);
    }

    private _createVotesTable(tableName: string) {
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS ${tableName} (
                commentCid TEXT NOT NULL REFERENCES ${TABLES.COMMENTS}(cid),
                authorSignerAddress TEXT NOT NULL,
                timestamp INTEGER CHECK(timestamp > 0) NOT NULL, 
                vote INTEGER CHECK(vote BETWEEN -1 AND 1) NOT NULL,
                protocolVersion TEXT NOT NULL,
                insertedAt INTEGER NOT NULL, 
                extraProps TEXT NULLABLE, -- JSON
                PRIMARY KEY (commentCid, authorSignerAddress)
            )
        `);
    }

    private _createCommentEditsTable(tableName: string) {
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS ${tableName} (
                commentCid TEXT NOT NULL REFERENCES ${TABLES.COMMENTS}(cid),
                authorSignerAddress TEXT NOT NULL,
                author TEXT NULLABLE, -- JSON
                signature TEXT NOT NULL, -- JSON
                protocolVersion TEXT NOT NULL,
                communityPublicKey TEXT,
                communityName TEXT,
                timestamp INTEGER CHECK(timestamp > 0) NOT NULL,
                content TEXT NULLABLE,
                reason TEXT NULLABLE,
                deleted INTEGER NULLABLE, -- BOOLEAN (0/1)
                flairs TEXT NULLABLE, -- JSON
                spoiler INTEGER NULLABLE, -- BOOLEAN (0/1)
                nsfw INTEGER NULLABLE, -- BOOLEAN (0/1)
                isAuthorEdit INTEGER NOT NULL, -- BOOLEAN (0/1)
                insertedAt INTEGER NOT NULL, 
                extraProps TEXT NULLABLE -- JSON
            )
        `);
    }

    private _createCommentModerationsTable(tableName: string) {
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS ${tableName} (
                commentCid TEXT NOT NULL,
                author TEXT NULLABLE, -- JSON
                signature TEXT NOT NULL, -- JSON
                modSignerAddress TEXT NOT NULL,
                protocolVersion TEXT NOT NULL,
                communityPublicKey TEXT,
                communityName TEXT,
                timestamp INTEGER CHECK(timestamp > 0) NOT NULL,
                commentModeration TEXT NOT NULL, -- JSON
                insertedAt INTEGER NOT NULL,
                extraProps TEXT NULLABLE, -- JSON
                targetAuthorSignerAddress TEXT NULLABLE, -- the signer address of the comment author being moderated (for bans/flairs)
                targetAuthorDomain TEXT NULLABLE -- the domain address (e.g., spammer.bso) of the comment author being moderated
            )
        `);
    }

    private _createPseudonymityAliasesTable(tableName: string) {
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS ${tableName} (
                commentCid TEXT NOT NULL PRIMARY KEY UNIQUE REFERENCES ${TABLES.COMMENTS}(cid) ON DELETE CASCADE,
                aliasPrivateKey TEXT NOT NULL,
                originalAuthorPublicKey TEXT NOT NULL,
                originalAuthorSignerAddress TEXT NULLABLE, -- derived from originalAuthorPublicKey at insert, so an author's aliases are an indexed lookup (issue #351)
                originalAuthorName TEXT NULLABLE, -- the original author's name (e.g., user.eth) if they used one
                mode TEXT NOT NULL CHECK(mode IN ('per-post', 'per-reply', 'per-author')),
                insertedAt INTEGER NOT NULL
            )
        `);
    }

    // The lookups the update cycle runs per comment: an author's comments (author.community karma), an author's
    // aliases, and a comment's edits and moderations (flags, reason, flairs, approval, the author's latest edit).
    // Without them each is a full scan of its table (issue #351).
    private _createAuthorIndexes() {
        this._db.exec(`CREATE INDEX IF NOT EXISTS idx_comments_authorSignerAddress ON ${TABLES.COMMENTS}(authorSignerAddress)`);
        this._db.exec(
            `CREATE INDEX IF NOT EXISTS idx_pseudonymityAliases_originalAuthorSignerAddress ON ${TABLES.PSEUDONYMITY_ALIASES}(originalAuthorSignerAddress)`
        );
        this._db.exec(`CREATE INDEX IF NOT EXISTS idx_commentEdits_commentCid ON ${TABLES.COMMENT_EDITS}(commentCid)`);
        this._db.exec(`CREATE INDEX IF NOT EXISTS idx_commentModerations_commentCid ON ${TABLES.COMMENT_MODERATIONS}(commentCid)`);
    }

    getDbVersion(): number {
        const result = this._db.pragma("user_version", { simple: true }) as number;
        return Number(result);
    }

    _migrateOldSettings(oldSettings: InternalCommunityRecordBeforeFirstUpdateType["settings"]) {
        const fieldsToRemove = ["post", "reply", "vote"] as const;
        const newSettings = clone(oldSettings);
        if (Array.isArray(newSettings.challenges)) {
            // Filter out challenges that reference removed built-in names
            newSettings.challenges = newSettings.challenges.filter((cs) => !cs.name || cs.path || cs.name in pkcJsChallenges);
            for (const oldChallengeSetting of newSettings.challenges)
                if (oldChallengeSetting.exclude)
                    for (const oldExcludeSetting of oldChallengeSetting.exclude)
                        for (const fieldToMove of fieldsToRemove) delete oldExcludeSetting[fieldToMove];
        }
        return newSettings;
    }

    async _createOrMigrateTablesIfNeeded() {
        const log = Logger("pkc-js:local-community:db-handler:createOrMigrateTablesIfNeeded");
        const currentDbVersion = this.getDbVersion();
        log.trace(`current db version: ${currentDbVersion}`);

        if (currentDbVersion > env.DB_VERSION)
            throw new Error(
                `DB version ${currentDbVersion} is greater than the latest version ${env.DB_VERSION}. You need to upgrade your client to accommodate the new DB version`
            );

        const needToMigrate = currentDbVersion < env.DB_VERSION;
        const dbPath = this._dbConfig.filename;
        let backupDbPath: string | undefined;
        const dbExistsAlready = fs.existsSync(dbPath);

        if (needToMigrate) {
            if (dbExistsAlready && currentDbVersion > 0) {
                this.destoryConnection();
                backupDbPath = path.join(
                    path.dirname(dbPath),
                    ".backup_before_migration",
                    `${path.basename(dbPath)}.${currentDbVersion}.${timestamp()}`
                );
                log(`Copying db ${path.basename(dbPath)} to ${backupDbPath} before migration`);
                if (!fs.existsSync(path.dirname(backupDbPath))) await fs.promises.mkdir(path.dirname(backupDbPath), { recursive: true });
                const sourceDb = new Database(dbPath, { fileMustExist: true });
                await sourceDb.backup(backupDbPath); // Use better-sqlite3's native backup method
                sourceDb.close();
                this._db = new Database(dbPath);
                this._db.pragma("journal_mode = WAL");
            }
            this._db.exec("PRAGMA foreign_keys = OFF");
            const tablesToDrop = ["challengeRequests", "challenges", "challengeAnswers", "challengeVerifications", "signers"];
            for (const tableName of tablesToDrop) this._db.exec(`DROP TABLE IF EXISTS ${tableName}`);
            this._db.exec(`DROP TABLE IF EXISTS ${TABLES.COMMENT_UPDATES}`);
        }

        this._columnNamesByTable = {}; // the loop below rewrites every table's schema
        this._preparedStatements.clear();
        const createTableFunctions = [
            this._createCommentsTable.bind(this),
            this._createCommentUpdatesTable.bind(this),
            this._createVotesTable.bind(this),
            this._createCommentModerationsTable.bind(this),
            this._createCommentEditsTable.bind(this),
            this._createPseudonymityAliasesTable.bind(this)
        ];
        const tables = Object.values(TABLES);

        for (let i = 0; i < tables.length; i++) {
            const tableName = tables[i];
            const tableExists = this._tableExists(tableName);
            if (!tableExists) {
                log(`Table ${tableName} does not exist. Will create schema`);
                createTableFunctions[i](tableName);
            } else if (tableExists && needToMigrate) {
                log(`Migrating table ${tableName} to new schema`);
                const tempTableName = `${tableName}_${env.DB_VERSION}_new`;
                this._db.exec(`DROP TABLE IF EXISTS ${tempTableName}`);
                createTableFunctions[i](tempTableName);
                await this._copyTable(tableName, tempTableName, currentDbVersion);
                this._db.exec(`DROP TABLE ${tableName}`);
                this._db.exec(`ALTER TABLE ${tempTableName} RENAME TO ${tableName}`);
            }
        }

        this._createCommentsIndexes(); // idempotent; the migration loop above recreates the tables without them
        this._createAuthorIndexes();

        if (needToMigrate) {
            await this._purgeCommentsWithInvalidSchemaOrSignature();
            await this._purgeCommentEditsWithInvalidSchemaOrSignature();
            await this._purgePublicationTablesWithDuplicateSignatures();
            if (currentDbVersion < 29) this._backfillApprovedCommentNumbers();
            if (currentDbVersion < 31) this._backfillTargetAuthorSignerAddress();
            if (currentDbVersion < 32) this._backfillTargetAuthorDomain();

            this._db.exec("PRAGMA foreign_keys = ON");
            this._db.pragma(`user_version = ${env.DB_VERSION}`);
            await this.initDbIfNeeded(); // to init keyv

            const internalState = this.keyvHas(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY])
                ? ((await this.keyvGet(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY])) as
                      | InternalCommunityRecordAfterFirstUpdateType
                      | InternalCommunityRecordBeforeFirstUpdateType)
                : undefined;
            if (internalState) {
                const protocolVersion = internalState.protocolVersion || env.PROTOCOL_VERSION;
                const _usingDefaultChallenge =
                    "_usingDefaultChallenge" in internalState
                        ? internalState._usingDefaultChallenge
                        : //@ts-expect-error - fallback for old DB records that predate _usingDefaultChallenge field
                          isDefaultChallengeStructure(internalState?.settings?.challenges);
                const updateCid: string =
                    "updateCid" in internalState && typeof internalState.updateCid === "string"
                        ? internalState.updateCid
                        : "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f";
                const newSettings = this._migrateOldSettings(internalState.settings);
                const newChallenges = newSettings.challenges
                    ? await Promise.all(
                          newSettings.challenges?.map(
                              async (cs) =>
                                  (
                                      await getCommunityChallengeFromCommunityChallengeSettings({
                                          communityChallengeSettings: cs,
                                          pkc: this._community._pkc
                                      })
                                  ).communityChallenge
                          )
                      )
                    : newSettings.challenges;
                await updateDbInternalState(this._community, {
                    posts: undefined,
                    challenges: newChallenges,
                    settings: newSettings,
                    updateCid,
                    protocolVersion,
                    _usingDefaultChallenge
                });
            }
        }
        this._db.exec(`VACUUM;`); // Run vacuum outside transaction or after commit

        const newDbVersion = this.getDbVersion();
        assert.equal(newDbVersion, env.DB_VERSION);
        this._createdTables = true;
        this._columnNamesByTable = {}; // every table now carries the latest schema
        this._preparedStatements.clear();
        if (needToMigrate)
            log(`Created/migrated the tables to the latest (${newDbVersion}) version and saved to path`, this._dbConfig.filename);
        if (backupDbPath) await fs.promises.rm(backupDbPath);
    }

    private _tableExists(tableName: string): boolean {
        const stmt = this._db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?");
        return !!stmt.get(tableName);
    }

    private _backfillApprovedCommentNumbers() {
        const log = Logger("pkc-js:local-community:db-handler:_backfillApprovedCommentNumbers");
        const comments = this._db
            .prepare(`SELECT cid, depth FROM ${TABLES.COMMENTS} WHERE pendingApproval IS NULL OR pendingApproval != 1 ORDER BY rowid ASC`)
            .all() as { cid: string; depth: number }[];

        if (comments.length === 0) return;

        let nextNumber = 1;
        let nextPostNumber = 1;
        const updateStmt = this._db.prepare(`UPDATE ${TABLES.COMMENTS} SET number = ?, postNumber = ? WHERE cid = ?`);
        const updateMany = this._db.transaction((items: { cid: string; depth: number }[]) => {
            for (const comment of items) {
                const postNumber = comment.depth === 0 ? nextPostNumber++ : null;
                updateStmt.run(nextNumber++, postNumber, comment.cid);
            }
        });
        updateMany(comments);
        log(`Backfilled number/postNumber for ${comments.length} non-pending comments`);
    }

    private _backfillTargetAuthorSignerAddress() {
        const log = Logger("pkc-js:local-community:db-handler:_backfillTargetAuthorSignerAddress");

        // Find comment moderations that have author-related edits (bans/flairs) but no targetAuthorSignerAddress
        const moderationsToUpdate = this._db
            .prepare(
                `
            SELECT cm.rowid, cm.commentCid, c.authorSignerAddress,
                   pa.originalAuthorPublicKey
            FROM ${TABLES.COMMENT_MODERATIONS} cm
            LEFT JOIN ${TABLES.COMMENTS} c ON cm.commentCid = c.cid
            LEFT JOIN ${TABLES.PSEUDONYMITY_ALIASES} pa ON cm.commentCid = pa.commentCid
            WHERE cm.targetAuthorSignerAddress IS NULL
              AND json_extract(cm.commentModeration, '$.author') IS NOT NULL
        `
            )
            .all() as {
            rowid: number;
            commentCid: string;
            authorSignerAddress: string | null;
            originalAuthorPublicKey: string | null;
        }[];

        if (moderationsToUpdate.length === 0) return;

        const updateStmt = this._db.prepare(`UPDATE ${TABLES.COMMENT_MODERATIONS} SET targetAuthorSignerAddress = ? WHERE rowid = ?`);

        const updateMany = this._db.transaction((items: typeof moderationsToUpdate) => {
            for (const mod of items) {
                let targetAddress: string | null = null;

                // If the comment was published with pseudonymity, use the original author's address
                if (mod.originalAuthorPublicKey) {
                    try {
                        targetAddress = getPKCAddressFromPublicKeySync(mod.originalAuthorPublicKey);
                    } catch {
                        // If we can't derive the address from the public key, fall back to authorSignerAddress
                        targetAddress = mod.authorSignerAddress;
                    }
                } else {
                    targetAddress = mod.authorSignerAddress;
                }

                if (targetAddress) {
                    updateStmt.run(targetAddress, mod.rowid);
                }
            }
        });

        updateMany(moderationsToUpdate);
        log(`Backfilled targetAuthorSignerAddress for ${moderationsToUpdate.length} comment moderations`);
    }

    private _backfillTargetAuthorDomain() {
        const log = Logger("pkc-js:local-community:db-handler:_backfillTargetAuthorDomain");

        // Find comment moderations that have author-related edits (bans/flairs) but no targetAuthorDomain
        // and the comment author used a domain address
        const moderationsToUpdate = this._db
            .prepare(
                `
            SELECT cm.rowid, c.author as commentAuthor,
                   pa.originalAuthorName
            FROM ${TABLES.COMMENT_MODERATIONS} cm
            LEFT JOIN ${TABLES.COMMENTS} c ON cm.commentCid = c.cid
            LEFT JOIN ${TABLES.PSEUDONYMITY_ALIASES} pa ON cm.commentCid = pa.commentCid
            WHERE cm.targetAuthorDomain IS NULL
              AND json_extract(cm.commentModeration, '$.author') IS NOT NULL
        `
            )
            .all() as {
            rowid: number;
            commentAuthor: string | null;
            originalAuthorName: string | null;
        }[];

        if (moderationsToUpdate.length === 0) return;

        const updateStmt = this._db.prepare(`UPDATE ${TABLES.COMMENT_MODERATIONS} SET targetAuthorDomain = ? WHERE rowid = ?`);

        let updatedCount = 0;
        const updateMany = this._db.transaction((items: typeof moderationsToUpdate) => {
            for (const mod of items) {
                let targetDomain: string | null = null;

                // If the comment was published with pseudonymity, use the original author's domain
                if (mod.originalAuthorName) {
                    targetDomain = mod.originalAuthorName;
                } else if (mod.commentAuthor) {
                    try {
                        const author = JSON.parse(mod.commentAuthor) as { address?: string; name?: string };
                        targetDomain = getAuthorNameFromWire(author) || null;
                    } catch {
                        // Ignore parse errors
                    }
                }

                if (targetDomain) {
                    updateStmt.run(targetDomain, mod.rowid);
                    updatedCount++;
                }
            }
        });

        updateMany(moderationsToUpdate);
        log(`Backfilled targetAuthorDomain for ${updatedCount} comment moderations`);
    }

    private _getColumnNames(tableName: string): string[] {
        const results = this._db.pragma(`table_info(${tableName})`) as { name: string }[];
        return results.map((col) => col.name);
    }

    // Query column lists are derived from the zod schemas, which describe the *code's* view of a
    // record. A DB that has not been migrated yet is one or more columns behind that view, and
    // createCommunity() reads the DB (resolveDbPostsCidRefs) before start() gets the chance to
    // migrate it — selecting a column the table does not have throws and the community can never be
    // loaded, let alone migrated (issue #273). Intersecting with the table's real columns keeps such
    // a DB readable; the fields left out are optional on the wire and the migration in start()
    // backfills the schema immediately after.
    private _existingColumns(tableName: string, columns: string[]): string[] {
        if (!this._columnNamesByTable[tableName]) this._columnNamesByTable[tableName] = this._getColumnNames(tableName);
        const existing = this._columnNamesByTable[tableName];
        return columns.filter((column) => existing.includes(column));
    }

    private async _copyTable(srcTable: string, dstTable: string, currentDbVersion: number) {
        const log = Logger("pkc-js:local-community:db-handler:createTablesIfNeeded:copyTable");
        const dstTableColumns = this._getColumnNames(dstTable);
        // Include rowid in the SELECT to preserve it
        const srcRecordsRaw: any[] = this._db.prepare(`SELECT rowid, * FROM ${srcTable} ORDER BY rowid ASC`).all();

        if (srcRecordsRaw.length > 0) {
            log(`Attempting to copy ${srcRecordsRaw.length} records from ${srcTable} to ${dstTable}`);

            // Add rowid to the column list for insertion
            const columnsWithRowid = ["rowid", ...dstTableColumns];
            const insertStmt = this._db.prepare(
                `INSERT INTO ${dstTable} (${columnsWithRowid.join(", ")}) VALUES (${columnsWithRowid.map(() => "?").join(", ")})`
            );

            const recordsToInsert = [];
            for (let srcRecord of srcRecordsRaw) {
                srcRecord = { ...srcRecord }; // Ensure mutable

                // Pre-process specific migrations
                if (currentDbVersion <= 11 && srcTable === TABLES.COMMENT_EDITS) {
                    const parsedSig: CommentEditSignature =
                        typeof srcRecord.signature === "string" ? JSON.parse(srcRecord.signature) : srcRecord.signature;
                    const commentToBeEdited = this.queryComment(srcRecord.commentCid);
                    if (!commentToBeEdited) throw Error(`Failed to compute isAuthorEdit for ${srcRecord.commentCid}`);
                    srcRecord["isAuthorEdit"] = parsedSig.publicKey === commentToBeEdited.signature.publicKey;

                    const commentEditFieldsNotIncludedAnymore = ["removed"];
                    const extraProps = removeNullUndefinedValues(pick(srcRecord, commentEditFieldsNotIncludedAnymore)) as Record<
                        string,
                        any
                    >;

                    if (Object.keys(extraProps).length > 0) srcRecord.extraProps = { ...srcRecord.extraProps, ...extraProps };
                }
                if (currentDbVersion <= 12 && srcRecord["authorAddress"] && srcRecord["signature"]) {
                    const sig = typeof srcRecord.signature === "string" ? JSON.parse(srcRecord.signature) : srcRecord.signature;
                    srcRecord["authorSignerAddress"] = await getPKCAddressFromPublicKey(sig["publicKey"]);
                }
                if (srcTable === TABLES.COMMENTS) {
                    const commentIpfsFieldsNotIncludedAnymore = ["ipnsName"];
                    const extraProps = removeNullUndefinedValues(pick(srcRecord, commentIpfsFieldsNotIncludedAnymore)) as Record<
                        string,
                        any
                    >;

                    if (Object.keys(extraProps).length > 0) srcRecord.extraProps = { ...srcRecord.extraProps, ...extraProps };
                }

                // Migrate subplebbitAddress to communityPublicKey/communityName (v36 → v37)
                if (currentDbVersion < 37 && srcRecord["subplebbitAddress"]) {
                    const addr = srcRecord["subplebbitAddress"] as string;
                    if (isStringDomain(addr)) {
                        srcRecord["communityName"] = addr;
                        // Leave communityPublicKey as NULL for domain-based old rows
                    } else {
                        srcRecord["communityPublicKey"] = addr;
                    }
                    // Preserve subplebbitAddress in extraProps for CID reconstruction
                    const existingExtra =
                        typeof srcRecord.extraProps === "string" ? JSON.parse(srcRecord.extraProps) : srcRecord.extraProps || {};
                    srcRecord.extraProps = { ...existingExtra, subplebbitAddress: addr };
                    delete srcRecord["subplebbitAddress"];
                }

                // The alias reverse-lookup column (v41 → v42, issue #351)
                if (
                    currentDbVersion < 42 &&
                    srcTable === TABLES.PSEUDONYMITY_ALIASES &&
                    typeof srcRecord["originalAuthorPublicKey"] === "string"
                )
                    srcRecord["originalAuthorSignerAddress"] = deriveAliasOriginalAuthorSignerAddress(srcRecord["originalAuthorPublicKey"]);

                // Rename pseudonymityAliases columns (v38 → v39)
                if (currentDbVersion < 39 && srcTable === TABLES.PSEUDONYMITY_ALIASES) {
                    if (srcRecord["originalAuthorSignerPublicKey"] !== undefined) {
                        srcRecord["originalAuthorPublicKey"] = srcRecord["originalAuthorSignerPublicKey"];
                        delete srcRecord["originalAuthorSignerPublicKey"];
                    }
                    if (srcRecord["originalAuthorDomain"] !== undefined) {
                        srcRecord["originalAuthorName"] = srcRecord["originalAuthorDomain"];
                        delete srcRecord["originalAuthorDomain"];
                    }
                }

                // Prepare record for insertion (stringify JSONs, convert booleans)
                const processedRecord = this._processRecordsForDbBeforeInsert([srcRecord])[0];

                // Map values including rowid (preserve the original rowid value)
                const finalRecordValues = columnsWithRowid.map((col) => {
                    if (col === "rowid") {
                        return srcRecord.rowid; // Use original rowid value
                    }
                    return processedRecord[col];
                });
                recordsToInsert.push(finalRecordValues);
            }

            if (recordsToInsert.length > 0) {
                const insertMany = this._db.transaction((items: any[][]) => {
                    for (const itemArgs of items) {
                        insertStmt.run(...itemArgs);
                    }
                });
                insertMany(recordsToInsert);
            }
        }
        log(`copied table ${srcTable} to table ${dstTable}`);
    }

    private async _purgePublicationTablesWithDuplicateSignatures() {
        const log = Logger("pkc-js:local-community:db-handler:_purgePublicationTablesWithDuplicateSignatures");
        const publicationTables = [TABLES.COMMENTS, TABLES.COMMENT_EDITS, TABLES.COMMENT_MODERATIONS, TABLES.COMMENT_UPDATES] as const;

        for (const tableName of publicationTables) {
            const columnNames = this._getColumnNames(tableName);
            if (!columnNames.includes("signature")) {
                log.trace(`Skipping duplicate signature purge for ${tableName} because column signature is missing.`);
                continue;
            }

            const jsonValidExpr = (alias: string) => `json_valid(${alias}.signature) = 1`;
            const signatureExtractExpr = (alias: string) => `json_extract(${alias}.signature, '$.signature')`;

            const duplicateRows = this._db
                .prepare(
                    `
                        SELECT newer.rowid AS rowid
                        FROM ${tableName} AS newer
                        WHERE ${jsonValidExpr("newer")}
                          AND ${signatureExtractExpr("newer")} IS NOT NULL
                          AND EXISTS (
                              SELECT 1
                              FROM ${tableName} AS older
                              WHERE ${jsonValidExpr("older")}
                                AND ${signatureExtractExpr("older")} = ${signatureExtractExpr("newer")}
                                AND older.rowid < newer.rowid
                          )
                    `
                )
                .all() as { rowid: number }[];

            if (duplicateRows.length === 0) continue;

            if (tableName === TABLES.COMMENTS) {
                const duplicateCids = this._db
                    .prepare(
                        `
                            SELECT cid
                            FROM ${TABLES.COMMENTS} AS newer
                            WHERE ${jsonValidExpr("newer")}
                              AND ${signatureExtractExpr("newer")} IS NOT NULL
                              AND EXISTS (
                                  SELECT 1
                                  FROM ${TABLES.COMMENTS} AS older
                                  WHERE ${jsonValidExpr("older")}
                                    AND ${signatureExtractExpr("older")} = ${signatureExtractExpr("newer")}
                                    AND older.rowid < newer.rowid
                              )
                        `
                    )
                    .all() as { cid: string }[];
                for (const { cid } of duplicateCids) {
                    const purgedRows = this.purgeComment(cid);
                    for (const row of purgedRows) await addAllCidsUnderPurgedCommentToBeRemoved(this._community, row);
                }
                log(`Purged ${duplicateCids.length} duplicate comment row(s) based on signature.signature with higher rowid values.`);
                continue;
            }

            const deleteStmt = this._db.prepare(`DELETE FROM ${tableName} WHERE rowid = ?`);
            const deleteMany = this._db.transaction((rows: { rowid: number }[]) => {
                for (const row of rows) deleteStmt.run(row.rowid);
            });
            deleteMany(duplicateRows);

            log(`Purged ${duplicateRows.length} duplicate row(s) from ${tableName} based on signature.signature with higher rowid values.`);
        }
    }

    private async _purgeCommentEditsWithInvalidSchemaOrSignature() {
        const log = Logger("pkc-js:local-community:db-handler:_purgeCommentEditsWithInvalidSchemaOrSignature");

        const commentEditsOrderedByASC = this._db
            .prepare(`SELECT rowid as rowid, * FROM ${TABLES.COMMENT_EDITS} ORDER BY rowid ASC`)
            .all() as (CommentEditsTableRow & { rowid: number })[];

        for (const rawCommentEditRecord of commentEditsOrderedByASC) {
            let commentEditRecord: CommentEditsTableRow;
            try {
                commentEditRecord = this._parseCommentEditsRow(rawCommentEditRecord);
            } catch (error) {
                if (error instanceof ZodError) {
                    log.error(
                        `Comment edit (${rawCommentEditRecord.commentCid}) row ${rawCommentEditRecord.rowid} in DB failed to parse and will be purged from comment edits table.`,
                        error
                    );
                    this._deleteCommentEditRow(rawCommentEditRecord.rowid);
                    continue;
                }
                throw error;
            }

            try {
                CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema.strip().parse(commentEditRecord);
            } catch (e) {
                log.error(
                    `Comment edit (${commentEditRecord.commentCid}) row ${rawCommentEditRecord.rowid} in DB has an invalid schema and will be purged from comment edits table.`,
                    e
                );
                this._deleteCommentEditRow(rawCommentEditRecord.rowid);
                continue;
            }

            const commentEditWithExtraProps = this._spreadExtraProps({ ...commentEditRecord });
            const commentEditPubsub = pick(commentEditWithExtraProps, [
                ...(commentEditWithExtraProps.signature.signedPropertyNames as CommentEditSignature["signedPropertyNames"]),
                "signature"
            ]) as CommentEditPubsubMessagePublication;
            const validRes = await verifyCommentEdit({
                edit: commentEditPubsub,
                resolveAuthorNames: false,
                clientsManager: this._community._clientsManager
            });
            if (!validRes.valid && validRes.reason === messages.ERR_SIGNATURE_IS_INVALID) {
                log.error(
                    `Comment edit (${commentEditRecord.commentCid}) row ${rawCommentEditRecord.rowid} in DB has invalid signature due to ${validRes.reason}. Removing comment edit entry.`
                );
                this._deleteCommentEditRow(rawCommentEditRecord.rowid);
            }
        }
    }

    private async _purgeCommentsWithInvalidSchemaOrSignature() {
        const log = Logger("pkc-js:local-community:db-handler:_purgeCommentsWithInvalidSchema");

        const commentsOrderedByASC = this._db.prepare(`SELECT * FROM ${TABLES.COMMENTS} ORDER BY rowid ASC`).all() as CommentsTableRow[];
        const alreadyPurgedCids = new Set<string>();

        for (const rawCommentRecord of commentsOrderedByASC) {
            if (alreadyPurgedCids.has(rawCommentRecord.cid)) continue;

            let commentRecord: CommentsTableRow;
            try {
                commentRecord = this._parseCommentsTableRow(rawCommentRecord);
            } catch (error) {
                if (error instanceof ZodError) {
                    const purged = this.purgeComment(rawCommentRecord.cid);
                    for (const p of purged) alreadyPurgedCids.add(p.commentTableRow.cid);
                    continue;
                }
                throw error;
            }

            try {
                CommentIpfsSchema.strip().parse(commentRecord);
            } catch (e) {
                log.error(`Comment (${commentRecord.cid}) in DB has an invalid schema, will be purged.`, e);
                const purged = this.purgeComment(commentRecord.cid);
                for (const p of purged) alreadyPurgedCids.add(p.commentTableRow.cid);
                continue;
            }
            const validRes = await verifyCommentIpfs({
                comment: deriveCommentIpfsFromCommentTableRow(commentRecord),
                resolveAuthorNames: false,
                calculatedCommentCid: commentRecord.cid,
                clientsManager: this._community._clientsManager
            });
            if (!validRes.valid) {
                log.error(`Comment ${commentRecord.cid} in DB has invalid signature due to ${validRes.reason}. Will be purged.`);
                const purged = this.purgeComment(commentRecord.cid);
                for (const p of purged) alreadyPurgedCids.add(p.commentTableRow.cid);
            }
        }
    }

    deleteVote(authorSignerAddress: VotesTableRow["authorSignerAddress"], commentCid: VotesTableRow["commentCid"]): void {
        this._db
            .prepare(`DELETE FROM ${TABLES.VOTES} WHERE commentCid = ? AND authorSignerAddress = ?`)
            .run(commentCid, authorSignerAddress);
    }

    private _deleteCommentEditRow(rowid: number): boolean {
        const deleteResult = this._db.prepare(`DELETE FROM ${TABLES.COMMENT_EDITS} WHERE rowid = ?`).run(rowid);
        return deleteResult.changes > 0;
    }

    insertVotes(votes: VotesTableRowInsert[]): void {
        if (votes.length === 0) return;
        const processedVotes = this._processRecordsForDbBeforeInsert(votes);

        // Get all column names from the votes table to create defaults
        const columnNames = this._getColumnNames(TABLES.VOTES);

        const stmt = this._db.prepare(`
            INSERT INTO ${TABLES.VOTES} 
            (commentCid, authorSignerAddress, timestamp, vote, protocolVersion, insertedAt, extraProps) 
            VALUES (@commentCid, @authorSignerAddress, @timestamp, @vote, @protocolVersion, @insertedAt, @extraProps)
        `);

        const insertMany = this._db.transaction((items: VotesTableRowInsert[]) => {
            for (const vote of items) {
                // Create default object with null values for all columns
                const defaults: Record<string, null> = {};
                columnNames.forEach((column) => {
                    if (!(column in vote)) {
                        defaults[column] = null;
                    }
                });

                // Merge defaults with actual vote data
                const completeVote = { ...defaults, ...vote };
                stmt.run(completeVote);
            }
        });

        insertMany(processedVotes);
    }

    insertComments(comments: CommentsTableRowInsert[]): void {
        if (comments.length === 0) return;
        const processedComments = this._processRecordsForDbBeforeInsert(comments);

        // Get all column names from the comments table to create defaults
        const columnNames = this._getColumnNames(TABLES.COMMENTS) as (keyof CommentsTableRow)[];

        // TODO: refactor to derive column list from CommentsTableRowSchema instead of hardcoding.
        // Adding a new column to the comments table requires updating this list manually, which is error-prone.
        const stmt = this._db.prepare(`
            INSERT INTO ${TABLES.COMMENTS}
            (cid, authorSignerAddress, author, link, linkWidth, linkHeight, thumbnailUrl, thumbnailUrlWidth, thumbnailUrlHeight, parentCid, postCid, previousCid, communityPublicKey, communityName, content, timestamp, signature, originalCommentSignatureEncoded, title, depth, linkHtmlTagName, flairs, spoiler, pendingApproval, number, postNumber, nsfw, pseudonymityMode, quotedCids, crosspost, extraProps, challengeCommentUpdate, protocolVersion, insertedAt)
            VALUES (@cid, @authorSignerAddress, @author, @link, @linkWidth, @linkHeight, @thumbnailUrl, @thumbnailUrlWidth, @thumbnailUrlHeight, @parentCid, @postCid, @previousCid, @communityPublicKey, @communityName, @content, @timestamp, @signature, @originalCommentSignatureEncoded, @title, @depth, @linkHtmlTagName, @flairs, @spoiler, @pendingApproval, @number, @postNumber, @nsfw, @pseudonymityMode, @quotedCids, @crosspost, @extraProps, @challengeCommentUpdate, @protocolVersion, @insertedAt)
        `);

        // Create default object with null values for all columns
        const defaults = mapToObj(columnNames, (column) => [column, null]);

        const insertMany = this._db.transaction((items: CommentsTableRowInsert[]) => {
            for (const comment of items) {
                // Merge defaults with actual comment data
                const completeComment = { ...defaults, ...comment };
                stmt.run(completeComment);
            }
        });

        insertMany(processedComments);
    }

    insertPseudonymityAliases(aliases: PseudonymityAliasRow[]): void {
        if (aliases.length === 0) return;
        const processedAliases = this._processRecordsForDbBeforeInsert(aliases).map((alias) => ({
            ...alias,
            originalAuthorSignerAddress: deriveAliasOriginalAuthorSignerAddress(alias.originalAuthorPublicKey)
        }));
        const stmt = this._db.prepare(`
            INSERT OR REPLACE INTO ${TABLES.PSEUDONYMITY_ALIASES}
            (commentCid, aliasPrivateKey, originalAuthorPublicKey, originalAuthorSignerAddress, originalAuthorName, mode, insertedAt)
            VALUES (@commentCid, @aliasPrivateKey, @originalAuthorPublicKey, @originalAuthorSignerAddress, @originalAuthorName, @mode, @insertedAt)
        `);

        const insertMany = this._db.transaction((items: PseudonymityAliasRow[]) => {
            for (const alias of items) stmt.run(alias);
        });

        insertMany(processedAliases);
    }

    upsertCommentUpdates(updates: CommentUpdatesTableRowInsert[]): void {
        const processedUpdates = this._processRecordsForDbBeforeInsert(updates);

        // Get all column names from the comment_updates table to create defaults
        const columnNames = this._getColumnNames(TABLES.COMMENT_UPDATES) as (keyof CommentUpdatesRow)[];

        const stmt = this._prepareCached(`
            INSERT INTO ${TABLES.COMMENT_UPDATES} 
            (cid, edit, upvoteCount, downvoteCount, replyCount, childCount, number, postNumber, flairs, spoiler, nsfw, pinned, locked, archived, removed, approved, reason, updatedAt, protocolVersion, signature, author, replies, lastChildCid, lastReplyTimestamp, postUpdatesBucket, publishedToPostUpdatesMFS, insertedAt)
            VALUES (@cid, @edit, @upvoteCount, @downvoteCount, @replyCount, @childCount, @number, @postNumber, @flairs, @spoiler, @nsfw, @pinned, @locked, @archived, @removed, @approved, @reason, @updatedAt, @protocolVersion, @signature, @author, @replies, @lastChildCid, @lastReplyTimestamp, @postUpdatesBucket, @publishedToPostUpdatesMFS, @insertedAt)
            ON CONFLICT(cid) DO UPDATE SET
                edit = excluded.edit, upvoteCount = excluded.upvoteCount, downvoteCount = excluded.downvoteCount, replyCount = excluded.replyCount, childCount = excluded.childCount,
                number = COALESCE(excluded.number, ${TABLES.COMMENT_UPDATES}.number),
                postNumber = COALESCE(excluded.postNumber, ${TABLES.COMMENT_UPDATES}.postNumber),
                flairs = excluded.flairs, spoiler = excluded.spoiler, nsfw = excluded.nsfw, pinned = excluded.pinned, locked = excluded.locked, archived = excluded.archived,
                removed = excluded.removed, approved = excluded.approved, reason = excluded.reason, updatedAt = excluded.updatedAt, protocolVersion = excluded.protocolVersion,
                signature = excluded.signature, author = excluded.author, replies = excluded.replies, lastChildCid = excluded.lastChildCid,
                lastReplyTimestamp = excluded.lastReplyTimestamp, postUpdatesBucket = excluded.postUpdatesBucket,
                publishedToPostUpdatesMFS = excluded.publishedToPostUpdatesMFS,
                insertedAt = excluded.insertedAt
        `);

        const defaults = mapToObj(columnNames, (column) => [column, null]);

        const upsertMany = this._db.transaction((items: CommentUpdatesTableRowInsert[]) => {
            for (const update of items) {
                // Create default object with null values for all columns

                // Merge defaults with actual update data
                const completeUpdate = { ...defaults, ...update };
                stmt.run(completeUpdate);
            }
        });

        upsertMany(processedUpdates);
    }

    insertCommentModerations(moderations: CommentModerationsTableRowInsert[]): void {
        if (moderations.length === 0) return;
        const processedModerations = this._processRecordsForDbBeforeInsert(moderations);

        // Get all column names from the comment_moderations table to create defaults
        const columnNames = this._getColumnNames(TABLES.COMMENT_MODERATIONS) as (keyof CommentModerationTableRow)[];

        const stmt = this._db.prepare(`
            INSERT INTO ${TABLES.COMMENT_MODERATIONS}
            (commentCid, author, signature, modSignerAddress, protocolVersion, communityPublicKey, communityName, timestamp, commentModeration, insertedAt, extraProps, targetAuthorSignerAddress, targetAuthorDomain)
            VALUES (@commentCid, @author, @signature, @modSignerAddress, @protocolVersion, @communityPublicKey, @communityName, @timestamp, @commentModeration, @insertedAt, @extraProps, @targetAuthorSignerAddress, @targetAuthorDomain)
        `);

        const defaults = mapToObj(columnNames, (column) => [column, null]);
        const insertMany = this._db.transaction((items: CommentModerationsTableRowInsert[]) => {
            for (const mod of items) {
                // Create default object with null values for all columns

                // Merge defaults with actual moderation data
                const completeMod = { ...defaults, ...mod };
                stmt.run(completeMod);
            }
        });

        insertMany(processedModerations);
    }

    insertCommentEdits(edits: CommentEditsTableRowInsert[]): void {
        if (edits.length === 0) return;
        const processedEdits = this._processRecordsForDbBeforeInsert(edits);

        // Get all column names from the comment_edits table to create defaults
        const columnNames = this._getColumnNames(TABLES.COMMENT_EDITS) as (keyof CommentEditsTableRow)[];

        const stmt = this._db.prepare(`
            INSERT INTO ${TABLES.COMMENT_EDITS}
            (commentCid, authorSignerAddress, author, signature, protocolVersion, communityPublicKey, communityName, timestamp, content, reason, deleted, flairs, spoiler, nsfw, isAuthorEdit, insertedAt, extraProps)
            VALUES (@commentCid, @authorSignerAddress, @author, @signature, @protocolVersion, @communityPublicKey, @communityName, @timestamp, @content, @reason, @deleted, @flairs, @spoiler, @nsfw, @isAuthorEdit, @insertedAt, @extraProps)
        `);

        const defaults = mapToObj(columnNames, (column) => [column, null]);
        const insertMany = this._db.transaction((items: CommentEditsTableRowInsert[]) => {
            for (const edit of items) {
                // Create default object with null values for all columns

                // Merge defaults with actual edit data
                const completeEdit = { ...defaults, ...edit };
                stmt.run(completeEdit);
            }
        });

        insertMany(processedEdits);
    }

    queryVote(commentCid: string, authorSignerAddress: string): VotesTableRow | undefined {
        const row = this._db
            .prepare(`SELECT * FROM ${TABLES.VOTES} WHERE commentCid = ? AND authorSignerAddress = ?`)
            .get(commentCid, authorSignerAddress) as VotesTableRow | undefined;
        if (!row) return undefined;
        return this._parseVoteRow(row);
    }

    private _approvedClause(alias: string): string {
        return `(${alias}.approved IS NULL OR ${alias}.approved = 1 OR ${alias}.approved IS TRUE)`;
    }

    private _removedClause(alias: string): string {
        return `(${alias}.removed IS NOT 1 AND ${alias}.removed IS NOT TRUE)`;
    }

    private _deletedFromUpdatesClause(alias: string): string {
        return `(json_extract(${alias}.edit, '$.deleted') IS NULL OR json_extract(${alias}.edit, '$.deleted') != 1)`;
    }

    private _deletedFromLookupClause(alias: string): string {
        return `(${alias}.deleted_flag IS NULL OR ${alias}.deleted_flag != 1)`;
    }

    private _pendingApprovalClause(alias: string): string {
        return `(${alias}.pendingApproval IS NULL OR ${alias}.pendingApproval != 1)`;
    }

    private _communityAddressClause(alias: string): { clause: string; params: string[] } {
        const address = this._community.address;
        const addresses = getEquivalentCommunityAddresses(address);
        if (isStringDomain(address)) {
            // Domain-based: match communityName OR communityPublicKey (domain strings and IPNS keys never overlap)
            const domainPlaceholders = addresses.map(() => "?").join(", ");
            return {
                clause: `(${alias}.communityName IN (${domainPlaceholders}) OR ${alias}.communityPublicKey IN (${domainPlaceholders}))`,
                params: [...addresses, ...addresses]
            };
        } else {
            // IPNS key: match communityPublicKey directly
            return { clause: `${alias}.communityPublicKey = ?`, params: [address] };
        }
    }

    private _communityAddressClauseNamed(alias: string, paramPrefix: string): { clause: string; params: Record<string, string> } {
        const address = this._community.address;
        const addresses = getEquivalentCommunityAddresses(address);
        if (isStringDomain(address)) {
            // Domain-based: match communityName OR communityPublicKey (domain strings and IPNS keys never overlap)
            const params: Record<string, string> = {};
            const namePlaceholders: string[] = [];
            const keyPlaceholders: string[] = [];
            addresses.forEach((addr, i) => {
                const nameParam = `${paramPrefix}CommunityName${i}`;
                const keyParam = `${paramPrefix}CommunityKey${i}`;
                params[nameParam] = addr;
                params[keyParam] = addr;
                namePlaceholders.push(`:${nameParam}`);
                keyPlaceholders.push(`:${keyParam}`);
            });
            return {
                clause: `(${alias}.communityName IN (${namePlaceholders.join(", ")}) OR ${alias}.communityPublicKey IN (${keyPlaceholders.join(", ")}))`,
                params
            };
        } else {
            // IPNS key: match communityPublicKey directly
            const paramName = `${paramPrefix}CommunityKey`;
            return { clause: `${alias}.communityPublicKey = :${paramName}`, params: { [paramName]: address } };
        }
    }

    private _buildPageQueryParts(options: Omit<PageOptions, "pageSize" | "preloadedPage" | "baseTimestamp" | "firstPageSizeBytes">): {
        whereClauses: string[];
        params: any[];
    } {
        const commentsTable = TABLES.COMMENTS;
        const commentUpdatesTable = TABLES.COMMENT_UPDATES;

        const whereClauses: string[] = [`${commentsTable}.parentCid = ?`];
        const params: any[] = [options.parentCid];

        if (options.excludeCommentsWithDifferentCommunityAddress) {
            const { clause, params: addrParams } = this._communityAddressClause(commentsTable);
            whereClauses.push(clause);
            params.push(...addrParams);
        }
        if (options.excludeCommentPendingApproval) whereClauses.push(this._pendingApprovalClause(commentsTable));
        if (options.excludeRemovedComments) whereClauses.push(this._removedClause(commentUpdatesTable));
        if (options.excludeDeletedComments) whereClauses.push(this._deletedFromUpdatesClause(commentUpdatesTable));
        if (options.excludeCommentWithApprovedFalse) whereClauses.push(this._approvedClause(commentUpdatesTable));

        return { whereClauses, params };
    }

    // The column set of a page entry: every CommentIpfs column plus extraProps, and every CommentUpdate column
    // unless the caller excludes some (a flat page drops `replies`). Compiled mappers are cached per column set.
    private _pageEntryMapper(commentUpdateFieldsToExclude?: (keyof CommentUpdateType)[], existingOnly = false): PositionalCommentRowMapper {
        const commentUpdateCols = keys(
            commentUpdateFieldsToExclude ? omit(CommentUpdateSchema.shape, commentUpdateFieldsToExclude) : CommentUpdateSchema.shape
        );
        const commentIpfsCols = [...keys(CommentIpfsSchema.shape), "extraProps"];
        return this._positionalMapperFor({
            commentIpfsCols: existingOnly ? this._existingColumns(TABLES.COMMENTS, commentIpfsCols) : commentIpfsCols,
            commentUpdateCols: existingOnly ? this._existingColumns(TABLES.COMMENT_UPDATES, commentUpdateCols) : commentUpdateCols
        });
    }

    private _positionalMapperFor(cols: { commentIpfsCols: string[]; commentUpdateCols: string[] }): PositionalCommentRowMapper {
        const key = `${cols.commentIpfsCols.join(",")}|${cols.commentUpdateCols.join(",")}`;
        let mapper = this._positionalMappers.get(key);
        if (!mapper) {
            mapper = createPositionalCommentRowMapper(cols);
            this._positionalMappers.set(key, mapper);
        }
        return mapper;
    }

    queryPageComments(options: Omit<PageOptions, "firstPageSizeBytes">): PageIpfs["comments"] {
        const mapper = this._pageEntryMapper(options.commentUpdateFieldsToExclude);
        const { whereClauses, params } = this._buildPageQueryParts(options);
        const queryStr = `
            SELECT ${mapper.selectList(
                (col) => `${TABLES.COMMENTS}.${col}`,
                (col) => `${TABLES.COMMENT_UPDATES}.${col}`
            )}
            FROM ${TABLES.COMMENTS} INNER JOIN ${TABLES.COMMENT_UPDATES} ON ${TABLES.COMMENTS}.cid = ${TABLES.COMMENT_UPDATES}.cid
            WHERE ${whereClauses.join(" AND ")}
        `;
        const rows = this._prepareCached(queryStr)
            .raw(true)
            .all(...params) as unknown[][];
        return rows.map(mapper.map);
    }

    // Nested reply trees out of page entries and the parent each was reached through (its own parentCid, whether
    // it came from a flat subtree read or from the level walk).
    // A child listed under two preloaded sorts of the same parent comes back twice and is kept once. `attachReplies`
    // rebuilds one page per preloaded sort of a parent, in that sort's commentCids order (the CTE's row order is not
    // the json_each order once the JOINs are involved), and `buildWireCommentUpdate` swaps the DB-format `replies`
    // for the resolved pages, or for `pageCids` alone when nothing is embedded but pages exist.
    private _assembleReplyTrees(items: { entry: PageIpfs["comments"][number]; parent: string }[]) {
        type Entry = PageIpfs["comments"][number];
        const parsedByCid = new Map<string, Entry>();
        const childrenByParent = new Map<string, Map<string, Entry>>();
        for (const { entry, parent } of items) {
            const cid = entry.commentUpdate.cid;
            if (parsedByCid.has(cid)) continue;
            parsedByCid.set(cid, entry);
            let siblings = childrenByParent.get(parent);
            if (!siblings) childrenByParent.set(parent, (siblings = new Map()));
            siblings.set(cid, entry);
        }

        // Keys stay sorted (see createPositionalCommentRowMapper): `replies` is re-inserted in order, and
        // `pageCids` sorts before `pages`
        const buildWireCommentUpdate = (
            commentUpdate: CommentUpdateType,
            resolvedReplies: CommentUpdateType["replies"] | undefined
        ): CommentUpdateType => {
            const { replies: dbReplies, ...rest } = commentUpdate;
            if (resolvedReplies) return withSortedKeys({ ...rest, replies: resolvedReplies }) as CommentUpdateType;
            if (dbReplies) {
                const pageCids: Record<string, string> = {};
                for (const sortName of Object.keys(dbReplies as Record<string, DbRepliesSortEntry>).sort()) {
                    const sortEntry = (dbReplies as Record<string, DbRepliesSortEntry>)[sortName];
                    if (sortEntry?.allPageCids?.[0]) pageCids[sortName] = sortEntry.allPageCids[0];
                }
                if (Object.keys(pageCids).length > 0)
                    return withSortedKeys({ ...rest, replies: { pageCids, pages: {} } }) as CommentUpdateType;
            }
            return rest as CommentUpdateType;
        };

        const attachReplies = (cid: string): CommentUpdateType["replies"] | undefined => {
            const children = childrenByParent.get(cid);
            if (!children?.size) return undefined;
            const parentDbReplies = parsedByCid.get(cid)?.commentUpdate.replies as Record<string, DbRepliesSortEntry> | undefined;
            const pages: Record<string, PageIpfs> = {};
            for (const sortName of Object.keys(parentDbReplies ?? {}).sort()) {
                const sortEntry = parentDbReplies![sortName];
                if (!sortEntry?.commentCids) continue;
                const comments: Entry[] = [];
                for (const childCid of sortEntry.commentCids) {
                    const child = children.get(childCid);
                    if (child)
                        comments.push({
                            comment: child.comment,
                            commentUpdate: buildWireCommentUpdate(child.commentUpdate, attachReplies(childCid))
                        });
                }
                pages[sortName] = { comments };
            }
            if (Object.keys(pages).length === 0) return undefined;
            return { pages };
        };

        return { parsedByCid, childrenByParent, buildWireCommentUpdate, attachReplies };
    }

    // The page entries under one comment: its direct children that pass the page's exclusions, each carrying the
    // reply pages its own CommentUpdate was signed with (resolveRepliesCidRefsForEntries). The exclusions apply to
    // the children only: what a child embeds was fixed when the child was signed, and a change below it re-flags the
    // child before its parent (stale_replies), so re-filtering the nested tree here could only disagree with the
    // child's signature. The recursive CTE this replaced cost a scan of the board per call (issue #351).
    queryPageCommentsWithResolvedReplies(options: Omit<PageOptions, "firstPageSizeBytes">): PageIpfs["comments"] {
        return this.resolveRepliesCidRefsForEntries(this.queryPageComments(options));
    }

    // Whether a loaded entry's CommentUpdate has replies to embed: its DB-format `replies` names a preloaded page or
    // a page CID (deriveDbReplies never stores an empty object)
    private _entryHasDbReplies(entry: PageIpfs["comments"][number]): boolean {
        const replies = entry.commentUpdate.replies as Record<string, DbRepliesSortEntry> | undefined;
        if (!replies) return false;
        return Object.values(replies).some((sortEntry) => sortEntry?.commentCids || sortEntry?.allPageCids);
    }

    // Run one statement per batch of cids, under the SQLite variable cap, collecting every row
    private _forEachCidBatch<Row>(
        cids: string[],
        queryFor: (placeholders: string) => string,
        onRow: (row: Row) => void,
        raw = false
    ): void {
        for (const { placeholders, params } of this._cidChunks(cids)) {
            const statement = this._prepareCached(queryFor(placeholders));
            if (raw) statement.raw(true);
            for (const row of statement.all(...params) as Row[]) onRow(row);
        }
    }

    // Every reply under the given posts (depth > 0, by postCid, indexed), as page entries with their DB-format reply
    // refs, in one flat read per batch of posts: what the page generator streams through, one batch of posts at a
    // time, to build those posts' nested reply pages (issue #351). Reads a post's whole subtree, listed or not; the
    // assembly keeps what the CID refs list.
    queryRepliesUnderPosts(postCids: string[]): PageIpfs["comments"] {
        const mapper = this._pageEntryMapper(undefined, true);
        const entries: PageIpfs["comments"] = [];
        this._forEachCidBatch<unknown[]>(
            postCids,
            (placeholders) => `
            SELECT ${mapper.selectList(
                (col) => `c.${col}`,
                (col) => `cu.${col}`
            )}
            FROM ${TABLES.COMMENTS} c
            INNER JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid
            WHERE c.depth > 0 AND c.postCid IN (${placeholders})
        `,
            (row) => entries.push(mapper.map(row)),
            true
        );
        return entries;
    }

    // Resolve each entry's CID-ref replies into the wire form its CommentUpdate was signed with: one page per preloaded
    // sort in that sort's commentCids order, nested recursively, `pageCids` from allPageCids. Entries without replies
    // come back untouched. Posts are resolved from one flat read of their subtrees (queryRepliesUnderPosts); a set
    // that includes replies walks the listed CID refs level by level. The page generator calls this per bounded
    // batch of posts (issue #351), never for a whole board at once.
    resolveRepliesCidRefsForEntries(entries: PageIpfs["comments"]): PageIpfs["comments"] {
        const withReplies = entries.filter((entry) => this._entryHasDbReplies(entry));
        if (withReplies.length === 0) return entries;
        const trees = withReplies.every((entry) => entry.comment.depth === 0)
            ? this._assembleReplyTrees(
                  this.queryRepliesUnderPosts(withReplies.map((entry) => entry.commentUpdate.cid)).map((entry) => ({
                      entry,
                      parent: entry.comment.parentCid!
                  }))
              )
            : this._assembleReplyTreesFromCidRefs(withReplies);
        return this._rebuildEntriesFromTrees(entries, trees);
    }

    // The listed-subtree resolution for entries that are not all posts (a reply's page, at any depth): walk the CID
    // refs level by level, each level one primary-key read of the cids the level above lists, batched under the
    // SQLite variable cap. Reads exactly the tree the entries embed, so a reply's cost is its own subtree (issue #351).
    private _assembleReplyTreesFromCidRefs(entries: PageIpfs["comments"]): ReturnType<DbHandler["_assembleReplyTrees"]> {
        const mapper = this._pageEntryMapper(undefined, true);
        const listedChildren = (ofEntries: PageIpfs["comments"]): string[] => {
            const cids: string[] = [];
            for (const entry of ofEntries) {
                const replies = entry.commentUpdate.replies as Record<string, DbRepliesSortEntry> | undefined;
                if (!replies) continue;
                for (const sortEntry of Object.values(replies)) if (sortEntry?.commentCids) cids.push(...sortEntry.commentCids);
            }
            return cids;
        };
        const items: { entry: PageIpfs["comments"][number]; parent: string }[] = [];
        const seen = new Set<string>();
        let frontier = listedChildren(entries);
        while (frontier.length > 0) {
            const level: PageIpfs["comments"] = [];
            this._forEachCidBatch<unknown[]>(
                frontier.filter((cid) => !seen.has(cid)),
                (placeholders) => `
                SELECT ${mapper.selectList(
                    (col) => `c.${col}`,
                    (col) => `cu.${col}`
                )}
                FROM ${TABLES.COMMENTS} c
                INNER JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid
                WHERE c.cid IN (${placeholders})
            `,
                (row) => level.push(mapper.map(row)),
                true
            );
            for (const entry of level) {
                seen.add(entry.commentUpdate.cid);
                items.push({ entry, parent: entry.comment.parentCid! });
            }
            frontier = listedChildren(level);
        }
        return this._assembleReplyTrees(items);
    }

    // Each entry's pages rebuilt from the assembled trees in its own commentCids order
    private _rebuildEntriesFromTrees(
        entries: PageIpfs["comments"],
        { parsedByCid, buildWireCommentUpdate, attachReplies }: ReturnType<DbHandler["_assembleReplyTrees"]>
    ): PageIpfs["comments"] {
        return entries.map((entry) => {
            if (!this._entryHasDbReplies(entry)) return entry;
            const replies = entry.commentUpdate.replies as Record<string, DbRepliesSortEntry>;

            const resolvedPages: Record<string, PageIpfs> = {};
            const resolvedPageCids: Record<string, string> = {};
            for (const sortName of Object.keys(replies).sort()) {
                const sortEntry = replies[sortName];
                if (sortEntry?.commentCids) {
                    const resolvedComments: PageIpfs["comments"] = [];
                    for (const cid of sortEntry.commentCids) {
                        const child = parsedByCid.get(cid);
                        if (child)
                            resolvedComments.push({
                                comment: child.comment,
                                commentUpdate: buildWireCommentUpdate(child.commentUpdate, attachReplies(cid))
                            });
                    }
                    // nextCid from allPageCids[0]; the legacy nextCid field for old DB rows
                    const nextCidForSort = sortEntry.allPageCids?.[0] ?? (sortEntry as { nextCid?: string }).nextCid;
                    resolvedPages[sortName] = { comments: resolvedComments, ...(nextCidForSort ? { nextCid: nextCidForSort } : {}) };
                }
                if (sortEntry?.allPageCids?.[0]) resolvedPageCids[sortName] = sortEntry.allPageCids[0];
            }

            const { replies: _dbReplies, ...entryCommentUpdateRest } = entry.commentUpdate;
            return {
                ...entry,
                commentUpdate: withSortedKeys({
                    ...entryCommentUpdateRest,
                    replies: {
                        ...(Object.keys(resolvedPageCids).length > 0 ? { pageCids: resolvedPageCids } : {}),
                        pages: resolvedPages
                    }
                }) as CommentUpdateType
            };
        });
    }

    queryCommentAndCommentUpdateByCids(
        cids: string[],
        opts: { commentUpdateCols: string[]; commentIpfsCols: string[] }
    ): PageIpfs["comments"] {
        if (cids.length === 0) return [];
        const mapper = this._positionalMapperFor({
            commentIpfsCols: this._existingColumns(TABLES.COMMENTS, opts.commentIpfsCols),
            commentUpdateCols: this._existingColumns(TABLES.COMMENT_UPDATES, opts.commentUpdateCols)
        });
        const entries: PageIpfs["comments"] = [];
        this._forEachCidBatch<unknown[]>(
            cids,
            (placeholders) => `
            SELECT ${mapper.selectList(
                (col) => `c.${col}`,
                (col) => `cu.${col}`
            )}
            FROM ${TABLES.COMMENTS} c
            INNER JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid
            WHERE c.cid IN (${placeholders})
        `,
            (row) => entries.push(mapper.map(row)),
            true
        );
        return entries;
    }

    queryFlattenedPageReplies(options: Omit<PageOptions, "firstPageSizeBytes"> & { parentCid: string }): PageIpfs["comments"] {
        const mapper = this._pageEntryMapper(options.commentUpdateFieldsToExclude);
        const commentUpdateCols = mapper.commentUpdateCols;

        let baseWhereClausesStr = "";
        let recursiveWhereClausesStr = "";
        const params: any[] = [options.parentCid];
        const baseFilterClauses: string[] = [];
        const recursiveFilterClauses: string[] = [];

        const commentsAlias = "comments";
        const commentUpdatesAlias = "c_updates";
        const deletedLookupAlias = "d";

        if (options.excludeCommentsWithDifferentCommunityAddress) {
            const { clause: baseClause, params: baseAddrParams } = this._communityAddressClause(commentsAlias);
            baseFilterClauses.push(baseClause);
            params.push(...baseAddrParams);
            const { clause: recClause, params: recAddrParams } = this._communityAddressClause(commentsAlias);
            recursiveFilterClauses.push(recClause);
            params.push(...recAddrParams);
        }
        if (options.excludeCommentPendingApproval) {
            const clause = this._pendingApprovalClause(commentsAlias);
            baseFilterClauses.push(clause);
            recursiveFilterClauses.push(clause);
        }
        if (options.excludeRemovedComments) {
            const clause = this._removedClause(commentUpdatesAlias);
            baseFilterClauses.push(clause);
            recursiveFilterClauses.push(clause);
        }
        if (options.excludeDeletedComments) {
            const clause = this._deletedFromLookupClause(deletedLookupAlias);
            baseFilterClauses.push(clause);
            recursiveFilterClauses.push(clause);
        }
        if (options.excludeCommentWithApprovedFalse) {
            const clause = this._approvedClause(commentUpdatesAlias);
            baseFilterClauses.push(clause);
            recursiveFilterClauses.push(clause);
        }
        baseWhereClausesStr = baseFilterClauses.length > 0 ? `AND ${baseFilterClauses.join(" AND ")}` : "";
        recursiveWhereClausesStr = recursiveFilterClauses.length > 0 ? `AND ${recursiveFilterClauses.join(" AND ")}` : "";

        const query = `
            WITH RECURSIVE comment_tree AS (
                SELECT comments.*, ${commentUpdateCols.map((c) => `c_updates.${c} AS c_updates_${c}`).join(", ")}, 0 AS tree_level 
                FROM ${TABLES.COMMENTS} comments
                INNER JOIN ${TABLES.COMMENT_UPDATES} c_updates ON comments.cid = c_updates.cid
                LEFT JOIN (SELECT cid, json_extract(edit, '$.deleted') AS deleted_flag FROM ${TABLES.COMMENT_UPDATES}) AS d ON comments.cid = d.cid
                WHERE comments.parentCid = ? ${baseWhereClausesStr}
                UNION ALL
                SELECT comments.*, ${commentUpdateCols.map((c) => `c_updates.${c} AS c_updates_${c}`).join(", ")}, tree.tree_level + 1
                FROM ${TABLES.COMMENTS} comments
                INNER JOIN ${TABLES.COMMENT_UPDATES} c_updates ON comments.cid = c_updates.cid
                LEFT JOIN (SELECT cid, json_extract(edit, '$.deleted') AS deleted_flag FROM ${TABLES.COMMENT_UPDATES}) AS d ON comments.cid = d.cid
                INNER JOIN comment_tree tree ON comments.parentCid = tree.cid
                WHERE 1=1 ${recursiveWhereClausesStr}
            )
            SELECT ${mapper.selectList(
                (col) => `comments_alias.${col}`,
                (col) => `comments_alias.c_updates_${col}`
            )}
            FROM comment_tree comments_alias
        `;
        const rows = this._prepareCached(query)
            .raw(true)
            .all(...params) as unknown[][];
        return rows.map(mapper.map);
    }

    queryStoredCommentUpdate(comment: Pick<CommentsTableRow, "cid">): CommentUpdatesRow | undefined {
        const row = this._prepareCached(`SELECT * FROM ${TABLES.COMMENT_UPDATES} WHERE cid = ?`).get(comment.cid) as
            | CommentUpdatesRow
            | undefined;
        if (!row) return undefined;
        return this._parseCommentUpdatesRow(row);
    }

    queryCommentUpdateTimestampBucketReplies(opts: {
        cid: string;
    }): Pick<CommentUpdatesRow, "updatedAt" | "postUpdatesBucket" | "replies"> | undefined {
        const row = this._prepareCached(`SELECT updatedAt, postUpdatesBucket, replies FROM ${TABLES.COMMENT_UPDATES} WHERE cid = ?`).get(
            opts.cid
        ) as { updatedAt: number; postUpdatesBucket: number | null; replies: string | null } | undefined;
        if (!row) return undefined;
        return {
            updatedAt: row.updatedAt,
            postUpdatesBucket: row.postUpdatesBucket ?? undefined,
            replies: typeof row.replies === "string" ? JSON.parse(row.replies) : undefined
        } as Pick<CommentUpdatesRow, "updatedAt" | "postUpdatesBucket" | "replies">;
    }

    queryCommentUpdateBucketAndReplies(opts: { cid: string }): Pick<CommentUpdatesRow, "postUpdatesBucket" | "replies"> | undefined {
        const row = this._prepareCached(`SELECT postUpdatesBucket, replies FROM ${TABLES.COMMENT_UPDATES} WHERE cid = ?`).get(opts.cid) as
            | { postUpdatesBucket: number | null; replies: string | null }
            | undefined;
        if (!row) return undefined;
        return {
            postUpdatesBucket: row.postUpdatesBucket ?? undefined,
            replies: typeof row.replies === "string" ? JSON.parse(row.replies) : undefined
        } as Pick<CommentUpdatesRow, "postUpdatesBucket" | "replies">;
    }

    hasCommentWithSignatureEncoded(signatureEncoded: string): boolean {
        const row = this._db
            .prepare(
                `SELECT 1 FROM ${TABLES.COMMENTS}
                 WHERE json_extract(signature, '$.signature') = ?
                    OR originalCommentSignatureEncoded = ?
                 LIMIT 1`
            )
            .get(signatureEncoded, signatureEncoded);
        return row !== undefined;
    }

    queryCommentBySignatureEncoded(signatureEncoded: string): CommentsTableRow | undefined {
        const row = this._prepareCached(
            `SELECT * FROM ${TABLES.COMMENTS}
                 WHERE json_extract(signature, '$.signature') = ?
                    OR originalCommentSignatureEncoded = ?
                 LIMIT 1`
        ).get(signatureEncoded, signatureEncoded) as CommentsTableRow | undefined;
        if (!row) return undefined;
        return this._parseCommentsTableRow(row);
    }

    hasCommentModerationWithSignatureEncoded(signatureEncoded: string): boolean {
        const row = this._db
            .prepare(`SELECT 1 FROM ${TABLES.COMMENT_MODERATIONS} WHERE json_extract(signature, '$.signature') = ? LIMIT 1`)
            .get(signatureEncoded);
        return row !== undefined;
    }

    hasCommentEditWithSignatureEncoded(signatureEncoded: string): boolean {
        const row = this._db
            .prepare(`SELECT 1 FROM ${TABLES.COMMENT_EDITS} WHERE json_extract(signature, '$.signature') = ? LIMIT 1`)
            .get(signatureEncoded);
        return row !== undefined;
    }

    queryParentsCids(rootComment: Pick<CommentsTableRow, "parentCid">): Pick<CommentsTableRow, "cid">[] {
        if (!rootComment.parentCid) throw Error("Root comment has no parent cid");
        const query = `
            WITH RECURSIVE parent_chain AS (
                SELECT cid, parentCid, 0 AS level FROM ${TABLES.COMMENTS} WHERE cid = ?
                UNION ALL
                SELECT c.cid, c.parentCid, pc.level + 1 FROM ${TABLES.COMMENTS} c JOIN parent_chain pc ON c.cid = pc.parentCid
            ) SELECT cid FROM parent_chain ORDER BY level
        `;
        return this._db.prepare(query).all(rootComment.parentCid) as Pick<CommentsTableRow, "cid">[];
    }

    queryCommentsPendingApproval(): CommentsTableRow[] {
        const results = this._prepareCached(
            `SELECT * FROM ${TABLES.COMMENTS} WHERE pendingApproval = 1 ORDER BY rowid DESC`
        ).all() as CommentsTableRow[];
        return results.map((r) => this._parseCommentsTableRow(r));
    }

    // Windowed reply sorts (settings.pages.replies[].options.maxAge) need a time-based trigger that nothing else
    // provides: a page's membership changes when a reply crosses the window boundary even though no row changed.
    // One arm per distinct window flags a parent only when a reply was inside the window at the parent's last
    // generation (cu.updatedAt) and is outside it now, so a quiet thread costs a range scan and nothing else.
    // Flat sorts filter the whole flattened subtree and are generated for posts only, so their arm walks
    // descendants up to the depth-0 ancestor. Pinned replies bypass the filter when pinnedFirst is true. Omitted
    // entirely (empty strings) when no reply sort is windowed, so the default config pays nothing.
    private _buildWindowedReplySortArms(now: number): { ctes: string; unions: string; params: Record<string, number> } {
        const windowedSorts = (this._community._pageSorts?.replies ?? []).filter((sort) => typeof sort.maxAgeSeconds === "number");
        if (windowedSorts.length === 0) return { ctes: "", unions: "", params: {} };
        const ctes: string[] = [];
        const unions: string[] = [];
        const params: Record<string, number> = { windowNow: now };
        const seen = new Set<string>();
        for (const sort of windowedSorts) {
            const key = `${sort.maxAgeSeconds}:${sort.flat}:${sort.pinnedFirst}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const i = ctes.length;
            params[`windowMaxAge${i}`] = sort.maxAgeSeconds!;
            const pinnedClause = sort.pinnedFirst ? `AND (rcu.pinned IS NULL OR rcu.pinned != 1)` : "";
            const crossingClause = `r_ts >= cu_anc.updatedAt - :windowMaxAge${i} AND r_ts < :windowNow - :windowMaxAge${i}`;
            if (sort.flat)
                ctes.push(`
            windowed_flat_${i}_ancestors AS (
                SELECT r.cid AS reply_cid, r.timestamp AS r_ts, r.parentCid AS anc_cid FROM ${TABLES.COMMENTS} r WHERE r.parentCid IS NOT NULL
                UNION ALL
                SELECT wa.reply_cid, wa.r_ts, p.parentCid FROM windowed_flat_${i}_ancestors wa
                JOIN ${TABLES.COMMENTS} p ON p.cid = wa.anc_cid WHERE p.parentCid IS NOT NULL
            ),
            windowed_${i} AS (
                SELECT DISTINCT wa.anc_cid AS cid
                FROM windowed_flat_${i}_ancestors wa
                JOIN ${TABLES.COMMENTS} anc ON anc.cid = wa.anc_cid AND anc.depth = 0
                JOIN ${TABLES.COMMENT_UPDATES} cu_anc ON cu_anc.cid = wa.anc_cid
                LEFT JOIN ${TABLES.COMMENT_UPDATES} rcu ON rcu.cid = wa.reply_cid
                WHERE ${crossingClause} ${pinnedClause}
            ),`);
            else
                ctes.push(`
            windowed_${i} AS (
                SELECT DISTINCT r.parentCid AS cid
                FROM (SELECT cid, parentCid, timestamp AS r_ts FROM ${TABLES.COMMENTS} WHERE parentCid IS NOT NULL) r
                JOIN ${TABLES.COMMENT_UPDATES} cu_anc ON cu_anc.cid = r.parentCid
                LEFT JOIN ${TABLES.COMMENT_UPDATES} rcu ON rcu.cid = r.cid
                WHERE ${crossingClause} ${pinnedClause}
            ),`);
            unions.push(`UNION SELECT c.* FROM ${TABLES.COMMENTS} c JOIN windowed_${i} w${i} ON c.cid = w${i}.cid`);
        }
        return { ctes: ctes.join(""), unions: unions.join("\n                "), params };
    }

    queryCommentsToBeUpdated(): CommentsTableRow[] {
        // TODO optimize this query in the future
        // Make sure tests in commentsToUpdate.db.community.test.js are passing
        const windowed = this._buildWindowedReplySortArms(timestamp());
        const query = `
            WITH RECURSIVE 
            direct_updates AS (
                SELECT c.* FROM ${TABLES.COMMENTS} c LEFT JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid
                WHERE (c.pendingApproval IS NULL OR c.pendingApproval != 1)
                AND (cu.cid IS NULL OR (cu.publishedToPostUpdatesMFS = 0 OR cu.publishedToPostUpdatesMFS IS FALSE))
                UNION
                SELECT c.* FROM ${TABLES.COMMENTS} c JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid
                WHERE (c.pendingApproval IS NULL OR c.pendingApproval != 1)
                AND (
                    EXISTS (SELECT 1 FROM ${TABLES.VOTES} v WHERE v.commentCid = c.cid AND v.insertedAt >= cu.insertedAt)
                    OR EXISTS (SELECT 1 FROM ${TABLES.COMMENT_EDITS} ce WHERE ce.commentCid = c.cid AND ce.insertedAt >= cu.insertedAt)
                    OR EXISTS (SELECT 1 FROM ${TABLES.COMMENT_MODERATIONS} cm WHERE cm.commentCid = c.cid AND cm.insertedAt >= cu.insertedAt)
                    OR EXISTS (SELECT 1 FROM ${TABLES.COMMENTS} cc WHERE cc.parentCid = c.cid AND cc.insertedAt >= cu.insertedAt)
                  )
            ),
            child_counts AS (
                SELECT 
                    c.parentCid AS cid,
                    COUNT(*) AS actual_child_count
                FROM ${TABLES.COMMENTS} c
                JOIN ${TABLES.COMMENT_UPDATES} cu_child ON c.cid = cu_child.cid
                LEFT JOIN (
                    SELECT cid, json_extract(edit, '$.deleted') AS deleted_flag FROM ${TABLES.COMMENT_UPDATES}
                ) deleted_lookup ON deleted_lookup.cid = c.cid
                WHERE c.parentCid IS NOT NULL
                  AND (c.pendingApproval IS NULL OR c.pendingApproval != 1)
                  AND (cu_child.removed IS NOT 1 AND cu_child.removed IS NOT TRUE)
                  AND (deleted_lookup.deleted_flag IS NULL OR deleted_lookup.deleted_flag != 1)
                GROUP BY c.parentCid
            ),
            filtered_children AS (
                SELECT
                    c.parentCid AS cid,
                    c.cid AS child_cid,
                    ROW_NUMBER() OVER (PARTITION BY c.parentCid ORDER BY c.rowid DESC) AS child_rank
                FROM ${TABLES.COMMENTS} c
                JOIN ${TABLES.COMMENT_UPDATES} cu_child ON c.cid = cu_child.cid
                LEFT JOIN (
                    SELECT cid, json_extract(edit, '$.deleted') AS deleted_flag FROM ${TABLES.COMMENT_UPDATES}
                ) deleted_lookup ON deleted_lookup.cid = c.cid
                WHERE c.parentCid IS NOT NULL
                  AND (c.pendingApproval IS NULL OR c.pendingApproval != 1)
                  AND (cu_child.removed IS NOT 1 AND cu_child.removed IS NOT TRUE)
                  AND (deleted_lookup.deleted_flag IS NULL OR deleted_lookup.deleted_flag != 1)
                  AND COALESCE(cu_child.approved, 1) != 0
            ),
            last_child_cids AS (
                SELECT cid, child_cid AS actual_last_child_cid
                FROM filtered_children
                WHERE child_rank = 1
            ),
            stale_child_counts AS (
                SELECT parent.cid
                FROM ${TABLES.COMMENTS} parent
                JOIN ${TABLES.COMMENT_UPDATES} cu_parent ON parent.cid = cu_parent.cid
                LEFT JOIN child_counts cc ON cc.cid = parent.cid
                WHERE (parent.pendingApproval IS NULL OR parent.pendingApproval != 1)
                  AND COALESCE(cc.actual_child_count, 0) != COALESCE(cu_parent.childCount, 0)
            ),
            stale_last_child_cids AS (
                SELECT parent.cid
                FROM ${TABLES.COMMENTS} parent
                JOIN ${TABLES.COMMENT_UPDATES} cu_parent ON parent.cid = cu_parent.cid
                LEFT JOIN last_child_cids lc ON lc.cid = parent.cid
                WHERE (parent.pendingApproval IS NULL OR parent.pendingApproval != 1)
                  AND COALESCE(lc.actual_last_child_cid, '') != COALESCE(cu_parent.lastChildCid, '')
            ),
            stale_replies AS (
                SELECT DISTINCT cu_parent.cid
                FROM ${TABLES.COMMENT_UPDATES} cu_parent
                CROSS JOIN json_each(cu_parent.replies) sort_entry
                CROSS JOIN json_each(json_extract(sort_entry.value, '$.commentCids')) child_ref
                JOIN ${TABLES.COMMENT_UPDATES} cu_child ON cu_child.cid = child_ref.value
                WHERE cu_parent.replies IS NOT NULL
                  AND json_type(sort_entry.value, '$.commentCids') = 'array'
                  -- Compare against the parent's updatedAt, not its insertedAt (issue #230). insertedAt is
                  -- the batch's start timestamp, shared by every row the batch writes (issue #209/#211),
                  -- while updatedAt is stamped when that row is actually calculated. A batch walks a post
                  -- tree deepest-depth-first, so a child is always calculated before its parent and its
                  -- updatedAt lands after the batch's start: comparing against insertedAt re-flagged every
                  -- parent of any batch spanning >= 1 second, which produced another such batch, and the
                  -- update loop never converged. updatedAt is when the parent's replies page was actually
                  -- generated, which is the point the child's data could have gone stale relative to.
                  AND cu_child.updatedAt > cu_parent.updatedAt
            ),
            ${windowed.ctes}base_updates AS (
                SELECT * FROM direct_updates
                UNION SELECT c.* FROM ${TABLES.COMMENTS} c JOIN stale_child_counts scc ON c.cid = scc.cid
                UNION SELECT c.* FROM ${TABLES.COMMENTS} c JOIN stale_last_child_cids slc ON c.cid = slc.cid
                UNION SELECT c.* FROM ${TABLES.COMMENTS} c JOIN stale_replies sr ON c.cid = sr.cid
                ${windowed.unions}
            ),
            authors_to_update AS (SELECT DISTINCT authorSignerAddress FROM base_updates),
            author_comments AS (
                SELECT c.* FROM ${TABLES.COMMENTS} c JOIN authors_to_update a ON c.authorSignerAddress = a.authorSignerAddress
                WHERE (c.pendingApproval IS NULL OR c.pendingApproval != 1)
            ),
            comments_needing_update AS (
                SELECT * FROM base_updates
                UNION SELECT * FROM author_comments
            ),
            parent_chain AS (
                SELECT DISTINCT p.* FROM ${TABLES.COMMENTS} p JOIN comments_needing_update cnu ON p.cid = cnu.parentCid
                WHERE p.cid IS NOT NULL AND (p.pendingApproval IS NULL OR p.pendingApproval != 1)
                UNION
                SELECT DISTINCT p.* FROM ${TABLES.COMMENTS} p JOIN parent_chain pc ON p.cid = pc.parentCid
                WHERE p.cid IS NOT NULL AND (p.pendingApproval IS NULL OR p.pendingApproval != 1)
            ),
            all_updates AS (
                SELECT cid FROM comments_needing_update UNION SELECT cid FROM parent_chain
            )
            SELECT c.* FROM ${TABLES.COMMENTS} c JOIN all_updates au ON c.cid = au.cid
            WHERE (c.pendingApproval IS NULL OR c.pendingApproval != 1)
            ORDER BY c.rowid
        `;
        const results = this._prepareCached(query).all(windowed.params) as CommentsTableRow[];
        return results.map((r) => this._parseCommentsTableRow(r));
    }

    queryCommunityStats(): CommunityStats {
        // if you change this logic, make sure to run stats.community.test.js
        const now = timestamp(); // All timestamps are in seconds
        const { clause: commentAddrClause, params: commentAddrParams } = this._communityAddressClauseNamed("comments", "statsComments");
        const { clause: votesAddrClause, params: votesAddrParams } = this._communityAddressClauseNamed("comments_for_votes", "statsVotes");
        const removedCommentsClause = this._removedClause("cu_comments");
        const deletedCommentsClause = this._deletedFromUpdatesClause("cu_comments");
        const removedVotesClause = this._removedClause("cu_votes");
        const deletedVotesClause = this._deletedFromUpdatesClause("cu_votes");
        const pendingCommentsClause = this._pendingApprovalClause("comments");
        type PostAndReplyCounts = Pick<
            CommunityStats,
            | "hourPostCount"
            | "dayPostCount"
            | "weekPostCount"
            | "monthPostCount"
            | "yearPostCount"
            | "allPostCount"
            | "hourReplyCount"
            | "dayReplyCount"
            | "weekReplyCount"
            | "monthReplyCount"
            | "yearReplyCount"
            | "allReplyCount"
        >;
        const postAndReplyCountsQuery = `
            SELECT
                COALESCE(SUM(CASE WHEN comments.depth = 0 AND comments.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.HOUR} THEN 1 ELSE 0 END), 0) AS hourPostCount,
                COALESCE(SUM(CASE WHEN comments.depth = 0 AND comments.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.DAY} THEN 1 ELSE 0 END), 0) AS dayPostCount,
                COALESCE(SUM(CASE WHEN comments.depth = 0 AND comments.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.WEEK} THEN 1 ELSE 0 END), 0) AS weekPostCount,
                COALESCE(SUM(CASE WHEN comments.depth = 0 AND comments.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.MONTH} THEN 1 ELSE 0 END), 0) AS monthPostCount,
                COALESCE(SUM(CASE WHEN comments.depth = 0 AND comments.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.YEAR} THEN 1 ELSE 0 END), 0) AS yearPostCount,
                COALESCE(SUM(CASE WHEN comments.depth = 0 THEN 1 ELSE 0 END), 0) AS allPostCount,
                COALESCE(SUM(CASE WHEN comments.depth > 0 AND comments.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.HOUR} THEN 1 ELSE 0 END), 0) AS hourReplyCount,
                COALESCE(SUM(CASE WHEN comments.depth > 0 AND comments.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.DAY} THEN 1 ELSE 0 END), 0) AS dayReplyCount,
                COALESCE(SUM(CASE WHEN comments.depth > 0 AND comments.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.WEEK} THEN 1 ELSE 0 END), 0) AS weekReplyCount,
                COALESCE(SUM(CASE WHEN comments.depth > 0 AND comments.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.MONTH} THEN 1 ELSE 0 END), 0) AS monthReplyCount,
                COALESCE(SUM(CASE WHEN comments.depth > 0 AND comments.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.YEAR} THEN 1 ELSE 0 END), 0) AS yearReplyCount,
                COALESCE(SUM(CASE WHEN comments.depth > 0 THEN 1 ELSE 0 END), 0) AS allReplyCount
            FROM ${TABLES.COMMENTS} AS comments
            LEFT JOIN ${TABLES.COMMENT_UPDATES} AS cu_comments ON cu_comments.cid = comments.cid
            WHERE ${commentAddrClause}
              AND ${removedCommentsClause}
              AND ${deletedCommentsClause}
              AND ${pendingCommentsClause}
        `;
        const postAndReplyCounts = this._db.prepare(postAndReplyCountsQuery).get(commentAddrParams) as PostAndReplyCounts;

        type ActiveIdentityRow = {
            authorSignerAddress: string;
            hourActive: number;
            dayActive: number;
            weekActive: number;
            monthActive: number;
            yearActive: number;
        };
        const activeIdentityRowsQuery = `
            SELECT
                activity.authorSignerAddress AS authorSignerAddress,
                MAX(activity.hour_active) AS hourActive,
                MAX(activity.day_active) AS dayActive,
                MAX(activity.week_active) AS weekActive,
                MAX(activity.month_active) AS monthActive,
                MAX(activity.year_active) AS yearActive
            FROM (
                SELECT
                    comments.authorSignerAddress,
                    CASE WHEN comments.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.HOUR} THEN 1 ELSE 0 END AS hour_active,
                    CASE WHEN comments.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.DAY} THEN 1 ELSE 0 END AS day_active,
                    CASE WHEN comments.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.WEEK} THEN 1 ELSE 0 END AS week_active,
                    CASE WHEN comments.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.MONTH} THEN 1 ELSE 0 END AS month_active,
                    CASE WHEN comments.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.YEAR} THEN 1 ELSE 0 END AS year_active
                FROM ${TABLES.COMMENTS} AS comments
                LEFT JOIN ${TABLES.COMMENT_UPDATES} AS cu_comments ON cu_comments.cid = comments.cid
                WHERE ${commentAddrClause}
                  AND ${removedCommentsClause}
                  AND ${deletedCommentsClause}
                  AND ${pendingCommentsClause}
                UNION ALL
                SELECT
                    votes.authorSignerAddress,
                    CASE WHEN votes.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.HOUR} THEN 1 ELSE 0 END AS hour_active,
                    CASE WHEN votes.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.DAY} THEN 1 ELSE 0 END AS day_active,
                    CASE WHEN votes.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.WEEK} THEN 1 ELSE 0 END AS week_active,
                    CASE WHEN votes.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.MONTH} THEN 1 ELSE 0 END AS month_active,
                    CASE WHEN votes.timestamp >= ${now - TIMEFRAMES_TO_SECONDS.YEAR} THEN 1 ELSE 0 END AS year_active
                FROM ${TABLES.VOTES} AS votes
                INNER JOIN ${TABLES.COMMENTS} AS comments_for_votes ON comments_for_votes.cid = votes.commentCid
                LEFT JOIN ${TABLES.COMMENT_UPDATES} AS cu_votes ON cu_votes.cid = comments_for_votes.cid
                WHERE ${votesAddrClause}
                  AND ${removedVotesClause}
                  AND ${deletedVotesClause}
            ) AS activity
            GROUP BY activity.authorSignerAddress
        `;
        const activeIdentityRows = this._db
            .prepare(activeIdentityRowsQuery)
            .all({ ...commentAddrParams, ...votesAddrParams }) as ActiveIdentityRow[];

        type CanonicalActivity = Omit<ActiveIdentityRow, "authorSignerAddress">;
        const canonicalAddressesByAlias = new Map<string, string>();
        if (activeIdentityRows.length > 0) {
            const uniqueActiveAddresses = [...new Set(activeIdentityRows.map((row) => row.authorSignerAddress))];
            const aliasPlaceholders = uniqueActiveAddresses.map(() => "?").join(", ");
            const aliasesQuery = `
                SELECT DISTINCT
                    comments.authorSignerAddress AS aliasSignerAddress,
                    alias.originalAuthorPublicKey AS originalAuthorPublicKey
                FROM ${TABLES.PSEUDONYMITY_ALIASES} AS alias
                INNER JOIN ${TABLES.COMMENTS} AS comments ON comments.cid = alias.commentCid
                WHERE comments.authorSignerAddress IN (${aliasPlaceholders})
            `;
            const aliasRows = this._db.prepare(aliasesQuery).all(...uniqueActiveAddresses) as {
                aliasSignerAddress: string;
                originalAuthorPublicKey: string;
            }[];
            for (const aliasRow of aliasRows) {
                let originalAuthorAddress: string;
                try {
                    originalAuthorAddress = getPKCAddressFromPublicKeySync(aliasRow.originalAuthorPublicKey);
                } catch {
                    throw new Error(`Failed to resolve original author address for alias signer address ${aliasRow.aliasSignerAddress}`);
                }
                const existingCanonicalAddress = canonicalAddressesByAlias.get(aliasRow.aliasSignerAddress);
                if (existingCanonicalAddress && existingCanonicalAddress !== originalAuthorAddress) {
                    throw new Error(`Inconsistent pseudonymity alias mappings for signer address ${aliasRow.aliasSignerAddress}`);
                }
                canonicalAddressesByAlias.set(aliasRow.aliasSignerAddress, originalAuthorAddress);
            }
        }

        const canonicalActivityByAddress = new Map<string, CanonicalActivity>();
        for (const activeIdentityRow of activeIdentityRows) {
            const canonicalAddress =
                canonicalAddressesByAlias.get(activeIdentityRow.authorSignerAddress) || activeIdentityRow.authorSignerAddress;
            const existing = canonicalActivityByAddress.get(canonicalAddress);
            if (!existing) {
                canonicalActivityByAddress.set(canonicalAddress, {
                    hourActive: activeIdentityRow.hourActive,
                    dayActive: activeIdentityRow.dayActive,
                    weekActive: activeIdentityRow.weekActive,
                    monthActive: activeIdentityRow.monthActive,
                    yearActive: activeIdentityRow.yearActive
                });
                continue;
            }
            existing.hourActive = Math.max(existing.hourActive, activeIdentityRow.hourActive);
            existing.dayActive = Math.max(existing.dayActive, activeIdentityRow.dayActive);
            existing.weekActive = Math.max(existing.weekActive, activeIdentityRow.weekActive);
            existing.monthActive = Math.max(existing.monthActive, activeIdentityRow.monthActive);
            existing.yearActive = Math.max(existing.yearActive, activeIdentityRow.yearActive);
        }

        const activeUserCounts: Pick<
            CommunityStats,
            | "hourActiveUserCount"
            | "dayActiveUserCount"
            | "weekActiveUserCount"
            | "monthActiveUserCount"
            | "yearActiveUserCount"
            | "allActiveUserCount"
        > = {
            hourActiveUserCount: 0,
            dayActiveUserCount: 0,
            weekActiveUserCount: 0,
            monthActiveUserCount: 0,
            yearActiveUserCount: 0,
            allActiveUserCount: canonicalActivityByAddress.size
        };
        for (const canonicalActivity of canonicalActivityByAddress.values()) {
            if (canonicalActivity.hourActive > 0) activeUserCounts.hourActiveUserCount++;
            if (canonicalActivity.dayActive > 0) activeUserCounts.dayActiveUserCount++;
            if (canonicalActivity.weekActive > 0) activeUserCounts.weekActiveUserCount++;
            if (canonicalActivity.monthActive > 0) activeUserCounts.monthActiveUserCount++;
            if (canonicalActivity.yearActive > 0) activeUserCounts.yearActiveUserCount++;
        }

        return {
            ...activeUserCounts,
            ...postAndReplyCounts
        };
    }

    queryCommentsUnderComment(parentCid: string | null): CommentsTableRow[] {
        const results = this._db.prepare(`SELECT * FROM ${TABLES.COMMENTS} WHERE parentCid = ?`).all(parentCid) as CommentsTableRow[];
        return results.map((r) => this._parseCommentsTableRow(r));
    }

    queryFirstCommentWithDepth(commentDepth: number): CommentsTableRow | undefined {
        if (!Number.isInteger(commentDepth) || commentDepth < 0) throw new Error("commentDepth must be a non-negative integer");
        const { clause: addrClause, params: addrParams } = this._communityAddressClauseNamed("c", "firstComment");
        const exactDepthRow = this._db
            .prepare(
                `SELECT c.* FROM ${TABLES.COMMENTS} c
                 LEFT JOIN ${TABLES.COMMENT_UPDATES} cu ON cu.cid = c.cid
                 WHERE ${addrClause}
                   AND c.depth = @commentDepth
                 ORDER BY COALESCE(cu.replyCount, 0) DESC
                 LIMIT 1`
            )
            .get({ ...addrParams, commentDepth }) as CommentsTableRow | undefined;
        if (exactDepthRow) return this._parseCommentsTableRow(exactDepthRow);

        const lowerDepthRow = this._db
            .prepare(
                `SELECT c.* FROM ${TABLES.COMMENTS} c
                 LEFT JOIN ${TABLES.COMMENT_UPDATES} cu ON cu.cid = c.cid
                 WHERE ${addrClause}
                   AND c.depth < @commentDepth
                 ORDER BY c.depth DESC, COALESCE(cu.replyCount, 0) DESC
                 LIMIT 1`
            )
            .get({ ...addrParams, commentDepth }) as CommentsTableRow | undefined;
        if (!lowerDepthRow) return undefined;
        return this._parseCommentsTableRow(lowerDepthRow);
    }

    queryCombinedHashOfPendingComments(): string {
        const rows = this._db.prepare(`SELECT cid FROM ${TABLES.COMMENTS} WHERE pendingApproval = 1 ORDER BY rowid ASC`).all() as {
            cid: string;
        }[];

        const concatenated = rows.map((r) => r.cid).join("");
        const hash = sha256(concatenated);
        return hash;
    }

    queryComment(cid: string): CommentsTableRow | undefined {
        const row = this._prepareCached(`SELECT * FROM ${TABLES.COMMENTS} WHERE cid = ?`).get(cid) as CommentsTableRow | undefined;
        if (!row) return undefined;
        return this._parseCommentsTableRow(row);
    }

    commentExistsInDb(cid: string): boolean {
        return this._prepareCached(`SELECT 1 FROM ${TABLES.COMMENTS} WHERE cid = ? LIMIT 1`).get(cid) !== undefined;
    }

    queryPseudonymityAliasByCommentCid(commentCid: string): PseudonymityAliasRow | undefined {
        const row = this._prepareCached(
            `SELECT commentCid, aliasPrivateKey, originalAuthorPublicKey, originalAuthorName, mode, insertedAt FROM ${TABLES.PSEUDONYMITY_ALIASES} WHERE commentCid = ?`
        ).get(commentCid) as PseudonymityAliasRow | undefined;
        return row;
    }

    queryPseudonymityAliasForPost(originalAuthorPublicKey: string, postCid: string): PseudonymityAliasRow | undefined {
        const row = this._db
            .prepare(
                `
            SELECT alias.commentCid, alias.aliasPrivateKey, alias.originalAuthorPublicKey, alias.originalAuthorName, alias.mode, alias.insertedAt
            FROM ${TABLES.PSEUDONYMITY_ALIASES} AS alias
            INNER JOIN ${TABLES.COMMENTS} AS comments ON comments.cid = alias.commentCid
            WHERE alias.mode = 'per-post' AND alias.originalAuthorPublicKey = ? AND comments.postCid = ?
            ORDER BY alias.insertedAt ASC
            LIMIT 1
        `
            )
            .get(originalAuthorPublicKey, postCid) as PseudonymityAliasRow | undefined;
        return row;
    }

    queryPseudonymityAliasForAuthor(originalAuthorPublicKey: string): PseudonymityAliasRow | undefined {
        const row = this._db
            .prepare(
                `
            SELECT commentCid, aliasPrivateKey, originalAuthorPublicKey, originalAuthorName, mode, insertedAt
            FROM ${TABLES.PSEUDONYMITY_ALIASES}
            WHERE mode = 'per-author' AND originalAuthorPublicKey = ?
            ORDER BY insertedAt ASC
            LIMIT 1
        `
            )
            .get(originalAuthorPublicKey) as PseudonymityAliasRow | undefined;
        return row;
    }

    private _queryCommentAuthorAndParentWithoutParsing(cid: string):
        | {
              authorSignerAddress?: string;
              parentCid?: string | null;
          }
        | undefined {
        const row = this._db.prepare(`SELECT authorSignerAddress, parentCid FROM ${TABLES.COMMENTS} WHERE cid = ?`).get(cid) as
            | { authorSignerAddress?: unknown; parentCid?: unknown }
            | undefined;
        if (!row) return undefined;

        const authorSignerAddress = typeof row.authorSignerAddress === "string" ? row.authorSignerAddress : undefined;
        const parentCid = typeof row.parentCid === "string" ? row.parentCid : row.parentCid === null ? null : undefined;

        return { authorSignerAddress, parentCid };
    }

    queryPostsWithOutdatedBuckets(buckets: number[]): { cid: string; timestamp: number; currentBucket: number; newBucket: number }[] {
        const currentTimestampSeconds = timestamp(); // timestamp is in seconds
        const maxBucket = Math.max(...buckets);
        const caseClauses = buckets
            .sort((a, b) => a - b)
            .map((bucket) => `WHEN (${currentTimestampSeconds} - c.timestamp) <= ${bucket} THEN ${bucket}`)
            .join(" ");
        const { clause: addrClause, params: addrParams } = this._communityAddressClause("c");
        const query = `
            WITH post_data AS (
                SELECT c.cid, c.timestamp, cu.postUpdatesBucket AS current_bucket,
                    CASE ${caseClauses} ELSE ${maxBucket} END AS new_bucket
                FROM ${TABLES.COMMENTS} as c INNER JOIN ${TABLES.COMMENT_UPDATES} as cu ON c.cid = cu.cid
                WHERE ${addrClause}
                  AND (c.pendingApproval IS NULL OR c.pendingApproval != 1)
                  AND cu.postUpdatesBucket IS NOT NULL AND cu.postUpdatesBucket != ?
            ) SELECT cid, timestamp, current_bucket AS currentBucket, new_bucket AS newBucket
            FROM post_data WHERE current_bucket != new_bucket
        `;
        return this._prepareCached(query).all(...addrParams, maxBucket) as {
            cid: string;
            timestamp: number;
            currentBucket: number;
            newBucket: number;
        }[];
    }

    removeCommentFromPendingApproval(comment: Pick<CommentsTableRow, "cid">): void {
        const log = Logger("pkc-js:local-community:db-handler:removeCommentFromPendingApproval");
        const stmt = this._db.prepare(`UPDATE ${TABLES.COMMENTS} SET pendingApproval = 0 WHERE cid = ?`);
        const res = stmt.run(comment.cid);
        log.trace(`Removed pendingApproval for cid=${comment.cid}, changes=${res.changes}`);
    }

    approvePendingComment(comment: Pick<CommentsTableRow, "cid">): { number?: number; postNumber?: number } {
        const log = Logger("pkc-js:local-community:db-handler:approvePendingComment");
        const assignNumbers = this._db.transaction((commentCid: string) => {
            this._db.prepare(`UPDATE ${TABLES.COMMENTS} SET pendingApproval = 0 WHERE cid = ?`).run(commentCid);
            return this._assignNumbersForComment(commentCid);
        });
        const numbers = assignNumbers(comment.cid);
        log.trace(`Approved pending comment cid=${comment.cid}`, numbers);
        return numbers;
    }

    getNextCommentNumbers(depth: number): { number: number; postNumber?: number } {
        const pendingClause = this._pendingApprovalClause("c");
        const maxNumberRow = this._db
            .prepare(`SELECT COALESCE(MAX(number), 0) AS maxNumber FROM ${TABLES.COMMENTS} c WHERE number IS NOT NULL AND ${pendingClause}`)
            .get() as { maxNumber: number } | undefined;
        const number = (maxNumberRow?.maxNumber || 0) + 1;

        if (depth !== 0) return { number };

        const maxPostNumberRow = this._db
            .prepare(
                `SELECT COALESCE(MAX(postNumber), 0) AS maxPostNumber FROM ${TABLES.COMMENTS} c WHERE postNumber IS NOT NULL AND depth = 0 AND ${pendingClause}`
            )
            .get() as { maxPostNumber: number } | undefined;
        const postNumber = (maxPostNumberRow?.maxPostNumber || 0) + 1;

        return { number, postNumber };
    }

    _assignNumbersForComment(commentCid: string): { number?: number; postNumber?: number } {
        const commentRow = this._db
            .prepare(`SELECT depth, pendingApproval, number, postNumber FROM ${TABLES.COMMENTS} WHERE cid = ? LIMIT 1`)
            .get(commentCid) as
            | { depth: number; pendingApproval: number | null; number: number | null; postNumber: number | null }
            | undefined;

        if (!commentRow) throw Error(`Failed to query comment row for ${commentCid}`);
        if (commentRow.pendingApproval === 1) return {};
        if (typeof commentRow.number === "number" && commentRow.number > 0) {
            return {
                number: commentRow.number,
                ...(typeof commentRow.postNumber === "number" && commentRow.postNumber > 0 ? { postNumber: commentRow.postNumber } : {})
            };
        }

        const pendingClause = this._pendingApprovalClause("c");
        const maxNumberRow = this._db
            .prepare(`SELECT COALESCE(MAX(number), 0) AS maxNumber FROM ${TABLES.COMMENTS} c WHERE number IS NOT NULL AND ${pendingClause}`)
            .get() as { maxNumber: number } | undefined;
        const number = (maxNumberRow?.maxNumber || 0) + 1;

        let postNumber: number | undefined;
        if (commentRow.depth === 0) {
            const maxPostNumberRow = this._db
                .prepare(
                    `SELECT COALESCE(MAX(postNumber), 0) AS maxPostNumber FROM ${TABLES.COMMENTS} c WHERE postNumber IS NOT NULL AND depth = 0 AND ${pendingClause}`
                )
                .get() as { maxPostNumber: number } | undefined;
            postNumber = (maxPostNumberRow?.maxPostNumber || 0) + 1;
        }

        this._db
            .prepare(`UPDATE ${TABLES.COMMENTS} SET number = ?, postNumber = ? WHERE cid = ?`)
            .run(number, postNumber ?? null, commentCid);

        return { number, ...(postNumber !== undefined ? { postNumber } : {}) };
    }

    // Remove oldest comments pending approval when exceeding the configured limit
    removeOldestPendingCommentIfWeHitMaxPendingCount(maxPendingApprovalCount: number): void {
        const log = Logger("pkc-js:local-community:db-handler:removeOldestPendingCommentIfWeHitMaxPendingCount");

        // Assume maxPendingApprovalCount is a valid integer > 0
        try {
            const { cnt } = this._db.prepare(`SELECT COUNT(1) as cnt FROM ${TABLES.COMMENTS} WHERE pendingApproval = 1`).get() as {
                cnt: number;
            };

            if (cnt <= maxPendingApprovalCount) return;

            const toRemove = cnt - maxPendingApprovalCount;
            const oldest = this._db
                .prepare(`SELECT cid FROM ${TABLES.COMMENTS} WHERE pendingApproval = 1 ORDER BY rowid ASC LIMIT ?`)
                .all(toRemove) as { cid: string }[];

            if (oldest.length === 0) return;

            log(`Evicting ${oldest.length} oldest pending comments (count=${cnt}, limit=${maxPendingApprovalCount})`);

            this.createTransaction();
            try {
                for (const { cid } of oldest) this.purgeComment(cid);
                this.commitTransaction();
            } catch (e) {
                this.rollbackTransaction();
                throw e;
            }
        } catch (e) {
            log.error("Failed to enforce maxPendingApprovalCount", e);
        }
    }

    purgeDisapprovedCommentsOlderThan(
        retentionSeconds: number
    ): { cid: string; parentCid?: string | null; postUpdatesBucket?: number; purgedTableRows: PurgedCommentTableRows[] }[] | undefined {
        const log = Logger("pkc-js:local-community:db-handler:purgeDisapprovedCommentsOlderThan");
        if (!Number.isFinite(retentionSeconds) || retentionSeconds <= 0) return;

        const now = timestamp();
        const cutoffTimestamp = now - retentionSeconds;

        const rows = this._db
            .prepare(
                `
            WITH first_disapproved AS (
                SELECT commentCid AS cid,
                       MIN(timestamp) AS first_disapproved_at
                FROM ${TABLES.COMMENT_MODERATIONS}
                WHERE json_type(commentModeration, '$.approved') = 'false'
                GROUP BY commentCid
            )
            SELECT c.cid AS cid,
                   c.parentCid AS parentCid,
                   COALESCE(fd.first_disapproved_at, cu.updatedAt) AS firstDisapprovedAt,
                   cu.postUpdatesBucket AS postUpdatesBucket
            FROM ${TABLES.COMMENT_UPDATES} cu
            INNER JOIN ${TABLES.COMMENTS} c ON c.cid = cu.cid
            LEFT JOIN first_disapproved fd ON fd.cid = cu.cid
            WHERE (COALESCE(cu.approved, 1) = 0 OR cu.approved = 'false')
              AND COALESCE(fd.first_disapproved_at, cu.updatedAt) <= ?
        `
            )
            .all(cutoffTimestamp) as { cid: string; parentCid?: string | null; postUpdatesBucket: number | null }[];

        if (rows.length === 0) return;

        log(`Purging ${rows.length} disapproved comments older than ${retentionSeconds} seconds (cutoff ${cutoffTimestamp}).`);

        const purgedDetails: {
            cid: string;
            parentCid?: string | null;
            postUpdatesBucket?: number;
            purgedTableRows: PurgedCommentTableRows[];
        }[] = [];
        for (const row of rows) {
            const purgedTableRows = this.purgeComment(row.cid);
            purgedDetails.push({
                cid: row.cid,
                parentCid: row.parentCid,
                postUpdatesBucket: row.postUpdatesBucket || undefined,
                purgedTableRows
            });
        }
        return purgedDetails;
    }

    queryCommentFlagsSetByMod(cid: string): Pick<CommentUpdateType, "spoiler" | "pinned" | "locked" | "archived" | "removed" | "nsfw"> {
        const query = `
            WITH flags_with_rank AS (
                SELECT commentCid,
                    json_extract(commentModeration, '$.spoiler') AS spoiler, json_extract(commentModeration, '$.pinned') AS pinned,
                    json_extract(commentModeration, '$.locked') AS locked, json_extract(commentModeration, '$.archived') AS archived,
                    json_extract(commentModeration, '$.removed') AS removed,
                    json_extract(commentModeration, '$.nsfw') AS nsfw,
                    ROW_NUMBER() OVER (PARTITION BY commentCid, CASE WHEN json_extract(commentModeration, '$.spoiler') IS NOT NULL THEN 'spoiler' ELSE NULL END ORDER BY rowid DESC) AS spoiler_rank,
                    ROW_NUMBER() OVER (PARTITION BY commentCid, CASE WHEN json_extract(commentModeration, '$.pinned') IS NOT NULL THEN 'pinned' ELSE NULL END ORDER BY rowid DESC) AS pinned_rank,
                    ROW_NUMBER() OVER (PARTITION BY commentCid, CASE WHEN json_extract(commentModeration, '$.locked') IS NOT NULL THEN 'locked' ELSE NULL END ORDER BY rowid DESC) AS locked_rank,
                    ROW_NUMBER() OVER (PARTITION BY commentCid, CASE WHEN json_extract(commentModeration, '$.archived') IS NOT NULL THEN 'archived' ELSE NULL END ORDER BY rowid DESC) AS archived_rank,
                    ROW_NUMBER() OVER (PARTITION BY commentCid, CASE WHEN json_extract(commentModeration, '$.removed') IS NOT NULL THEN 'removed' ELSE NULL END ORDER BY rowid DESC) AS removed_rank,
                    ROW_NUMBER() OVER (PARTITION BY commentCid, CASE WHEN json_extract(commentModeration, '$.nsfw') IS NOT NULL THEN 'nsfw' ELSE NULL END ORDER BY rowid DESC) AS nsfw_rank
                FROM ${TABLES.COMMENT_MODERATIONS} WHERE commentCid = ?
            )
            SELECT
                MAX(CASE WHEN spoiler IS NOT NULL AND spoiler_rank = 1 THEN spoiler ELSE NULL END) AS spoiler,
                MAX(CASE WHEN pinned IS NOT NULL AND pinned_rank = 1 THEN pinned ELSE NULL END) AS pinned,
                MAX(CASE WHEN locked IS NOT NULL AND locked_rank = 1 THEN locked ELSE NULL END) AS locked,
                MAX(CASE WHEN archived IS NOT NULL AND archived_rank = 1 THEN archived ELSE NULL END) AS archived,
                MAX(CASE WHEN removed IS NOT NULL AND removed_rank = 1 THEN removed ELSE NULL END) AS removed,
                MAX(CASE WHEN nsfw IS NOT NULL AND nsfw_rank = 1 THEN nsfw ELSE NULL END) AS nsfw
            FROM flags_with_rank
        `;
        const flags = this._prepareCached(query).get(cid) as
            | Record<keyof Pick<CommentUpdateType, "spoiler" | "pinned" | "locked" | "archived" | "removed" | "nsfw">, 0 | 1 | null>
            | undefined;
        if (!flags) return {};

        return mapValues(removeNullUndefinedValues(flags), Boolean);
    }

    queryAuthorEditDeleted(cid: string): Pick<CommentEditsTableRow, "deleted"> | undefined {
        const result = this._db
            .prepare(
                `
            SELECT deleted FROM ${TABLES.COMMENT_EDITS}
            WHERE commentCid = ? AND (isAuthorEdit = 1 OR isAuthorEdit = TRUE) AND deleted IS NOT NULL ORDER BY rowid DESC LIMIT 1
        `
            )
            .get(cid) as { deleted: 0 | 1 | null } | undefined;
        return result && result.deleted !== null ? { deleted: Boolean(result.deleted) } : undefined;
    }

    _queryIsCommentApproved(
        comment: Pick<CommentsTableRow, "cid" | "authorSignerAddress" | "timestamp">
    ): { approved: boolean } | undefined {
        const result = this._prepareCached(
            `
            SELECT json_extract(commentModeration, '$.approved') AS approved FROM ${TABLES.COMMENT_MODERATIONS}
            WHERE commentCid = ? AND json_extract(commentModeration, '$.approved') IS NOT NULL ORDER BY rowid DESC LIMIT 1
        `
        ).get(comment.cid) as { approved: 0 | 1 | boolean | null } | undefined;
        if (!result || result.approved === null) return undefined;
        return { approved: Boolean(result.approved) };
    }

    queryCalculatedCommentUpdate(opts: { comment: CommentUpdateCalculationInput; authorDomain?: string }): CalculatedCommentUpdate {
        // The batch of one: the per-comment API is the batched calculation over a single entry (issue #352)
        return this._calculateCommentUpdates([{ comment: opts.comment, authorDomain: opts.authorDomain }], new Map()).get(
            opts.comment.cid
        )!;
    }

    // The CommentUpdate fields of every given comment in one pass (issue #352): each field group is one statement per
    // chunk of comments instead of nine statements per comment, and the author aggregates are computed once per
    // distinct author (address set + domain) and kept in `authorMemo`, which the update cycle shares across its
    // depth batches so an author with a thousand comments is aggregated once per cycle. Same result as
    // queryCalculatedCommentUpdate for every comment (the per-comment API is this over one entry).
    queryCalculatedCommentUpdates(opts: {
        comments: (CommentUpdateCalculationInput & Pick<CommentsTableRow, "author">)[];
        authorMemo?: CommunityAuthorMemo;
    }): Map<string, CalculatedCommentUpdate> {
        return this._calculateCommentUpdates(
            opts.comments.map((comment) => ({ comment, authorDomain: getAuthorNameFromWire(comment.author) })),
            opts.authorMemo ?? new Map()
        );
    }

    private _calculateCommentUpdates(
        entries: { comment: CommentUpdateCalculationInput; authorDomain?: string }[],
        authorMemo: CommunityAuthorMemo
    ): Map<string, CalculatedCommentUpdate> {
        const result = new Map<string, CalculatedCommentUpdate>();
        if (entries.length === 0) return result;
        const cids = entries.map((entry) => entry.comment.cid);
        const authorByCid = this._queryCommunityAuthorsForCommentUpdates(entries, authorMemo);
        const votes = this._queryVoteCountsByCids(cids);
        const counts = this._queryReplyCountsByParentCids(cids);
        const lastReplyTimestamps = this._queryLastReplyTimestampsByParentCids(cids);
        const lastChildCids = this._queryLastChildCidsByParentCids(cids);
        const moderations = this._queryModerationSummariesByCids(cids);
        const authorEdits = this._queryLatestAuthorEditsByCids(entries.map((entry) => entry.comment));
        const numbers = this._queryCommentNumbersByCids(cids);

        for (const { comment } of entries) {
            const authorCommunity = authorByCid.get(comment.cid);
            if (!authorCommunity) throw Error("Failed to query author.community in queryCalculatedCommentUpdate");
            const moderation = moderations.get(comment.cid);
            const authorEdit = authorEdits.get(comment.cid);
            const isThisCommentApproved = moderation?.approved !== undefined ? { approved: moderation.approved } : undefined;
            const removedFromApproved = isThisCommentApproved?.approved === false ? { removed: true } : undefined; // automatically add removed:true if approved=false. Will be overridden if there's commentFlags.removed
            const { number: commentNumber, postNumber } = numbers.get(comment.cid) ?? {};
            const voteCounts = votes.get(comment.cid) ?? { upvoteCount: 0, downvoteCount: 0 };
            const replyCounts = counts.get(comment.cid) ?? { replyCount: 0, childCount: 0 };

            // Seed with challenge-supplied commentUpdate (lowest priority, per-field). Mod queries below
            // overwrite individual keys (reason, flairs, flags, approved, ...) when the mod has actually
            // published a moderation that set that key — challenge keys the mod never touched persist.
            // Same logic applies one level deeper for author.community: challenge-supplied
            // commentUpdate.author.community.<newKey> (e.g. countryCode) seeds underneath the computed
            // authorCommunity, so community-computed keys (postScore, replyScore, ...) and mod-settable
            // keys (flairs, banExpiresAt) always win. The validator forbids challenges from setting any
            // schema-defined key on author.community, so the spread here only carries novel extras.
            const challengeAuthorCommunity = (comment.challengeCommentUpdate?.author as { community?: Record<string, unknown> } | undefined)
                ?.community;
            result.set(comment.cid, {
                ...(comment.challengeCommentUpdate ?? {}),
                ...(removedFromApproved ? removedFromApproved : undefined),
                cid: comment.cid,
                ...(commentNumber !== undefined ? { number: commentNumber } : undefined),
                ...(postNumber !== undefined ? { postNumber } : undefined),
                upvoteCount: voteCounts.upvoteCount,
                downvoteCount: voteCounts.downvoteCount,
                replyCount: replyCounts.replyCount,
                childCount: replyCounts.childCount,
                flairs: moderation?.flairs || authorEdit?.flairs || (comment.challengeCommentUpdate?.flairs as CommentUpdateType["flairs"]),
                ...moderation?.flags,
                // moderatorReason wins when present, else fall back to the challenge-supplied reason (if any).
                reason: moderation?.reason ?? (comment.challengeCommentUpdate?.reason as string | undefined),
                author: { community: { ...(challengeAuthorCommunity ?? {}), ...authorCommunity } },
                lastChildCid: lastChildCids.get(comment.cid),
                lastReplyTimestamp: lastReplyTimestamps.get(comment.cid),
                ...(authorEdit ? { edit: authorEdit } : undefined),
                ...(isThisCommentApproved ? { approved: isThisCommentApproved.approved } : undefined)
            });
        }
        return result;
    }

    // Chunks of a cid list under the SQLite variable cap, each padded with NULLs to a power of two so a query has at
    // most 13 prepared variants instead of one per batch size (`x IN (..., NULL)` never matches the padding).
    private _cidChunks(cids: string[], variablesBesidesCids = 0): { placeholders: string; params: (string | null)[] }[] {
        const max = 4096 - variablesBesidesCids;
        const chunks: { placeholders: string; params: (string | null)[] }[] = [];
        for (let start = 0; start < cids.length; start += max) {
            const chunk = cids.slice(start, start + max);
            let size = 1;
            while (size < chunk.length) size *= 2;
            size = Math.min(size, max);
            chunks.push({
                placeholders: new Array(size).fill("?").join(","),
                params: [...chunk, ...new Array(size - chunk.length).fill(null)]
            });
        }
        return chunks;
    }

    private _queryVoteCountsByCids(cids: string[]): Map<string, { upvoteCount: number; downvoteCount: number }> {
        const result = new Map<string, { upvoteCount: number; downvoteCount: number }>();
        for (const { placeholders, params } of this._cidChunks(cids)) {
            const rows = this._prepareCached(
                `SELECT commentCid,
                        SUM(CASE WHEN vote = 1 THEN 1 ELSE 0 END) AS upvoteCount,
                        SUM(CASE WHEN vote = -1 THEN 1 ELSE 0 END) AS downvoteCount
                 FROM ${TABLES.VOTES} WHERE commentCid IN (${placeholders}) GROUP BY commentCid`
            ).all(...params) as { commentCid: string; upvoteCount: number; downvoteCount: number }[];
            for (const row of rows) result.set(row.commentCid, { upvoteCount: row.upvoteCount, downvoteCount: row.downvoteCount });
        }
        return result;
    }

    // replyCount and childCount of every parent in one recursive walk anchored on all of them: a descendant counts
    // when every comment on the path from the parent has a CommentUpdate, this community's address, and is neither
    // removed nor deleted; childCount is the level-1 part of the same walk.
    private _queryReplyCountsByParentCids(parentCids: string[]): Map<string, { replyCount: number; childCount: number }> {
        const result = new Map<string, { replyCount: number; childCount: number }>();
        const { clause: addrClause, params: addrParams } = this._communityAddressClause("c");
        const passes = `${addrClause} AND (cu.removed IS NOT 1 AND cu.removed IS NOT TRUE) AND (d.deleted_flag IS NULL OR d.deleted_flag != 1)`;
        const deletedLookup = `(SELECT cid, json_extract(edit, '$.deleted') AS deleted_flag FROM ${TABLES.COMMENT_UPDATES})`;
        for (const { placeholders, params } of this._cidChunks(parentCids, addrParams.length * 2)) {
            const rows = this._prepareCached(
                `WITH RECURSIVE descendants(root, cid, level) AS (
                    SELECT c.parentCid, c.cid, 1 FROM ${TABLES.COMMENTS} c
                    INNER JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid
                    LEFT JOIN ${deletedLookup} AS d ON c.cid = d.cid
                    WHERE c.parentCid IN (${placeholders}) AND ${passes}
                    UNION ALL
                    SELECT desc_nodes.root, c.cid, desc_nodes.level + 1 FROM ${TABLES.COMMENTS} c
                    INNER JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid
                    LEFT JOIN ${deletedLookup} AS d ON c.cid = d.cid
                    JOIN descendants desc_nodes ON c.parentCid = desc_nodes.cid
                    WHERE ${passes}
                )
                SELECT root, COUNT(*) AS replyCount, SUM(CASE WHEN level = 1 THEN 1 ELSE 0 END) AS childCount
                FROM descendants GROUP BY root`
            ).all(...params, ...addrParams, ...addrParams) as { root: string; replyCount: number; childCount: number }[];
            for (const row of rows) result.set(row.root, { replyCount: row.replyCount, childCount: row.childCount });
        }
        return result;
    }

    // lastReplyTimestamp of every parent: the newest timestamp under it. A direct reply counts unless it is pending or
    // disapproved (a reply with no CommentUpdate yet counts); a deeper one also needs a CommentUpdate, this
    // community's address and to be neither removed nor deleted, and so does every comment on its path.
    private _queryLastReplyTimestampsByParentCids(parentCids: string[]): Map<string, number> {
        const result = new Map<string, number>();
        const { clause: addrClause, params: addrParams } = this._communityAddressClause("c");
        for (const { placeholders, params } of this._cidChunks(parentCids, addrParams.length)) {
            const rows = this._prepareCached(
                `WITH RECURSIVE descendants(root, cid, timestamp) AS (
                    SELECT c.parentCid, c.cid, c.timestamp FROM ${TABLES.COMMENTS} c
                    LEFT JOIN ${TABLES.COMMENT_UPDATES} cu ON cu.cid = c.cid
                    WHERE c.parentCid IN (${placeholders})
                      AND COALESCE(cu.approved, 1) != 0
                      AND (c.pendingApproval IS NULL OR c.pendingApproval != 1)
                    UNION ALL
                    SELECT desc_nodes.root, c.cid, c.timestamp FROM ${TABLES.COMMENTS} c
                    INNER JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid
                    LEFT JOIN (SELECT cid, json_extract(edit, '$.deleted') AS deleted_flag FROM ${TABLES.COMMENT_UPDATES}) AS d ON c.cid = d.cid
                    JOIN descendants desc_nodes ON c.parentCid = desc_nodes.cid
                    WHERE ${addrClause} AND (cu.removed IS NOT 1 AND cu.removed IS NOT TRUE) AND (d.deleted_flag IS NULL OR d.deleted_flag != 1)
                      AND COALESCE(cu.approved, 1) != 0
                      AND (c.pendingApproval IS NULL OR c.pendingApproval != 1)
                )
                SELECT root, MAX(timestamp) AS maxTimestamp FROM descendants GROUP BY root`
            ).all(...params, ...addrParams) as { root: string; maxTimestamp: number | null }[];
            for (const row of rows) if (row.maxTimestamp !== null) result.set(row.root, row.maxTimestamp);
        }
        return result;
    }

    // lastChildCid of every parent: its newest direct reply that has a CommentUpdate and is not pending, disapproved,
    // removed or deleted (MAX(rowid) with the bare cid column: SQLite returns the cid of that row).
    private _queryLastChildCidsByParentCids(parentCids: string[]): Map<string, string> {
        const result = new Map<string, string>();
        for (const { placeholders, params } of this._cidChunks(parentCids)) {
            const rows = this._prepareCached(
                `SELECT c.parentCid AS parentCid, c.cid AS cid, MAX(c.rowid) AS lastRowid FROM ${TABLES.COMMENTS} c
                 INNER JOIN ${TABLES.COMMENT_UPDATES} cu ON cu.cid = c.cid
                 LEFT JOIN (
                     SELECT cid, json_extract(edit, '$.deleted') AS deleted_flag FROM ${TABLES.COMMENT_UPDATES}
                 ) deleted_lookup ON deleted_lookup.cid = c.cid
                 WHERE c.parentCid IN (${placeholders})
                   AND (c.pendingApproval IS NULL OR c.pendingApproval != 1)
                   AND COALESCE(cu.approved, 1) != 0
                   AND (cu.removed IS NOT 1 AND cu.removed IS NOT TRUE)
                   AND (deleted_lookup.deleted_flag IS NULL OR deleted_lookup.deleted_flag != 1)
                 GROUP BY c.parentCid`
            ).all(...params) as { parentCid: string; cid: string }[];
            for (const row of rows) result.set(row.parentCid, row.cid);
        }
        return result;
    }

    // What the moderations of each comment say, newest first, one read for the batch: the latest non-null value per
    // field (reason, flairs, approved and the six flags), the same precedence as the per-field statements this replaces.
    private _queryModerationSummariesByCids(cids: string[]): Map<
        string,
        {
            reason?: string;
            flairs?: CommentModerationTableRow["commentModeration"]["flairs"];
            approved?: boolean;
            flags: Partial<Pick<CommentUpdateType, "spoiler" | "pinned" | "locked" | "archived" | "removed" | "nsfw">>;
        }
    > {
        type Summary = {
            reason?: string;
            flairs?: CommentModerationTableRow["commentModeration"]["flairs"];
            approved?: boolean;
            flags: Partial<Pick<CommentUpdateType, "spoiler" | "pinned" | "locked" | "archived" | "removed" | "nsfw">>;
        };
        const FLAG_NAMES = ["spoiler", "pinned", "locked", "archived", "removed", "nsfw"] as const;
        const result = new Map<string, Summary>();
        for (const { placeholders, params } of this._cidChunks(cids)) {
            const rows = this._prepareCached(
                `SELECT commentCid, commentModeration FROM ${TABLES.COMMENT_MODERATIONS} WHERE commentCid IN (${placeholders}) ORDER BY rowid DESC`
            ).all(...params) as { commentCid: string; commentModeration: string }[];
            for (const row of rows) {
                const moderation = JSON.parse(row.commentModeration) as Record<string, unknown>;
                let summary = result.get(row.commentCid);
                if (!summary) {
                    summary = { flags: {} };
                    result.set(row.commentCid, summary);
                }
                if (summary.reason === undefined && typeof moderation.reason === "string") summary.reason = moderation.reason;
                if (summary.flairs === undefined && moderation.flairs !== null && moderation.flairs !== undefined)
                    summary.flairs = moderation.flairs as Summary["flairs"];
                if (summary.approved === undefined && moderation.approved !== null && moderation.approved !== undefined)
                    summary.approved = Boolean(moderation.approved);
                for (const flag of FLAG_NAMES)
                    if (summary.flags[flag] === undefined && moderation[flag] !== null && moderation[flag] !== undefined)
                        summary.flags[flag] = Boolean(moderation[flag]);
            }
        }
        return result;
    }

    // The latest edit each comment's own author published, one read for the batch
    private _queryLatestAuthorEditsByCids(
        comments: Pick<CommentsTableRow, "cid" | "authorSignerAddress">[]
    ): Map<string, CommentEditPubsubMessagePublication> {
        const result = new Map<string, CommentEditPubsubMessagePublication>();
        const authorOf = new Map(comments.map((comment) => [comment.cid, comment.authorSignerAddress]));
        const commentEditFields = keys(CommentEditPubsubMessagePublicationSchema.shape);
        for (const { placeholders, params } of this._cidChunks(comments.map((comment) => comment.cid))) {
            const rows = this._prepareCached(
                `SELECT * FROM ${TABLES.COMMENT_EDITS} WHERE commentCid IN (${placeholders}) AND isAuthorEdit = 1 ORDER BY rowid DESC`
            ).all(...params) as CommentEditsTableRow[];
            for (const row of rows) {
                if (result.has(row.commentCid) || authorOf.get(row.commentCid) !== row.authorSignerAddress) continue;
                const parsed = this._spreadExtraProps(this._parseCommentEditsRow(row));
                const signedKeys = parsed.signature.signedPropertyNames as CommentEditSignature["signedPropertyNames"];
                result.set(
                    row.commentCid,
                    pick(parsed, ["signature", ...signedKeys, ...commentEditFields]) as CommentEditPubsubMessagePublication
                );
            }
        }
        return result;
    }

    // number / postNumber of each comment: the comments row's, else the numbers an earlier CommentUpdate carried
    private _queryCommentNumbersByCids(cids: string[]): Map<string, { number?: number; postNumber?: number }> {
        type Meta = { cid: string; depth: number; pendingApproval: number | null; number: number | null; postNumber: number | null };
        const metaByCid = new Map<string, Meta>();
        for (const { placeholders, params } of this._cidChunks(cids)) {
            const rows = this._prepareCached(
                `SELECT cid, depth, pendingApproval, number, postNumber FROM ${TABLES.COMMENTS} WHERE cid IN (${placeholders})`
            ).all(...params) as Meta[];
            for (const row of rows) metaByCid.set(row.cid, row);
        }
        const result = new Map<string, { number?: number; postNumber?: number }>();
        const needStored: string[] = [];
        for (const cid of cids) {
            const meta = metaByCid.get(cid);
            if (!meta) throw Error(`Failed to query row metadata for comment ${cid}`);
            if (meta.pendingApproval === 1) {
                result.set(cid, {});
                continue;
            }
            const number = typeof meta.number === "number" && meta.number > 0 ? meta.number : undefined;
            const postNumber = typeof meta.postNumber === "number" && meta.postNumber > 0 ? meta.postNumber : undefined;
            result.set(cid, {
                ...(number !== undefined ? { number } : undefined),
                ...(postNumber !== undefined ? { postNumber } : undefined)
            });
            if (number === undefined || (meta.depth === 0 && postNumber === undefined)) needStored.push(cid);
        }
        for (const { placeholders, params } of this._cidChunks(needStored)) {
            const rows = this._prepareCached(
                `SELECT cid, number, postNumber FROM ${TABLES.COMMENT_UPDATES} WHERE cid IN (${placeholders})`
            ).all(...params) as { cid: string; number: number | null; postNumber: number | null }[];
            for (const row of rows) {
                const meta = metaByCid.get(row.cid)!;
                const numbers = result.get(row.cid)!;
                if (numbers.number === undefined && typeof row.number === "number" && row.number > 0) numbers.number = row.number;
                if (meta.depth === 0 && numbers.postNumber === undefined && typeof row.postNumber === "number" && row.postNumber > 0)
                    numbers.postNumber = row.postNumber;
            }
        }
        return result;
    }

    // author.community of every comment: the karma of the address set the comment's author is (an alias comment
    // counts the alias alone, a plain one every alias of the author too) plus the mod edits (bans, flairs) targeting
    // any of them or the domain. Aggregated once per distinct (karma set, mod-edit set, domain) and memoised for the
    // cycle; the aggregates themselves are one GROUP BY per chunk of addresses.
    private _queryCommunityAuthorsForCommentUpdates(
        entries: { comment: CommentUpdateCalculationInput; authorDomain?: string }[],
        memo: CommunityAuthorMemo
    ): Map<string, CommunityAuthor | undefined> {
        type Need = { karma: string[]; modEdit: string[]; domain?: string; key: string };
        const aliasByCid = this._queryPseudonymityAliasesByCommentCids(entries.map((entry) => entry.comment.cid));
        const plainAddresses = [
            ...new Set(entries.filter((entry) => !aliasByCid.has(entry.comment.cid)).map((entry) => entry.comment.authorSignerAddress))
        ];
        const expanded = this._queryAliasExpandedAddressSets(plainAddresses);
        const keyOf = (karma: string[], modEdit: string[], domain?: string) =>
            `${[...karma].sort().join(",")}|${[...modEdit].sort().join(",")}|${domain ?? ""}`;
        const needByCid = new Map<string, Need>();
        for (const { comment, authorDomain } of entries) {
            const alias = aliasByCid.get(comment.cid);
            if (alias) {
                // Karma for just this alias, but mod edits (bans/flairs) from both the alias and the original author
                const modEdit = [comment.authorSignerAddress];
                try {
                    const originalAddress = getPKCAddressFromPublicKeySync(alias.originalAuthorPublicKey);
                    if (originalAddress !== comment.authorSignerAddress) modEdit.push(originalAddress);
                } catch {
                    // ignore malformed keys
                }
                const domain = alias.originalAuthorName || authorDomain;
                needByCid.set(comment.cid, {
                    karma: [comment.authorSignerAddress],
                    modEdit,
                    domain,
                    key: keyOf([comment.authorSignerAddress], modEdit, domain)
                });
            } else {
                const set = [...(expanded.get(comment.authorSignerAddress) ?? new Set([comment.authorSignerAddress]))];
                needByCid.set(comment.cid, { karma: set, modEdit: set, domain: authorDomain, key: keyOf(set, set, authorDomain) });
            }
        }
        const uncached = new Map<string, Need>();
        for (const need of needByCid.values()) if (!memo.has(need.key)) uncached.set(need.key, need);
        if (uncached.size > 0) {
            const addresses = new Set<string>();
            const domains = new Set<string>();
            for (const need of uncached.values()) {
                for (const address of need.karma) addresses.add(address);
                for (const address of need.modEdit) addresses.add(address);
                if (need.domain) domains.add(need.domain);
            }
            const aggregates = this._queryAuthorAggregatesByAddresses([...addresses]);
            const modEditRows = this._queryAuthorModEditRows([...addresses], [...domains]);
            for (const need of uncached.values()) {
                const modEditSet = new Set(need.modEdit);
                const modAuthorEdits = modEditRows
                    .filter(
                        (row) =>
                            (row.targetAuthorSignerAddress !== null && modEditSet.has(row.targetAuthorSignerAddress)) ||
                            (need.domain !== undefined && row.targetAuthorDomain === need.domain)
                    )
                    .map((row) => row.author);
                const banAuthor = modAuthorEdits.find((modEdit) => typeof modEdit?.banExpiresAt === "number");
                const authorFlairsByMod = modAuthorEdits.find((modEdit) => modEdit?.flairs);
                const modEdits: Pick<CommunityAuthor, "banExpiresAt" | "flairs"> = {};
                if (banAuthor?.banExpiresAt) modEdits.banExpiresAt = banAuthor.banExpiresAt;
                if (authorFlairsByMod?.flairs) modEdits.flairs = authorFlairsByMod.flairs;

                const karma = need.karma.map((address) => aggregates.get(address)).filter((aggregate) => aggregate !== undefined);
                if (karma.length === 0) {
                    memo.set(need.key, Object.keys(modEdits).length > 0 ? (modEdits as CommunityAuthor) : undefined);
                    continue;
                }
                const last = firstBy(karma, [(aggregate) => aggregate.lastRowid, "desc"])!;
                const first = firstBy(karma, (aggregate) => aggregate.firstRowid)!;
                memo.set(need.key, {
                    postScore: sumBy(karma, (aggregate) => aggregate.postScore),
                    replyScore: sumBy(karma, (aggregate) => aggregate.replyScore),
                    lastCommentCid: last.lastCommentCid,
                    ...modEdits,
                    firstCommentTimestamp: first.firstCommentTimestamp
                });
            }
        }
        const result = new Map<string, CommunityAuthor | undefined>();
        for (const [cid, need] of needByCid) result.set(cid, memo.get(need.key));
        return result;
    }

    private _queryPseudonymityAliasesByCommentCids(cids: string[]): Map<string, PseudonymityAliasRow> {
        const result = new Map<string, PseudonymityAliasRow>();
        for (const { placeholders, params } of this._cidChunks(cids)) {
            const rows = this._prepareCached(
                `SELECT commentCid, aliasPrivateKey, originalAuthorPublicKey, originalAuthorName, mode, insertedAt FROM ${TABLES.PSEUDONYMITY_ALIASES} WHERE commentCid IN (${placeholders})`
            ).all(...params) as PseudonymityAliasRow[];
            for (const row of rows) result.set(row.commentCid, row);
        }
        return result;
    }

    // What queryCommunityAuthor sums for a plain address: the address itself, every alias address of that original
    // author, and the original author of that alias address, batched over a chunk of addresses.
    private _queryAliasExpandedAddressSets(addresses: string[]): Map<string, Set<string>> {
        const result = new Map<string, Set<string>>(addresses.map((address) => [address, new Set([address])]));
        for (const { placeholders, params } of this._cidChunks(addresses)) {
            const aliasRows = this._prepareCached(
                `SELECT alias.originalAuthorSignerAddress AS original, comments.authorSignerAddress AS aliasAddress
                 FROM ${TABLES.PSEUDONYMITY_ALIASES} AS alias
                 INNER JOIN ${TABLES.COMMENTS} AS comments ON comments.cid = alias.commentCid
                 WHERE alias.originalAuthorSignerAddress IN (${placeholders})`
            ).all(...params) as { original: string; aliasAddress: string | null }[];
            for (const row of aliasRows) if (row.aliasAddress) result.get(row.original)?.add(row.aliasAddress);
            const originalRows = this._prepareCached(
                `SELECT comments.authorSignerAddress AS aliasAddress, alias.originalAuthorPublicKey AS originalAuthorPublicKey
                 FROM ${TABLES.PSEUDONYMITY_ALIASES} AS alias
                 INNER JOIN ${TABLES.COMMENTS} AS comments ON comments.cid = alias.commentCid
                 WHERE comments.authorSignerAddress IN (${placeholders})`
            ).all(...params) as { aliasAddress: string; originalAuthorPublicKey: string }[];
            for (const row of originalRows)
                try {
                    result.get(row.aliasAddress)?.add(getPKCAddressFromPublicKeySync(row.originalAuthorPublicKey));
                } catch {
                    // ignore malformed keys
                }
        }
        return result;
    }

    // Per address: post and reply karma (votes on the author's comments) and the rowids of the author's first and
    // last comments, one GROUP BY per chunk of addresses
    private _queryAuthorAggregatesByAddresses(
        addresses: string[]
    ): Map<
        string,
        {
            postScore: number;
            replyScore: number;
            lastRowid: number;
            lastCommentCid: string;
            firstRowid: number;
            firstCommentTimestamp: number;
        }
    > {
        type Aggregate = {
            postScore: number;
            replyScore: number;
            lastRowid: number;
            lastCommentCid: string;
            firstRowid: number;
            firstCommentTimestamp: number;
        };
        const partial = new Map<string, Omit<Aggregate, "lastCommentCid" | "firstCommentTimestamp">>();
        for (const { placeholders, params } of this._cidChunks(addresses)) {
            const rows = this._prepareCached(
                `SELECT c.authorSignerAddress AS address,
                        COALESCE(SUM(CASE WHEN c.depth = 0 AND v.vote = 1 THEN 1 WHEN c.depth = 0 AND v.vote = -1 THEN -1 ELSE 0 END), 0) AS postScore,
                        COALESCE(SUM(CASE WHEN c.depth > 0 AND v.vote = 1 THEN 1 WHEN c.depth > 0 AND v.vote = -1 THEN -1 ELSE 0 END), 0) AS replyScore,
                        MAX(c.rowid) AS lastRowid, MIN(c.rowid) AS firstRowid
                 FROM ${TABLES.COMMENTS} c LEFT JOIN ${TABLES.VOTES} v ON c.cid = v.commentCid
                 WHERE c.authorSignerAddress IN (${placeholders}) GROUP BY c.authorSignerAddress`
            ).all(...params) as { address: string; postScore: number; replyScore: number; lastRowid: number; firstRowid: number }[];
            for (const row of rows) partial.set(row.address, row);
        }
        const rowids = [...new Set([...partial.values()].flatMap((aggregate) => [aggregate.lastRowid, aggregate.firstRowid]))];
        const byRowid = new Map<number, { cid: string; timestamp: number }>();
        for (const { placeholders, params } of this._cidChunks(rowids.map(String))) {
            const rows = this._prepareCached(`SELECT rowid, cid, timestamp FROM ${TABLES.COMMENTS} WHERE rowid IN (${placeholders})`).all(
                ...params
            ) as { rowid: number; cid: string; timestamp: number }[];
            for (const row of rows) byRowid.set(row.rowid, row);
        }
        const result = new Map<string, Aggregate>();
        for (const [address, aggregate] of partial) {
            const last = byRowid.get(aggregate.lastRowid);
            const first = byRowid.get(aggregate.firstRowid);
            if (!last) throw Error("Failed to query communityAuthor.lastCommentCid");
            if (!first) throw Error("Failed to query communityAuthor.firstCommentTimestamp");
            result.set(address, { ...aggregate, lastCommentCid: last.cid, firstCommentTimestamp: first.timestamp });
        }
        return result;
    }

    // Every mod edit of an author (bans, flairs) targeting any of the addresses or domains, newest first, with its
    // target so a caller keeps the ones aimed at one author. Read by target, so a ban survives a purged comment.
    private _queryAuthorModEditRows(
        addresses: string[],
        domains: string[]
    ): {
        rowid: number;
        targetAuthorSignerAddress: string | null;
        targetAuthorDomain: string | null;
        author: CommentModerationTableRow["commentModeration"]["author"];
    }[] {
        type Row = {
            rowid: number;
            targetAuthorSignerAddress: string | null;
            targetAuthorDomain: string | null;
            commentAuthorJson: string;
        };
        const rows: Row[] = [];
        const select = `SELECT rowid, targetAuthorSignerAddress, targetAuthorDomain, json_extract(commentModeration, '$.author') AS commentAuthorJson
                        FROM ${TABLES.COMMENT_MODERATIONS} WHERE json_extract(commentModeration, '$.author') IS NOT NULL AND`;
        for (const { placeholders, params } of this._cidChunks(addresses))
            rows.push(...(this._prepareCached(`${select} targetAuthorSignerAddress IN (${placeholders})`).all(...params) as Row[]));
        for (const { placeholders, params } of this._cidChunks(domains))
            rows.push(...(this._prepareCached(`${select} targetAuthorDomain IN (${placeholders})`).all(...params) as Row[]));
        const unique = uniqueBy(rows, (row) => row.rowid).sort((a, b) => b.rowid - a.rowid);
        return unique.map((row) => ({
            rowid: row.rowid,
            targetAuthorSignerAddress: row.targetAuthorSignerAddress,
            targetAuthorDomain: row.targetAuthorDomain,
            author: JSON.parse(row.commentAuthorJson) as CommentModerationTableRow["commentModeration"]["author"]
        }));
    }

    // The stored updatedAt / postUpdatesBucket / replies of a batch of comments, what calculateNewCommentUpdate reads
    // before writing the next CommentUpdate (issue #352)
    queryCommentUpdateTimestampBucketRepliesByCids(
        cids: string[]
    ): Map<string, Pick<CommentUpdatesRow, "updatedAt" | "postUpdatesBucket" | "replies">> {
        const result = new Map<string, Pick<CommentUpdatesRow, "updatedAt" | "postUpdatesBucket" | "replies">>();
        for (const { placeholders, params } of this._cidChunks(cids)) {
            const rows = this._prepareCached(
                `SELECT cid, updatedAt, postUpdatesBucket, replies FROM ${TABLES.COMMENT_UPDATES} WHERE cid IN (${placeholders})`
            ).all(...params) as { cid: string; updatedAt: number; postUpdatesBucket: number | null; replies: string | null }[];
            for (const row of rows)
                result.set(row.cid, {
                    updatedAt: row.updatedAt,
                    postUpdatesBucket: row.postUpdatesBucket ?? undefined,
                    replies: typeof row.replies === "string" ? JSON.parse(row.replies) : undefined
                } as Pick<CommentUpdatesRow, "updatedAt" | "postUpdatesBucket" | "replies">);
        }
        return result;
    }

    queryLatestPostCid(): Pick<CommentsTableRow, "cid"> | undefined {
        return this._prepareCached(
            `SELECT c.cid FROM ${TABLES.COMMENTS} c
                 LEFT JOIN ${TABLES.COMMENT_UPDATES} cu ON cu.cid = c.cid
                 WHERE c.depth = 0
                   AND c.pendingApproval IS NOT 1
                   AND COALESCE(cu.approved, 1) != 0
                 ORDER BY c.rowid DESC
                 LIMIT 1`
        ).get() as Pick<CommentsTableRow, "cid"> | undefined;
    }

    queryLatestCommentCid(): Pick<CommentsTableRow, "cid"> | undefined {
        return this._prepareCached(
            `SELECT c.cid FROM ${TABLES.COMMENTS} c
                 LEFT JOIN ${TABLES.COMMENT_UPDATES} cu ON cu.cid = c.cid
                 WHERE c.pendingApproval IS NOT 1
                   AND COALESCE(cu.approved, 1) != 0
                 ORDER BY c.rowid DESC
                 LIMIT 1`
        ).get() as Pick<CommentsTableRow, "cid"> | undefined;
    }

    queryAllCommentsOrderedByIdAsc(): CommentsTableRow[] {
        const results = this._db.prepare(`SELECT * FROM ${TABLES.COMMENTS} ORDER BY rowid ASC`).all() as CommentsTableRow[];
        return results.map((r) => this._parseCommentsTableRow(r));
    }

    queryAuthorModEdits(opts: {
        authorSignerAddresses: string[];
        authorDomain?: string;
    }): Pick<CommunityAuthor, "banExpiresAt" | "flairs"> {
        const { authorSignerAddresses, authorDomain } = opts;
        if (authorSignerAddresses.length === 0 && !authorDomain) return {};

        const conditions: string[] = [];
        const params: string[] = [];

        if (authorSignerAddresses.length > 0) {
            const placeholders = authorSignerAddresses.map(() => "?").join(",");
            conditions.push(`targetAuthorSignerAddress IN (${placeholders})`);
            params.push(...authorSignerAddresses);
        }

        if (authorDomain) {
            conditions.push(`targetAuthorDomain = ?`);
            params.push(authorDomain);
        }

        // Query directly by targetAuthorSignerAddress or targetAuthorDomain to find bans/flairs even for purged comments
        const modAuthorEditsRaw = this._prepareCached(
            `
            SELECT json_extract(commentModeration, '$.author') AS commentAuthorJson FROM ${TABLES.COMMENT_MODERATIONS}
            WHERE (${conditions.join(" OR ")}) AND json_extract(commentModeration, '$.author') IS NOT NULL ORDER BY rowid DESC
        `
        ).all(...params) as { commentAuthorJson: string }[];

        const modAuthorEdits = modAuthorEditsRaw.map(
            (r) => JSON.parse(r.commentAuthorJson) as CommentModerationTableRow["commentModeration"]["author"]
        );
        const banAuthor = modAuthorEdits.find((modEdit) => typeof modEdit?.banExpiresAt === "number");
        const authorFlairsByMod = modAuthorEdits.find((modEdit) => modEdit?.flairs);
        const aggregateAuthor: Pick<CommunityAuthor, "banExpiresAt" | "flairs"> = {};
        if (banAuthor?.banExpiresAt) aggregateAuthor.banExpiresAt = banAuthor.banExpiresAt;
        if (authorFlairsByMod?.flairs) aggregateAuthor.flairs = authorFlairsByMod.flairs;
        return aggregateAuthor;
    }

    queryAllCommentModerations(opts?: ExportCommunityModLogsOptions): CommentModerationTableRow[] {
        const conditions: string[] = [];
        const params: (string | number)[] = [];
        if (opts?.startTimestamp !== undefined) {
            conditions.push(`timestamp >= ?`);
            params.push(opts.startTimestamp);
        }
        if (opts?.endTimestamp !== undefined) {
            conditions.push(`timestamp <= ?`);
            params.push(opts.endTimestamp);
        }
        if (opts?.commentCid !== undefined) {
            conditions.push(`commentCid = ?`);
            params.push(opts.commentCid);
        }
        const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
        const direction = opts?.order === "ASC" ? "ASC" : "DESC"; // explicit map so only ASC/DESC reach the SQL
        let sql = `SELECT * FROM ${TABLES.COMMENT_MODERATIONS} ${whereClause} ORDER BY timestamp ${direction}, rowid ${direction}`;
        if (opts?.limit !== undefined) {
            sql += ` LIMIT ?`;
            params.push(opts.limit);
        }
        const results = this._db.prepare(sql).all(...params) as Record<string, unknown>[];
        return results.map((r) => this._parseCommentModerationRow(r));
    }

    queryAuthorPublicationCounts(authorSignerAddress: string): { postCount: number; replyCount: number } {
        const pendingClause = this._pendingApprovalClause(TABLES.COMMENTS);
        const result = this._db
            .prepare(
                `
            SELECT
                COALESCE(SUM(CASE WHEN depth = 0 THEN 1 ELSE 0 END), 0) as postCount,
                COALESCE(SUM(CASE WHEN depth > 0 THEN 1 ELSE 0 END), 0) as replyCount
            FROM ${TABLES.COMMENTS}
            WHERE authorSignerAddress = ? AND ${pendingClause}
        `
            )
            .get(authorSignerAddress) as { postCount: number; replyCount: number };
        return result;
    }

    queryCommunityAuthor(authorSignerAddress: string, authorDomain?: string): CommunityAuthor | undefined {
        const authorSignerAddresses = new Set<string>([authorSignerAddress]);

        // If the provided address is the original signer, include all alias signer addresses for that author
        // (originalAuthorSignerAddress is derived from the original public key at insert and indexed, issue #351).
        const aliasSignerRows = this._prepareCached(
            `
            SELECT comments.authorSignerAddress
            FROM ${TABLES.PSEUDONYMITY_ALIASES} AS alias
            INNER JOIN ${TABLES.COMMENTS} AS comments ON comments.cid = alias.commentCid
            WHERE alias.originalAuthorSignerAddress = ?
        `
        ).all(authorSignerAddress) as { authorSignerAddress: string | null }[];
        for (const row of aliasSignerRows) if (row.authorSignerAddress) authorSignerAddresses.add(row.authorSignerAddress);

        // If the provided address is an alias, include the original signer address for that alias.
        const aliasRowsForAliasAddress = this._prepareCached(
            `
            SELECT alias.originalAuthorPublicKey
            FROM ${TABLES.PSEUDONYMITY_ALIASES} AS alias
            INNER JOIN ${TABLES.COMMENTS} AS comments ON comments.cid = alias.commentCid
            WHERE comments.authorSignerAddress = ?
        `
        ).all(authorSignerAddress) as Pick<PseudonymityAliasRow, "originalAuthorPublicKey">[];
        for (const aliasRow of aliasRowsForAliasAddress) {
            try {
                const originalAddress = getPKCAddressFromPublicKeySync(aliasRow.originalAuthorPublicKey);
                authorSignerAddresses.add(originalAddress);
            } catch {
                // ignore malformed keys
            }
        }

        return this._queryCommunityAuthorByAddresses([...authorSignerAddresses], undefined, authorDomain);
    }

    /** Shared helper: query karma for a set of addresses, with optional separate addresses for mod edits */
    private _queryCommunityAuthorByAddresses(
        karmaAddresses: string[],
        modEditAddresses: string[] = karmaAddresses,
        authorDomain?: string
    ): CommunityAuthor | undefined {
        if (karmaAddresses.length === 0) return undefined;
        const placeholders = karmaAddresses.map(() => "?").join(", ");

        const modAuthorEdits = this.queryAuthorModEdits({ authorSignerAddresses: modEditAddresses, authorDomain });

        const authorCommentsData = this._prepareCached(
            `
            SELECT c.depth, c.rowid, c.timestamp, c.cid,
                   COALESCE(SUM(CASE WHEN v.vote = 1 THEN 1 ELSE 0 END), 0) as upvoteCount,
                   COALESCE(SUM(CASE WHEN v.vote = -1 THEN 1 ELSE 0 END), 0) as downvoteCount
            FROM ${TABLES.COMMENTS} c LEFT JOIN ${TABLES.VOTES} v ON c.cid = v.commentCid
            WHERE c.authorSignerAddress IN (${placeholders}) GROUP BY c.cid
        `
        ).all(...karmaAddresses) as (Pick<CommentsTableRow, "depth" | "timestamp" | "cid"> & {
            rowid: number;
            upvoteCount: number;
            downvoteCount: number;
        })[];

        if (authorCommentsData.length === 0) {
            if (Object.keys(modAuthorEdits).length > 0) {
                return modAuthorEdits as CommunityAuthor;
            }
            return undefined;
        }

        const authorPosts = authorCommentsData.filter((c) => c.depth === 0);
        const authorReplies = authorCommentsData.filter((c) => c.depth > 0);
        const postScore = sumBy(authorPosts, (p) => p.upvoteCount) - sumBy(authorPosts, (p) => p.downvoteCount);
        const replyScore = sumBy(authorReplies, (r) => r.upvoteCount) - sumBy(authorReplies, (r) => r.downvoteCount);
        const lastCommentCid = firstBy(authorCommentsData, [(c) => c.rowid, "desc"])?.cid;
        if (!lastCommentCid) throw Error("Failed to query communityAuthor.lastCommentCid");
        const firstCommentTimestamp = firstBy(authorCommentsData, (c) => c.rowid)?.timestamp;
        if (typeof firstCommentTimestamp !== "number") throw Error("Failed to query communityAuthor.firstCommentTimestamp");
        return { postScore, replyScore, lastCommentCid, ...modAuthorEdits, firstCommentTimestamp };
    }

    /**
     * Returns author.community for CommentUpdates, respecting pseudonymity mode boundaries.
     *
     * The alias address already encodes the isolation boundary:
     * - per-reply: Each reply has a unique alias, so querying by alias = that one comment's karma
     * - per-post: All comments in a thread share an alias, so querying by alias = thread karma
     * - per-author: One alias for all comments, so querying by alias = total karma
     *
     * We query karma for ONLY the alias address (no lookup to other aliases like queryCommunityAuthor does),
     * but include mod edits from both alias and original author.
     */
    private _getAllDescendantCids(cid: string): string[] {
        const allCids: string[] = [cid];
        const directChildren = this._db.prepare(`SELECT cid FROM ${TABLES.COMMENTS} WHERE parentCid = ?`).all(cid) as { cid: string }[];

        for (const child of directChildren) {
            allCids.push(...this._getAllDescendantCids(child.cid));
        }

        return allCids;
    }

    purgeComment(cid: string, isNestedCall: boolean = false): PurgedCommentTableRows[] {
        const log = Logger("pkc-js:local-community:db-handler:purgeComment");
        const purgedRecords: PurgedCommentTableRows[] = [];
        const detachedPageCids: string[] = [];
        if (!isNestedCall) this.createTransaction();

        try {
            // Get all CIDs that will be purged (including descendants) and their authors
            const allCidsToBeDeleted = this._getAllDescendantCids(cid);
            const allAffectedAuthors = new Set<string>();
            const commentsToForceUpdate = new Set<string>();

            // Collect all unique authorSignerAddresses from comments that will be purged
            if (!isNestedCall) {
                for (const cidToDelete of allCidsToBeDeleted) {
                    const commentToDelete = this._queryCommentAuthorAndParentWithoutParsing(cidToDelete);
                    if (!commentToDelete) {
                        throw new Error(`Comment with cid ${cidToDelete} not found when attempting to purge`);
                    }
                    if (!commentToDelete.authorSignerAddress) {
                        throw new Error(`Comment with cid ${cidToDelete} has no authorSignerAddress`);
                    }
                    allAffectedAuthors.add(commentToDelete.authorSignerAddress);

                    // Collect comments that received votes FROM this purged comment
                    const votesFromPurgedComment = this._db
                        .prepare(`SELECT commentCid FROM ${TABLES.VOTES} WHERE authorSignerAddress = ?`)
                        .all(commentToDelete.authorSignerAddress) as { commentCid: string }[];
                    votesFromPurgedComment.forEach((vote) => commentsToForceUpdate.add(vote.commentCid));

                    // Collect comments that received edits FROM this purged comment
                    const editsFromPurgedComment = this._db
                        .prepare(`SELECT commentCid FROM ${TABLES.COMMENT_EDITS} WHERE authorSignerAddress = ?`)
                        .all(commentToDelete.authorSignerAddress) as { commentCid: string }[];
                    editsFromPurgedComment.forEach((edit) => commentsToForceUpdate.add(edit.commentCid));

                    // Collect parent comments of purged comments (for reply count updates)
                    if (commentToDelete.parentCid) {
                        const allAncestors = this.queryParentsCids({ parentCid: commentToDelete.parentCid });
                        allAncestors.forEach((ancestor) => commentsToForceUpdate.add(ancestor.cid));
                    }
                }
            }

            const directChildren = this._db.prepare(`SELECT cid FROM ${TABLES.COMMENTS} WHERE parentCid = ?`).all(cid) as { cid: string }[];
            for (const child of directChildren) purgedRecords.push(...this.purgeComment(child.cid, true));

            const commentTableRow = this.queryComment(cid);
            this._db.prepare(`DELETE FROM ${TABLES.VOTES} WHERE commentCid = ?`).run(cid);
            this._db.prepare(`DELETE FROM ${TABLES.COMMENT_EDITS} WHERE commentCid = ?`).run(cid);
            this._db.prepare(`DELETE FROM ${TABLES.PSEUDONYMITY_ALIASES} WHERE commentCid = ?`).run(cid);

            const commentUpdate = this.queryCommentUpdateBucketAndReplies({ cid });
            if (commentUpdate) {
                this._db.prepare(`DELETE FROM ${TABLES.COMMENT_UPDATES} WHERE cid = ?`).run(cid);
            }
            const deleteResult = this._db.prepare(`DELETE FROM ${TABLES.COMMENTS} WHERE cid = ?`).run(cid);
            if (deleteResult.changes > 0) {
                if (!commentTableRow) throw new Error(`Comment with cid ${cid} not found when attempting to purge`);
                purgedRecords.push({
                    commentTableRow,
                    commentUpdateTableRow: commentUpdate
                });
            }

            // Force update on all comments by all affected authors since their statistics have changed
            if (!isNestedCall && (allAffectedAuthors.size > 0 || commentsToForceUpdate.size > 0)) {
                const allAffectedAuthorCids: string[] = [];

                for (const authorSignerAddress of allAffectedAuthors) {
                    const authorCommentCids = this._db
                        .prepare(`SELECT cid FROM ${TABLES.COMMENTS} WHERE authorSignerAddress = ?`)
                        .all(authorSignerAddress) as { cid: string }[];

                    allAffectedAuthorCids.push(...authorCommentCids.map((c) => c.cid));
                }

                // Combine author comments and comments that received votes/edits/replies from purged comments
                const allCommentsToUpdate = [...allAffectedAuthorCids, ...Array.from(commentsToForceUpdate)];

                // Force update on a random comment to ensure IPNS update triggers even if no other comments need updating
                // Make sure we don't select a comment that's being purged
                // The purged set as one JSON parameter: a purged post can have more descendants than a statement may bind
                const randomComment = this._db
                    .prepare(
                        `SELECT cid FROM ${TABLES.COMMENTS} WHERE cid NOT IN (SELECT value FROM json_each(?)) ORDER BY RANDOM() LIMIT 1`
                    )
                    .get(JSON.stringify(allCidsToBeDeleted)) as { cid: string } | undefined;
                if (randomComment) {
                    allCommentsToUpdate.push(randomComment.cid);
                    log(`Forcing update on random comment ${randomComment.cid} to ensure IPNS update after purge`);
                } else {
                    log(`No comments left to force update after purge - IPNS will update to show empty community`);
                }

                if (allCommentsToUpdate.length > 0) {
                    this.forceUpdateOnAllCommentsWithCid(allCommentsToUpdate);
                }
            }

            if (!isNestedCall) this.commitTransaction();
            const uniquePurgedRecords = uniqueBy(purgedRecords, (record) => record.commentTableRow.cid);
            return uniquePurgedRecords;
        } catch (error) {
            log.error(`Error during comment purge for ${cid}: ${error}`);
            if (!isNestedCall) this.rollbackTransaction();
            throw error;
        }
    }

    async changeDbFilename(oldDbName: string, newDbName: string) {
        const log = Logger("pkc-js:local-community:db-handler:changeDbFilename");
        if (this._db || this._keyv) await this.destoryConnection();

        this._transactionDepth = 0;

        const dataPath = this._community._pkc.dataPath!;
        const oldPathString = path.join(dataPath, "communities", oldDbName);
        const newPathString = path.join(dataPath, "communities", newDbName);
        await fs.promises.mkdir(path.dirname(oldPathString), { recursive: true });
        await fs.promises.mkdir(path.dirname(newPathString), { recursive: true });

        try {
            // Check if oldDb exists before attempting to open for backup
            if (!fs.existsSync(oldPathString)) {
                log(`Old DB file ${oldPathString} does not exist. Cannot backup/rename.`);
                // If old doesn't exist, maybe we just want to set up the new path?
                // For now, this will mean the operation can't proceed as intended.
            } else {
                const sourceDb = new Database(oldPathString, { fileMustExist: true });
                await sourceDb.backup(newPathString); // backup is synchronous in better-sqlite3 v8+
                sourceDb.close();
                if (os.type() === "Windows_NT") await deleteOldCommunityInWindows(oldPathString, this._community._pkc);
                else await fs.promises.rm(oldPathString, { force: true });
            }
        } catch (error) {
            log.error(`Failed to backup/rename database from ${oldPathString} to ${newPathString}: `, error);
            throw error;
        }
        this._dbConfig = { ...this._dbConfig, filename: newPathString };
        log(`Changed db path from (${oldPathString}) to (${newPathString})`);
    }

    async lockCommunityStart(communityAddress = this._community.address) {
        const log = Logger("pkc-js:local-community:db-handler:lock:start");

        const lockfilePath = path.join(this._community._pkc.dataPath!, "communities", `${communityAddress}.start.lock`);
        const communityDbPath = path.join(this._community._pkc.dataPath!, "communities", communityAddress);

        try {
            await lockfile.lock(communityDbPath, {
                lockfilePath,
                onCompromised: () => {} // Temporary bandaid for the moment. Should be deleted later
            });
            log(`Locked the start of community (${communityAddress}) successfully`);
        } catch (e: unknown) {
            if (e instanceof Error && e.message === "Lock file is already being held")
                throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED", { communityAddress: communityAddress, error: e });
            else {
                log(`Error while trying to lock start of community (${communityAddress}): ${e}`);
                throw e;
            }
        }
    }

    async unlockCommunityStart(communityAddress = this._community.address) {
        const log = Logger("pkc-js:local-community:db-handler:unlock:start");
        log.trace(`Attempting to unlock the start of community (${communityAddress})`);

        const lockfilePath = path.join(this._community._pkc.dataPath!, "communities", `${communityAddress}.start.lock`);
        const communityDbPath = path.join(this._community._pkc.dataPath!, "communities", communityAddress);
        if (!fs.existsSync(lockfilePath) || !fs.existsSync(communityDbPath)) return;

        try {
            await lockfile.unlock(communityDbPath, { lockfilePath });
            log(`Unlocked start of community (${communityAddress})`);
        } catch (e: unknown) {
            log(`Error while trying to unlock start of community (${communityAddress}): ${e}`);
            throw e;
        }
    }

    async isCommunityStartLocked(communityAddress = this._community.address): Promise<boolean> {
        const lockfilePath = path.join(this._community._pkc.dataPath!, "communities", `${communityAddress}.start.lock`);
        const communityDbPath = path.join(this._community._pkc.dataPath!, "communities", communityAddress);
        const isLocked = await lockfile.check(communityDbPath, { lockfilePath, realpath: false, stale: 10000 });
        return isLocked;
    }

    // Community state lock

    async lockCommunityState() {
        const log = Logger("pkc-js:local-community:db-handler:lock:lockCommunityState");
        const lockfilePath = path.join(this._community._pkc.dataPath!, "communities", `${this._community.address}.state.lock`);
        const communityDbPath = path.join(this._community._pkc.dataPath!, "communities", this._community.address);
        try {
            await lockfile.lock(communityDbPath, {
                lockfilePath,
                retries: 5,
                onCompromised: () => {}
            });
        } catch (e: unknown) {
            log.error(`Error when attempting to lock community state`, this._community.address, e);
            if (e instanceof Error && e.message === "Lock file is already being held")
                throw new PKCError("ERR_COMMUNITY_STATE_LOCKED", { communityAddress: this._community.address, error: e });
            // Not sure, do we need to throw error here
        }
    }

    async unlockCommunityState() {
        const log = Logger("pkc-js:local-community:db-handler:lock:unlockCommunityState");

        const lockfilePath = path.join(this._community._pkc.dataPath!, "communities", `${this._community.address}.state.lock`);
        const communityDbPath = path.join(this._community._pkc.dataPath!, "communities", this._community.address);
        if (!fs.existsSync(lockfilePath)) return;
        try {
            await lockfile.unlock(communityDbPath, { lockfilePath });
        } catch (e: unknown) {
            log.error(`Error when attempting to unlock community state`, this._community.address, e);
            if (e instanceof Error && "code" in e && e.code !== "ENOTACQUIRED") throw e;
        }
    }

    communityDbExists() {
        const communityDbPath = path.join(this._community._pkc.dataPath!, "communities", this._community.address);
        return fs.existsSync(communityDbPath);
    }

    // Batched under the SQLite variable cap: a cycle that updates every comment (after a migration, or a
    // settings.pages edit) passes more cids than one statement may bind (issue #351)
    markCommentsAsPublishedToPostUpdates(commentCids: string[]): void {
        if (commentCids.length === 0) return;
        this._runForEachCidBatch(
            commentCids,
            (placeholders) => `UPDATE ${TABLES.COMMENT_UPDATES} SET publishedToPostUpdatesMFS = 1 WHERE cid IN (${placeholders})`
        );
    }

    forceUpdateOnAllComments(): void {
        this._db.prepare(`UPDATE ${TABLES.COMMENT_UPDATES} SET publishedToPostUpdatesMFS = 0`).run();
    }

    forceUpdateOnAllCommentsWithCid(commentCids: string[]): void {
        if (commentCids.length === 0) return;
        this._runForEachCidBatch(
            commentCids,
            (placeholders) => `UPDATE ${TABLES.COMMENT_UPDATES} SET publishedToPostUpdatesMFS = 0 WHERE cid IN (${placeholders})`
        );
    }

    // The write form of _forEachCidBatch: one statement per batch, in one transaction
    private _runForEachCidBatch(cids: string[], queryFor: (placeholders: string) => string): void {
        const BATCH = 4096;
        const run = this._db.transaction(() => {
            for (let start = 0; start < cids.length; start += BATCH) {
                const batch = cids.slice(start, start + BATCH);
                this._prepareCached(queryFor(new Array(batch.length).fill("?").join(","))).run(...batch);
            }
        });
        run();
    }

    queryAllCommentCidsAndTheirReplies(): { cid: string; allPageCids: string[] }[] {
        const log = Logger("pkc-js:local-community:db-handler:queryAllCidsUnderThisCommunity");

        const rows = this._db
            .prepare(
                `SELECT c.cid AS cid, cu.replies AS replies
                 FROM ${TABLES.COMMENTS} c
                 LEFT JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid`
            )
            .all() as { cid: string; replies?: string | null }[];

        return rows.map((row) => {
            const allPageCids: string[] = [];
            if (typeof row.replies === "string" && row.replies.length > 0) {
                try {
                    const parsed = JSON.parse(row.replies) as Record<string, DbRepliesSortEntry>;
                    for (const sortEntry of Object.values(parsed)) {
                        if (sortEntry?.allPageCids) allPageCids.push(...sortEntry.allPageCids);
                    }
                } catch (e) {
                    log.error(`Failed to parse replies JSON for comment ${row.cid} when collecting cids`, e);
                }
            }
            return { cid: row.cid, allPageCids };
        });
    }

    // Every post (depth 0) that survives the exclusion options, with its DB-format replies (CID refs) still attached;
    // callers resolve those with resolveRepliesCidRefsForEntries. Scoring is the page sort's job (issue #73).
    queryPosts(
        pageOptions: Omit<PageOptions, "pageSize" | "preloadedPage" | "baseTimestamp" | "firstPageSizeBytes">
    ): PageIpfs["comments"] {
        const mapper = this._pageEntryMapper(pageOptions.commentUpdateFieldsToExclude);

        const params: Record<string, string> = {};
        const postsWhereClauses = ["c.depth = 0"];
        if (pageOptions.excludeCommentsWithDifferentCommunityAddress) {
            const { clause, params: addrParams } = this._communityAddressClauseNamed("c", "asPosts");
            postsWhereClauses.push(clause);
            Object.assign(params, addrParams);
        }
        if (pageOptions.excludeRemovedComments) postsWhereClauses.push(this._removedClause("cu"));
        if (pageOptions.excludeDeletedComments) postsWhereClauses.push(this._deletedFromUpdatesClause("cu"));
        if (pageOptions.excludeCommentPendingApproval) postsWhereClauses.push(this._pendingApprovalClause("c"));
        if (pageOptions.excludeCommentWithApprovedFalse) postsWhereClauses.push(this._approvedClause("cu"));

        const postsQueryStr = `
            SELECT ${mapper.selectList(
                (col) => `c.${col}`,
                (col) => `cu.${col}`
            )}
            FROM ${TABLES.COMMENTS} c INNER JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid
            WHERE ${postsWhereClauses.join(" AND ")}
        `;
        const rows = this._prepareCached(postsQueryStr).raw(true).all(params) as unknown[][];
        return rows.map(mapper.map);
    }

    // queryPosts plus the built-in active score: the bump time the CommentUpdate carries (max of the post's own
    // timestamp and lastReplyTimestamp), the same number the active page sort file and a client compute. Kept as one
    // entry point for "posts with their bump score" for the migration tests.
    queryPostsWithActiveScore(
        pageOptions: Omit<PageOptions, "pageSize" | "preloadedPage" | "baseTimestamp" | "firstPageSizeBytes">
    ): (PageIpfs["comments"][0] & { activeScore: number })[] {
        return this.queryPosts(pageOptions).map((post) => ({
            ...post,
            activeScore: Math.max(post.comment.timestamp, post.commentUpdate.lastReplyTimestamp ?? 0)
        }));
    }

    // Every reply (depth > 0) in the community, or under one post, with no exclusions applied: the one reply set a
    // generation loads for its requireReplies sorts, each of which then filters it with its own exclusion options
    // through applyPageSortExclusions (the same filter a client applies) and slices each comment's subtree from it
    // (createDescendantsLookup). Lean on purpose (PageSortReplyEntry): a fixed column list mapped by hand, no
    // signature, no nested pages, no schema row parser, since a board can hold a million replies and this runs per
    // generation. A pending-approval reply is marked on its CommentUpdate the way the mod queue marks one, so the
    // filter can see it; the list never reaches a page.
    queryAllRepliesForPageSort(opts: { postCid?: string; postCids?: string[] } = {}): PageSortReplyEntry[] {
        // A list of posts streams in batches under the SQLite variable cap: what a post sort with requireReplies
        // scores over, one batch of posts' subtrees at a time (issue #351)
        if (opts.postCids) {
            const entries: PageSortReplyEntry[] = [];
            const BATCH = 4096;
            for (let start = 0; start < opts.postCids.length; start += BATCH) {
                const batch = opts.postCids.slice(start, start + BATCH);
                entries.push(...this._queryRepliesForPageSort(`c.postCid IN (${batch.map(() => "?").join(",")})`, batch));
            }
            return entries;
        }
        if (opts.postCid) return this._queryRepliesForPageSort("c.postCid = ?", [opts.postCid]);
        return this._queryRepliesForPageSort("1 = 1", []);
    }

    private _queryRepliesForPageSort(scopeClause: string, params: unknown[]): PageSortReplyEntry[] {
        const whereClauses = ["c.depth > 0", scopeClause];
        const query = `
            SELECT c.cid, c.parentCid, c.postCid, c.depth, c.timestamp, c.content, c.title, c.link, c.author, c.communityPublicKey,
                c.communityName, c.nsfw, c.spoiler, c.flairs, c.pendingApproval,
                cu.upvoteCount, cu.downvoteCount, cu.replyCount, cu.childCount, cu.updatedAt, cu.lastReplyTimestamp, cu.pinned,
                cu.locked, cu.removed, cu.approved, cu.nsfw AS cuNsfw, cu.spoiler AS cuSpoiler, cu.flairs AS cuFlairs,
                json_extract(cu.edit, '$.deleted') AS editDeleted
            FROM ${TABLES.COMMENTS} c INNER JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid
            WHERE ${whereClauses.join(" AND ")}
        `;
        // Raw rows: better-sqlite3 building an object per row is the dominant cost at a million rows (about 4x the
        // array form on the benchmark in test/benchmarks), and the entry shape is fixed anyway.
        type Row = [
            cid: string,
            parentCid: string,
            postCid: string,
            depth: number,
            timestamp: number,
            content: string | null,
            title: string | null,
            link: string | null,
            author: string,
            communityPublicKey: string | null,
            communityName: string | null,
            nsfw: number | null,
            spoiler: number | null,
            flairs: string | null,
            pendingApproval: number | null,
            upvoteCount: number,
            downvoteCount: number,
            replyCount: number,
            childCount: number,
            updatedAt: number,
            lastReplyTimestamp: number | null,
            pinned: number | null,
            locked: number | null,
            removed: number | null,
            approved: number | null,
            cuNsfw: number | null,
            cuSpoiler: number | null,
            cuFlairs: string | null,
            editDeleted: number | null
        ];
        const rows = this._prepareCached(query)
            .raw(true)
            .all(...params) as Row[];
        const entries: PageSortReplyEntry[] = new Array(rows.length);
        for (let i = 0; i < rows.length; i++) {
            const [
                cid,
                parentCid,
                postCid,
                depth,
                timestamp,
                content,
                title,
                link,
                author,
                communityPublicKey,
                communityName,
                nsfw,
                spoiler,
                flairs,
                pendingApproval,
                upvoteCount,
                downvoteCount,
                replyCount,
                childCount,
                updatedAt,
                lastReplyTimestamp,
                pinned,
                locked,
                removed,
                approved,
                cuNsfw,
                cuSpoiler,
                cuFlairs,
                editDeleted
            ] = rows[i];
            const comment: PageSortReplyEntry["comment"] = { parentCid, postCid, depth, timestamp, author: JSON.parse(author) };
            if (content !== null) comment.content = content;
            if (title !== null) comment.title = title;
            if (link !== null) comment.link = link;
            if (communityPublicKey !== null) comment.communityPublicKey = communityPublicKey;
            if (communityName !== null) comment.communityName = communityName;
            if (nsfw !== null) comment.nsfw = Boolean(nsfw);
            if (spoiler !== null) comment.spoiler = Boolean(spoiler);
            if (flairs !== null) comment.flairs = JSON.parse(flairs);
            const commentUpdate: PageSortReplyEntry["commentUpdate"] = {
                cid,
                upvoteCount,
                downvoteCount,
                replyCount,
                childCount,
                updatedAt
            };
            if (lastReplyTimestamp !== null) commentUpdate.lastReplyTimestamp = lastReplyTimestamp;
            if (pinned !== null) commentUpdate.pinned = Boolean(pinned);
            if (locked !== null) commentUpdate.locked = Boolean(locked);
            if (removed !== null) commentUpdate.removed = Boolean(removed);
            if (approved !== null) commentUpdate.approved = Boolean(approved);
            if (cuNsfw !== null) commentUpdate.nsfw = Boolean(cuNsfw);
            if (cuSpoiler !== null) commentUpdate.spoiler = Boolean(cuSpoiler);
            if (cuFlairs !== null) commentUpdate.flairs = JSON.parse(cuFlairs);
            if (editDeleted) commentUpdate.edit = { deleted: true };
            if (pendingApproval) commentUpdate.pendingApproval = true;
            entries[i] = { comment, commentUpdate };
        }
        return entries;
    }

    private _processRecordsForDbBeforeInsert<T extends Record<string, any>>(records: T[]): T[] {
        return records.map((record) => {
            const processed = { ...record };
            for (const [key, value] of remedaEntries(processed)) {
                if (isPlainObject(value) || Array.isArray(value)) (processed as any)[key] = JSON.stringify(value);
                else if (typeof value === "boolean") (processed as any)[key] = value ? 1 : 0;
            }
            return processed;
        });
    }

    private _spreadExtraProps<T extends Record<string, any>>(record: T): T {
        const extraPropsNames = ["extraProps", "commentIpfs_extraProps", "commentUpdate_extaProps"];
        extraPropsNames.forEach((extraPropName) => {
            record = { ...record, ...record[extraPropName] };
            delete record[extraPropName];
        });
        // For old migrated rows (pre-wire-format-change), extraProps contains subplebbitAddress.
        // The original CommentIpfs did NOT have communityPublicKey/communityName,
        // so we must remove them to preserve CID reproducibility.
        if ("subplebbitAddress" in record) {
            delete record["communityPublicKey"];
            delete record["communityName"];
        }
        return record;
    }
}

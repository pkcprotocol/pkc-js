import {
    getEquivalentSubplebbitAddresses,
    hideClassPrivateProps,
    isStringDomain,
    removeNullUndefinedValues,
    timestamp
} from "../../../util.js";
import { PlebbitError } from "../../../plebbit-error.js";
import path from "path";
import assert from "assert";
import fs from "fs";
import os from "os";
import Logger from "@plebbit/plebbit-logger";
import { deleteOldSubplebbitInWindows, getDefaultSubplebbitDbConfig } from "../util.js";
import env from "../../../version.js";
import Database, { type Database as BetterSqlite3Database } from "better-sqlite3";
import { sha256 } from "js-sha256";

//@ts-expect-error
import * as lockfile from "@plebbit/proper-lockfile";
import type { PageOptions } from "./page-generator.js";
import type {
    InternalSubplebbitRecordAfterFirstUpdateType,
    InternalSubplebbitRecordBeforeFirstUpdateType,
    SubplebbitStats
} from "../../../subplebbit/types.js";
import { LocalSubplebbit } from "./local-subplebbit.js";
import { getPlebbitAddressFromPublicKey, getPlebbitAddressFromPublicKeySync } from "../../../signer/util.js";
import * as remeda from "remeda";
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
    SubplebbitAuthor
} from "../../../publications/comment/types.js";
import { CommentIpfsSchema, CommentUpdateSchema } from "../../../publications/comment/schema.js";
import { verifyCommentEdit, verifyCommentIpfs } from "../../../signer/signatures.js";
import type { PageIpfs, RepliesPagesTypeIpfs } from "../../../pages/types.js";
import type { CommentModerationsTableRowInsert, CommentModerationTableRow } from "../../../publications/comment-moderation/types.js";
import { getSubplebbitChallengeFromSubplebbitChallengeSettings, plebbitJsChallenges } from "./challenges/index.js";
import KeyvBetterSqlite3 from "./keyv-better-sqlite3.js";

import { STORAGE_KEYS } from "../../../constants.js";
import { CommentEditPubsubMessagePublicationSchema } from "../../../publications/comment-edit/schema.js";
import { TIMEFRAMES_TO_SECONDS } from "../../../pages/util.js";
import type { VotesTableRow, VotesTableRowInsert } from "../../../publications/vote/types.js";
import {
    parseCommentEditsRow,
    parseCommentUpdateRow,
    parseCommentsTableRow,
    parsePrefixedComment,
    parseVoteRow,
    type PrefixedCommentRow
} from "./db-row-parser.js";
import { ZodError } from "zod";
import { messages } from "../../../errors.js";
import type { PseudonymityAliasRow, CommentCidWithReplies, PurgedCommentTableRows } from "./db-handler-types.js";
import { getAuthorDomainFromWire } from "../../../publications/publication-author.js";

const TABLES = Object.freeze({
    COMMENTS: "comments",
    COMMENT_UPDATES: "commentUpdates",
    VOTES: "votes",
    COMMENT_MODERATIONS: "commentModerations",
    COMMENT_EDITS: "commentEdits",
    PSEUDONYMITY_ALIASES: "pseudonymityAliases"
});

export class DbHandler {
    _db!: BetterSqlite3Database;
    private _subplebbit!: LocalSubplebbit;
    private _transactionDepth!: number;
    private _dbConfig!: { filename: string } & Database.Options;
    private _keyv!: KeyvBetterSqlite3;
    private _createdTables: boolean;

    constructor(subplebbit: DbHandler["_subplebbit"]) {
        this._subplebbit = subplebbit;
        this._transactionDepth = 0;
        this._createdTables = false;
        hideClassPrivateProps(this);
    }

    private _parsePrefixedComment(row: PrefixedCommentRow) {
        const parsed = parsePrefixedComment(row);

        const comment = removeNullUndefinedValues(this._spreadExtraProps(parsed.comment)) as CommentIpfsType;
        const commentUpdate = removeNullUndefinedValues(this._spreadExtraProps(parsed.commentUpdate)) as CommentUpdateType;

        return {
            comment,
            commentUpdate,
            extras: parsed.extras
        };
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

    async initDbConfigIfNeeded() {
        if (!this._dbConfig) this._dbConfig = await getDefaultSubplebbitDbConfig(this._subplebbit.address, this._subplebbit._plebbit);
    }

    toJSON() {
        return undefined;
    }

    async initDbIfNeeded(dbConfigOptions?: Partial<DbHandler["_dbConfig"]>) {
        const log = Logger("plebbit-js:local-subplebbit:db-handler:initDbIfNeeded");
        assert(
            typeof this._subplebbit.address === "string" && this._subplebbit.address.length > 0,
            `DbHandler needs to be an instantiated with a Subplebbit that has a valid address, (${this._subplebbit.address}) was provided`
        );
        await this.initDbConfigIfNeeded();
        const dbFilePath = this._dbConfig.filename;
        if (!this._db || !this._db.open) {
            this._db = new Database(dbFilePath, { ...this._dbConfig, ...dbConfigOptions });
            try {
                this._db.pragma("journal_mode = WAL");
            } catch (e) {
                log(`Could not set WAL journal mode for ${dbFilePath}`, e);
                throw e;
            }
            log("initialized a new connection to db", dbFilePath);
        }
        if (!this._keyv) this._keyv = new KeyvBetterSqlite3(this._db);
    }

    async createOrMigrateTablesIfNeeded() {
        const log = Logger("plebbit-js:local-subplebbit:db-handler:createOrMigrateTablesIfNeeded");
        if (this._createdTables) return;

        try {
            await this._createOrMigrateTablesIfNeeded();
        } catch (e) {
            await this.initDbIfNeeded();
            log.error(
                `Sub (${this._subplebbit.address}) failed to create/migrate tables. Current db version (${this.getDbVersion()}), latest db version (${env.DB_VERSION}). Error`,
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
        const log = Logger("plebbit-js:local-subplebbit:dbHandler:destroyConnection");
        if (this._db && this._db.open) {
            this._db.exec("PRAGMA checkpoint"); // write all wal to disk
            this._db.close();
        }
        if (this._keyv) this._keyv.disconnect();

        //@ts-expect-error
        this._db = this._keyv = undefined;
        this._transactionDepth = 0;

        log("Destroyed DB connection to sub", this._subplebbit.address, "successfully");
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
        const log = Logger("plebbit-js:local-subplebbit:db-handler:rollbackTransaction");
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
        const log = Logger("plebbit-js:local-subplebbit:db-handler:rollbackAllTransactions");
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
                extraProps TEXT NULLABLE, -- JSON
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
                replies TEXT NULLABLE, -- JSON
                lastChildCid TEXT NULLABLE,
                lastReplyTimestamp INTEGER NULLABLE, 
                postUpdatesBucket INTEGER NULLABLE,
                publishedToPostUpdatesMFS INTEGER NOT NULL, -- BOOLEAN (0/1)
                insertedAt INTEGER NOT NULL 
            )
        `);
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
                originalAuthorSignerPublicKey TEXT NOT NULL,
                originalAuthorDomain TEXT NULLABLE, -- the original author's domain address (e.g., user.eth) if they used one
                mode TEXT NOT NULL CHECK(mode IN ('per-post', 'per-reply', 'per-author')),
                insertedAt INTEGER NOT NULL
            )
        `);
    }

    getDbVersion(): number {
        const result = this._db.pragma("user_version", { simple: true }) as number;
        return Number(result);
    }

    _migrateOldSettings(oldSettings: InternalSubplebbitRecordBeforeFirstUpdateType["settings"]) {
        const fieldsToRemove = ["post", "reply", "vote"] as const;
        const newSettings = remeda.clone(oldSettings);
        if (Array.isArray(newSettings.challenges)) {
            // Filter out challenges that reference removed built-in names
            newSettings.challenges = newSettings.challenges.filter((cs) => !cs.name || cs.path || cs.name in plebbitJsChallenges);
            for (const oldChallengeSetting of newSettings.challenges)
                if (oldChallengeSetting.exclude)
                    for (const oldExcludeSetting of oldChallengeSetting.exclude)
                        for (const fieldToMove of fieldsToRemove) delete oldExcludeSetting[fieldToMove];
        }
        return newSettings;
    }

    async _createOrMigrateTablesIfNeeded() {
        const log = Logger("plebbit-js:local-subplebbit:db-handler:createOrMigrateTablesIfNeeded");
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

            const internalState = this.keyvHas(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_SUBPLEBBIT])
                ? ((await this.keyvGet(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_SUBPLEBBIT])) as
                      | InternalSubplebbitRecordAfterFirstUpdateType
                      | InternalSubplebbitRecordBeforeFirstUpdateType)
                : undefined;
            if (internalState) {
                const protocolVersion = internalState.protocolVersion || env.PROTOCOL_VERSION;
                const _usingDefaultChallenge =
                    "_usingDefaultChallenge" in internalState
                        ? internalState._usingDefaultChallenge
                        : //@ts-expect-error
                          remeda.isDeepEqual(this._subplebbit._defaultSubplebbitChallenges, internalState?.settings?.challenges);
                const updateCid: string =
                    "updateCid" in internalState && typeof internalState.updateCid === "string"
                        ? internalState.updateCid
                        : "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f";
                const newSettings = this._migrateOldSettings(internalState.settings);
                const newChallenges = newSettings.challenges
                    ? await Promise.all(
                          newSettings.challenges?.map((cs) =>
                              getSubplebbitChallengeFromSubplebbitChallengeSettings(cs, this._subplebbit._plebbit)
                          )
                      )
                    : newSettings.challenges;
                await this._subplebbit._updateDbInternalState({
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
        if (needToMigrate)
            log(`Created/migrated the tables to the latest (${newDbVersion}) version and saved to path`, this._dbConfig.filename);
        if (backupDbPath) await fs.promises.rm(backupDbPath);
    }

    private _tableExists(tableName: string): boolean {
        const stmt = this._db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?");
        return !!stmt.get(tableName);
    }

    private _backfillApprovedCommentNumbers() {
        const log = Logger("plebbit-js:local-subplebbit:db-handler:_backfillApprovedCommentNumbers");
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
        const log = Logger("plebbit-js:local-subplebbit:db-handler:_backfillTargetAuthorSignerAddress");

        // Find comment moderations that have author-related edits (bans/flairs) but no targetAuthorSignerAddress
        const moderationsToUpdate = this._db
            .prepare(
                `
            SELECT cm.rowid, cm.commentCid, c.authorSignerAddress,
                   pa.originalAuthorSignerPublicKey
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
            originalAuthorSignerPublicKey: string | null;
        }[];

        if (moderationsToUpdate.length === 0) return;

        const updateStmt = this._db.prepare(`UPDATE ${TABLES.COMMENT_MODERATIONS} SET targetAuthorSignerAddress = ? WHERE rowid = ?`);

        const updateMany = this._db.transaction((items: typeof moderationsToUpdate) => {
            for (const mod of items) {
                let targetAddress: string | null = null;

                // If the comment was published with pseudonymity, use the original author's address
                if (mod.originalAuthorSignerPublicKey) {
                    try {
                        targetAddress = getPlebbitAddressFromPublicKeySync(mod.originalAuthorSignerPublicKey);
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
        const log = Logger("plebbit-js:local-subplebbit:db-handler:_backfillTargetAuthorDomain");

        // Find comment moderations that have author-related edits (bans/flairs) but no targetAuthorDomain
        // and the comment author used a domain address
        const moderationsToUpdate = this._db
            .prepare(
                `
            SELECT cm.rowid, c.author as commentAuthor,
                   pa.originalAuthorDomain
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
            originalAuthorDomain: string | null;
        }[];

        if (moderationsToUpdate.length === 0) return;

        const updateStmt = this._db.prepare(`UPDATE ${TABLES.COMMENT_MODERATIONS} SET targetAuthorDomain = ? WHERE rowid = ?`);

        let updatedCount = 0;
        const updateMany = this._db.transaction((items: typeof moderationsToUpdate) => {
            for (const mod of items) {
                let targetDomain: string | null = null;

                // If the comment was published with pseudonymity, use the original author's domain
                if (mod.originalAuthorDomain) {
                    targetDomain = mod.originalAuthorDomain;
                } else if (mod.commentAuthor) {
                    try {
                        const author = JSON.parse(mod.commentAuthor) as { address?: string; name?: string };
                        targetDomain = getAuthorDomainFromWire(author) || null;
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

    private async _copyTable(srcTable: string, dstTable: string, currentDbVersion: number) {
        const log = Logger("plebbit-js:local-subplebbit:db-handler:createTablesIfNeeded:copyTable");
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
                    const extraProps = removeNullUndefinedValues(remeda.pick(srcRecord, commentEditFieldsNotIncludedAnymore)) as Record<
                        string,
                        any
                    >;

                    if (Object.keys(extraProps).length > 0) srcRecord.extraProps = { ...srcRecord.extraProps, ...extraProps };
                }
                if (currentDbVersion <= 12 && srcRecord["authorAddress"] && srcRecord["signature"]) {
                    const sig = typeof srcRecord.signature === "string" ? JSON.parse(srcRecord.signature) : srcRecord.signature;
                    srcRecord["authorSignerAddress"] = await getPlebbitAddressFromPublicKey(sig["publicKey"]);
                }
                if (srcTable === TABLES.COMMENTS) {
                    const commentIpfsFieldsNotIncludedAnymore = ["ipnsName"];
                    const extraProps = removeNullUndefinedValues(remeda.pick(srcRecord, commentIpfsFieldsNotIncludedAnymore)) as Record<
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
        const log = Logger("plebbit-js:local-subplebbit:db-handler:_purgePublicationTablesWithDuplicateSignatures");
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
                    for (const row of purgedRows) await this._subplebbit._addAllCidsUnderPurgedCommentToBeRemoved(row);
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
        const log = Logger("plebbit-js:local-subplebbit:db-handler:_purgeCommentEditsWithInvalidSchemaOrSignature");

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
                CommentEditPubsubMessagePublicationSchema.strip().parse(commentEditRecord);
            } catch (e) {
                log.error(
                    `Comment edit (${commentEditRecord.commentCid}) row ${rawCommentEditRecord.rowid} in DB has an invalid schema and will be purged from comment edits table.`,
                    e
                );
                this._deleteCommentEditRow(rawCommentEditRecord.rowid);
                continue;
            }

            const commentEditPubsub = remeda.pick(commentEditRecord, [
                ...(commentEditRecord.signature.signedPropertyNames as CommentEditSignature["signedPropertyNames"]),
                "signature"
            ]) as CommentEditPubsubMessagePublication;
            const validRes = await verifyCommentEdit({
                edit: commentEditPubsub,
                resolveAuthorNames: false,
                clientsManager: this._subplebbit._clientsManager
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
        const log = Logger("plebbit-js:local-subplebbit:db-handler:_purgeCommentsWithInvalidSchema");

        const commentsOrderedByASC = this._db.prepare(`SELECT * FROM ${TABLES.COMMENTS} ORDER BY rowid ASC`).all() as CommentsTableRow[];

        for (const rawCommentRecord of commentsOrderedByASC) {
            let commentRecord: CommentsTableRow;
            try {
                commentRecord = this._parseCommentsTableRow(rawCommentRecord);
            } catch (error) {
                if (error instanceof ZodError) {
                    this.purgeComment(rawCommentRecord.cid);
                    continue;
                }
                throw error;
            }

            try {
                CommentIpfsSchema.strip().parse(commentRecord);
            } catch (e) {
                log.error(`Comment (${commentRecord.cid}) in DB has an invalid schema, will be purged.`, e);
                this.purgeComment(commentRecord.cid);
                continue;
            }
            const validRes = await verifyCommentIpfs({
                comment: { ...commentRecord, ...commentRecord.extraProps },
                resolveAuthorNames: false,
                calculatedCommentCid: commentRecord.cid,
                clientsManager: this._subplebbit._clientsManager
            });
            if (!validRes.valid) {
                log.error(`Comment ${commentRecord.cid} in DB has invalid signature due to ${validRes.reason}. Will be purged.`);
                this.purgeComment(commentRecord.cid);
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
            (cid, authorSignerAddress, author, link, linkWidth, linkHeight, thumbnailUrl, thumbnailUrlWidth, thumbnailUrlHeight, parentCid, postCid, previousCid, communityPublicKey, communityName, content, timestamp, signature, originalCommentSignatureEncoded, title, depth, linkHtmlTagName, flairs, spoiler, pendingApproval, number, postNumber, nsfw, pseudonymityMode, quotedCids, extraProps, protocolVersion, insertedAt)
            VALUES (@cid, @authorSignerAddress, @author, @link, @linkWidth, @linkHeight, @thumbnailUrl, @thumbnailUrlWidth, @thumbnailUrlHeight, @parentCid, @postCid, @previousCid, @communityPublicKey, @communityName, @content, @timestamp, @signature, @originalCommentSignatureEncoded, @title, @depth, @linkHtmlTagName, @flairs, @spoiler, @pendingApproval, @number, @postNumber, @nsfw, @pseudonymityMode, @quotedCids, @extraProps, @protocolVersion, @insertedAt)
        `);

        // Create default object with null values for all columns
        const defaults = remeda.mapToObj(columnNames, (column) => [column, null]);

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
        const processedAliases = this._processRecordsForDbBeforeInsert(aliases);
        const stmt = this._db.prepare(`
            INSERT OR REPLACE INTO ${TABLES.PSEUDONYMITY_ALIASES}
            (commentCid, aliasPrivateKey, originalAuthorSignerPublicKey, originalAuthorDomain, mode, insertedAt)
            VALUES (@commentCid, @aliasPrivateKey, @originalAuthorSignerPublicKey, @originalAuthorDomain, @mode, @insertedAt)
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

        const stmt = this._db.prepare(`
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

        const defaults = remeda.mapToObj(columnNames, (column) => [column, null]);

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

        const defaults = remeda.mapToObj(columnNames, (column) => [column, null]);
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

        const defaults = remeda.mapToObj(columnNames, (column) => [column, null]);
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
        const address = this._subplebbit.address;
        const addresses = getEquivalentSubplebbitAddresses(address);
        if (isStringDomain(address)) {
            // Domain-based: match communityName against equivalent domain variants
            const domainPlaceholders = addresses.map(() => "?").join(", ");
            return { clause: `${alias}.communityName IN (${domainPlaceholders})`, params: addresses };
        } else {
            // IPNS key: match communityPublicKey directly
            return { clause: `${alias}.communityPublicKey = ?`, params: [address] };
        }
    }

    private _communityAddressClauseNamed(alias: string, paramPrefix: string): { clause: string; params: Record<string, string> } {
        const address = this._subplebbit.address;
        const addresses = getEquivalentSubplebbitAddresses(address);
        if (isStringDomain(address)) {
            // Domain-based: match communityName against equivalent domain variants
            const params: Record<string, string> = {};
            const placeholders: string[] = [];
            addresses.forEach((addr, i) => {
                const paramName = `${paramPrefix}CommunityName${i}`;
                params[paramName] = addr;
                placeholders.push(`:${paramName}`);
            });
            return { clause: `${alias}.communityName IN (${placeholders.join(", ")})`, params };
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

        if (options.excludeCommentsWithDifferentSubAddress) {
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

    queryMaximumTimestampUnderComment(comment: Pick<CommentsTableRow, "cid">): number | undefined {
        const { clause: addrClause, params: addrParams } = this._communityAddressClause("c");
        const query = `
            WITH RECURSIVE descendants AS (
                SELECT c.cid, c.timestamp FROM ${TABLES.COMMENTS} c
                LEFT JOIN ${TABLES.COMMENT_UPDATES} cu ON cu.cid = c.cid
                WHERE c.parentCid = ?
                  AND COALESCE(cu.approved, 1) != 0
                  AND (c.pendingApproval IS NULL OR c.pendingApproval != 1)
                UNION ALL
                SELECT c.cid, c.timestamp FROM ${TABLES.COMMENTS} c
                INNER JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid
                LEFT JOIN (SELECT cid, json_extract(edit, '$.deleted') AS deleted_flag FROM ${TABLES.COMMENT_UPDATES}) AS d ON c.cid = d.cid
                JOIN descendants desc_nodes ON c.parentCid = desc_nodes.cid
                WHERE ${addrClause} AND (cu.removed IS NOT 1 AND cu.removed IS NOT TRUE) AND (d.deleted_flag IS NULL OR d.deleted_flag != 1)
                  AND COALESCE(cu.approved, 1) != 0
                  AND (c.pendingApproval IS NULL OR c.pendingApproval != 1)
            )
            SELECT MAX(timestamp) AS max_timestamp FROM descendants
        `;
        const result = this._db.prepare(query).get(comment.cid, ...addrParams) as { max_timestamp: number | null };

        if (result.max_timestamp === null) return undefined;
        return result.max_timestamp;
    }

    queryPageComments(options: Omit<PageOptions, "firstPageSizeBytes">): PageIpfs["comments"] {
        const commentUpdateCols = remeda.keys.strict(
            options.commentUpdateFieldsToExclude
                ? remeda.omit(CommentUpdateSchema.shape, options.commentUpdateFieldsToExclude)
                : CommentUpdateSchema.shape
        );
        const commentUpdateSelects = commentUpdateCols.map((col) => `${TABLES.COMMENT_UPDATES}.${col} AS commentUpdate_${col}`);
        const commentIpfsCols = [...remeda.keys.strict(CommentIpfsSchema.shape), "extraProps"];
        const commentIpfsSelects = commentIpfsCols.map((col) => `${TABLES.COMMENTS}.${col} AS commentIpfs_${col}`);

        const { whereClauses, params } = this._buildPageQueryParts(options);
        const queryStr = `
            SELECT ${commentIpfsSelects.join(", ")}, ${commentUpdateSelects.join(", ")}
            FROM ${TABLES.COMMENTS} INNER JOIN ${TABLES.COMMENT_UPDATES} ON ${TABLES.COMMENTS}.cid = ${TABLES.COMMENT_UPDATES}.cid
            WHERE ${whereClauses.join(" AND ")}
        `;

        const commentsRaw = this._db.prepare(queryStr).all(...params) as PrefixedCommentRow[];

        return commentsRaw.map((commentRaw) => {
            const { comment, commentUpdate } = this._parsePrefixedComment(commentRaw);
            return { comment, commentUpdate };
        });
    }

    queryFlattenedPageReplies(options: Omit<PageOptions, "firstPageSizeBytes"> & { parentCid: string }): PageIpfs["comments"] {
        const commentUpdateCols = remeda.keys.strict(
            options.commentUpdateFieldsToExclude
                ? remeda.omit(CommentUpdateSchema.shape, options.commentUpdateFieldsToExclude)
                : CommentUpdateSchema.shape
        );
        // TODO, is it omitting replies?
        const commentUpdateSelects = commentUpdateCols.map((col) => `c_updates.${col} AS commentUpdate_${col}`);
        const commentIpfsCols = [...remeda.keys.strict(CommentIpfsSchema.shape), "extraProps"];
        const commentIpfsSelects = commentIpfsCols.map((col) => `comments_alias.${col} AS commentIpfs_${col}`);

        let baseWhereClausesStr = "";
        let recursiveWhereClausesStr = "";
        const params: any[] = [options.parentCid];
        const baseFilterClauses: string[] = [];
        const recursiveFilterClauses: string[] = [];

        const commentsAlias = "comments";
        const commentUpdatesAlias = "c_updates";
        const deletedLookupAlias = "d";

        if (options.excludeCommentsWithDifferentSubAddress) {
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
            SELECT ${commentIpfsSelects.join(", ")}, ${commentUpdateCols.map((col) => `comments_alias.c_updates_${col} AS commentUpdate_${col}`).join(", ")}
            FROM comment_tree comments_alias
        `;

        const commentsRaw = this._db.prepare(query).all(...params) as (PrefixedCommentRow & { tree_level: number })[];
        return commentsRaw.map((commentRaw) => {
            const { comment, commentUpdate } = this._parsePrefixedComment(commentRaw);
            return { comment, commentUpdate };
        });
    }

    queryStoredCommentUpdate(comment: Pick<CommentsTableRow, "cid">): CommentUpdatesRow | undefined {
        const row = this._db.prepare(`SELECT * FROM ${TABLES.COMMENT_UPDATES} WHERE cid = ?`).get(comment.cid) as
            | CommentUpdatesRow
            | undefined;
        if (!row) return undefined;
        return this._parseCommentUpdatesRow(row);
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
        const row = this._db
            .prepare(
                `SELECT * FROM ${TABLES.COMMENTS}
                 WHERE json_extract(signature, '$.signature') = ?
                    OR originalCommentSignatureEncoded = ?
                 LIMIT 1`
            )
            .get(signatureEncoded, signatureEncoded) as CommentsTableRow | undefined;
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
        const results = this._db
            .prepare(`SELECT * FROM ${TABLES.COMMENTS} WHERE pendingApproval = 1 ORDER BY rowid DESC`)
            .all() as CommentsTableRow[];
        return results.map((r) => this._parseCommentsTableRow(r));
    }

    queryCommentsToBeUpdated(): CommentsTableRow[] {
        // TODO optimize this query in the future
        // Make sure tests in commentsToUpdate.db.subplebbit.test.js are passing
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
            replies_json AS (
                SELECT
                    cu_parent.cid AS parentCid,
                    json_extract(comment_entry.value, '$.comment.cid') AS comment_child_cid,
                    json_extract(comment_entry.value, '$.commentUpdate.cid') AS update_child_cid,
                    json_extract(comment_entry.value, '$.commentUpdate.updatedAt') AS json_child_updated_at
                FROM ${TABLES.COMMENT_UPDATES} cu_parent
                INNER JOIN ${TABLES.COMMENTS} parent ON parent.cid = cu_parent.cid
                JOIN json_each(cu_parent.replies, '$.pages') pages
                JOIN json_each(pages.value, '$.comments') comment_entry
                WHERE cu_parent.replies IS NOT NULL
                  AND json_type(cu_parent.replies, '$.pages') = 'object'
                  AND (parent.pendingApproval IS NULL OR parent.pendingApproval != 1)
            ),
            stale_replies_json AS (
                SELECT r.parentCid AS cid
                FROM replies_json r
                LEFT JOIN ${TABLES.COMMENTS} existing_child ON existing_child.cid = COALESCE(r.comment_child_cid, r.update_child_cid)
                LEFT JOIN ${TABLES.COMMENT_UPDATES} actual_child_update ON actual_child_update.cid = COALESCE(r.comment_child_cid, r.update_child_cid)
                WHERE COALESCE(r.comment_child_cid, r.update_child_cid) IS NOT NULL
                  AND (
                      existing_child.cid IS NULL
                      OR actual_child_update.cid IS NULL
                      OR (
                          r.json_child_updated_at IS NOT NULL
                              AND actual_child_update.cid IS NOT NULL
                              AND CAST(r.json_child_updated_at AS INTEGER) < actual_child_update.updatedAt
                      )
                  )
                GROUP BY r.parentCid
            ),
            base_updates AS (
                SELECT * FROM direct_updates
                UNION SELECT c.* FROM ${TABLES.COMMENTS} c JOIN stale_child_counts scc ON c.cid = scc.cid
                UNION SELECT c.* FROM ${TABLES.COMMENTS} c JOIN stale_last_child_cids slc ON c.cid = slc.cid
                UNION SELECT c.* FROM ${TABLES.COMMENTS} c JOIN stale_replies_json srj ON c.cid = srj.cid
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
        const results = this._db.prepare(query).all() as CommentsTableRow[];
        return results.map((r) => this._parseCommentsTableRow(r));
    }

    querySubplebbitStats(): SubplebbitStats {
        // if you change this logic, make sure to run stats.subplebbit.test.js
        const now = timestamp(); // All timestamps are in seconds
        const { clause: commentAddrClause, params: commentAddrParams } = this._communityAddressClauseNamed("comments", "statsComments");
        const { clause: votesAddrClause, params: votesAddrParams } = this._communityAddressClauseNamed("comments_for_votes", "statsVotes");
        const removedCommentsClause = this._removedClause("cu_comments");
        const deletedCommentsClause = this._deletedFromUpdatesClause("cu_comments");
        const removedVotesClause = this._removedClause("cu_votes");
        const deletedVotesClause = this._deletedFromUpdatesClause("cu_votes");
        const pendingCommentsClause = this._pendingApprovalClause("comments");
        type PostAndReplyCounts = Pick<
            SubplebbitStats,
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
                    alias.originalAuthorSignerPublicKey AS originalAuthorSignerPublicKey
                FROM ${TABLES.PSEUDONYMITY_ALIASES} AS alias
                INNER JOIN ${TABLES.COMMENTS} AS comments ON comments.cid = alias.commentCid
                WHERE comments.authorSignerAddress IN (${aliasPlaceholders})
            `;
            const aliasRows = this._db.prepare(aliasesQuery).all(...uniqueActiveAddresses) as {
                aliasSignerAddress: string;
                originalAuthorSignerPublicKey: string;
            }[];
            for (const aliasRow of aliasRows) {
                let originalAuthorAddress: string;
                try {
                    originalAuthorAddress = getPlebbitAddressFromPublicKeySync(aliasRow.originalAuthorSignerPublicKey);
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
            SubplebbitStats,
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
        const row = this._db.prepare(`SELECT * FROM ${TABLES.COMMENTS} WHERE cid = ?`).get(cid) as CommentsTableRow | undefined;
        if (!row) return undefined;
        return this._parseCommentsTableRow(row);
    }

    queryPseudonymityAliasByCommentCid(commentCid: string): PseudonymityAliasRow | undefined {
        const row = this._db
            .prepare(
                `SELECT commentCid, aliasPrivateKey, originalAuthorSignerPublicKey, originalAuthorDomain, mode, insertedAt FROM ${TABLES.PSEUDONYMITY_ALIASES} WHERE commentCid = ?`
            )
            .get(commentCid) as PseudonymityAliasRow | undefined;
        return row;
    }

    queryPseudonymityAliasForPost(originalAuthorSignerPublicKey: string, postCid: string): PseudonymityAliasRow | undefined {
        const row = this._db
            .prepare(
                `
            SELECT alias.commentCid, alias.aliasPrivateKey, alias.originalAuthorSignerPublicKey, alias.originalAuthorDomain, alias.mode, alias.insertedAt
            FROM ${TABLES.PSEUDONYMITY_ALIASES} AS alias
            INNER JOIN ${TABLES.COMMENTS} AS comments ON comments.cid = alias.commentCid
            WHERE alias.mode = 'per-post' AND alias.originalAuthorSignerPublicKey = ? AND comments.postCid = ?
            ORDER BY alias.insertedAt ASC
            LIMIT 1
        `
            )
            .get(originalAuthorSignerPublicKey, postCid) as PseudonymityAliasRow | undefined;
        return row;
    }

    queryPseudonymityAliasForAuthor(originalAuthorSignerPublicKey: string): PseudonymityAliasRow | undefined {
        const row = this._db
            .prepare(
                `
            SELECT commentCid, aliasPrivateKey, originalAuthorSignerPublicKey, originalAuthorDomain, mode, insertedAt
            FROM ${TABLES.PSEUDONYMITY_ALIASES}
            WHERE mode = 'per-author' AND originalAuthorSignerPublicKey = ?
            ORDER BY insertedAt ASC
            LIMIT 1
        `
            )
            .get(originalAuthorSignerPublicKey) as PseudonymityAliasRow | undefined;
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

    private _queryCommentCounts(cid: string): Pick<CommentUpdateType, "replyCount" | "upvoteCount" | "downvoteCount" | "childCount"> {
        const { clause: addrClause, params: addrParams } = this._communityAddressClauseNamed("c", "cc");
        const query = `
        SELECT
            (SELECT COUNT(*) FROM ${TABLES.VOTES} WHERE commentCid = :cid AND vote = 1) AS upvoteCount,
            (SELECT COUNT(*) FROM ${TABLES.VOTES} WHERE commentCid = :cid AND vote = -1) AS downvoteCount,
            (
                WITH RECURSIVE descendants AS (
                    SELECT c.cid FROM ${TABLES.COMMENTS} c
                    INNER JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid
                    LEFT JOIN (SELECT cid, json_extract(edit, '$.deleted') AS deleted_flag FROM ${TABLES.COMMENT_UPDATES}) AS d ON c.cid = d.cid
                    WHERE c.parentCid = :cid AND ${addrClause} AND (cu.removed IS NOT 1 AND cu.removed IS NOT TRUE) AND (d.deleted_flag IS NULL OR d.deleted_flag != 1)
                    UNION ALL
                    SELECT c.cid FROM ${TABLES.COMMENTS} c
                    INNER JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid
                    LEFT JOIN (SELECT cid, json_extract(edit, '$.deleted') AS deleted_flag FROM ${TABLES.COMMENT_UPDATES}) AS d ON c.cid = d.cid
                    JOIN descendants desc_nodes ON c.parentCid = desc_nodes.cid
                    WHERE ${addrClause} AND (cu.removed IS NOT 1 AND cu.removed IS NOT TRUE) AND (d.deleted_flag IS NULL OR d.deleted_flag != 1)
                ) SELECT COUNT(*) FROM descendants
            ) AS replyCount,
            (
                SELECT COUNT(*) FROM ${TABLES.COMMENTS} c
                INNER JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid
                LEFT JOIN (SELECT cid, json_extract(edit, '$.deleted') AS deleted_flag FROM ${TABLES.COMMENT_UPDATES}) AS d ON c.cid = d.cid
                WHERE c.parentCid = :cid AND ${addrClause} AND (cu.removed IS NOT 1 AND cu.removed IS NOT TRUE) AND (d.deleted_flag IS NULL OR d.deleted_flag != 1)
            ) AS childCount
        `;
        return this._db.prepare(query).get({ cid, ...addrParams }) as Pick<
            CommentUpdateType,
            "replyCount" | "upvoteCount" | "downvoteCount" | "childCount"
        >;
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
        return this._db.prepare(query).all(...addrParams, maxBucket) as {
            cid: string;
            timestamp: number;
            currentBucket: number;
            newBucket: number;
        }[];
    }

    private _queryLatestAuthorEdit(cid: string, authorSignerAddress: string): CommentEditPubsubMessagePublication | undefined {
        const row = this._db
            .prepare(
                `
            SELECT * FROM ${TABLES.COMMENT_EDITS}
            WHERE commentCid = ? AND authorSignerAddress = ? AND (isAuthorEdit = 1)
            ORDER BY rowid DESC LIMIT 1
        `
            )
            .get(cid, authorSignerAddress) as CommentEditsTableRow | undefined;
        if (!row) return undefined;

        const parsed = this._spreadExtraProps(this._parseCommentEditsRow(row));

        const signedKeys = parsed.signature.signedPropertyNames as CommentEditSignature["signedPropertyNames"];

        const commentEditFields = remeda.keys.strict(CommentEditPubsubMessagePublicationSchema.shape);

        return remeda.pick(parsed, ["signature", ...signedKeys, ...commentEditFields]) as CommentEditPubsubMessagePublication;
    }

    removeCommentFromPendingApproval(comment: Pick<CommentsTableRow, "cid">): void {
        const log = Logger("plebbit-js:local-subplebbit:db-handler:removeCommentFromPendingApproval");
        const stmt = this._db.prepare(`UPDATE ${TABLES.COMMENTS} SET pendingApproval = 0 WHERE cid = ?`);
        const res = stmt.run(comment.cid);
        log.trace(`Removed pendingApproval for cid=${comment.cid}, changes=${res.changes}`);
    }

    approvePendingComment(comment: Pick<CommentsTableRow, "cid">): { number?: number; postNumber?: number } {
        const log = Logger("plebbit-js:local-subplebbit:db-handler:approvePendingComment");
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
        const log = Logger("plebbit-js:local-subplebbit:db-handler:removeOldestPendingCommentIfWeHitMaxPendingCount");

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
        const log = Logger("plebbit-js:local-subplebbit:db-handler:purgeDisapprovedCommentsOlderThan");
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

    private _queryLatestModeratorReason(comment: Pick<CommentsTableRow, "cid">): Pick<CommentUpdateType, "reason"> | undefined {
        const result = this._db
            .prepare(
                `
            SELECT json_extract(commentModeration, '$.reason') AS reason FROM ${TABLES.COMMENT_MODERATIONS}
            WHERE commentCid = ? AND json_extract(commentModeration, '$.reason') IS NOT NULL ORDER BY rowid DESC LIMIT 1
        `
            )
            .get(comment.cid) as { reason: string } | undefined;
        if (!result) return undefined;
        return result;
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
        const flags = this._db.prepare(query).get(cid) as
            | Record<keyof Pick<CommentUpdateType, "spoiler" | "pinned" | "locked" | "archived" | "removed" | "nsfw">, 0 | 1 | null>
            | undefined;
        if (!flags) return {};

        return remeda.mapValues(removeNullUndefinedValues(flags), Boolean);
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

    private _queryModCommentFlairs(
        comment: Pick<CommentsTableRow, "cid">
    ): { flairs?: CommentModerationTableRow["commentModeration"]["flairs"] } | undefined {
        const result = this._db
            .prepare(
                `
            SELECT json_extract(commentModeration, '$.flairs') AS flairs FROM ${TABLES.COMMENT_MODERATIONS}
            WHERE commentCid = ? AND json_extract(commentModeration, '$.flairs') IS NOT NULL ORDER BY rowid DESC LIMIT 1
        `
            )
            .get(comment.cid) as { flairs: string } | undefined;
        if (!result) return undefined;
        return { flairs: JSON.parse(result.flairs) as CommentModerationTableRow["commentModeration"]["flairs"] };
    }

    private _queryLastChildCidAndLastReplyTimestamp(comment: Pick<CommentsTableRow, "cid">) {
        const lastChildCid = this._db
            .prepare(
                `SELECT c.cid FROM ${TABLES.COMMENTS} c
                 INNER JOIN ${TABLES.COMMENT_UPDATES} cu ON cu.cid = c.cid
                 LEFT JOIN (
                     SELECT cid, json_extract(edit, '$.deleted') AS deleted_flag FROM ${TABLES.COMMENT_UPDATES}
                 ) deleted_lookup ON deleted_lookup.cid = c.cid
                 WHERE c.parentCid = ?
                   AND (c.pendingApproval IS NULL OR c.pendingApproval != 1)
                   AND COALESCE(cu.approved, 1) != 0
                   AND (cu.removed IS NOT 1 AND cu.removed IS NOT TRUE)
                   AND (deleted_lookup.deleted_flag IS NULL OR deleted_lookup.deleted_flag != 1)
                 ORDER BY c.rowid DESC
                 LIMIT 1`
            )
            .get(comment.cid) as { cid: string } | undefined;
        const lastReplyTimestamp = this.queryMaximumTimestampUnderComment(comment);
        return { lastChildCid: lastChildCid?.cid, lastReplyTimestamp };
    }

    _queryIsCommentApproved(
        comment: Pick<CommentsTableRow, "cid" | "authorSignerAddress" | "timestamp">
    ): { approved: boolean } | undefined {
        const result = this._db
            .prepare(
                `
            SELECT json_extract(commentModeration, '$.approved') AS approved FROM ${TABLES.COMMENT_MODERATIONS}
            WHERE commentCid = ? AND json_extract(commentModeration, '$.approved') IS NOT NULL ORDER BY rowid DESC LIMIT 1
        `
            )
            .get(comment.cid) as { approved: 0 | 1 | boolean | null } | undefined;
        if (!result || result.approved === null) return undefined;
        return { approved: Boolean(result.approved) };
    }

    private _calculateCommentNumbers(cid: string): { number?: number; postNumber?: number } {
        const commentRowMeta = this._db
            .prepare(`SELECT rowid as rowid, depth, pendingApproval, number, postNumber FROM ${TABLES.COMMENTS} WHERE cid = ?`)
            .get(cid) as
            | { rowid: number; depth: number; pendingApproval: number | null; number: number | null; postNumber: number | null }
            | undefined;
        if (!commentRowMeta) throw Error(`Failed to query row metadata for comment ${cid}`);
        if (commentRowMeta.pendingApproval === 1) return {};

        let commentNumber = typeof commentRowMeta.number === "number" && commentRowMeta.number > 0 ? commentRowMeta.number : undefined;
        let postNumber =
            typeof commentRowMeta.postNumber === "number" && commentRowMeta.postNumber > 0 ? commentRowMeta.postNumber : undefined;

        if (commentNumber === undefined || (commentRowMeta.depth === 0 && postNumber === undefined)) {
            const existingNumbers = this._db
                .prepare(`SELECT number, postNumber FROM ${TABLES.COMMENT_UPDATES} WHERE cid = ? LIMIT 1`)
                .get(cid) as { number: number | null; postNumber: number | null } | undefined;

            if (commentNumber === undefined && typeof existingNumbers?.number === "number" && existingNumbers.number > 0)
                commentNumber = existingNumbers.number;
            if (commentRowMeta.depth === 0 && postNumber === undefined) {
                if (typeof existingNumbers?.postNumber === "number" && existingNumbers.postNumber > 0)
                    postNumber = existingNumbers.postNumber;
            }
        }

        return {
            ...(commentNumber !== undefined ? { number: commentNumber } : undefined),
            ...(postNumber !== undefined ? { postNumber } : undefined)
        };
    }

    queryCalculatedCommentUpdate(opts: {
        comment: Pick<CommentsTableRow, "cid" | "authorSignerAddress" | "timestamp">;
        authorDomain?: string;
    }): Omit<CommentUpdateType, "signature" | "updatedAt" | "replies" | "protocolVersion"> {
        const { comment, authorDomain } = opts;

        const authorSubplebbit = this.querySubplebbitAuthorForCommentUpdate({
            authorSignerAddress: comment.authorSignerAddress,
            commentCid: comment.cid,
            authorDomain
        });
        const authorEdit = this._queryLatestAuthorEdit(comment.cid, comment.authorSignerAddress);
        const commentUpdateCounts = this._queryCommentCounts(comment.cid);
        const moderatorReason = this._queryLatestModeratorReason(comment);
        const commentFlags = this.queryCommentFlagsSetByMod(comment.cid);
        const commentModFlairs = this._queryModCommentFlairs(comment);
        const lastChildAndLastReplyTimestamp = this._queryLastChildCidAndLastReplyTimestamp(comment);
        const isThisCommentApproved = this._queryIsCommentApproved(comment);
        const removedFromApproved = isThisCommentApproved?.approved === false ? { removed: true } : undefined; // automatically add removed:true if approved=false. Will be overridden if there's commentFlags.removed

        const { number: commentNumber, postNumber } = this._calculateCommentNumbers(comment.cid);

        if (!authorSubplebbit) throw Error("Failed to query author.subplebbit in queryCalculatedCommentUpdate");
        return {
            ...(removedFromApproved ? removedFromApproved : undefined),
            cid: comment.cid,
            ...(commentNumber !== undefined ? { number: commentNumber } : undefined),
            ...(postNumber !== undefined ? { postNumber } : undefined),
            ...commentUpdateCounts,
            flairs: commentModFlairs?.flairs || authorEdit?.flairs,
            ...commentFlags,
            reason: moderatorReason?.reason,
            author: { subplebbit: authorSubplebbit },
            ...lastChildAndLastReplyTimestamp,
            ...(authorEdit ? { edit: authorEdit } : undefined),
            ...(isThisCommentApproved ? { approved: isThisCommentApproved.approved } : undefined)
        };
    }

    queryLatestPostCid(): Pick<CommentsTableRow, "cid"> | undefined {
        return this._db
            .prepare(
                `SELECT c.cid FROM ${TABLES.COMMENTS} c
                 LEFT JOIN ${TABLES.COMMENT_UPDATES} cu ON cu.cid = c.cid
                 WHERE c.depth = 0
                   AND c.pendingApproval IS NOT 1
                   AND COALESCE(cu.approved, 1) != 0
                 ORDER BY c.rowid DESC
                 LIMIT 1`
            )
            .get() as Pick<CommentsTableRow, "cid"> | undefined;
    }

    queryLatestCommentCid(): Pick<CommentsTableRow, "cid"> | undefined {
        return this._db
            .prepare(
                `SELECT c.cid FROM ${TABLES.COMMENTS} c
                 LEFT JOIN ${TABLES.COMMENT_UPDATES} cu ON cu.cid = c.cid
                 WHERE c.pendingApproval IS NOT 1
                   AND COALESCE(cu.approved, 1) != 0
                 ORDER BY c.rowid DESC
                 LIMIT 1`
            )
            .get() as Pick<CommentsTableRow, "cid"> | undefined;
    }

    queryAllCommentsOrderedByIdAsc(): CommentsTableRow[] {
        const results = this._db.prepare(`SELECT * FROM ${TABLES.COMMENTS} ORDER BY rowid ASC`).all() as CommentsTableRow[];
        return results.map((r) => this._parseCommentsTableRow(r));
    }

    queryAuthorModEdits(opts: {
        authorSignerAddresses: string[];
        authorDomain?: string;
    }): Pick<SubplebbitAuthor, "banExpiresAt" | "flairs"> {
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
        const modAuthorEditsRaw = this._db
            .prepare(
                `
            SELECT json_extract(commentModeration, '$.author') AS commentAuthorJson FROM ${TABLES.COMMENT_MODERATIONS}
            WHERE (${conditions.join(" OR ")}) AND json_extract(commentModeration, '$.author') IS NOT NULL ORDER BY rowid DESC
        `
            )
            .all(...params) as { commentAuthorJson: string }[];

        const modAuthorEdits = modAuthorEditsRaw.map(
            (r) => JSON.parse(r.commentAuthorJson) as CommentModerationTableRow["commentModeration"]["author"]
        );
        const banAuthor = modAuthorEdits.find((modEdit) => typeof modEdit?.banExpiresAt === "number");
        const authorFlairsByMod = modAuthorEdits.find((modEdit) => modEdit?.flairs);
        const aggregateAuthor: Pick<SubplebbitAuthor, "banExpiresAt" | "flairs"> = {};
        if (banAuthor?.banExpiresAt) aggregateAuthor.banExpiresAt = banAuthor.banExpiresAt;
        if (authorFlairsByMod?.flairs) aggregateAuthor.flairs = authorFlairsByMod.flairs;
        return aggregateAuthor;
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

    querySubplebbitAuthor(authorSignerAddress: string, authorDomain?: string): SubplebbitAuthor | undefined {
        const authorSignerAddresses = new Set<string>([authorSignerAddress]);

        // If the provided address is the original signer, include all alias signer addresses for that author.
        const aliasRowsForOriginal = this._db
            .prepare(
                `
            SELECT alias.commentCid, alias.originalAuthorSignerPublicKey
            FROM ${TABLES.PSEUDONYMITY_ALIASES} AS alias
        `
            )
            .all() as Pick<PseudonymityAliasRow, "commentCid" | "originalAuthorSignerPublicKey">[];
        for (const aliasRow of aliasRowsForOriginal) {
            try {
                const originalAddress = getPlebbitAddressFromPublicKeySync(aliasRow.originalAuthorSignerPublicKey);
                if (originalAddress === authorSignerAddress) {
                    const commentRow = this._db
                        .prepare(`SELECT authorSignerAddress FROM ${TABLES.COMMENTS} WHERE cid = ?`)
                        .get(aliasRow.commentCid) as { authorSignerAddress?: string } | undefined;
                    if (commentRow?.authorSignerAddress) authorSignerAddresses.add(commentRow.authorSignerAddress);
                }
            } catch {
                // ignore malformed keys
            }
        }

        // If the provided address is an alias, include the original signer address for that alias.
        const aliasRowsForAliasAddress = this._db
            .prepare(
                `
            SELECT alias.originalAuthorSignerPublicKey
            FROM ${TABLES.PSEUDONYMITY_ALIASES} AS alias
            INNER JOIN ${TABLES.COMMENTS} AS comments ON comments.cid = alias.commentCid
            WHERE comments.authorSignerAddress = ?
        `
            )
            .all(authorSignerAddress) as Pick<PseudonymityAliasRow, "originalAuthorSignerPublicKey">[];
        for (const aliasRow of aliasRowsForAliasAddress) {
            try {
                const originalAddress = getPlebbitAddressFromPublicKeySync(aliasRow.originalAuthorSignerPublicKey);
                authorSignerAddresses.add(originalAddress);
            } catch {
                // ignore malformed keys
            }
        }

        return this._querySubplebbitAuthorByAddresses([...authorSignerAddresses], undefined, authorDomain);
    }

    /** Shared helper: query karma for a set of addresses, with optional separate addresses for mod edits */
    private _querySubplebbitAuthorByAddresses(
        karmaAddresses: string[],
        modEditAddresses: string[] = karmaAddresses,
        authorDomain?: string
    ): SubplebbitAuthor | undefined {
        if (karmaAddresses.length === 0) return undefined;
        const placeholders = karmaAddresses.map(() => "?").join(", ");

        const modAuthorEdits = this.queryAuthorModEdits({ authorSignerAddresses: modEditAddresses, authorDomain });

        const authorCommentsData = this._db
            .prepare(
                `
            SELECT c.depth, c.rowid, c.timestamp, c.cid,
                   COALESCE(SUM(CASE WHEN v.vote = 1 THEN 1 ELSE 0 END), 0) as upvoteCount,
                   COALESCE(SUM(CASE WHEN v.vote = -1 THEN 1 ELSE 0 END), 0) as downvoteCount
            FROM ${TABLES.COMMENTS} c LEFT JOIN ${TABLES.VOTES} v ON c.cid = v.commentCid
            WHERE c.authorSignerAddress IN (${placeholders}) GROUP BY c.cid
        `
            )
            .all(...karmaAddresses) as (Pick<CommentsTableRow, "depth" | "timestamp" | "cid"> & {
            rowid: number;
            upvoteCount: number;
            downvoteCount: number;
        })[];

        if (authorCommentsData.length === 0) {
            if (Object.keys(modAuthorEdits).length > 0) {
                return modAuthorEdits as SubplebbitAuthor;
            }
            return undefined;
        }

        const authorPosts = authorCommentsData.filter((c) => c.depth === 0);
        const authorReplies = authorCommentsData.filter((c) => c.depth > 0);
        const postScore = remeda.sumBy(authorPosts, (p) => p.upvoteCount) - remeda.sumBy(authorPosts, (p) => p.downvoteCount);
        const replyScore = remeda.sumBy(authorReplies, (r) => r.upvoteCount) - remeda.sumBy(authorReplies, (r) => r.downvoteCount);
        const lastCommentCid = remeda.maxBy(authorCommentsData, (c) => c.rowid)?.cid;
        if (!lastCommentCid) throw Error("Failed to query subplebbitAuthor.lastCommentCid");
        const firstCommentTimestamp = remeda.minBy(authorCommentsData, (c) => c.rowid)?.timestamp;
        if (typeof firstCommentTimestamp !== "number") throw Error("Failed to query subplebbitAuthor.firstCommentTimestamp");
        return { postScore, replyScore, lastCommentCid, ...modAuthorEdits, firstCommentTimestamp };
    }

    /**
     * Returns author.subplebbit for CommentUpdates, respecting pseudonymity mode boundaries.
     *
     * The alias address already encodes the isolation boundary:
     * - per-reply: Each reply has a unique alias, so querying by alias = that one comment's karma
     * - per-post: All comments in a thread share an alias, so querying by alias = thread karma
     * - per-author: One alias for all comments, so querying by alias = total karma
     *
     * We query karma for ONLY the alias address (no lookup to other aliases like querySubplebbitAuthor does),
     * but include mod edits from both alias and original author.
     */
    querySubplebbitAuthorForCommentUpdate(opts: {
        authorSignerAddress: string;
        commentCid: string;
        authorDomain?: string;
    }): SubplebbitAuthor | undefined {
        const { authorSignerAddress, commentCid, authorDomain } = opts;

        // Check if this comment has a pseudonymity alias
        const aliasRow = this.queryPseudonymityAliasByCommentCid(commentCid);
        if (!aliasRow) {
            // No pseudonymity mode - use standard aggregated karma
            return this.querySubplebbitAuthor(authorSignerAddress, authorDomain);
        }

        // Get original author's address for mod edits (bans/flairs are applied to original author)
        const modEditAddresses = [authorSignerAddress];
        try {
            const originalAddress = getPlebbitAddressFromPublicKeySync(aliasRow.originalAuthorSignerPublicKey);
            if (originalAddress !== authorSignerAddress) {
                modEditAddresses.push(originalAddress);
            }
        } catch {
            // ignore malformed keys
        }

        // For mod edits (bans/flairs), use the original author's domain if available
        const modEditDomain = aliasRow.originalAuthorDomain || authorDomain;

        // Query karma for just this alias, but mod edits from both alias and original
        return this._querySubplebbitAuthorByAddresses([authorSignerAddress], modEditAddresses, modEditDomain);
    }

    private _getAllDescendantCids(cid: string): string[] {
        const allCids: string[] = [cid];
        const directChildren = this._db.prepare(`SELECT cid FROM ${TABLES.COMMENTS} WHERE parentCid = ?`).all(cid) as { cid: string }[];

        for (const child of directChildren) {
            allCids.push(...this._getAllDescendantCids(child.cid));
        }

        return allCids;
    }

    purgeComment(cid: string, isNestedCall: boolean = false): PurgedCommentTableRows[] {
        const log = Logger("plebbit-js:local-subplebbit:db-handler:purgeComment");
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

            const commentUpdate = this.queryStoredCommentUpdate({ cid });
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
                const placeholders = allCidsToBeDeleted.map(() => "?").join(",");
                const randomComment = this._db
                    .prepare(`SELECT cid FROM ${TABLES.COMMENTS} WHERE cid NOT IN (${placeholders}) ORDER BY RANDOM() LIMIT 1`)
                    .get(...allCidsToBeDeleted) as { cid: string } | undefined;
                if (randomComment) {
                    allCommentsToUpdate.push(randomComment.cid);
                    log(`Forcing update on random comment ${randomComment.cid} to ensure IPNS update after purge`);
                } else {
                    log(`No comments left to force update after purge - IPNS will update to show empty subplebbit`);
                }

                if (allCommentsToUpdate.length > 0) {
                    this.forceUpdateOnAllCommentsWithCid(allCommentsToUpdate);
                }
            }

            if (!isNestedCall) this.commitTransaction();
            const uniquePurgedRecords = remeda.uniqueBy(purgedRecords, (record) => record.commentTableRow.cid);
            return uniquePurgedRecords;
        } catch (error) {
            log.error(`Error during comment purge for ${cid}: ${error}`);
            if (!isNestedCall) this.rollbackTransaction();
            throw error;
        }
    }

    async changeDbFilename(oldDbName: string, newDbName: string) {
        const log = Logger("plebbit-js:local-subplebbit:db-handler:changeDbFilename");
        if (this._db || this._keyv) await this.destoryConnection();

        this._transactionDepth = 0;

        const dataPath = this._subplebbit._plebbit.dataPath!;
        const oldPathString = path.join(dataPath, "subplebbits", oldDbName);
        const newPathString = path.join(dataPath, "subplebbits", newDbName);
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
                if (os.type() === "Windows_NT") await deleteOldSubplebbitInWindows(oldPathString, this._subplebbit._plebbit);
                else await fs.promises.rm(oldPathString, { force: true });
            }
        } catch (error) {
            log.error(`Failed to backup/rename database from ${oldPathString} to ${newPathString}: `, error);
            throw error;
        }
        this._dbConfig = { ...this._dbConfig, filename: newPathString };
        log(`Changed db path from (${oldPathString}) to (${newPathString})`);
    }

    async lockSubStart(subAddress = this._subplebbit.address) {
        const log = Logger("plebbit-js:local-subplebbit:db-handler:lock:start");

        const lockfilePath = path.join(this._subplebbit._plebbit.dataPath!, "subplebbits", `${subAddress}.start.lock`);
        const subDbPath = path.join(this._subplebbit._plebbit.dataPath!, "subplebbits", subAddress);

        try {
            await lockfile.lock(subDbPath, {
                lockfilePath,
                onCompromised: () => {} // Temporary bandaid for the moment. Should be deleted later
            });
            log(`Locked the start of subplebbit (${subAddress}) successfully`);
        } catch (e: unknown) {
            if (e instanceof Error && e.message === "Lock file is already being held")
                throw new PlebbitError("ERR_SUB_ALREADY_STARTED", { subplebbitAddress: subAddress, error: e });
            else {
                log(`Error while trying to lock start of sub (${subAddress}): ${e}`);
                throw e;
            }
        }
    }

    async unlockSubStart(subAddress = this._subplebbit.address) {
        const log = Logger("plebbit-js:local-subplebbit:db-handler:unlock:start");
        log.trace(`Attempting to unlock the start of sub (${subAddress})`);

        const lockfilePath = path.join(this._subplebbit._plebbit.dataPath!, "subplebbits", `${subAddress}.start.lock`);
        const subDbPath = path.join(this._subplebbit._plebbit.dataPath!, "subplebbits", subAddress);
        if (!fs.existsSync(lockfilePath) || !fs.existsSync(subDbPath)) return;

        try {
            await lockfile.unlock(subDbPath, { lockfilePath });
            log(`Unlocked start of sub (${subAddress})`);
        } catch (e: unknown) {
            log(`Error while trying to unlock start of sub (${subAddress}): ${e}`);
            throw e;
        }
    }

    async isSubStartLocked(subAddress = this._subplebbit.address): Promise<boolean> {
        const lockfilePath = path.join(this._subplebbit._plebbit.dataPath!, "subplebbits", `${subAddress}.start.lock`);
        const subDbPath = path.join(this._subplebbit._plebbit.dataPath!, "subplebbits", subAddress);
        const isLocked = await lockfile.check(subDbPath, { lockfilePath, realpath: false, stale: 10000 });
        return isLocked;
    }

    // Subplebbit state lock

    async lockSubState() {
        const log = Logger("plebbit-js:local-subplebbit:db-handler:lock:lockSubState");
        const lockfilePath = path.join(this._subplebbit._plebbit.dataPath!, "subplebbits", `${this._subplebbit.address}.state.lock`);
        const subDbPath = path.join(this._subplebbit._plebbit.dataPath!, "subplebbits", this._subplebbit.address);
        try {
            await lockfile.lock(subDbPath, {
                lockfilePath,
                retries: 5,
                onCompromised: () => {}
            });
        } catch (e: unknown) {
            log.error(`Error when attempting to lock sub state`, this._subplebbit.address, e);
            if (e instanceof Error && e.message === "Lock file is already being held")
                throw new PlebbitError("ERR_SUB_STATE_LOCKED", { subplebbitAddress: this._subplebbit.address, error: e });
            // Not sure, do we need to throw error here
        }
    }

    async unlockSubState() {
        const log = Logger("plebbit-js:local-subplebbit:db-handler:lock:unlockSubState");

        const lockfilePath = path.join(this._subplebbit._plebbit.dataPath!, "subplebbits", `${this._subplebbit.address}.state.lock`);
        const subDbPath = path.join(this._subplebbit._plebbit.dataPath!, "subplebbits", this._subplebbit.address);
        if (!fs.existsSync(lockfilePath)) return;
        try {
            await lockfile.unlock(subDbPath, { lockfilePath });
        } catch (e: unknown) {
            log.error(`Error when attempting to unlock sub state`, this._subplebbit.address, e);
            if (e instanceof Error && "code" in e && e.code !== "ENOTACQUIRED") throw e;
        }
    }

    subDbExists() {
        const subDbPath = path.join(this._subplebbit._plebbit.dataPath!, "subplebbits", this._subplebbit.address);
        return fs.existsSync(subDbPath);
    }

    markCommentsAsPublishedToPostUpdates(commentCids: string[]): void {
        if (commentCids.length === 0) return;
        const stmt = this._db.prepare(
            `UPDATE ${TABLES.COMMENT_UPDATES} SET publishedToPostUpdatesMFS = 1 WHERE cid IN (${commentCids.map(() => "?").join(",")})`
        );
        stmt.run(...commentCids);
    }

    forceUpdateOnAllComments(): void {
        this._db.prepare(`UPDATE ${TABLES.COMMENT_UPDATES} SET publishedToPostUpdatesMFS = 0`).run();
    }

    forceUpdateOnAllCommentsWithCid(commentCids: string[]): void {
        if (commentCids.length === 0) return;
        this._db
            .prepare(
                `UPDATE ${TABLES.COMMENT_UPDATES} SET publishedToPostUpdatesMFS = 0 WHERE cid IN (${commentCids.map(() => "?").join(",")})`
            )
            .run(...commentCids);
    }

    queryAllCommentCidsAndTheirReplies(): CommentCidWithReplies[] {
        const log = Logger("plebbit-js:local-subplebbit:db-handler:queryAllCidsUnderThisSubplebbit");

        const rows = this._db
            .prepare(
                `SELECT 
                     c.cid AS cid,
                     CASE
                         WHEN cu.replies IS NULL THEN NULL
                         ELSE json_set(
                             cu.replies,
                             '$.pages',
                             (
                                 SELECT json_group_object(
                                     pages.key,
                                     json_set(pages.value, '$.comments', json('[]'))
                                 )
                                 FROM json_each(cu.replies, '$.pages') AS pages
                             )
                         )
                     END AS replies
                 FROM ${TABLES.COMMENTS} c
                 LEFT JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid`
            )
            .all() as { cid: string; replies?: string | null }[];

        return rows.map((row) => {
            let parsedReplies: CommentUpdatesRow["replies"];
            if (typeof row.replies === "string" && row.replies.length > 0) {
                try {
                    parsedReplies = JSON.parse(row.replies) as CommentUpdatesRow["replies"];
                } catch (e) {
                    log.error(`Failed to parse replies JSON for comment ${row.cid} when collecting cids`, e);
                }
            }
            return { cid: row.cid, replies: parsedReplies };
        });
    }

    queryPostsWithActiveScore(
        pageOptions: Omit<PageOptions, "pageSize" | "preloadedPage" | "baseTimestamp" | "firstPageSizeBytes">
    ): (PageIpfs["comments"][0] & { activeScore: number })[] {
        const { clause: rootAddrClause, params: rootAddrParams } = this._communityAddressClauseNamed("p", "asRoot");
        const { clause: descAddrClause, params: descAddrParams } = this._communityAddressClauseNamed("c", "asDesc");
        const { clause: postsAddrClause, params: postsAddrParams } = this._communityAddressClauseNamed("c", "asPosts");

        const activeScoreRootConditions = ["p.depth = 0"];
        if (pageOptions.excludeCommentsWithDifferentSubAddress) activeScoreRootConditions.push(rootAddrClause);
        if (pageOptions.excludeCommentPendingApproval) activeScoreRootConditions.push(this._pendingApprovalClause("p"));
        if (pageOptions.excludeRemovedComments) activeScoreRootConditions.push(this._removedClause("cu_root"));
        if (pageOptions.excludeDeletedComments) activeScoreRootConditions.push(this._deletedFromUpdatesClause("cu_root"));
        if (pageOptions.excludeCommentWithApprovedFalse) activeScoreRootConditions.push(this._approvedClause("cu_root"));
        const activeScoreRootWhere = `WHERE ${activeScoreRootConditions.join(" AND ")}`;

        const activeScoreDescendantConditions: string[] = [];
        if (pageOptions.excludeCommentsWithDifferentSubAddress) activeScoreDescendantConditions.push(descAddrClause);
        if (pageOptions.excludeCommentPendingApproval) activeScoreDescendantConditions.push(this._pendingApprovalClause("c"));
        if (pageOptions.excludeRemovedComments) activeScoreDescendantConditions.push(this._removedClause("cu"));
        if (pageOptions.excludeDeletedComments) activeScoreDescendantConditions.push(this._deletedFromLookupClause("deleted_lookup"));
        if (pageOptions.excludeCommentWithApprovedFalse) activeScoreDescendantConditions.push(this._approvedClause("cu"));
        const activeScoreDescendantWhere =
            activeScoreDescendantConditions.length > 0 ? `WHERE ${activeScoreDescendantConditions.join(" AND ")}` : "";

        const activeScoresCte = `
            WITH RECURSIVE descendants AS (
                SELECT p.cid AS post_cid, p.cid AS current_cid, p.timestamp
                FROM ${TABLES.COMMENTS} p
                INNER JOIN ${TABLES.COMMENT_UPDATES} cu_root ON p.cid = cu_root.cid
                ${activeScoreRootWhere}
                UNION ALL
                SELECT desc_tree.post_cid, c.cid AS current_cid, c.timestamp FROM ${TABLES.COMMENTS} c
                INNER JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid
                LEFT JOIN (SELECT cid, json_extract(edit, '$.deleted') AS deleted_flag FROM ${TABLES.COMMENT_UPDATES}) AS deleted_lookup ON c.cid = deleted_lookup.cid
                JOIN descendants desc_tree ON c.parentCid = desc_tree.current_cid
                ${activeScoreDescendantWhere}
            ) SELECT post_cid, MAX(timestamp) as active_score FROM descendants GROUP BY post_cid
        `;
        const commentUpdateCols = remeda.keys.strict(
            pageOptions.commentUpdateFieldsToExclude
                ? remeda.omit(CommentUpdateSchema.shape, pageOptions.commentUpdateFieldsToExclude)
                : CommentUpdateSchema.shape
        );
        const commentUpdateSelects = commentUpdateCols.map((col) => `cu.${col} AS commentUpdate_${col}`);
        const commentIpfsCols = [...remeda.keys.strict(CommentIpfsSchema.shape), "extraProps"];
        const commentIpfsSelects = commentIpfsCols.map((col) => `c.${col} AS commentIpfs_${col}`);

        let postsQueryStr = `
            SELECT ${commentIpfsSelects.join(", ")}, ${commentUpdateSelects.join(", ")}, asc_scores.active_score
            FROM ${TABLES.COMMENTS} c INNER JOIN ${TABLES.COMMENT_UPDATES} cu ON c.cid = cu.cid
            INNER JOIN (${activeScoresCte}) AS asc_scores ON c.cid = asc_scores.post_cid
        `;
        const params: Record<string, any> = { ...rootAddrParams, ...descAddrParams };

        const postsWhereClauses = ["c.depth = 0"];

        if (pageOptions.excludeCommentsWithDifferentSubAddress) {
            postsWhereClauses.push(postsAddrClause);
            Object.assign(params, postsAddrParams);
        }
        if (pageOptions.excludeRemovedComments) postsWhereClauses.push(this._removedClause("cu"));
        if (pageOptions.excludeDeletedComments) postsWhereClauses.push(this._deletedFromUpdatesClause("cu"));
        if (pageOptions.excludeCommentPendingApproval) postsWhereClauses.push(this._pendingApprovalClause("c"));
        if (pageOptions.excludeCommentWithApprovedFalse) postsWhereClauses.push(this._approvedClause("cu"));

        postsQueryStr += ` WHERE ${postsWhereClauses.join(" AND ")}`;

        const postsRaw = this._db.prepare(postsQueryStr).all(params) as (PrefixedCommentRow & { active_score: number })[];
        return postsRaw.map((postRaw) => {
            const { comment, commentUpdate } = this._parsePrefixedComment(postRaw);
            return {
                comment,
                commentUpdate,
                activeScore: postRaw.active_score
            };
        });
    }

    private _processRecordsForDbBeforeInsert<T extends Record<string, any>>(records: T[]): T[] {
        return records.map((record) => {
            const processed = { ...record };
            for (const [key, value] of remeda.entries(processed)) {
                if (remeda.isPlainObject(value) || Array.isArray(value)) (processed as any)[key] = JSON.stringify(value);
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
        return record;
    }
}

import { it, beforeEach, afterEach } from "vitest";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { JsonSignature } from "../../../dist/node/signer/types.js";
import type { CommentsTableRowInsert } from "../../../dist/node/publications/comment/types.js";
import type { CommentEditsTableRowInsert } from "../../../dist/node/publications/comment-edit/types.js";
import type { CommentModerationsTableRowInsert } from "../../../dist/node/publications/comment-moderation/types.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { PurgedCommentTableRows } from "../../../dist/node/runtime/node/community/db-handler-types.js";

interface FakeCommunity {
    address: string;
    _pkc: { noData: boolean };
    _cidsToUnPin: Set<string>;
    _blocksToRm: string[];
    _mfsPathsToRemove: Set<string>;
    _clientsManager: object;
    _calculateLocalMfsPathForCommentUpdate: () => string;
    _addOldPageCidsToCidsToUnpin: () => Promise<void>;
    _addAllCidsUnderPurgedCommentToBeRemoved: (purgedCommentAndCommentUpdate: PurgedCommentTableRows) => void;
}

interface InsertCommentOptions {
    cid?: string;
    signatureValue?: string;
    depth?: number;
    parentCid?: string | null;
    postCid?: string;
    timestamp?: number;
    insertedAt?: number;
}

interface InsertEditOrModerationOptions {
    timestamp?: number;
    insertedAt?: number;
}

interface DbRow {
    rowid: number;
    signature: string;
    cid?: string;
    [key: string]: string | number | null | undefined;
}

describeSkipIfRpc("db-handler duplicate signature purge during migration", function () {
    let dbHandler: DbHandler | undefined;
    let communityAddress: string;
    let cidCounter = 0;
    const protocolVersion = "1.0.0";

    const nextCid = (prefix = "QmTest"): string => `${prefix}${(cidCounter++).toString().padStart(4, "0")}`;
    const currentTimestamp = (): number => Math.floor(Date.now() / 1000);
    const makeSignature = (signatureValue: string): JsonSignature => ({
        type: "ed25519",
        signature: signatureValue,
        publicKey: `pk-${signatureValue}`,
        signedPropertyNames: []
    });

    async function createTestDbHandler(): Promise<DbHandler> {
        const fakePKC = { noData: true };
        const fakeCommunity: FakeCommunity = {
            address: communityAddress,
            _pkc: fakePKC,
            _cidsToUnPin: new Set<string>(),
            _blocksToRm: [],
            _mfsPathsToRemove: new Set<string>(),
            _clientsManager: {},
            _calculateLocalMfsPathForCommentUpdate: () => "",
            async _addOldPageCidsToCidsToUnpin() {},
            _addAllCidsUnderPurgedCommentToBeRemoved(purgedCommentAndCommentUpdate: PurgedCommentTableRows) {
                this._cidsToUnPin.add(purgedCommentAndCommentUpdate.commentTableRow.cid);
                this._blocksToRm.push(purgedCommentAndCommentUpdate.commentTableRow.cid);
                if (typeof purgedCommentAndCommentUpdate.commentUpdateTableRow?.postUpdatesBucket === "number") {
                    const localCommentUpdatePath = this._calculateLocalMfsPathForCommentUpdate();
                    this._mfsPathsToRemove.add(localCommentUpdatePath);
                }
                if (purgedCommentAndCommentUpdate.commentUpdateTableRow?.replies) {
                    this._addOldPageCidsToCidsToUnpin().catch(() => {});
                }
            }
        };
        const handler = new DbHandler(fakeCommunity as unknown as LocalCommunity);
        await handler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await handler.createOrMigrateTablesIfNeeded();
        return handler;
    }

    const insertComment = ({
        cid = nextCid(),
        signatureValue,
        depth = 0,
        parentCid = null,
        postCid,
        timestamp,
        insertedAt
    }: InsertCommentOptions = {}): { cid: string } => {
        const resolvedTimestamp = timestamp ?? currentTimestamp();
        const resolvedPostCid = postCid ?? (depth === 0 ? cid : parentCid ?? nextCid("post"));
        const authorSignerAddress = `12D3KooAuthor${cid}`;

        const commentToInsert: CommentsTableRowInsert = {
            cid,
            authorSignerAddress,
            author: { address: authorSignerAddress },
            link: null,
            linkWidth: null,
            linkHeight: null,
            thumbnailUrl: null,
            thumbnailUrlWidth: null,
            thumbnailUrlHeight: null,
            parentCid: depth === 0 ? null : parentCid,
            postCid: resolvedPostCid,
            previousCid: null,
            communityPublicKey: communityAddress,
            content: `content-${cid}`,
            timestamp: resolvedTimestamp,
            signature: makeSignature(signatureValue ?? `comment-${cid}`),
            title: depth === 0 ? `title-${cid}` : null,
            depth,
            linkHtmlTagName: null,
            flairs: null,
            spoiler: false,
            pendingApproval: false,
            nsfw: false,
            extraProps: null,
            protocolVersion,
            insertedAt: insertedAt ?? resolvedTimestamp
        };

        dbHandler!.insertComments([commentToInsert]);

        return { cid };
    };

    const insertCommentEdit = (
        commentCid: string,
        signatureValue: string,
        { timestamp, insertedAt }: InsertEditOrModerationOptions = {}
    ): void => {
        const resolvedTimestamp = timestamp ?? currentTimestamp();
        const resolvedInsertedAt = insertedAt ?? resolvedTimestamp;
        const authorSignerAddress = `12D3KooEdit${commentCid}${signatureValue}`;

        const editToInsert: CommentEditsTableRowInsert = {
            commentCid,
            authorSignerAddress,
            author: {},
            signature: makeSignature(signatureValue),
            protocolVersion,
            communityPublicKey: communityAddress,
            timestamp: resolvedTimestamp,
            content: `edit-${commentCid}`,
            reason: null,
            deleted: false,
            flairs: null,
            spoiler: false,
            nsfw: false,
            isAuthorEdit: true,
            insertedAt: resolvedInsertedAt,
            extraProps: null
        };

        dbHandler!.insertCommentEdits([editToInsert]);
    };

    const insertCommentModeration = (
        commentCid: string,
        signatureValue: string,
        { timestamp, insertedAt }: InsertEditOrModerationOptions = {}
    ): void => {
        const resolvedTimestamp = timestamp ?? currentTimestamp();
        const resolvedInsertedAt = insertedAt ?? resolvedTimestamp;

        const moderationToInsert: CommentModerationsTableRowInsert = {
            commentCid,
            author: { address: `12D3KooModAuthor${commentCid}` },
            signature: makeSignature(signatureValue),
            modSignerAddress: `12D3KooMod${commentCid}${signatureValue}`,
            protocolVersion,
            communityPublicKey: communityAddress,
            timestamp: resolvedTimestamp,
            commentModeration: { approved: true },
            insertedAt: resolvedInsertedAt,
            extraProps: null
        };

        dbHandler!.insertCommentModerations([moderationToInsert]);
    };

    function extractSignature(serialized: string | object | null | undefined, pathSegments: string[]): string | undefined {
        if (serialized === null || serialized === undefined) return undefined;
        let parsed: Record<string, unknown> = serialized as Record<string, unknown>;
        try {
            parsed = typeof serialized === "string" ? JSON.parse(serialized) : serialized;
        } catch {
            return undefined;
        }
        return pathSegments.reduce<unknown>(
            (acc, segment) =>
                acc && typeof acc === "object" && segment in (acc as Record<string, unknown>)
                    ? (acc as Record<string, unknown>)[segment]
                    : undefined,
            parsed
        ) as string | undefined;
    }

    function rowsWithSignature(tableName: string, column: string, pathSegments: string[], targetSignature: string): DbRow[] {
        const db = (dbHandler as unknown as { _db: { prepare: (sql: string) => { all: () => DbRow[] } } })._db;
        const rows = db.prepare(`SELECT rowid, * FROM ${tableName}`).all();
        return rows.filter((row) => extractSignature(row[column] as string | null, pathSegments) === targetSignature);
    }

    beforeEach(async () => {
        communityAddress = `test-sub-${Date.now()}-${Math.random()}`;
        dbHandler = await createTestDbHandler();
        cidCounter = 0;
    });

    afterEach(async () => {
        if (dbHandler) {
            dbHandler.destoryConnection();
            dbHandler = undefined;
        }
    });

    it("purges duplicate comment signatures during migrations", async () => {
        const commentToKeep = insertComment({ signatureValue: "comment-keep" });
        const commentOriginal = insertComment({ signatureValue: "comment-duplicate" });
        const commentDuplicate = insertComment({ signatureValue: "comment-duplicate" });

        const commentDuplicatesBefore = rowsWithSignature("comments", "signature", ["signature"], "comment-duplicate");
        expect(commentDuplicatesBefore.map((row) => row.cid)).to.have.members([commentOriginal.cid, commentDuplicate.cid]);
        expect(commentDuplicatesBefore).to.have.lengthOf(2);

        const commentKeeps = rowsWithSignature("comments", "signature", ["signature"], "comment-keep");
        expect(commentKeeps.map((row) => row.cid)).to.deep.equal([commentToKeep.cid]);

        const dbHandlerWithPrivate = dbHandler as unknown as {
            _purgePublicationTablesWithDuplicateSignatures: () => void;
            _community: FakeCommunity;
        };
        dbHandlerWithPrivate._purgePublicationTablesWithDuplicateSignatures();

        const commentDuplicatesAfter = rowsWithSignature("comments", "signature", ["signature"], "comment-duplicate");
        expect(commentDuplicatesAfter.map((row) => row.cid)).to.deep.equal([commentOriginal.cid]);

        const unpinnedCids = Array.from(dbHandlerWithPrivate._community._cidsToUnPin);
        expect(unpinnedCids).to.include(commentDuplicate.cid);
    });

    it("purges duplicate comment edit signatures during migrations", async () => {
        const baseComment = insertComment({ signatureValue: "comment-base" });

        insertCommentEdit(baseComment.cid, "edit-keep");
        insertCommentEdit(baseComment.cid, "edit-duplicate");
        insertCommentEdit(baseComment.cid, "edit-duplicate");

        const editDuplicatesBefore = rowsWithSignature("commentEdits", "signature", ["signature"], "edit-duplicate");
        expect(editDuplicatesBefore).to.have.lengthOf(2);

        const editKeepsBefore = rowsWithSignature("commentEdits", "signature", ["signature"], "edit-keep");
        expect(editKeepsBefore).to.have.lengthOf(1);

        const dbHandlerWithPrivate = dbHandler as unknown as { _purgePublicationTablesWithDuplicateSignatures: () => void };
        dbHandlerWithPrivate._purgePublicationTablesWithDuplicateSignatures();

        const editDuplicates = rowsWithSignature("commentEdits", "signature", ["signature"], "edit-duplicate");
        expect(editDuplicates).to.have.lengthOf(1);

        const editKeeps = rowsWithSignature("commentEdits", "signature", ["signature"], "edit-keep");
        expect(editKeeps).to.have.lengthOf(1);
    });

    it("purges duplicate comment moderation signatures during migrations", async () => {
        const baseComment = insertComment({ signatureValue: "comment-base" });

        insertCommentModeration(baseComment.cid, "mod-keep");
        insertCommentModeration(baseComment.cid, "mod-duplicate");
        insertCommentModeration(baseComment.cid, "mod-duplicate");

        const moderationDuplicatesBefore = rowsWithSignature("commentModerations", "signature", ["signature"], "mod-duplicate");
        expect(moderationDuplicatesBefore).to.have.lengthOf(2);

        const moderationKeepsBefore = rowsWithSignature("commentModerations", "signature", ["signature"], "mod-keep");
        expect(moderationKeepsBefore).to.have.lengthOf(1);

        const dbHandlerWithPrivate = dbHandler as unknown as { _purgePublicationTablesWithDuplicateSignatures: () => void };
        dbHandlerWithPrivate._purgePublicationTablesWithDuplicateSignatures();

        const moderationDuplicates = rowsWithSignature("commentModerations", "signature", ["signature"], "mod-duplicate");
        expect(moderationDuplicates).to.have.lengthOf(1);

        const moderationKeeps = rowsWithSignature("commentModerations", "signature", ["signature"], "mod-keep");
        expect(moderationKeeps).to.have.lengthOf(1);
    });
});

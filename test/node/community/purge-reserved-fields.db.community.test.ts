import { describe, it, beforeEach, afterEach, expect } from "vitest";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { deriveCommentIpfsFromCommentTableRow } from "../../../dist/node/runtime/node/util.js";
import { CommentIpfsReservedFields } from "../../../dist/node/publications/comment/schema.js";
import type { JsonSignature } from "../../../dist/node/signer/types.js";
import type { CommentsTableRowInsert } from "../../../dist/node/publications/comment/types.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { PurgedCommentTableRows } from "../../../dist/node/runtime/node/community/db-handler-types.js";
import * as remeda from "remeda";

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

interface DbHandlerPrivate {
    _db: import("better-sqlite3").Database;
    _purgeCommentsWithInvalidSchemaOrSignature: () => Promise<void>;
    _parseCommentsTableRow: (row: unknown) => CommentsTableRowInsert & { rowid?: number };
    _community: FakeCommunity;
}

const communityAddress = "12D3KooWTestCommunityPurge";
const protocolVersion = "1.0.0";

const makeSignature = (signatureValue: string): JsonSignature => ({
    type: "ed25519",
    signature: signatureValue,
    publicKey: `pk-${signatureValue}`,
    signedPropertyNames: ["content", "title", "author", "communityPublicKey", "protocolVersion", "timestamp"]
});

// This test exercises local DB internals and does not apply to RPC
describe(`_purgeCommentsWithInvalidSchemaOrSignature constructs CommentIpfs correctly`, function () {
    let dbHandler: DbHandler | undefined;

    async function createTestDbHandler(): Promise<DbHandler> {
        const fakeCommunity: FakeCommunity = {
            address: communityAddress,
            _pkc: { noData: true },
            _cidsToUnPin: new Set<string>(),
            _blocksToRm: [],
            _mfsPathsToRemove: new Set<string>(),
            _clientsManager: {},
            _calculateLocalMfsPathForCommentUpdate: () => "",
            async _addOldPageCidsToCidsToUnpin() {},
            _addAllCidsUnderPurgedCommentToBeRemoved(purgedCommentAndCommentUpdate: PurgedCommentTableRows) {
                this._cidsToUnPin.add(purgedCommentAndCommentUpdate.commentTableRow.cid);
                this._blocksToRm.push(purgedCommentAndCommentUpdate.commentTableRow.cid);
            }
        };
        const handler = new DbHandler(fakeCommunity as unknown as LocalCommunity);
        await handler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        // Stub purge methods during table creation so they don't run prematurely
        const priv = handler as unknown as DbHandlerPrivate;
        const origPurge = priv._purgeCommentsWithInvalidSchemaOrSignature;
        priv._purgeCommentsWithInvalidSchemaOrSignature = async () => {};
        await handler.createOrMigrateTablesIfNeeded();
        priv._purgeCommentsWithInvalidSchemaOrSignature = origPurge;
        return handler;
    }

    beforeEach(async () => {
        dbHandler = await createTestDbHandler();
    });

    afterEach(async () => {
        if (dbHandler) {
            await dbHandler.destoryConnection();
            dbHandler = undefined;
        }
    });

    it(`the raw spread used in _purgeCommentsWithInvalidSchemaOrSignature includes reserved fields (demonstrating the bug)`, async () => {
        const cid = "QmTestValidComment1";
        const authorSignerAddress = "12D3KooWAuthorPurgeTest";

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
            parentCid: null,
            postCid: cid,
            previousCid: null,
            communityPublicKey: communityAddress,
            content: "test content",
            timestamp: Math.floor(Date.now() / 1000),
            signature: makeSignature("valid-sig-1"),
            title: "test title",
            depth: 0,
            linkHtmlTagName: null,
            flairs: null,
            spoiler: false,
            pendingApproval: false,
            nsfw: false,
            extraProps: null,
            protocolVersion,
            insertedAt: Math.floor(Date.now() / 1000)
        };

        dbHandler!.insertComments([commentToInsert]);

        // Simulate what _purgeCommentsWithInvalidSchemaOrSignature does:
        // It queries the comment, parses it, then constructs the object for verification
        const commentRecord = dbHandler!.queryComment(cid)!;
        expect(commentRecord).toBeDefined();

        // BUG: the current code does { ...commentRecord, ...commentRecord.extraProps }
        // which includes DB-only fields that are in CommentIpfsReservedFields
        const buggyObject = { ...commentRecord, ...commentRecord.extraProps };
        const buggyKeys = Object.keys(buggyObject);
        const reservedFieldsInBuggyObject = remeda.intersection(buggyKeys, [...CommentIpfsReservedFields]);

        // This SHOULD be empty but ISN'T due to the bug
        expect(
            reservedFieldsInBuggyObject.length,
            `Raw spread includes reserved fields: ${reservedFieldsInBuggyObject.join(", ")}`
        ).toBeGreaterThan(0);

        // FIX: deriveCommentIpfsFromCommentTableRow correctly extracts only CommentIpfs fields
        const fixedObject = deriveCommentIpfsFromCommentTableRow(commentRecord);
        const fixedKeys = Object.keys(fixedObject);
        const reservedFieldsInFixedObject = remeda.intersection(fixedKeys, [...CommentIpfsReservedFields]);

        expect(reservedFieldsInFixedObject, `deriveCommentIpfsFromCommentTableRow should not include any reserved fields`).toEqual([]);
    });
});

import { beforeEach, afterEach, describe, it } from "vitest";
import assert from "assert";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../../dist/node/test/test-util.js";
import { CommentIpfsSchema } from "../../../dist/node/publications/comment/schema.js";
import { CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema } from "../../../dist/node/publications/comment-edit/schema.js";
import { CommentModerationPubsubMessagePublicationSchema } from "../../../dist/node/publications/comment-moderation/schema.js";
import { cleanWireAuthor } from "../../../dist/node/publications/publication-author.js";

import type { CommentsTableRowInsert } from "../../../dist/node/publications/comment/types.js";
import type { CommentEditsTableRowInsert } from "../../../dist/node/publications/comment-edit/types.js";
import type { CommentModerationsTableRowInsert } from "../../../dist/node/publications/comment-moderation/types.js";
import { JsonSignatureSchema } from "../../../dist/node/schema/schema.js";
import type { z } from "zod";

type JsonSignature = z.infer<typeof JsonSignatureSchema>;

const PROTOCOL_VERSION = "1.0.0";

const runtimeOnlyAuthorFields = ["address", "publicKey", "shortAddress", "subplebbit", "nameResolved"] as const;

function buildSignature(): JsonSignature {
    return {
        type: "ed25519",
        signature: "test-signature",
        publicKey: "test-public-key",
        signedPropertyNames: ["author", "content", "timestamp", "subplebbitAddress", "protocolVersion"]
    };
}

/** Author object with runtime fields that should NOT be stored in DB */
function buildAuthorWithRuntimeFields() {
    return {
        // Legitimate wire fields
        name: "test-author.eth",
        displayName: "TestUser",
        // Runtime-only fields that must NOT be stored
        address: "test-author.eth",
        publicKey: "12D3KooWFakePublicKey",
        shortAddress: "12D3KooWFake",
        nameResolved: true,
        subplebbit: {
            postScore: 5,
            replyScore: 3,
            firstCommentTimestamp: 1700000000,
            lastCommentCid: "QmFakeCid"
        }
    };
}

describeSkipIfRpc("runtime author fields must not be stored in DB", () => {
    let _dbHandler: DbHandler | undefined;
    let communityAddress: string;

    async function createTestDbHandler(): Promise<DbHandler> {
        communityAddress = `test-sub-${Date.now()}-${Math.random()}`;
        const fakePlebbit = { noData: true };
        const fakeSubplebbit = { address: communityAddress, _plebbit: fakePlebbit };
        const handler = new DbHandler(fakeSubplebbit as never);
        await handler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await handler.createOrMigrateTablesIfNeeded();
        return handler;
    }

    function getRawDb() {
        assert(_dbHandler, "DbHandler not initialised");
        return (_dbHandler as unknown as { _db: { prepare: (sql: string) => { get: (...args: string[]) => Record<string, unknown> } } })
            ._db;
    }

    function assertNoRuntimeAuthorFields(storedAuthor: Record<string, unknown>) {
        for (const field of runtimeOnlyAuthorFields) {
            expect(storedAuthor).to.not.have.property(field);
        }
    }

    beforeEach(async () => {
        _dbHandler = await createTestDbHandler();
        assert(_dbHandler, "Failed to initialise DbHandler");
    });

    afterEach(async () => {
        if (_dbHandler) {
            await _dbHandler.destoryConnection();
            _dbHandler = undefined;
        }
    });

    describe("comments table", () => {
        it("should not store runtime-only author fields", () => {
            assert(_dbHandler, "DbHandler not initialised");

            const commentIpfs = {
                author: buildAuthorWithRuntimeFields(),
                content: "test content",
                title: "test title",
                communityAddress: communityAddress,
                timestamp: 1700000000,
                signature: buildSignature(),
                protocolVersion: PROTOCOL_VERSION,
                depth: 0
            };

            // Same stripping as local-subplebbit.ts storeComment (line 1266-1267)
            const strippedOutCommentIpfs = CommentIpfsSchema.strip().parse(commentIpfs);
            strippedOutCommentIpfs.author = cleanWireAuthor(strippedOutCommentIpfs.author);

            const cid = "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f";
            const commentRow = <CommentsTableRowInsert>{
                ...strippedOutCommentIpfs,
                cid,
                postCid: cid,
                authorSignerAddress: "12D3KooWTestSigner",
                insertedAt: 1700000000
            };

            _dbHandler.insertComments([commentRow]);

            const rawRow = getRawDb().prepare("SELECT author FROM comments WHERE cid = ?").get(cid);
            assert(rawRow, "Comment row not found in DB");
            assert(typeof rawRow.author === "string", "author column should be a JSON string");
            const storedAuthor = JSON.parse(rawRow.author as string);

            assertNoRuntimeAuthorFields(storedAuthor);
            expect(storedAuthor.name).to.equal("test-author.eth");
            expect(storedAuthor.displayName).to.equal("TestUser");
        });
    });

    describe("commentEdits table", () => {
        it("should not store runtime-only author fields", () => {
            assert(_dbHandler, "DbHandler not initialised");

            // First insert a comment so FK constraint is satisfied
            const commentCid = "QmX7yV8dWgyMUiw5DSBt5ABToBWqi55GVEtnidAbNGGFoG";
            const commentRow = <CommentsTableRowInsert>{
                cid: commentCid,
                postCid: commentCid,
                authorSignerAddress: "12D3KooWTestSigner",
                author: { name: "original-author" },
                content: "original content",
                communityAddress: communityAddress,
                timestamp: 1700000000,
                signature: buildSignature(),
                protocolVersion: PROTOCOL_VERSION,
                depth: 0,
                insertedAt: 1700000000
            };
            _dbHandler.insertComments([commentRow]);

            const commentEditRaw = {
                author: buildAuthorWithRuntimeFields(),
                commentCid,
                content: "edited content",
                communityAddress: communityAddress,
                timestamp: 1700000100,
                signature: buildSignature(),
                protocolVersion: PROTOCOL_VERSION
            };

            // Same stripping as local-subplebbit.ts storeCommentEdit (line 924-925)
            const strippedOutEditPublication = CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema.strip().parse(commentEditRaw);
            strippedOutEditPublication.author = cleanWireAuthor(strippedOutEditPublication.author);

            const editTableRow = <CommentEditsTableRowInsert>{
                ...strippedOutEditPublication,
                isAuthorEdit: true,
                authorSignerAddress: "12D3KooWTestSigner",
                insertedAt: 1700000100
            };

            _dbHandler.insertCommentEdits([editTableRow]);

            const rawRow = getRawDb().prepare("SELECT author FROM commentEdits WHERE commentCid = ?").get(commentCid);
            assert(rawRow, "CommentEdit row not found in DB");
            assert(typeof rawRow.author === "string", "author column should be a JSON string");
            const storedAuthor = JSON.parse(rawRow.author as string);

            assertNoRuntimeAuthorFields(storedAuthor);
            expect(storedAuthor.name).to.equal("test-author.eth");
            expect(storedAuthor.displayName).to.equal("TestUser");
        });
    });

    describe("commentModerations table", () => {
        it("should not store runtime-only author fields", () => {
            assert(_dbHandler, "DbHandler not initialised");

            // First insert a comment so FK constraint is satisfied
            const commentCid = "QmZg4TCKqKoMTVHCpQbVmGBkcGaA4vHwaC7xaoZ3nfJm8k";
            const commentRow = <CommentsTableRowInsert>{
                cid: commentCid,
                postCid: commentCid,
                authorSignerAddress: "12D3KooWTestSigner",
                author: { name: "original-author" },
                content: "some content",
                communityAddress: communityAddress,
                timestamp: 1700000000,
                signature: buildSignature(),
                protocolVersion: PROTOCOL_VERSION,
                depth: 0,
                insertedAt: 1700000000
            };
            _dbHandler.insertComments([commentRow]);

            const commentModRaw = {
                author: buildAuthorWithRuntimeFields(),
                commentCid,
                commentModeration: { removed: true, reason: "spam" },
                communityAddress: communityAddress,
                timestamp: 1700000200,
                signature: buildSignature(),
                protocolVersion: PROTOCOL_VERSION
            };

            // Same stripping as local-subplebbit.ts storeCommentModeration (line 961-962)
            const strippedOutModPublication = CommentModerationPubsubMessagePublicationSchema.strip().parse(commentModRaw);
            strippedOutModPublication.author = cleanWireAuthor(strippedOutModPublication.author);

            const modTableRow = <CommentModerationsTableRowInsert>{
                ...strippedOutModPublication,
                modSignerAddress: "12D3KooWModSigner",
                insertedAt: 1700000200
            };

            _dbHandler.insertCommentModerations([modTableRow]);

            const rawRow = getRawDb().prepare("SELECT author FROM commentModerations WHERE commentCid = ?").get(commentCid);
            assert(rawRow, "CommentModeration row not found in DB");
            assert(typeof rawRow.author === "string", "author column should be a JSON string");
            const storedAuthor = JSON.parse(rawRow.author as string);

            assertNoRuntimeAuthorFields(storedAuthor);
            expect(storedAuthor.name).to.equal("test-author.eth");
            expect(storedAuthor.displayName).to.equal("TestUser");
        });
    });
});

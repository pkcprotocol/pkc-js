// Issue #572. A signed CommentUpdate is shipped two ways: serialized into MFS as is, and as a page entry rebuilt from its
// `comment_updates` row. commentUpdateToDbRow / spreadCommentUpdateExtraProps (comment-update-row.ts) are the one
// definition of that mapping, and this file pins that the page entry is the signed record, key for key, including the
// keys CommentUpdateSchema does not know (a challenge's `commentUpdate` extras).

import { beforeEach, afterEach, describe, it, expect } from "vitest";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import {
    commentUpdateExtraKeys,
    commentUpdateToDbRow,
    spreadCommentUpdateExtraProps
} from "../../../dist/node/runtime/node/community/comment-update-row.js";
import { resolveDbPostsCidRefs } from "../../../dist/node/runtime/node/util.js";
import { CommentUpdateSchema } from "../../../dist/node/publications/comment/schema.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { CommentsTableRowInsert, CommentUpdateType } from "../../../dist/node/publications/comment/types.js";
import Logger from "@pkcprotocol/pkc-logger";

// DbHandler and the community helpers log through community._log (issue #493); fakes get the process-default root
const testLog = Logger({ namespace: "pkc-js:test:commentUpdate" });

const now = Math.floor(Date.now() / 1000);
const CID = "QmExtraPropsRoundTrip0001";
const OTHER_CID = "QmExtraPropsRoundTrip0002";

const dbOnlyFields: { postUpdatesBucket?: number; publishedToPostUpdatesMFS: boolean; insertedAt: number } = {
    publishedToPostUpdatesMFS: false,
    insertedAt: now
};

// A record that carries every optional CommentUpdateSchema key except `replies`, which has its own DB form
const baseUpdate = (cid: string): CommentUpdateType =>
    ({
        cid,
        upvoteCount: 3,
        downvoteCount: 1,
        replyCount: 2,
        childCount: 2,
        number: 7,
        postNumber: 7,
        edit: undefined,
        flairs: [{ text: "mod flair" }],
        spoiler: true,
        nsfw: false,
        pinned: true,
        locked: false,
        archived: true,
        removed: false,
        reason: "a reason",
        authorBanExpiresAt: now + 1000,
        approved: true,
        updatedAt: now,
        author: { community: { postScore: 1, replyScore: 2, firstCommentTimestamp: now - 10, lastCommentCid: OTHER_CID } },
        lastChildCid: OTHER_CID,
        lastReplyTimestamp: now - 5,
        pseudonymityAuthorTag: "nBUe3DGZKQ8fBcP6YGnpRQ",
        protocolVersion: "1.0.0",
        signature: { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] }
    }) as unknown as CommentUpdateType;

const withoutUndefined = <T extends Record<string, unknown>>(record: T): T =>
    Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T;

describe("comment-update-row mapping functions (pure)", () => {
    it("commentUpdateExtraKeys lists the keys CommentUpdateSchema does not know and nothing else", () => {
        const update = { ...baseUpdate(CID), myExtraKey: 1, tip: { a: 1 } };
        expect(commentUpdateExtraKeys(update)).to.deep.equal(["myExtraKey", "tip"]);
        expect(commentUpdateExtraKeys(baseUpdate(CID))).to.deep.equal([]);
    });

    it("a record with no extras gets no extraProps key", () => {
        const row = commentUpdateToDbRow({ update: baseUpdate(CID), dbOnlyFields });
        expect("extraProps" in row).to.equal(false);
    });

    it("moves only the unknown keys of the record into extraProps, and removes them from the row", () => {
        const update = { ...baseUpdate(CID), myExtraKey: "hello", tip: { chainId: 1 } } as CommentUpdateType;
        const row = commentUpdateToDbRow({ update, dbOnlyFields }) as Record<string, unknown>;
        expect(row.extraProps).to.deep.equal({ myExtraKey: "hello", tip: { chainId: 1 } });
        expect("myExtraKey" in row).to.equal(false);
        expect("tip" in row).to.equal(false);
        // the schema keys stay columns
        expect(row.upvoteCount).to.equal(3);
        expect(row.reason).to.equal("a reason");
    });

    it("the DB-only fields are never extras, whatever they hold", () => {
        const update = { ...baseUpdate(CID), myExtraKey: 1 } as CommentUpdateType;
        const row = commentUpdateToDbRow({
            update,
            dbOnlyFields: {
                postUpdatesBucket: 12345,
                publishedToPostUpdatesMFS: false,
                insertedAt: now,
                replies: { hot: { commentCids: [CID] } }
            }
        }) as Record<string, unknown>;
        expect(row.postUpdatesBucket).to.equal(12345);
        expect(row.publishedToPostUpdatesMFS).to.equal(false);
        expect(row.insertedAt).to.equal(now);
        expect(row.replies).to.deep.equal({ hot: { commentCids: [CID] } });
        expect(row.extraProps).to.deep.equal({ myExtraKey: 1 });
    });

    it("an undefined extra is dropped, a falsy one (0, false, empty string) is kept", () => {
        const update = { ...baseUpdate(CID), zero: 0, no: false, empty: "", missing: undefined } as unknown as CommentUpdateType;
        const row = commentUpdateToDbRow({ update, dbOnlyFields }) as Record<string, unknown>;
        expect(row.extraProps).to.deep.equal({ zero: 0, no: false, empty: "" });
    });

    it("an extra key named like a DB column that is not in the schema stays an extra, not a column write", () => {
        const update = { ...baseUpdate(CID), insertedAt: 1, postUpdatesBucket: 2 } as unknown as CommentUpdateType;
        const row = commentUpdateToDbRow({ update, dbOnlyFields }) as Record<string, unknown>;
        expect(row.insertedAt).to.equal(now); // the DB-only value wins on the column
        expect(row.postUpdatesBucket).to.equal(undefined);
        expect(row.extraProps).to.deep.equal({ insertedAt: 1, postUpdatesBucket: 2 });
    });

    it("an extra key named extraProps round-trips as nested data", () => {
        const update = { ...baseUpdate(CID), extraProps: { inner: true } } as unknown as CommentUpdateType;
        const row = commentUpdateToDbRow({ update, dbOnlyFields }) as Record<string, unknown>;
        expect(row.extraProps).to.deep.equal({ extraProps: { inner: true } });
        const record: Record<string, unknown> = {};
        spreadCommentUpdateExtraProps(record, row.extraProps);
        expect(record).to.deep.equal({ extraProps: { inner: true } });
    });

    it("spreadCommentUpdateExtraProps ignores a null or non-object extraProps and never overwrites a schema key", () => {
        for (const bad of [null, undefined, "x", 5, true]) {
            const record: Record<string, unknown> = { cid: CID };
            spreadCommentUpdateExtraProps(record, bad);
            expect(record).to.deep.equal({ cid: CID });
        }
        const record: Record<string, unknown> = { cid: CID, upvoteCount: 3 };
        spreadCommentUpdateExtraProps(record, { upvoteCount: 999, fine: 1, nothing: null });
        expect(record).to.deep.equal({ cid: CID, upvoteCount: 3, fine: 1 });
    });
});

// DbHandler-only: opens an in-memory SQLite DB through the node-only DbHandler, which an RPC client has no access to.
describeSkipIfRpc("comment_updates.extraProps through the DB and the page mapper (issue #572)", () => {
    let dbHandler: DbHandler;
    const communityAddress = "12D3KooWExtraPropsRoundTrip";

    const pageOptions = () =>
        ({
            parentCid: PARENT_CID,
            excludeRemovedComments: false,
            excludeDeletedComments: false,
            excludeCommentPendingApproval: false,
            excludeCommentWithApprovedFalse: false,
            baseTimestamp: now + 100
        }) as Parameters<DbHandler["queryPageComments"]>[0];

    const PARENT_CID = "QmExtraPropsRoundTripParent";

    // The page query lists the children of one parent, so the comments under test are replies of a parent post
    const insertComment = ({ cid, depth, parentCid }: { cid: string; depth: number; parentCid?: string }) => {
        const { number, postNumber } = dbHandler.getNextCommentNumbers(depth);
        const comment: CommentsTableRowInsert = {
            cid,
            authorSignerAddress: `12D3KooAuthor${cid}`,
            author: { address: `12D3KooAuthor${cid}` },
            ...(depth === 0 ? { title: `title-${cid}` } : {}),
            content: `content-${cid}`,
            communityPublicKey: communityAddress,
            timestamp: now - 100,
            depth,
            postCid: depth === 0 ? cid : PARENT_CID,
            ...(parentCid ? { parentCid } : {}),
            signature: { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] },
            protocolVersion: "1.0.0",
            number,
            postNumber,
            insertedAt: now - 100
        };
        dbHandler.insertComments([comment]);
    };
    const insertPost = (cid: string) => insertComment({ cid, depth: 1, parentCid: PARENT_CID });

    const upsert = (update: CommentUpdateType) => dbHandler.upsertCommentUpdates([commentUpdateToDbRow({ update, dbOnlyFields })]);

    const pageEntryOf = (cid: string) => {
        const entry = dbHandler.queryPageComments(pageOptions()).find((e) => e.commentUpdate.cid === cid);
        if (!entry) throw Error(`no page entry for ${cid}`);
        return entry.commentUpdate;
    };

    beforeEach(async () => {
        const handler = new DbHandler({ _log: testLog, address: communityAddress, _pkc: { noData: true } } as never);
        await handler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await handler.createOrMigrateTablesIfNeeded();
        dbHandler = handler;
        insertComment({ cid: PARENT_CID, depth: 0 });
    });

    afterEach(() => {
        dbHandler.destoryConnection();
    });

    it("a record with every schema key comes back from the page query exactly as it went in", () => {
        insertPost(CID);
        const update = baseUpdate(CID);
        upsert(update);
        // every key the schema defines (but replies, whose DB form differs) is populated, so a column dropped from the
        // upsert or the mapper cannot hide
        const populated = Object.keys(CommentUpdateSchema.shape).filter((k) => k !== "replies" && k !== "edit");
        for (const key of populated) expect(key in update, `fixture lacks ${key}`).to.equal(true);
        expect(pageEntryOf(CID)).to.deep.equal(withoutUndefined(update as unknown as Record<string, unknown>));
    });

    it("the unknown keys come back, with their values, and the page entry serializes like the signed record", () => {
        insertPost(CID);
        const update = {
            ...baseUpdate(CID),
            myExtraKey: "hello",
            tip: { txHash: "0xabc", chainId: 1, amounts: [1, 2, 3], nested: { z: 1, a: 2 } },
            zero: 0,
            no: false
        } as unknown as CommentUpdateType;
        upsert(update);
        const entry = pageEntryOf(CID);
        expect(entry).to.deep.equal(withoutUndefined(update as unknown as Record<string, unknown>));
        // MFS writes deterministicStringify(update); pages serialize the entry the same way. They must be byte-identical
        expect(deterministicStringify(entry)).to.equal(
            deterministicStringify(withoutUndefined(update as unknown as Record<string, unknown>))
        );
        // and the key order of the entry is canonical, so plain JSON.stringify is too (the page generator relies on it)
        expect(JSON.stringify(entry)).to.equal(deterministicStringify(withoutUndefined(update as unknown as Record<string, unknown>)));
    });

    it("the CID-ref reload at startup (resolveDbPostsCidRefs) keeps the extras too", () => {
        insertPost(CID);
        const update = { ...baseUpdate(CID), tip: { txHash: "0xabc" } } as unknown as CommentUpdateType;
        upsert(update);
        const [entry] = resolveDbPostsCidRefs({
            dbPosts: { new: { commentCids: [CID] } } as never,
            dbHandler
        })!.pages!.new.comments;
        expect((entry.commentUpdate as Record<string, unknown>).tip).to.deep.equal({ txHash: "0xabc" });
    });

    it("extras of one comment do not leak into another comment's page entry", () => {
        insertPost(CID);
        insertPost(OTHER_CID);
        upsert({ ...baseUpdate(CID), myExtraKey: "only on the first" } as unknown as CommentUpdateType);
        upsert(baseUpdate(OTHER_CID));
        expect((pageEntryOf(CID) as Record<string, unknown>).myExtraKey).to.equal("only on the first");
        expect("myExtraKey" in pageEntryOf(OTHER_CID)).to.equal(false);
    });

    it("a re-upsert without the extras clears them, and one with changed extras replaces them", () => {
        insertPost(CID);
        upsert({ ...baseUpdate(CID), myExtraKey: "v1", gone: true } as unknown as CommentUpdateType);
        upsert({ ...baseUpdate(CID), updatedAt: now + 1, myExtraKey: "v2" } as unknown as CommentUpdateType);
        const second = pageEntryOf(CID) as Record<string, unknown>;
        expect(second.myExtraKey).to.equal("v2");
        expect("gone" in second).to.equal(false);

        upsert({ ...baseUpdate(CID), updatedAt: now + 2 });
        const third = pageEntryOf(CID) as Record<string, unknown>;
        expect("myExtraKey" in third).to.equal(false);
        expect(third.updatedAt).to.equal(now + 2);
    });

    it("stores extras as JSON in the extraProps column and nothing else changes in the row", () => {
        insertPost(CID);
        upsert({ ...baseUpdate(CID), myExtraKey: { a: 1 } } as unknown as CommentUpdateType);
        const stored = dbHandler.queryStoredCommentUpdate({ cid: CID })!;
        expect(stored.extraProps).to.deep.equal({ myExtraKey: { a: 1 } });
        expect(stored.upvoteCount).to.equal(3);
        expect(stored.publishedToPostUpdatesMFS).to.equal(false);
        expect(stored.insertedAt).to.equal(now);
    });
});

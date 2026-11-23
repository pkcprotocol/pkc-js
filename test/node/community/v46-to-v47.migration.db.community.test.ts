import { it, describe, beforeAll, afterAll, expect } from "vitest";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import env from "../../../dist/node/version.js";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { mockRemotePKC, generateMockPost } from "../../../dist/node/test/test-util.js";
import { getPKCAddressFromPublicKeySync } from "../../../dist/node/signer/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { resignVerbatim } from "../../helpers/resign-verbatim.js";
import type { WirePublication } from "../../helpers/resign-verbatim.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { CommentsTableRowInsert } from "../../../dist/node/publications/comment/types.js";
import type Database from "better-sqlite3";

// v46 -> v47 has no schema change. The version bump makes the open-time sweeps run again, and those now apply the
// rule that a record with a key named like an object member (toString, constructor, __proto__) or starting with an
// underscore is invalid, in the record and in its author. A community that stored such a comment before the upgrade
// (it was accepted then) would otherwise fail its own signature check on every publish cycle, and so would a stored
// challenge `commentUpdate` extra with such a key. Real signed records: the purge calls verifyCommentIpfs.
// Uses DbHandler directly (Node-only), cannot run under RPC.

const COMMUNITY = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
type Bag = Record<string, unknown>;

interface DbHandlerPrivate {
    _db: Database.Database;
    _createdTables: boolean;
}

describeSkipIfRpc("v46 → v47 DB migration (records with forbidden keys stored by an older version)", () => {
    let pkc: PKC;
    let dbHandler: DbHandler;
    const cids: Record<string, string> = {};
    let cidCounter = 0;

    // A signed post, re-signed verbatim so the key is part of the signed bytes, stored the way a community stores it
    const storeSignedPost = async (
        label: string,
        mutate: (wire: Bag) => void,
        extra: { challengeCommentUpdate?: Record<string, unknown> } = {}
    ) => {
        const comment = <Comment>await generateMockPost({ communityAddress: COMMUNITY, pkc, postProps: undefined });
        if (!comment.raw.pubsubMessageToPublish) {
            await comment._initCommunity();
            await comment._signPublicationWithCommunityFields();
        }
        const wire = <Bag>JSON.parse(JSON.stringify(comment.raw.pubsubMessageToPublish));
        mutate(wire);
        await resignVerbatim(<WirePublication>(<unknown>wire), comment.signer!);
        const commentIpfs = { ...wire, depth: 0 };
        const cid = await calculateIpfsHash(deterministicStringify(commentIpfs)!);
        cids[label] = cid;
        const known = new Set([
            "author",
            "content",
            "title",
            "communityPublicKey",
            "communityName",
            "timestamp",
            "signature",
            "protocolVersion",
            "depth"
        ]);
        const extraProps = Object.fromEntries(Object.entries(wire).filter(([k]) => !known.has(k) && k !== "link"));
        const numbers = dbHandler.getNextCommentNumbers(0);
        const row = <CommentsTableRowInsert>(<unknown>{
            cid,
            authorSignerAddress: getPKCAddressFromPublicKeySync((<{ publicKey: string }>wire.signature).publicKey),
            author: wire.author,
            content: wire.content,
            title: wire.title,
            communityPublicKey: wire.communityPublicKey,
            communityName: wire.communityName,
            timestamp: wire.timestamp,
            depth: 0,
            postCid: cid,
            signature: wire.signature,
            protocolVersion: wire.protocolVersion,
            number: numbers.number,
            postNumber: numbers.postNumber,
            insertedAt: Math.floor(Date.now() / 1000) + cidCounter++,
            ...(Object.keys(extraProps).length > 0 ? { extraProps } : {}),
            ...(extra.challengeCommentUpdate ? { challengeCommentUpdate: extra.challengeCommentUpdate } : {})
        });
        dbHandler.insertComments([row]);
    };

    const exists = (label: string) => dbHandler.queryComment(cids[label]) !== undefined;

    beforeAll(async () => {
        pkc = await mockRemotePKC();
        const anyComment = <Comment>await generateMockPost({ communityAddress: COMMUNITY, pkc });
        const fakeCommunity = {
            address: COMMUNITY,
            _pkc: { noData: true },
            _cidsToUnPin: new Set<string>(),
            _blocksToRm: <string[]>[],
            _mfsPathsToRemove: new Set<string>(),
            _clientsManager: anyComment._clientsManager,
            _calculateLocalMfsPathForCommentUpdate: () => "",
            _addOldPageCidsToCidsToUnpin: async () => {},
            _addAllCidsUnderPurgedCommentToBeRemoved: () => {}
        };
        dbHandler = new DbHandler(<LocalCommunity>(<unknown>fakeCommunity));
        await dbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await dbHandler.createOrMigrateTablesIfNeeded(); // the v46 schema is the current schema

        await storeSignedPost("clean", () => {});
        await storeSignedPost("benign-extra", (w) => {
            w.extraProp = "kept";
        });
        await storeSignedPost("author-underscore", (w) => {
            (<Bag>w.author)._x = 1;
        });
        await storeSignedPost("author-tostring", (w) => {
            (<Bag>w.author)["toString"] = "x";
        });
        await storeSignedPost("top-level-underscore", (w) => {
            w._y = 1;
        });
        await storeSignedPost("top-level-constructor", (w) => {
            w["constructor"] = "x";
        });
        await storeSignedPost("extras-with-forbidden", () => {}, {
            challengeCommentUpdate: <Bag>(
                JSON.parse('{"tip": 1, "_z": 2, "toString": "x", "author": {"community": {"postScore": 3}, "_w": 1}}')
            )
        });
        await storeSignedPost("extras-only-forbidden", () => {}, { challengeCommentUpdate: { _only: 1 } });
        await storeSignedPost("extras-clean", () => {}, { challengeCommentUpdate: { tip: 5 } });

        const priv = <DbHandlerPrivate>(<unknown>dbHandler);
        priv._db.pragma("user_version = 46");
        priv._createdTables = false; // the first call above marked the tables as created; this is the start after the upgrade
        await dbHandler.createOrMigrateTablesIfNeeded();
    }, 120_000);

    afterAll(async () => {
        dbHandler?.destoryConnection();
        await pkc?.destroy();
    });

    it("DB version was bumped to the latest", () => {
        expect((<DbHandlerPrivate>(<unknown>dbHandler))._db.pragma("user_version", { simple: true })).toBe(env.DB_VERSION);
        expect(env.DB_VERSION).toBeGreaterThanOrEqual(47);
    });

    it("keeps a comment with no forbidden key and one with a benign extra key", () => {
        expect(exists("clean")).toBe(true);
        expect(exists("benign-extra")).toBe(true);
        expect(dbHandler.queryComment(cids["benign-extra"])!.extraProps).toEqual({ extraProp: "kept" });
    });

    for (const label of ["author-underscore", "author-tostring", "top-level-underscore", "top-level-constructor"])
        it(`purges the comment stored with ${label}`, () => {
            expect(exists(label)).toBe(false);
        });

    it("drops the forbidden keys from stored challenge extras and keeps the rest and the comment", () => {
        expect(exists("extras-with-forbidden")).toBe(true);
        expect(dbHandler.queryComment(cids["extras-with-forbidden"])!.challengeCommentUpdate).toEqual({
            tip: 1,
            author: { community: { postScore: 3 } }
        });
    });

    it("clears extras that held only forbidden keys, and leaves the comment", () => {
        expect(exists("extras-only-forbidden")).toBe(true);
        expect(dbHandler.queryComment(cids["extras-only-forbidden"])!.challengeCommentUpdate).toBeUndefined();
    });

    it("leaves clean extras alone", () => {
        expect(dbHandler.queryComment(cids["extras-clean"])!.challengeCommentUpdate).toEqual({ tip: 5 });
    });
});

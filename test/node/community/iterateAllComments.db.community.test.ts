import { it, describe, beforeEach, afterEach, expect } from "vitest";
import Logger from "@pkcprotocol/pkc-logger";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { CommentsTableRow, CommentsTableRowInsert } from "../../../dist/node/publications/comment/types.js";

// DbHandler and the community helpers log through community._log (issue #493); fakes get the process-default root
const testLog = Logger({ namespace: "pkc-js:test:iterateAllComments" });

// The repin-on-start walk reads the comments table one batch at a time instead of materializing every row
// (issue #359). These tests drive that reader straight off a DbHandler, which only exists community-side, so
// there is nothing for them to talk to when the tests run against an RPC-backed community.
describeSkipIfRpc("db-handler.iterateAllCommentsOrderedByIdAsc", function () {
    let dbHandler: DbHandler | undefined;
    let communityAddress: string;
    let cidCounter = 0;

    const nextCid = (): string => `QmWalk${(cidCounter++).toString().padStart(4, "0")}`;
    const currentTimestamp = (): number => Math.floor(Date.now() / 1000);

    const insertComment = (overrides: Partial<CommentsTableRowInsert> = {}): string => {
        const cid = (overrides.cid as string) ?? nextCid();
        const timestamp = currentTimestamp();
        dbHandler!.insertComments([
            {
                cid,
                authorSignerAddress: `12D3KooAuthor${cid}`,
                author: { address: `12D3KooAuthor${cid}`, displayName: `display-${cid}` },
                content: `content-${cid}`,
                title: `title-${cid}`,
                communityPublicKey: communityAddress,
                timestamp,
                depth: 0,
                postCid: cid,
                parentCid: null,
                signature: { type: "ed25519", signature: `sig-${cid}`, publicKey: `pk-${cid}`, signedPropertyNames: ["content"] },
                protocolVersion: "1.0.0",
                pendingApproval: null,
                insertedAt: timestamp,
                ...overrides
            } as unknown as CommentsTableRowInsert
        ]);
        return cid;
    };

    const walk = (batchSize: number): string[][] =>
        [...dbHandler!.iterateAllCommentsOrderedByIdAsc(batchSize)].map((batch) => batch.map((row) => row.cid));

    beforeEach(async () => {
        communityAddress = `test-sub-${Date.now()}-${Math.random()}`;
        const fakeCommunity = { _log: testLog, address: communityAddress, _pkc: { noData: true } };
        dbHandler = new DbHandler(fakeCommunity as DbHandler["_community"]);
        await dbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await dbHandler.createOrMigrateTablesIfNeeded();
        cidCounter = 0;
    });

    afterEach(async () => {
        if (dbHandler) {
            await dbHandler.destoryConnection();
            dbHandler = undefined;
        }
    });

    it("yields every comment in insertion order, split into batches of the requested size", () => {
        const cids = [insertComment(), insertComment(), insertComment(), insertComment(), insertComment()];

        expect(walk(2)).to.deep.equal([[cids[0], cids[1]], [cids[2], cids[3]], [cids[4]]]);
    });

    it("yields one batch when the whole table fits in it, and nothing at all for an empty table", () => {
        expect(walk(1000)).to.deep.equal([]);

        const cid = insertComment();
        expect(walk(1000)).to.deep.equal([[cid]]);
    });

    it("yields exactly one batch when the table size is a multiple of the batch size", () => {
        const cids = [insertComment(), insertComment()];

        expect(walk(2)).to.deep.equal([cids]);
    });

    it("parses each row's JSON columns instead of handing back their stored strings", () => {
        const cid = insertComment();

        const [[row]] = [...dbHandler!.iterateAllCommentsOrderedByIdAsc(10)];
        expect(row.cid).to.equal(cid);
        expect(row.author).to.deep.equal({ address: `12D3KooAuthor${cid}`, displayName: `display-${cid}` });
        expect(row.signature).to.be.an("object");
        expect(row.signature.signedPropertyNames).to.deep.equal(["content"]);
        // The rowid the walk pages on is its own cursor, not a field of the comment it hands out
        expect(row).to.not.have.property("rowid");
    });

    it("yields comments pending approval too, since what to do with them is the caller's decision", () => {
        const pending = insertComment({ pendingApproval: true } as Partial<CommentsTableRowInsert>);
        const approved = insertComment();

        expect(walk(10)).to.deep.equal([[pending, approved]]);
    });

    // What makes the walk hold one batch instead of the board: it reads a batch only when one is asked for.
    it("reads each batch when it is asked for, not the whole table up front", () => {
        const first = insertComment();
        let second: string | undefined;
        const batches: string[][] = [];

        for (const batch of dbHandler!.iterateAllCommentsOrderedByIdAsc(1)) {
            batches.push(batch.map((row: CommentsTableRow) => row.cid));
            // Inserted only after the first batch was handed out. A reader that had already run one query
            // over the whole table could not see it; one that queries per batch does.
            if (!second) second = insertComment();
        }

        expect(batches).to.deep.equal([[first], [second]]);
    });
});

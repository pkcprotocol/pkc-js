// Leak suite (#496): queryCommunityAuthor prepares one statement per number of author addresses.
// A pseudonymous author (per-post / per-reply aliases) gains one address per aliased comment, so every new
// comment of theirs makes the IN-list one longer and compiles another pair of statements.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import signers from "../../fixtures/signers.js";
import type { CommentsTableRowInsert } from "../../../dist/node/publications/comment/types.js";

// it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
// starts failing once the leak is fixed: remove the .fails then.

const PROTOCOL_VERSION = "1.0.0";
const SIGNATURE = { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] as string[] };
const ALIASED_COMMENTS = 60;

function preparedStatementCount(handler: DbHandler): number {
    return (handler as unknown as { _preparedStatements: Map<string, unknown> })._preparedStatements.size;
}

describe("leak: DbHandler statements per author alias count", () => {
    let handler: DbHandler;
    let communityAddress: string;

    beforeEach(async () => {
        communityAddress = `leak-alias-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const fakeCommunity = { address: communityAddress, _pkc: { noData: true } };
        handler = new DbHandler(fakeCommunity as never);
        await handler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await handler.createOrMigrateTablesIfNeeded();
    });

    afterEach(() => {
        handler.destoryConnection();
    });

    it.fails(`queryCommunityAuthor keeps a bounded number of statements as one author gains ${ALIASED_COMMENTS} aliases`, () => {
        const originalAuthor = signers[0];
        let clock = 1_700_000_000;
        const addAliasedPost = (i: number) => {
            const cid = `QmCandAlias${i.toString().padStart(4, "0")}`;
            const aliasAddress = `12D3KooAlias${i}`;
            const timestamp = ++clock;
            const numbers = handler.getNextCommentNumbers(0);
            handler.insertComments([
                {
                    cid,
                    authorSignerAddress: aliasAddress,
                    author: { address: aliasAddress },
                    content: `content-${cid}`,
                    title: `title-${cid}`,
                    communityPublicKey: communityAddress,
                    timestamp,
                    depth: 0,
                    postCid: cid,
                    signature: SIGNATURE,
                    protocolVersion: PROTOCOL_VERSION,
                    number: numbers.number,
                    postNumber: numbers.postNumber,
                    insertedAt: timestamp
                } as CommentsTableRowInsert
            ]);
            handler.insertPseudonymityAliases([
                {
                    commentCid: cid,
                    aliasPrivateKey: `alias-private-key-${i}`,
                    originalAuthorPublicKey: originalAuthor.publicKey,
                    originalAuthorName: null,
                    mode: "per-post",
                    insertedAt: timestamp
                }
            ]);
        };

        addAliasedPost(0);
        handler.queryCommunityAuthor(originalAuthor.address);
        const afterFirst = preparedStatementCount(handler);
        const addressCounts: number[] = [];
        for (let i = 1; i < ALIASED_COMMENTS; i++) {
            addAliasedPost(i);
            // What a challenge request from this author runs (local-community/challenges.ts)
            const author = handler.queryCommunityAuthor(originalAuthor.address);
            addressCounts.push(author ? 1 : 0);
        }
        // The author's karma must have been found on every call, i.e. the alias addresses were really included
        expect(addressCounts.every((found) => found === 1)).toBe(true);
        // Padded to powers of two, 60 list lengths would need at most 6 more variants per query (2 queries)
        expect({ statementsAddedAfterFirstCall: preparedStatementCount(handler) - afterFirst <= 12 }).toEqual({
            statementsAddedAfterFirstCall: true
        });
    });
});

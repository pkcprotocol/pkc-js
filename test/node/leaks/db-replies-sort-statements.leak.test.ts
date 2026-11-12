// Leak suite (#496): queryAllRepliesForPageSort({ postCids }) prepares one statement per batch length.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";

// it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
// starts failing once the leak is fixed: remove the .fails then.

function preparedStatementCount(handler: DbHandler): number {
    return (handler as unknown as { _preparedStatements: Map<string, unknown> })._preparedStatements.size;
}

describe("leak: DbHandler statements per postCids batch length", () => {
    let handler: DbHandler;

    beforeEach(async () => {
        const fakeCommunity = { address: `leak-replies-${Date.now()}-${Math.random().toString(36).slice(2)}`, _pkc: { noData: true } };
        handler = new DbHandler(fakeCommunity as never);
        await handler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await handler.createOrMigrateTablesIfNeeded();
    });

    afterEach(() => {
        handler.destoryConnection();
    });

    it.fails("queryAllRepliesForPageSort keeps a bounded number of statements across 100 postCids list lengths", () => {
        handler.queryAllRepliesForPageSort({ postCids: ["QmPost0"] });
        const afterFirst = preparedStatementCount(handler);
        for (let length = 2; length <= 100; length++)
            handler.queryAllRepliesForPageSort({ postCids: Array.from({ length }, (_, i) => `QmPost${i}`) });
        const added = preparedStatementCount(handler) - afterFirst;
        // Padded to powers of two, lengths 2..100 need 7 variants (2, 4, ... 128)
        expect({ boundedStatements: added <= 7 }).toEqual({ boundedStatements: true });
    });
});

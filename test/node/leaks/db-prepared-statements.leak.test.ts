// Leak suite (#496): the DbHandler statement cache must not grow with the number of sync cycles.
//
// _prepareCached keys statements by SQL text and never evicts, so any query that writes a changing
// value into its SQL compiles and keeps a new SQLite statement per call. #488:
// queryPostsWithOutdatedBuckets interpolated the current Unix time, and syncIpnsWithDb calls it on
// every publish-loop pass for every started community, leaking ~7 KB of native memory (invisible to
// process.memoryUsage().heapUsed) per pass, ~2.5 GB/day on a 75-community daemon.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";

const POST_UPDATES_BUCKETS = [86400, 604800, 2592000, 3153600000];
const CYCLES = 50;

async function createTestDbHandler(): Promise<DbHandler> {
    // No "." in it, so the community is addressed by key (isStringDomain), as in the other in-memory DbHandler tests
    const communityAddress = `leak-sub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const fakeCommunity = { address: communityAddress, _pkc: { noData: true } };
    const handler = new DbHandler(fakeCommunity as DbHandler extends { _community: infer T } ? T : never);
    await handler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
    await handler.createOrMigrateTablesIfNeeded();
    return handler;
}

function preparedStatementCount(handler: DbHandler): number {
    return (handler as unknown as { _preparedStatements: Map<string, unknown> })._preparedStatements.size;
}

describe("leak: DbHandler prepared statement cache", () => {
    let dbHandler: DbHandler | undefined;

    beforeEach(async () => {
        dbHandler = await createTestDbHandler();
        vi.useFakeTimers({ toFake: ["Date"] });
    });

    afterEach(async () => {
        vi.useRealTimers();
        dbHandler?.destoryConnection();
        dbHandler = undefined;
    });

    it(`queryPostsWithOutdatedBuckets keeps one cached statement across ${CYCLES} sync cycles`, () => {
        const handler = dbHandler!;
        const startMs = Date.UTC(2026, 10, 1);

        // One call per publish-loop pass, each at a later second, as syncIpnsWithDb does
        vi.setSystemTime(startMs);
        handler.queryPostsWithOutdatedBuckets([...POST_UPDATES_BUCKETS]);
        const afterFirstCycle = preparedStatementCount(handler);

        for (let cycle = 1; cycle < CYCLES; cycle++) {
            vi.setSystemTime(startMs + cycle * 20_000);
            handler.queryPostsWithOutdatedBuckets([...POST_UPDATES_BUCKETS]);
        }

        expect({ statementsAddedAfterFirstCycle: preparedStatementCount(handler) - afterFirstCycle }).toEqual({
            statementsAddedAfterFirstCycle: 0
        });
    });
});

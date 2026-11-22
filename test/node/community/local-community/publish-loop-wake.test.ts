// How the publish loop of a started community sleeps between cycles (issue #576).
// It used to run a 100ms interval per community that queried the DB twice per tick to see whether a record was
// needed. Now it sleeps on one timer and is woken by whatever asks for a record: the trigger's setter, which the
// DB handler sets on every publication write, and stop().
//
// The cycle itself (syncIpnsWithDb) and the two re-provide steps are stubbed: only the waiting is under test.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { syncIpnsWithDbMock } = vi.hoisted(() => ({
    syncIpnsWithDbMock: vi.fn<(community: { _communityUpdateTrigger: boolean }) => Promise<void>>()
}));
vi.mock("../../../../dist/node/runtime/node/community/local-community/ipns-publishing.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, syncIpnsWithDb: syncIpnsWithDbMock };
});
vi.mock("../../../../dist/node/runtime/node/community/local-community/reprovide-on-address-change.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, reprovideOnAddressChangeIfDue: async (): Promise<void> => undefined };
});
vi.mock("../../../../dist/node/runtime/node/community/local-community/anchor-publishing.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, reprovideAnchorRecordIfDue: async (): Promise<void> => undefined };
});

import { publishLoop } from "../../../../dist/node/runtime/node/community/local-community/lifecycle.js";
import { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import { DbHandler } from "../../../../dist/node/runtime/node/community/db-handler.js";
import { isEventLoopWatchRunning } from "../../../../dist/node/runtime/node/event-loop-watch.js";

const SYNC_INTERVAL_MS = 20_000;

// The real class's prototype, so the trigger's getter and setter are the ones under test; none of its constructor runs.
function createIdleStartedCommunity() {
    const queryLatestPostCid = vi.fn((): { cid: string } | undefined => undefined);
    const queryLatestCommentCid = vi.fn((): { cid: string } | undefined => undefined);
    const errorListener = vi.fn();
    const community: LocalCommunity = Object.create(LocalCommunity.prototype);
    Object.assign(community, {
        address: "12D3KooWPublishLoopWake",
        state: "started",
        updatedAt: Math.round(Date.now() / 1000),
        _stopHasBeenCalled: false,
        _pendingEditProps: [],
        _blocksToRm: [],
        _communityUpdateTriggerValue: false,
        _updateTriggerGeneration: 0,
        _wakePublishLoop: undefined,
        _log: Object.assign(vi.fn(), { error: vi.fn(), trace: vi.fn() }),
        _dbHandler: { queryLatestPostCid, queryLatestCommentCid },
        emit: (event: string, error: Error) => (event === "error" ? errorListener(error) : undefined)
    });
    return { community, queryLatestPostCid, queryLatestCommentCid, errorListener };
}

// lets the loop run up to its next sleep without moving the clock
const settle = () => vi.advanceTimersByTimeAsync(0);

async function endLoop(community: LocalCommunity, loop: Promise<void>) {
    community._stopHasBeenCalled = true;
    community._wakePublishLoop?.();
    await loop;
}

describe("publish loop: sleeping between cycles", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        syncIpnsWithDbMock.mockReset();
        // a successful cycle publishes the record that was asked for
        syncIpnsWithDbMock.mockImplementation(async (community) => {
            community._communityUpdateTrigger = false;
        });
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it("an idle community runs no timer callback and no DB query until the sync interval has passed", async () => {
        const { community, queryLatestPostCid, queryLatestCommentCid } = createIdleStartedCommunity();
        const loop = publishLoop(community, SYNC_INTERVAL_MS);
        await settle();
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(1);
        const queriesBeforeSleeping = queryLatestPostCid.mock.calls.length + queryLatestCommentCid.mock.calls.length;
        // its own sleep, and the check of the event loop watch, which is one per process however many loops run
        expect(vi.getTimerCount()).to.equal(2);

        await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS - 1);
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(1);
        expect(queryLatestPostCid.mock.calls.length + queryLatestCommentCid.mock.calls.length).to.equal(queriesBeforeSleeping);

        await vi.advanceTimersByTimeAsync(1);
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(2);

        await endLoop(community, loop);
    });

    it("a request for a record wakes the loop at once", async () => {
        const { community } = createIdleStartedCommunity();
        const loop = publishLoop(community, SYNC_INTERVAL_MS);
        await settle();
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(5_000);
        community._communityUpdateTrigger = true;
        await settle();
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(2);

        await endLoop(community, loop);
    });

    // One publication writes several times in a row (the comment, then what it changes), and each write asks for a
    // record. The 100ms tick of the old loop took them in one cycle. Waking at once for each gave one cycle, and one
    // published record, per write.
    it("requests that arrive right after a cycle are taken together, in one cycle that starts 100ms after the last one ended", async () => {
        const { community } = createIdleStartedCommunity();
        const loop = publishLoop(community, SYNC_INTERVAL_MS);
        await settle();
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(1);

        community._communityUpdateTrigger = true;
        await vi.advanceTimersByTimeAsync(30);
        community._communityUpdateTrigger = true;
        await vi.advanceTimersByTimeAsync(69);
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(2);

        // nothing is left over from the two requests
        await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS - 1);
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(2);

        await endLoop(community, loop);
    });

    it("stop() wakes the loop, which ends without waiting out the interval", async () => {
        const { community } = createIdleStartedCommunity();
        const loop = publishLoop(community, SYNC_INTERVAL_MS);
        await settle();

        community._stopHasBeenCalled = true;
        community._wakePublishLoop?.();
        await loop;

        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).to.equal(0);
        expect(community._wakePublishLoop).to.equal(undefined);
    });

    it("the main thread is watched for as long as a loop runs, and no longer", async () => {
        expect(isEventLoopWatchRunning()).to.equal(false);
        const first = createIdleStartedCommunity();
        const second = createIdleStartedCommunity();
        const firstLoop = publishLoop(first.community, SYNC_INTERVAL_MS);
        const secondLoop = publishLoop(second.community, SYNC_INTERVAL_MS);
        await settle();
        expect(isEventLoopWatchRunning()).to.equal(true);

        await endLoop(first.community, firstLoop);
        expect(isEventLoopWatchRunning()).to.equal(true);
        await endLoop(second.community, secondLoop);
        expect(isEventLoopWatchRunning()).to.equal(false);
    });

    it("a record the cycle left requested is retried after a short pause, not in a spin", async () => {
        const { community } = createIdleStartedCommunity();
        // e.g. a block the cycle could not remove: the trigger is set again as soon as the cycle is done
        syncIpnsWithDbMock.mockImplementation(async () => {});
        community._communityUpdateTrigger = true;
        const loop = publishLoop(community, SYNC_INTERVAL_MS);
        await settle();
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(99);
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(2);

        await endLoop(community, loop);
    });

    // The record is published every 15 minutes at least, whatever the publish interval is: clients take a community
    // whose updatedAt is too old for one that is offline. Nothing asks for that record, so the loop has to wake for it
    it("a publish interval above 15 minutes does not put off the record that is due when the last one is 15 minutes old", async () => {
        const { community } = createIdleStartedCommunity();
        const publishedAt = community.updatedAt!;
        const loop = publishLoop(community, 60 * 60 * 1000);
        await settle();
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(1);

        // the record is too old once the clock, rounded to the second, is more than 15 minutes past its updatedAt
        const tooOldAtMs = (publishedAt + 15 * 60) * 1000 + 500;
        await vi.advanceTimersByTimeAsync(tooOldAtMs - Date.now() - 1);
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(1);
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(2);

        await endLoop(community, loop);
    });

    it("a publish interval above 15 minutes is still waited out after a failed cycle", async () => {
        const { community, errorListener } = createIdleStartedCommunity();
        syncIpnsWithDbMock.mockImplementation(async (failedCommunity) => {
            failedCommunity._communityUpdateTrigger = true;
            throw new Error("the cycle failed");
        });
        const loop = publishLoop(community, 60 * 60 * 1000);
        await settle();
        expect(errorListener).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 1);
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(2);

        await endLoop(community, loop);
    });

    // Issue #430: the trigger a failed cycle leaves set is not a new request
    it("after a failed cycle only a new request wakes the loop before the interval has passed", async () => {
        const { community, errorListener } = createIdleStartedCommunity();
        syncIpnsWithDbMock.mockImplementation(async () => {
            throw new Error("the cycle failed");
        });
        community._communityUpdateTrigger = true;
        const loop = publishLoop(community, SYNC_INTERVAL_MS);
        await settle();
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(1);
        expect(errorListener).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS - 1);
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(1);

        community._communityUpdateTrigger = true; // an edit, a new publication
        await settle();
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(2);

        await vi.advanceTimersByTimeAsync(SYNC_INTERVAL_MS);
        expect(syncIpnsWithDbMock).toHaveBeenCalledTimes(3);

        await endLoop(community, loop);
    });
});

// The loop no longer looks at the DB to find out that something was written, so every method that writes a
// publication has to ask for the record itself. A method added to DbHandler that writes one belongs in this list.
describe("publish loop: every publication write asks for a record", () => {
    async function createDbHandlerOfCommunity() {
        const community = {
            address: `publish-loop-wake-${Date.now()}-${Math.random()}`,
            _pkc: { noData: true },
            _communityUpdateTrigger: false
        };
        const dbHandler = new DbHandler(community as never);
        await dbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        await dbHandler.createOrMigrateTablesIfNeeded();
        community._communityUpdateTrigger = false;
        return { community, dbHandler };
    }

    const publicationWrites: { name: string; write: (dbHandler: DbHandler) => void }[] = [
        { name: "insertComments", write: (dbHandler) => dbHandler.insertComments([]) },
        { name: "insertVotes", write: (dbHandler) => dbHandler.insertVotes([]) },
        { name: "deleteVote", write: (dbHandler) => dbHandler.deleteVote("12D3KooWNoSuchAuthor", "QmNoSuchComment") },
        { name: "insertCommentEdits", write: (dbHandler) => dbHandler.insertCommentEdits([]) },
        { name: "insertCommentModerations", write: (dbHandler) => dbHandler.insertCommentModerations([]) },
        { name: "insertPseudonymityAliases", write: (dbHandler) => dbHandler.insertPseudonymityAliases([]) },
        {
            name: "removeCommentFromPendingApproval",
            write: (dbHandler) => dbHandler.removeCommentFromPendingApproval({ cid: "QmNoSuchComment" })
        },
        // throws for a comment it does not have, after noting the write
        {
            name: "purgeComment",
            write: (dbHandler) => {
                expect(() => dbHandler.purgeComment("QmNoSuchComment")).to.throw();
            }
        }
    ];

    for (const { name, write } of publicationWrites)
        it(`${name} sets the community's update trigger`, async () => {
            const { community, dbHandler } = await createDbHandlerOfCommunity();
            try {
                write(dbHandler);
                expect(community._communityUpdateTrigger).to.equal(true);
            } finally {
                await dbHandler.destoryConnection();
            }
        });

    // The dry run of an incoming comment or edit (the check that it is stored verbatim) writes inside a savepoint that
    // is always rolled back. Nothing was written, so it must not wake the loop: it runs for every incoming comment,
    // also for one that is then rejected.
    it("a write that readBackWithoutStoring rolls back does not set the community's update trigger", async () => {
        const { community, dbHandler } = await createDbHandlerOfCommunity();
        try {
            const read = dbHandler.readBackWithoutStoring({
                write: () => {
                    dbHandler.insertComments([]);
                    dbHandler.insertCommentEdits([]);
                },
                read: () => "read back"
            });
            expect(read).to.equal("read back");
            expect(community._communityUpdateTrigger).to.equal(false);

            // a write that throws leaves the next real write able to ask for a record
            expect(() =>
                dbHandler.readBackWithoutStoring({
                    write: () => {
                        throw new Error("the dry run failed");
                    },
                    read: (): string => "never read"
                })
            ).to.throw("the dry run failed");
            dbHandler.insertComments([]);
            expect(community._communityUpdateTrigger).to.equal(true);
        } finally {
            await dbHandler.destoryConnection();
        }
    });
});

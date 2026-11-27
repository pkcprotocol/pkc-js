// The two reports that say a node is falling behind (issue #576): the main thread was blocked, and a publish cycle
// took longer than the publish interval. Both are pure decisions over numbers measured elsewhere, tested here without
// a community, and the watch that feeds the first is checked for being one per process, held by whoever needs it.

import { describe, it, expect, vi } from "vitest";
import {
    EVENT_LOOP_BLOCKED_REPORT_MS,
    eventLoopDelayToReport,
    holdEventLoopWatch,
    isEventLoopWatchRunning,
    reportToEventLoopWatchHolders
} from "../../../../dist/node/runtime/node/event-loop-watch.js";
import { slowCycleReport } from "../../../../dist/node/runtime/node/community/local-community/ipns-publishing.js";
import Logger from "@pkcprotocol/pkc-logger";

const testLog = Logger({ namespace: "pkc-js:test:main-thread-guard" });

const msToNs = (ms: number) => ms * 1e6;

describe("event loop watch", () => {
    it("reports nothing while timers fire on time", () => {
        expect(eventLoopDelayToReport({ maxNs: msToNs(21), p99Ns: msToNs(20), resolutionMs: 20 })).to.equal(undefined);
        // just under the threshold: the histogram's own period is not lateness
        expect(
            eventLoopDelayToReport({ maxNs: msToNs(20 + EVENT_LOOP_BLOCKED_REPORT_MS - 1), p99Ns: msToNs(20), resolutionMs: 20 })
        ).to.equal(undefined);
    });

    it("reports how late the latest timer was, and the 99th percentile next to it", () => {
        expect(eventLoopDelayToReport({ maxNs: msToNs(1520), p99Ns: msToNs(45), resolutionMs: 20 })).to.deep.equal({
            maxLateMs: 1500,
            p99LateMs: 25
        });
        // a percentile below the period is no lateness, not a negative one
        expect(eventLoopDelayToReport({ maxNs: msToNs(520), p99Ns: msToNs(19), resolutionMs: 20 })).to.deep.equal({
            maxLateMs: 500,
            p99LateMs: 0
        });
    });

    it("runs once per process, for as long as anyone holds it", () => {
        expect(isEventLoopWatchRunning()).to.equal(false);
        const releaseFirst = holdEventLoopWatch({ log: testLog });
        const releaseSecond = holdEventLoopWatch({ log: testLog });
        expect(isEventLoopWatchRunning()).to.equal(true);

        releaseFirst();
        releaseFirst(); // giving a hold back twice does not take the other holder's
        expect(isEventLoopWatchRunning()).to.equal(true);

        releaseSecond();
        expect(isEventLoopWatchRunning()).to.equal(false);
    });

    // Issue #493: each PKC instance has its own log buffer, so a report must not go only to whoever started the watch
    it("reports to every logger that holds it, once each, and no longer to one that gave its holds back", () => {
        const firstLog = Logger({ namespace: "pkc-js:test:main-thread-guard:first" });
        const secondLog = Logger({ namespace: "pkc-js:test:main-thread-guard:second" });
        const firstError = vi.spyOn(firstLog, "error").mockImplementation(() => {});
        const secondError = vi.spyOn(secondLog, "error").mockImplementation(() => {});
        const releaseFirst = holdEventLoopWatch({ log: firstLog });
        const releaseFirstAgain = holdEventLoopWatch({ log: firstLog }); // a second community of the same instance
        const releaseSecond = holdEventLoopWatch({ log: secondLog });
        try {
            reportToEventLoopWatchHolders("blocked");
            expect(firstError.mock.calls).to.deep.equal([["blocked"]]);
            expect(secondError.mock.calls).to.deep.equal([["blocked"]]);

            releaseFirst();
            reportToEventLoopWatchHolders("blocked again");
            expect(firstError.mock.calls.length, "one hold of the first logger is still out").to.equal(2);

            releaseFirstAgain();
            reportToEventLoopWatchHolders("blocked a third time");
            expect(firstError.mock.calls.length).to.equal(2);
            expect(secondError.mock.calls.length).to.equal(3);
        } finally {
            releaseFirst();
            releaseFirstAgain();
            releaseSecond();
            vi.restoreAllMocks();
        }
        expect(isEventLoopWatchRunning()).to.equal(false);
    });
});

describe("slow publish cycle report", () => {
    it("says nothing about a cycle that fits in the publish interval", () => {
        expect(slowCycleReport({ cycleMs: 20_000, slowAfterMs: 20_000, phasesMs: { updateCommunityIpns: 19_000 } })).to.equal(undefined);
    });

    it("names the steps of a slow cycle, slowest first, and leaves out the ones that took no time", () => {
        const report = slowCycleReport({
            cycleMs: 31_400.4,
            slowAfterMs: 20_000,
            phasesMs: {
                listenToIncomingRequests: 12,
                syncWithRegistries: 0,
                updateCommentsAndWritePostUpdates: 29_100,
                updateCommunityIpns: 2_200
            }
        });
        expect(report).to.equal(
            "took 31400ms, longer than the publish interval of 20000ms: " +
                "updateCommentsAndWritePostUpdates 29100ms, updateCommunityIpns 2200ms, listenToIncomingRequests 12ms"
        );
    });
});

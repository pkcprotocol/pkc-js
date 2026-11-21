// The two reports that say a node is falling behind (issue #576): the main thread was blocked, and a publish cycle
// took longer than the publish interval. Both are pure decisions over numbers measured elsewhere, tested here without
// a community, and the watch that feeds the first is checked for being one per process, held by whoever needs it.

import { describe, it, expect } from "vitest";
import {
    EVENT_LOOP_BLOCKED_REPORT_MS,
    eventLoopDelayToReport,
    holdEventLoopWatch,
    isEventLoopWatchRunning
} from "../../../../dist/node/runtime/node/event-loop-watch.js";
import { slowCycleReport } from "../../../../dist/node/runtime/node/community/local-community/ipns-publishing.js";

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
        const releaseFirst = holdEventLoopWatch();
        const releaseSecond = holdEventLoopWatch();
        expect(isEventLoopWatchRunning()).to.equal(true);

        releaseFirst();
        releaseFirst(); // giving a hold back twice does not take the other holder's
        expect(isEventLoopWatchRunning()).to.equal(true);

        releaseSecond();
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

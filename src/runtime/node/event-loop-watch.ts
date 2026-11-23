import { monitorEventLoopDelay } from "node:perf_hooks";
import type { IntervalHistogram } from "node:perf_hooks";
import type { Logger } from "@pkcprotocol/pkc-logger";

// Reports when the process's main thread was held up (issue #576).
//
// A node hosting many communities does all of their work on one thread, and several scaling problems had the same
// shape: one synchronous stretch whose length grew with the number of communities (a directory listing, a lock check
// per community, decoding a list of every topic). Nothing reported it: the node kept working, only later and later.
// This measures how late timers fire, which is what such a stretch does to everything else, and logs when a timer
// was more than EVENT_LOOP_BLOCKED_REPORT_MS late in the last check period. It says that something blocked and for
// how long, not what: the slow-cycle report of the publish loop and a CPU profile say what.
//
// One histogram per process, running while at least one publish loop is. Its cost does not depend on the number of
// communities: one timer of EVENT_LOOP_DELAY_RESOLUTION_MS, and one check every EVENT_LOOP_CHECK_PERIOD_MS.

export const EVENT_LOOP_BLOCKED_REPORT_MS = 200;
export const EVENT_LOOP_CHECK_PERIOD_MS = 10_000;
const EVENT_LOOP_DELAY_RESOLUTION_MS = 20;

type EventLoopWatch = { histogram: IntervalHistogram; checkTimer: ReturnType<typeof setInterval>; holders: number };

let watch: EventLoopWatch | undefined;

// The delay of the last check period if it is worth a report, in milliseconds. The histogram records how long each of
// its timers took to fire, so the lateness is that minus the timer's own period.
export function eventLoopDelayToReport({
    maxNs,
    p99Ns,
    resolutionMs = EVENT_LOOP_DELAY_RESOLUTION_MS,
    reportMs = EVENT_LOOP_BLOCKED_REPORT_MS
}: {
    maxNs: number;
    p99Ns: number;
    resolutionMs?: number;
    reportMs?: number;
}): { maxLateMs: number; p99LateMs: number } | undefined {
    const maxLateMs = Math.round(maxNs / 1e6 - resolutionMs);
    if (maxLateMs < reportMs) return undefined;
    return { maxLateMs, p99LateMs: Math.max(0, Math.round(p99Ns / 1e6 - resolutionMs)) };
}

// Starts the watch if nobody holds it yet. The function it returns gives the hold back, once. The watch is one per
// process, so it reports through the logger of whoever started it.
export function holdEventLoopWatch({ log }: { log: Logger }): () => void {
    if (!watch) {
        const histogram = monitorEventLoopDelay({ resolution: EVENT_LOOP_DELAY_RESOLUTION_MS });
        histogram.enable();
        const checkTimer = setInterval(() => {
            const report = eventLoopDelayToReport({ maxNs: histogram.max, p99Ns: histogram.percentile(99) });
            histogram.reset();
            if (report)
                log.error(
                    `holdEventLoopWatch: The main thread was blocked for up to ${report.maxLateMs}ms in the last ${EVENT_LOOP_CHECK_PERIOD_MS / 1000}s` +
                        ` (99% of timers were at most ${report.p99LateMs}ms late). Everything this process does waited that long.`
                );
        }, EVENT_LOOP_CHECK_PERIOD_MS);
        checkTimer.unref();
        watch = { histogram, checkTimer, holders: 0 };
    }
    watch.holders++;
    let released = false;
    return () => {
        if (released || !watch) return;
        released = true;
        if (--watch.holders > 0) return;
        clearInterval(watch.checkTimer);
        watch.histogram.disable();
        watch = undefined;
    };
}

export function isEventLoopWatchRunning(): boolean {
    return watch !== undefined;
}

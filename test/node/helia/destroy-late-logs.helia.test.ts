// Regression test for #345: a libp2p-js block fetch used to outlive both its caller's abort
// signal and pkc.destroy().
//
// BaseClientsManager._fetchCidP2P handed the caller's abortSignal only to its outer pTimeout, never
// to cat(), so aborting the caller (comment/community stop(), the pkc destroy signal) abandoned the
// promise while the helia cat generator kept creating bitswap sessions and retrying "no providers"
// until its own kubo-style timeout fired (generic-ipfs = 30s). And the helia stop() in
// helia-for-pkc.ts neither aborted nor waited for in-flight cat() calls, so a fetch with no caller
// signal at all (pkc.fetchCid) kept going after helia.stop() returned.
//
// Why that matters: under --per-test-logs the `debug` module is routed through console.error and
// vitest forwards every line from the worker to the main process (onUserConsoleLog). A line that
// lands after the suite's last destroy() resolved, while vitest is tearing the worker down, is
// rejected with `EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was pending` and
// turns an all-green run into exit 1 (CI run 34019332586 on master, blamed on
// rejection.modqueue.community.test.ts). Same class as #325, which covered the RPC endpoints.
//
// The contract asserted here, using the same shared-`debug`-sink capture as
// test/node/rpc/rpc-destroy-late-logs.test.ts: once the caller's signal aborts, or once
// pkc.destroy() resolves, the fetch has rejected and the libp2p-js namespaces emit nothing further.
import { describe, it, expect, afterEach } from "vitest";
import { createRequire } from "node:module";
import { mockPKCWithHeliaConfig } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";

interface DebugModule {
    log: (...args: unknown[]) => void;
    enable: (namespaces: string) => void;
    disable: () => string;
}

// `debug` ships no typings and is CJS; createRequire hands back the same cached instance that
// @pkcprotocol/pkc-logger (and therefore dist/) logs through.
const debugModule: DebugModule = createRequire(import.meta.url)("debug");

// The retry loop and the per-router findProviders wrapper both log under pkc-js:libp2p-js; the
// fetch wrapper itself logs under pkc-js:clients-manager.
const CAPTURED_NAMESPACES = "pkc-js:libp2p-js*,pkc-js:clients-manager*";

function captureDebugOutput(namespaces: string): { lines: string[]; restore: () => void } {
    const lines: string[] = [];
    const previousLog = debugModule.log;
    const previousNamespaces = debugModule.disable();
    debugModule.enable(namespaces);
    debugModule.log = (...args: unknown[]) => {
        lines.push(args.map((arg) => (typeof arg === "string" ? arg : String(arg))).join(" "));
    };
    return {
        lines,
        restore: () => {
            debugModule.log = previousLog;
            debugModule.enable(previousNamespaces);
        }
    };
}

// A valid CIDv0 that nothing on the test network provides, so the fetch sits in the
// "no providers, retry" loop for as long as it is allowed to live.
const UNPROVIDED_CID = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";

// A "no providers" retry cycle is ~500ms (SESSION_NO_PROVIDERS_RETRY_BASE_DELAY_MS) plus the
// routing round-trip, so a fetch that survived abort/destroy logs its next attempt well inside
// this window. Generous for CI jitter.
const LATE_LOG_SETTLE_MS = 2_000;
// Far longer than the test itself, so the only ways the fetch can end are the abort or destroy
// under test, never its own timeout.
const FETCH_TIMEOUT_MS = 120_000;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Reject-or-still-pending probe: resolves "pending" if the promise has not settled by the next
// macrotask.
async function settledState(promise: Promise<unknown>): Promise<"resolved" | "rejected" | "pending"> {
    return Promise.race([
        promise.then(
            () => "resolved" as const,
            () => "rejected" as const
        ),
        sleep(0).then(() => "pending" as const)
    ]);
}

// Exercises the in-process libp2p-js client, so it is config-independent and runs once under
// non-RPC (under RPC the client would live in the server process, out of reach of the debug sink).
describeSkipIfRpc("libp2p-js block fetches end with their caller and with pkc.destroy() (#345)", () => {
    let pkc: PKC;

    afterEach(async () => {
        if (pkc && !pkc.destroyed) await pkc.destroy();
    });

    it("aborting the caller's signal ends the fetch and no libp2p-js debug output follows", async () => {
        pkc = await mockPKCWithHeliaConfig();
        const capture = captureDebugOutput(CAPTURED_NAMESPACES);
        try {
            const controller = new AbortController();
            const fetchPromise = pkc._clientsManager._fetchCidP2P(UNPROVIDED_CID, {
                maxFileSizeBytes: 1024 * 1024,
                timeoutMs: FETCH_TIMEOUT_MS,
                abortSignal: controller.signal
            });
            fetchPromise.catch(() => {}); // asserted on below, never left unhandled
            // Let the fetch get as far as at least one failed provider lookup so a retry is queued.
            await sleep(1_500);
            expect(capture.lines.some((line) => line.includes("retrying, attempt"))).toBe(true);

            controller.abort(new Error("caller is done"));
            await sleep(0);
            const fetchStateAfterAbort = await settledState(fetchPromise);
            const linesWhenAborted = capture.lines.length;

            await sleep(LATE_LOG_SETTLE_MS);

            expect({
                fetchStateAfterAbort,
                lateLines: capture.lines.slice(linesWhenAborted)
            }).toEqual({
                fetchStateAfterAbort: "rejected",
                lateLines: []
            });
        } finally {
            capture.restore();
        }
    });

    it("pkc.destroy() ends a fetch that has no caller signal and no libp2p-js debug output follows", async () => {
        pkc = await mockPKCWithHeliaConfig();
        const capture = captureDebugOutput(CAPTURED_NAMESPACES);
        try {
            // pkc.fetchCid passes no abortSignal down, so only the helia stop path can end this one.
            const fetchPromise = pkc._clientsManager._fetchCidP2P(UNPROVIDED_CID, {
                maxFileSizeBytes: 1024 * 1024,
                timeoutMs: FETCH_TIMEOUT_MS
            });
            fetchPromise.catch(() => {});
            await sleep(1_500);
            expect(capture.lines.some((line) => line.includes("retrying, attempt"))).toBe(true);

            await pkc.destroy();
            const fetchStateWhenDestroyResolved = await settledState(fetchPromise);
            const linesWhenDestroyResolved = capture.lines.length;

            await sleep(LATE_LOG_SETTLE_MS);

            expect({
                fetchStateWhenDestroyResolved,
                lateLines: capture.lines.slice(linesWhenDestroyResolved)
            }).toEqual({
                fetchStateWhenDestroyResolved: "rejected",
                lateLines: []
            });
        } finally {
            capture.restore();
        }
    });
});

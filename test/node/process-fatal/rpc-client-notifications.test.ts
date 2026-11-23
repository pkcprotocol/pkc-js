// A broken RPC server must not be able to end the client process with a live notification (findings 2 and 3).
// Each case runs twice, without and with an `error` listener on pkc and on the comment. Only the runs with a listener
// are asserted: a crash that survives a listener is the bug; one without a listener is the documented behaviour.
// One test collects every outcome, so a single run shows which cases crash.
import { describe, it, expect } from "vitest";
import PKC from "../../../dist/node/index.js";
import { captureProcessFatalErrors, letDetachedWorkSettle } from "../../helpers/process-fatal.js";
import { startNotificationSendingServer } from "../../helpers/fake-rpc-server.js";

const CID = "QmUDRXeoTt4kCZSwEK78UyduLcQcvhzfeEmUXTzuvVFRmu"; // any well-formed cid, the fake server never serves it

const cases: Record<string, { event: string; result: unknown }> = {
    "update event with a payload that fails parsing": { event: "update", result: { not: "a comment update" } },
    "comment event with a payload that fails parsing": { event: "comment", result: "garbage" },
    "updatingstatechange with a null result": { event: "updatingstatechange", result: null },
    "statechange with a null result": { event: "statechange", result: null },
    "runtimeupdate with a non-object result": { event: "runtimeupdate", result: 7 },
    "non-retriable error event": { event: "error", result: { code: "ERR_INVALID_JSON", message: "hostile", details: {} } }
};

describe("RPC client survives hostile live notifications", () => {
    it("raises no uncaught exception or unhandled rejection", async () => {
        const outcomes: Record<string, string[]> = {};
        for (const [name, notification] of Object.entries(cases)) {
            for (const withListener of [false, true]) {
                const server = await startNotificationSendingServer([notification]);
                const capture = captureProcessFatalErrors();
                const pkc = await PKC({ pkcRpcClientsOptions: [server.url], dataPath: undefined, httpRoutersOptions: [] });
                const comment = await pkc.createComment({ cid: CID });
                if (withListener) {
                    pkc.on("error", () => {});
                    comment.on("error", () => {});
                }
                // not awaited: over RPC update() settles only after the server's first update, which a hostile server withholds
                void comment.update().catch(() => {});
                await letDetachedWorkSettle(900);
                capture.stop();
                // teardown can hang on a half-broken subscription; bound it so the other cases still run
                await Promise.race([pkc.destroy().catch(() => {}), letDetachedWorkSettle(3000)]);
                await server.close();
                outcomes[`${name} | listener: ${withListener}`] = capture.fatals.map((f) => `${f.kind}: ${f.message}`);
            }
        }
        // With a listener nothing may end the process. Without one the report of the failure is an unlistened "error",
        // which stops the process by design (README: listen for "error"), so those outcomes are not asserted here.
        const withListener: Record<string, string[]> = {};
        const expected: Record<string, string[]> = {};
        for (const [key, fatals] of Object.entries(outcomes))
            if (key.endsWith("listener: true")) {
                withListener[key] = fatals;
                expected[key] = [];
            }
        expect(withListener).toEqual(expected);
    });
});

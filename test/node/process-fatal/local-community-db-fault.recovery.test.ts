// What the publish loop does with each kind of DB fault in the read it makes between two cycles
// (src/.../local-community/db-fault.ts): a busy DB or a short run of I/O errors is ridden out, a fault that keeps coming
// ends the loop with ONE error event.
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { uniqueTmpDataPath } from "../../helpers/rpc-server-harness.js";
import { captureProcessFatalErrors, letDetachedWorkSettle } from "../../helpers/process-fatal.js";
import { mockPKC, createSubWithNoChallenge } from "../../../dist/node/test/test-util.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// Needs the node-only LocalCommunity and its DB handle, which an RPC client does not have
describeSkipIfRpc("the publish loop's read of the DB between cycles, under DB faults", () => {
    async function run(fault: { code: string; message: string; forMs?: number }, observeMs: number, stopAfterMs?: number) {
        const dataPath = uniqueTmpDataPath("db-fault-recovery");
        const pkc = await mockPKC({ dataPath });
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        const errors: unknown[] = [];
        pkc.on("error", () => {});
        community.on("error", (e) => errors.push(e));
        await community.start();
        await Promise.race([new Promise((resolve) => community.once("update", resolve)), letDetachedWorkSettle(20000)]);
        const errorsBeforeFault = errors.length;
        const capture = captureProcessFatalErrors();
        const faultEndsAt = fault.forMs === undefined ? Infinity : Date.now() + fault.forMs;
        let failedReads = 0;
        const failingQuery = vi.spyOn(community._dbHandler, "queryLatestPostCid").mockImplementation(() => {
            if (Date.now() >= faultEndsAt) return undefined;
            failedReads++;
            throw Object.assign(new Error(fault.message), { code: fault.code });
        });
        // The loop sleeps until something asks for a record. End the sleep, so the cycle (which builds no record and
        // does not run this query) and the read after it happen now and not up to a publish interval later
        community._wakePublishLoop?.();
        let stopSettledWhileFaulty: boolean | undefined;
        if (stopAfterMs !== undefined) {
            await letDetachedWorkSettle(stopAfterMs);
            stopSettledWhileFaulty = await Promise.race([
                community.stop().then(() => true),
                letDetachedWorkSettle(observeMs).then(() => false)
            ]);
        } else await letDetachedWorkSettle(observeMs);
        capture.stop();
        failingQuery.mockRestore();
        const result = {
            errors: errors.length - errorsBeforeFault,
            fatals: capture.fatals.map((f) => f.message),
            state: community.state,
            failedReads,
            stopSettledWhileFaulty
        };
        await Promise.race([community.stop().catch(() => {}), letDetachedWorkSettle(10000)]);
        await Promise.race([pkc.destroy().catch(() => {}), letDetachedWorkSettle(10000)]);
        fs.rmSync(dataPath, { recursive: true, force: true });
        return result;
    }

    it("rides out a busy DB: no error, no fatal, still started", async () => {
        const result = await run({ code: "SQLITE_BUSY", message: "database is locked", forMs: 1000 }, 2000);
        expect({ errors: result.errors, fatals: result.fatals, state: result.state }).toEqual({ errors: 0, fatals: [], state: "started" });
        // more failed reads than a run of I/O errors is given: a busy DB is waited out however long it takes
        expect(result.failedReads).toBeGreaterThan(6);
    });

    // A DB that stays busy must not keep stop() waiting: the loop looks at stop() before every retry of the read
    it("stop() settles while the DB is still busy", async () => {
        const result = await run({ code: "SQLITE_BUSY", message: "database is locked" }, 5000, 500);
        expect({ stopped: result.stopSettledWhileFaulty, fatals: result.fatals, state: result.state }).toEqual({
            stopped: true,
            fatals: [],
            state: "stopped"
        });
        expect(result.failedReads).toBeGreaterThan(0);
    });

    it("rides out a short run of I/O errors", async () => {
        const result = await run({ code: "SQLITE_IOERR", message: "disk I/O error", forMs: 250 }, 1500);
        expect({ errors: result.errors, fatals: result.fatals, state: result.state }).toEqual({ errors: 0, fatals: [], state: "started" });
        expect(result.failedReads).toBeGreaterThan(0);
    });

    it("emits one error, stops the community and raises no fatal when I/O errors keep coming", async () => {
        const result = await run({ code: "SQLITE_IOERR", message: "disk I/O error" }, 2500);
        expect({ errors: result.errors, fatals: result.fatals, state: result.state }).toEqual({ errors: 1, fatals: [], state: "stopped" });
    });

    it("emits one error, stops the community and raises no fatal for a fault that is final at once", async () => {
        const result = await run({ code: "SQLITE_CORRUPT", message: "database disk image is malformed" }, 1500);
        expect({ errors: result.errors, fatals: result.fatals, state: result.state }).toEqual({ errors: 1, fatals: [], state: "stopped" });
    });
});

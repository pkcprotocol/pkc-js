// A DB fault the publish loop cannot get past: the loop ends, the community reports the failure ONCE as an "error" event
// and stops, instead of staying "started" with nothing that publishes. (The loop used to wake on a 100ms timer that queried
// the DB outside any try/catch; it now sleeps on a one-shot timer and checks the DB at the end of each cycle, on the loop's
// own stack, so nothing here can end the process when something listens.)
// A throwaway community on its own data path; nothing is published to a shared community.
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { uniqueTmpDataPath } from "../../helpers/rpc-server-harness.js";
import { captureProcessFatalErrors, letDetachedWorkSettle } from "../../helpers/process-fatal.js";
import { mockPKC, createSubWithNoChallenge } from "../../../dist/node/test/test-util.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// Needs the node-only LocalCommunity and its DB handle, which an RPC client does not have
describeSkipIfRpc("a DB fault in the publish loop of a started local community", () => {
    type Fault = "query throws SQLITE_IOERR (stubbed)" | "connection closed under the loop (real better-sqlite3 error)";

    async function run(fault: Fault) {
        const dataPath = uniqueTmpDataPath("db-fault-loop");
        const pkc = await mockPKC({ dataPath });
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        const errors: unknown[] = [];
        pkc.on("error", () => {});
        community.on("error", (e) => errors.push(e));
        await community.start();
        await Promise.race([new Promise((resolve) => community.once("update", resolve)), letDetachedWorkSettle(20000)]);
        const errorsBeforeFault = errors.length;
        const capture = captureProcessFatalErrors();
        const failingQuery =
            fault === "query throws SQLITE_IOERR (stubbed)"
                ? vi.spyOn(community._dbHandler, "queryLatestPostCid").mockImplementation(() => {
                      throw Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
                  })
                : undefined;
        // destoryConnection() refuses while the community is started (#561), so the raw handle is closed: what a handle
        // closed by another code path does to the loop's DB
        if (!failingQuery) (community._dbHandler as unknown as { _db: { close: () => void } })._db.close();
        // the loop checks the DB at the end of its next cycle; wait for the community to go down
        const deadline = Date.now() + 15000;
        while (community.state !== "stopped" && Date.now() < deadline) await letDetachedWorkSettle(100);
        await letDetachedWorkSettle(500); // a second error would show up here
        capture.stop();
        failingQuery?.mockRestore();
        const result = { errors: errors.length - errorsBeforeFault, fatals: capture.fatals.map((f) => f.message), state: community.state };
        await Promise.race([pkc.destroy().catch(() => {}), letDetachedWorkSettle(10000)]);
        fs.rmSync(dataPath, { recursive: true, force: true });
        return result;
    }

    it.each(<const>["query throws SQLITE_IOERR (stubbed)", "connection closed under the loop (real better-sqlite3 error)"])(
        "emits one error, stops the community and raises no process-fatal error: %s",
        async (fault) => {
            expect(await run(fault)).toEqual({ errors: 1, fatals: [], state: "stopped" });
        }
    );
});

import path from "node:path";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { runHangingScenarioInChildProcess } from "../../../dist/node/runtime/node/test/helpers/run-hanging-node.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";

// runHangingScenarioInChildProcess kills the child at timeoutMs and gave it a cleanup wait of the same
// length (HANGING_RUNNER_WAIT), but the child only starts that wait after the scenario has run. With a
// handle that never closes, the wait always outlasted the parent's timer, so the child was killed
// before printing the report of remaining handles and requests: a real leak surfaced only as
// "hanging-runner timed out", without the diagnostic the runner exists to produce.
//
// The scenario here leaks a listening server on purpose (a handle the runner reports; timers are not
// among process._getActiveHandles() on current Node). It needs no PKC, kubo or test server; the scenario
// module is written to .tmp/ and passed to the runner as a path relative to its scenarios directory.
// Config-independent, so it runs once under non-RPC via describeSkipIfRpc.
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scenariosDir = path.join(repoRoot, "dist", "node", "test", "node", "hanging-test", "scenarios");
const scenarioDir = path.join(repoRoot, ".tmp", "hanging-runner-leak-report");
const scenarioFile = path.join(scenarioDir, "leaked-server.scenario.mjs");

describeSkipIfRpc("hanging-runner reports leaked handles before the parent's timeout", () => {
    beforeAll(async () => {
        await mkdir(scenarioDir, { recursive: true });
        await writeFile(
            scenarioFile,
            `import net from "node:net";

export default {
    id: "leaked-server",
    description: "leaves a server listening after the scenario returns",
    run: async () => {
        await new Promise((resolve) => net.createServer().listen(0, "127.0.0.1", resolve));
    }
};
`
        );
    });

    afterAll(async () => {
        await rm(scenarioDir, { recursive: true, force: true });
    });

    it("fails with the JSON report of the remaining handles instead of a bare timeout", async () => {
        const scenarioModuleBaseName = path.relative(scenariosDir, scenarioFile).split(path.sep).join("/");

        const error = await runHangingScenarioInChildProcess({
            configCode: "local-kubo-rpc",
            // The child ends its wait 2s before this, 6s in. Starting it and printing the report must fit in
            // the 8s, which leaves room for a slow CI runner.
            timeoutMs: 8_000,
            scenarioModuleBaseName
        }).then(
            (): undefined => undefined,
            (e: Error) => e
        );

        expect(error, "a leaked server must fail the scenario").to.be.instanceOf(Error);
        expect(error!.message).to.not.include("timed out");
        expect(error!.message).to.include("hanging-runner exited with code 1");
        expect(error!.message).to.include("Active resources after pkc.destroy()");
        expect(error!.message).to.include('"type": "Server"');
    });
});

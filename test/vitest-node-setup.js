// Setup file for Vitest node tests

// Redirect debug module output through console.error so vitest captures it
// per-test via onUserConsoleLog (debug normally writes directly to process.stderr.write,
// bypassing vitest's console interception)
if (process.env.PER_TEST_LOG_DIR) {
    const debug = require("debug");
    debug.log = console.error.bind(console);
}

// Stagger worker startup (issue #265). Under --parallel every worker starts its first file at the
// same moment, and each one creates PKC instances, imports keys and adds blocks on the shared test
// Kubo daemon. That burst (250-360 API requests/s against ~25-175 in steady state) left TCP
// connects to :15001 unanswered past undici's 10s connect timeout, failing whichever test was
// mid-request. Each pool slot gets a start time relative to the run's start (set by
// run-test-config.js), so the workers ramp up one after another. The schedule is absolute because
// vitest forks a fresh process per file: a file that starts after its slot's time doesn't wait.
// Capped so a many-core machine doesn't idle its last workers for long.
const workerStaggerCapMs = 12_000;
const workerStaggerMs = Number(process.env.PKC_TEST_WORKER_STAGGER_MS ?? 3000);
const runStartedAtMs = Number(process.env.PKC_TEST_RUN_STARTED_AT_MS);
const poolId = Number(process.env.VITEST_POOL_ID);
if (runStartedAtMs > 0 && poolId > 1 && workerStaggerMs > 0) {
    const waitMs = runStartedAtMs + Math.min((poolId - 1) * workerStaggerMs, workerStaggerCapMs) - Date.now();
    // Own timeout: the wait can be up to the 12s cap, more than a short --vitest-timeout gives hooks
    if (waitMs > 0) beforeAll(() => new Promise((resolve) => setTimeout(resolve, waitMs)), waitMs + 10_000);
}

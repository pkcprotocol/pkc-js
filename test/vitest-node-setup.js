// Setup file for Vitest node tests

// Redirect debug module output through console.error so vitest captures it
// per-test via onUserConsoleLog (debug normally writes directly to process.stderr.write,
// bypassing vitest's console interception)
if (process.env.PER_TEST_LOG_DIR) {
    const debug = require("debug");
    debug.log = console.error.bind(console);
}

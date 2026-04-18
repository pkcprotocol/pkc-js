// Setup file for Vitest browser tests
import debug from "debug";

const debugNamespaces = typeof process !== "undefined" ? process?.env?.DEBUG : undefined;
if (typeof window !== "undefined" && window.localStorage && debugNamespaces) {
    try {
        const previousDebug = window.localStorage.getItem("debug");
        window.localStorage.setItem("debug", previousDebug ? `${previousDebug},${debugNamespaces}` : debugNamespaces);
    } catch (error) {
        console.warn("Failed to set debug namespaces for browser tests", error);
    }
}

// Redirect debug module output through console.error so vitest captures it
// as stderr per-test via onUserConsoleLog (debug defaults to console.debug
// in the browser, which vitest classifies as stdout)
if (typeof process !== "undefined" && process?.env?.PER_TEST_LOG_DIR) {
    debug.log = console.error.bind(console);
}

console.log("Vitest browser setup - PKC_CONFIGS:", globalThis.PKC_CONFIGS);

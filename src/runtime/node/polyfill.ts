// import this file at the very top of index.ts to polyfill
// stuff for browsers

// nothing to polyfill in node
import Logger from "../../logger.js";

// Add Promise.withResolvers polyfill for Node.js < 22
import "@enhances/with-resolvers";

// `undici` is ~112 modules - the second largest block of the eager import graph after the
// link-scraping closure - and the only thing we need it for is raising the global fetch body
// timeout for kubo-rpc-client. So it is NOT imported at module scope: `applyUndiciPolyfills()`
// below loads it on demand and is awaited by createKuboRpcClient() before the first kubo client
// exists, which is the only consumer that needs the raised timeout. An RPC-only process (the
// bitsocial CLI talking to a remote daemon) never constructs a kubo client and never pays for it.
//
// It has to be an explicit awaited call rather than a floating import() at module scope: a
// floating promise would race the first fetch, and index.ts cannot use top-level await because
// the package's `require` export condition points at this graph and require(esm) rejects TLA.
let undiciPolyfillPromise: Promise<void> | undefined;

export const applyUndiciPolyfills = () => (undiciPolyfillPromise ??= _applyUndiciPolyfills());

async function _applyUndiciPolyfills() {
    const { setGlobalDispatcher, Agent, WebSocket } = await import("undici");

    if (Number(process.versions.node.split(".")[0]) >= 18) {
        // We're on node 18+, we need to change the timeout of the body globally
        // Should be removed at some point once kubo-rpc-client fixes their problem with node 18+
        const log = Logger("pkc-js:polyfill");
        log("Patching up the global body timeout");
        setGlobalDispatcher(new Agent({ bodyTimeout: Number.MAX_SAFE_INTEGER }));
    }

    if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
        Reflect.set(globalThis as object, "WebSocket", WebSocket);
    }
}

// must export a function and call it or this file isn't read
export default () => {};

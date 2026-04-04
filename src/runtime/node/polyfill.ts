// import this file at the very top of index.ts to polyfill
// stuff for browsers

// nothing to polyfill in node
import { setGlobalDispatcher, Agent, WebSocket } from "undici";
import Logger from "../../logger.js";

// Add Promise.withResolvers polyfill for Node.js < 22
import "@enhances/with-resolvers";

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

// must export a function and call it or this file isn't read
export default () => {};

// import this file at the very top of index.ts to polyfill stuff for browsers.

// Add Promise.withResolvers polyfill for Node.js < 22
import "@enhances/with-resolvers";

// The undici global-dispatcher body-timeout patch (a workaround for kubo-rpc-client's HTTP body
// timeout, see applyKuboGlobalFetchBodyTimeoutPatch in runtime/node/util.ts) used to live here and
// forced every consumer — including the slim RPC-only ./client entry — to statically import undici's
// ~112-module graph. It is now applied lazily next to the kubo client, since it only matters for
// kubo's HTTP fetch. Node >= 22 (our `engines` floor) also ships a global WebSocket, so undici's
// WebSocket fallback is no longer needed. See issue #120.

// must export a function and call it or this file isn't read
export default () => {};

import type { NativeFunctions } from "../../types.js";
import dns from "node:dns";
import { applyUndiciPolyfills } from "./polyfill.js";
dns.setDefaultResultOrder("ipv4first");
const nativeFunctions: NativeFunctions = {
    // every gateway / IPFS content fetch goes through here, so this is where the deferred undici
    // dispatcher (raised body timeout) gets installed for the non-kubo paths. The promise is
    // memoized, so after the first call this awaits an already-resolved promise.
    fetch: async (...args) => {
        await applyUndiciPolyfills();
        return fetch(...args);
    }
};

export default nativeFunctions;

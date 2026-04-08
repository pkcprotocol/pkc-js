// import this file at the very top of index.ts to polyfill
// stuff for browsers

// fix "ReferenceError: process is not defined" in "assert" package
declare var window: any;
if (window.process === undefined) {
    const processPolyfill: any = {};
    // @ts-ignore
    window.process = processPolyfill;
}
if (window.process.env === undefined) {
    window.process.env = {};
}

// polyfill digest function, in case the we're loading pkc-js in browser on an insecure origin

import { sha512 } from "js-sha512";
import { sha256 } from "js-sha256";
// Check if running in browser, and if webcrypto is not loaded
// If it's not loaded it means we're running from an insecure origin
if (window && !window?.crypto?.subtle) {
    console.log("window.crypto.subtle is not set, attempting to polyfill window.crypto.subtle.digest");

    if (!window.crypto) window.crypto = {}; // to handle vitest in pkc-react-hooks
    window.crypto.subtle = {
        digest: (hashMethod: any, arrayBuffer: any) => {
            if (hashMethod === "SHA-512") return sha512.digest(arrayBuffer);
            else if (hashMethod?.name === "SHA-256") return sha256.digest(arrayBuffer);
            else {
                console.error(`Received an unsupported hash method (${hashMethod}) in the polyfill. Throwing`);
                throw Error("Unsupported digest " + hashMethod);
            }
        }
    };
}

// Add Promise.withResolvers polyfill for Node.js < 22
import "@enhances/with-resolvers";

// must export a function and call it or this file isn't read
export default () => {};

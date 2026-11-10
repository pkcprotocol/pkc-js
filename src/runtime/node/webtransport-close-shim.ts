// Node has no WebTransport transport and no Chromium renderer to crash, so there is nothing to patch.
// The browser build swaps this file for src/runtime/browser/webtransport-close-shim.ts (pkc-js#495).

/** What `installWebTransportCloseShim` did. Node always reports "unavailable". */
export type WebTransportCloseShimResult = "installed" | "already-installed" | "unavailable";

/** No-op counterpart of the browser shim, so shared code can call it unconditionally. */
export function installWebTransportCloseShim(): WebTransportCloseShimResult {
    return "unavailable";
}

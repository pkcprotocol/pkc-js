// Workaround for a Chromium renderer crash (pkc-js#495, upstream https://github.com/libp2p/js-libp2p/issues/3699).
//
// Chromium (141 and 156 tested) kills the tab with SIGSEGV when, in one synchronous task, a WebTransport
// stream has a write pending, then `writer.abort()` runs, then `WebTransport.close()` runs.
// @libp2p/webtransport 6.0.44 runs exactly that on every `connection.abort()`: each stream's sendReset()
// aborts its writer, then the muxer's sendReset() closes the session. The transport reads
// `globalThis.WebTransport` once when its module loads, so it cannot be handed a patched constructor;
// the prototype is the only place left to fix it.
//
// Running the real close() one microtask later avoids the crash every time. For any caller on the page
// the visible behaviour stays the same: close() still returns undefined, and `closed` and `ready` settle
// exactly as they would have, since the browser only ever settles them asynchronously.
//
// Remove this file (and its call in helia-for-pkc.ts) once a fixed @libp2p/webtransport ships.

/** The part of a WebTransport session this shim touches. */
interface WebTransportLike {
    close(closeInfo?: unknown): void;
}

type CloseFunction = WebTransportLike["close"];

/** A constructor whose prototype carries `close`, i.e. `globalThis.WebTransport` or a test double. */
export interface WebTransportConstructorLike {
    prototype: WebTransportLike;
}

/** What `installWebTransportCloseShim` did. */
export type WebTransportCloseShimResult = "installed" | "already-installed" | "unavailable";

// Symbol.for, not Symbol(): two copies of pkc-js on one page (or a hot reload) must see each other's mark
const SHIM_MARK = Symbol.for("pkc-js.webtransport-close-shim");

type MarkedCloseFunction = CloseFunction & { [SHIM_MARK]?: true };

type GlobalWithWebTransport = {
    WebTransport?: WebTransportConstructorLike;
    queueMicrotask: (callback: () => void) => void;
    reportError?: (error: unknown) => void;
};

/**
 * Wraps `WebTransport.prototype.close` so the real close runs one microtask later.
 *
 * Safe to call any number of times: the prototype is wrapped once per page. Does nothing when the
 * runtime has no WebTransport (Node, older browsers).
 *
 * @param WebTransportConstructor The constructor to patch. Defaults to `globalThis.WebTransport`; tests pass a double.
 * @returns "installed" when this call wrapped close, "already-installed" when an earlier call did,
 *          "unavailable" when there is no WebTransport to patch.
 */
export function installWebTransportCloseShim({
    WebTransportConstructor = (globalThis as unknown as GlobalWithWebTransport).WebTransport
}: { WebTransportConstructor?: WebTransportConstructorLike } = {}): WebTransportCloseShimResult {
    const prototype = WebTransportConstructor?.prototype;
    const originalClose: MarkedCloseFunction | undefined = prototype?.close;
    if (!prototype || typeof originalClose !== "function") return "unavailable";
    if (originalClose[SHIM_MARK]) return "already-installed";

    const globalScope = globalThis as unknown as GlobalWithWebTransport;

    const deferredClose: MarkedCloseFunction = function close(this: WebTransportLike, ...args: [closeInfo?: unknown]): void {
        globalScope.queueMicrotask(() => {
            try {
                originalClose.apply(this, args);
            } catch (error) {
                // The real close() throws only for a malformed closeInfo. The caller has already returned,
                // so close the session without it (never leave it open) and surface the error the way an
                // uncaught exception would be.
                try {
                    originalClose.call(this);
                } catch {
                    // the session is already closed or failed; nothing left to do
                }
                if (typeof globalScope.reportError === "function") globalScope.reportError(error);
            }
        });
    };
    deferredClose[SHIM_MARK] = true;

    const descriptor = Object.getOwnPropertyDescriptor(prototype, "close");
    Object.defineProperty(prototype, "close", {
        configurable: descriptor?.configurable ?? true,
        enumerable: descriptor?.enumerable ?? true,
        writable: descriptor?.writable ?? true,
        value: deferredClose
    });
    return "installed";
}

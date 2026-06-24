// Node-only stubs. The browser build is a string-replace copy of dist/node that rewrites
// `runtime/node/` imports to `runtime/browser/`, so every export the shared code (src/pkc/)
// imports from the node module must also exist here, or esbuild fails to bundle it. Neither is
// ever invoked in a browser (the callers are guarded by _canCreateNewLocalCommunity()).
//
// `syncKuboAppendAnnounce` is part of the kubo#11369 workaround — delete this stub together
// with the node implementation and its pkc.ts wiring once ipfs/kubo#11369 is fixed.
export function setupKuboHttpRouters() {
    throw Error("Should not be called in browser");
}

export function syncKuboAppendAnnounce() {
    throw Error("Should not be called in browser");
}

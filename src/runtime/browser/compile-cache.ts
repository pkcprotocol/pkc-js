// Browser counterpart of runtime/node/compile-cache.ts — V8's on-disk compile cache is a
// Node-only feature, so this is a no-op. It exists so the browser build's
// `/runtime/node/` -> `/runtime/browser/` import rewrite doesn't dangle.

export function enableNodeCompileCache(): void {
    // no-op in browsers
}

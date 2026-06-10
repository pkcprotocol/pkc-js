// Enables Node's on-disk V8 compile cache (issue #120). Caching the compiled bytecode
// recovers the parse/compile portion of import time (~29% of the post-lazy-load cost) on
// every run after the first.
//
// V8 only caches modules compiled AFTER the cache is enabled — and Node's ESM loader
// compiles the entire static import graph before any module body runs. So calling this
// from inside index.ts would never cover the package's own graph; it must be called from
// a thin bootstrap entry (index-with-compile-cache.ts) BEFORE the real entry is
// dynamic-imported.
//
// Designed to be a quiet optimization, never fatal:
// - no-op on Node < 22.8 (enableCompileCache doesn't exist there; engines allows >= 22)
// - cache dir is Node's default (os.tmpdir()/node-compile-cache), overridable with the
//   NODE_COMPILE_CACHE env var; consumers can opt out with NODE_DISABLE_COMPILE_CACHE=1
// - enableCompileCache itself reports failures via its return value instead of throwing,
//   but we still guard with try/catch in case of exotic runtimes

// Default import, not a named import: named imports of builtins are validated at link
// time, so `import { enableCompileCache }` would throw on Node 22.0-22.7.
import nodeModule from "node:module";

export function enableNodeCompileCache(): void {
    try {
        if (typeof nodeModule.enableCompileCache === "function") nodeModule.enableCompileCache();
    } catch {
        // compile cache is an optimization only — never let it break startup
    }
}

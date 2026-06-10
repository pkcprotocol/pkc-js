// Thin bootstrap entry for Node ESM consumers (the `"."` -> `import` condition in
// package.json). Part of issue #120: it enables Node's on-disk V8 compile cache and ONLY
// THEN dynamic-imports the real entry, so the whole module graph compiles with the cache
// active and runs after the first import reuse the cached bytecode (recovering the
// parse/compile ~29% of import time).
//
// Why a separate file instead of calling enableCompileCache() in index.ts: Node's ESM
// loader compiles the ENTIRE static import graph before any module body executes, and the
// compile cache only covers modules compiled after the call — so from inside index.ts it
// would always be too late. The dynamic import() below is what delays the graph's
// compilation until the cache is on.
//
// Why the `require` condition keeps pointing at plain index.js: this file uses top-level
// await, and require(esm) throws ERR_REQUIRE_ASYNC_MODULE on graphs containing TLA. CJS
// consumers simply keep the previous (uncached) behavior.
import { enableNodeCompileCache } from "./runtime/node/compile-cache.js";

enableNodeCompileCache();

const index = await import("./index.js");

export default index.default;
export const setNativeFunctions = index.setNativeFunctions;
export const nativeFunctions = index.nativeFunctions;
export const getShortCid = index.getShortCid;
export const getShortAddress = index.getShortAddress;
export const challenges = index.challenges;

// Keep the type-only surface identical to index.ts.
export type { NameResolverInterface } from "./schema.js";
export type { NameResolver } from "./types.js";

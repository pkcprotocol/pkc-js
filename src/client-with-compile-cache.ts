// Thin bootstrap for the `"./client"` -> `import` condition, mirroring index-with-compile-cache.ts.
// It enables Node's on-disk V8 compile cache and ONLY THEN dynamic-imports the real slim entry, so
// the whole (small) client graph compiles with the cache active and later runs reuse the cached
// bytecode. See index-with-compile-cache.ts for why the separate-file + dynamic-import dance is
// required (the cache only covers modules compiled after the call, and Node compiles the entire
// static graph before any module body runs).
import { enableNodeCompileCache } from "./runtime/node/compile-cache.js";

enableNodeCompileCache();

const client = await import("./client.js");

export default client.default;
export const setNativeFunctions = client.setNativeFunctions;
export const nativeFunctions = client.nativeFunctions;
export const getShortCid = client.getShortCid;
export const getShortAddress = client.getShortAddress;

// Keep the type-only surface identical to client.ts.
export type { NameResolverInterface } from "./schema.js";
export type { NameResolver } from "./types.js";

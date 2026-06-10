// Single source of truth for which bare imports stay EXTERNAL in the Node bundle
// (dist/bundled). Everything else reachable from the entries is inlined into the bundle
// chunks - that is the "inline pure-JS dependencies" step of issue #120: the remaining
// import cost on slow hosts is the node_modules ESM closure, not our own files.
//
// Shared by config/build-node-bundle.js (rolldown `external` option) and
// config/verify-bundle.js (external-allowlist gate) - keep this module side-effect free.
//
// Why each entry stays external:
//   - node builtins: checked first so the npm `assert`/`buffer` polyfill dependencies
//     (browser-only) never shadow the real builtins inside the node bundle.
//   - better-sqlite3: native .node binding, loads itself relative to its package dir.
//   - helia/libp2p subtree: only reachable through the lazy helia chunk, so inlining it
//     buys zero index-import time; it is a giant graph; and it reaches native optional
//     deps (node-datachannel via @libp2p/webrtc). Includes its datastore/blockstore
//     interface packages, which carry class identity across that graph.
//   - multiformats / uint8arrays / ipns: imported by BOTH our static graph and the
//     external helia graph. Keeping them external guarantees a single runtime copy, so
//     CID / peer-id / IPNS record values keep one identity on both sides.
//   - rpc-websockets: pre-bundled CJS dist whose `ws` dependency does optional native
//     requires (bufferutil, utf-8-validate) inside try/catch; rolldown would hoist those
//     into hard imports. It is a handful of modules anyway - negligible win.
//   - kubo-rpc-client + its IPFS plumbing: planned for a follow-up inlining pass (the
//     largest remaining module-count graph in the index static closure); kept external
//     in this step so each pass lands with its own measurements.

import { isBuiltin } from "node:module";

const externalPackages = new Set([
    "better-sqlite3",
    // helia/libp2p lazy subtree
    "helia",
    "libp2p",
    "datastore-core",
    "interface-datastore",
    "blockstore-core",
    // single-copy identity layer shared with the helia graph
    "multiformats",
    "uint8arrays",
    "ipns",
    // ws optional-native-deps hazard
    "rpc-websockets",
    // follow-up inlining pass (see header comment)
    "kubo-rpc-client",
    "ipfs-unixfs-importer",
    "typestub-ipfs-only-hash"
]);

const externalScopes = ["@helia/", "@libp2p/", "@chainsafe/", "@multiformats/"];

// "multiformats/cid" -> "multiformats", "@libp2p/peer-id/foo" -> "@libp2p/peer-id"
function packageNameOf(id) {
    const parts = id.split("/");
    return id.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function isExternalImport(id) {
    if (isBuiltin(id)) return true; // handles both "fs" and "node:fs"
    const packageName = packageNameOf(id);
    if (externalPackages.has(packageName)) return true;
    return externalScopes.some((scope) => packageName.startsWith(scope));
}

// For scripts/smoke-pack-install.js: the declared dependencies the Node bundle no longer
// resolves at runtime (i.e. inlined ones). They must still be installed by npm consumers
// because dist/browser is per-file and browser bundlers resolve them from node_modules.
export function inlinedDependencyNames(packageJson) {
    return Object.keys(packageJson.dependencies).filter((name) => !isExternalImport(name));
}

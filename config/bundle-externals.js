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
//   - typestub-ipfs-only-hash: its ipfs-only-hash graph is legacy CJS carrying its own
//     NESTED uint8arrays 2.x/3.x copies. Inlining it rewrites those requires to the root
//     ESM-only uint8arrays v5 (ERR_PACKAGE_PATH_NOT_EXPORTED), and its protobufjs dep
//     does optional eval("require") loads that silently degrade inside an ESM bundle.
//     It computes CIDs for signatures, so correctness beats the ~92-file CJS closure win.
//
// kubo-rpc-client and ipfs-unixfs-importer are deliberately INLINED even though they are
// IPFS plumbing: kubo-rpc-client alone was the largest remaining module graph in the
// index static closure (~371 modules), both are modern ESM with no nested copies of the
// identity layer, and only type imports of them cross the public API. Their
// multiformats/uint8arrays/ipns imports stay external per the list above, so the
// identity layer remains single-copy.

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
    // legacy CJS graph with nested uint8arrays copies (see header comment)
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

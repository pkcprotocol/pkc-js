// Bundles the tsc per-file output (dist/node/*.js) into dist/bundled/ with rolldown.
//
// Why: ~65% of the package's Node import time is ESM resolve/link overhead across the
// module graph, not code bodies (see docs/protocol/import-performance.md). Collapsing
// modules into a few chunks removes most of that overhead. Pure-JS dependencies are
// INLINED into the chunks too - after bundling our own ~157 files, the remaining import
// cost on slow hosts was the external node_modules ESM closure. What stays external (and
// why each does) lives in config/bundle-externals.js: node builtins, native deps
// (better-sqlite3), the lazy helia/libp2p subtree, the multiformats/uint8arrays/ipns
// identity layer shared with it, and rpc-websockets. Inlining zod is safe: zod v4
// instanceof is structural (Symbol.hasInstance checks _zod.traits), and external
// challenge plugins are loaded by path with their own node_modules anyway.
//
// The bundler input is the already-compiled JS, not the TS source: tsc stays the only
// compiler (NodeNext semantics, .d.ts emit), and dist/node + dist/browser are byte-identical
// to before. Only the package.json Node runtime conditions point at dist/bundled/.
//
// Output dir is dist/bundled/ on purpose - NOT dist/node-bundled/: config/build-browser.js
// filters watched paths with a startsWith(dist/node) prefix check, which a dist/node-bundled
// dir would falsely match.
//
// Why rolldown and not esbuild: this graph has import cycles (e.g. comment schema <->
// pages schema, clients <-> pkc client managers). esbuild's code splitting does not
// guarantee Node-like evaluation order across shared chunks of multiple entries, and with
// our 3 public entries it evaluated a cycle in the wrong order ("Class extends value
// undefined"). rolldown orders module bodies topologically like Node's ESM loader, and it
// supports top-level await together with splitting, so the compile-cache bootstrap can be
// part of the same build (esbuild cannot combine TLA + splitting at all).
//
// Code splitting keeps the lazy boundaries from the import-time work as real lazy chunks:
//   - src/pkc/pkc.ts -> await import("../helia/helia-for-pkc.js")         (helia/libp2p)
//   - src/pkc/pkc.ts -> await import(".../community/local-community.js")  (db-handler graph)
//   - index-with-compile-cache.js -> await import("./index.js")           (compile cache)
// The user-supplied challenge plugin import (await import(pathToFileURL(path).href)) is a
// non-analyzable runtime expression and passes through verbatim.
//
// Writes dist/bundled/bundle-manifest.json (per-output static/dynamic imports + input files);
// config/verify-bundle.js uses it to assert the lazy subgraphs really ended up in
// dynamically-imported chunks.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { rolldown } from "rolldown";
import { isExternalImport } from "./bundle-externals.js";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const outDir = path.join(root, "dist", "bundled");

// Chunk names are content-hashed, so a standalone re-run (outside `npm run build`, which
// rimrafs dist/) would otherwise accumulate stale chunks from previous builds and ship
// them in the tarball.
fs.rmSync(outDir, { recursive: true, force: true });

const bundle = await rolldown({
    cwd: root,
    input: {
        index: "dist/node/index.js",
        "index-with-compile-cache": "dist/node/index-with-compile-cache.js",
        challenges: "dist/node/challenges.js",
        "rpc/src/index": "dist/node/rpc/src/index.js"
    },
    platform: "node",
    // bare imports are inlined unless config/bundle-externals.js says otherwise; relative +
    // absolute ids are always ours (never external)
    external: (id) => !id.startsWith(".") && !path.isAbsolute(id) && isExternalImport(id),
    onwarn(warning, defaultHandler) {
        // text-math intentionally evals its own generated arithmetic expression; not a bundling problem
        if (warning.code === "EVAL" && String(warning.id).includes("text-math")) return;
        defaultHandler(warning);
    }
});

const { output } = await bundle.write({
    dir: outDir,
    format: "esm",
    chunkFileNames: "chunks/[name]-[hash].js",
    // No sourcemaps: with deps inlined they are ~16MB of the tarball, Node ignores them
    // without --enable-source-maps, and the per-file dist/node (which ships anyway) is the
    // readable reference for any bundled frame. Rebuild locally with sourcemap: true when
    // a bundled stack trace genuinely needs mapping.
    sourcemap: false
});
await bundle.close();

// Manifest for config/verify-bundle.js: which inputs each output contains and what it
// imports statically vs dynamically. Paths are relative to the repo root / outDir, always
// with posix separators - path.relative yields backslashes on Windows, which would break
// verify-bundle.js's forward-slash lookups (chunk.fileName/imports already use "/").
const manifest = { outputs: {} };
for (const chunk of output) {
    if (chunk.type !== "chunk") continue;
    manifest.outputs[chunk.fileName] = {
        isEntry: chunk.isEntry,
        imports: chunk.imports,
        dynamicImports: chunk.dynamicImports,
        inputs: Object.keys(chunk.modules).map((id) => path.relative(root, id).split(path.sep).join("/"))
    };
}
fs.writeFileSync(path.join(outDir, "bundle-manifest.json"), JSON.stringify(manifest, null, 4));

console.log(`build-node-bundle: ok (${Object.keys(manifest.outputs).length} files under dist/bundled)`);

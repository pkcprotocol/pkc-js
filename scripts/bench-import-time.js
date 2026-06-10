// Import-time benchmark (issue #120): measures the wall-clock cost of importing the compiled
// package, broken down by layer, to attribute where the startup latency comes from and to give
// the optimization work a repeatable number to track. It is a measurement tool, not a regression
// gate, so it lives here under scripts/ rather than in the test suite.
//
//   npm run build           # the harness imports from dist/, so build first
//   node scripts/bench-import-time.js
//
// Tune iterations with BENCH_IMPORT_ITERATIONS (default 5). Each measurement runs in a FRESH node
// process, because once a module graph is in a process's ESM cache a second import() is ~free — so
// per-process isolation is the only way to measure real cold-start cost. We report the median over
// the iterations.
//
// Why this exists (see issue #120): importing dist/node/index.js takes ~9s on slow hardware and
// ~0.5s on a fast dev machine, with NO PKC instance created and no work done. The dominant cost is
// that the RPC-client path eagerly pulls in the full local-node runtime: pkc-with-rpc-client.js
// does `class PKCWithRpcClient extends PKC`, and the base PKC class statically imports the local
// community classes (-> better-sqlite3), the challenges subsystem, the IPFS/helia helpers, and the
// full zod schema set. A consumer that only talks to a remote daemon over RPC needs none of that to
// start, yet pays for all of it.
//
// The layers below are imported each in isolation so you can see the marginal jump from the pure
// RPC-client graph to the full pkc-with-rpc-client graph (the inheritance pull-in), and the jump
// again to index.js. The absolute numbers scale with hardware; the RATIOS between layers are the
// stable, portable signal — they hold on fast and slow machines alike.

import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

const ITERATIONS = Number(process.env.BENCH_IMPORT_ITERATIONS ?? 5);
const distNode = fileURLToPath(new URL("../dist/node/", import.meta.url));

// Scratch lives under the project's .tmp/ (gitignored, on real disk), NEVER os.tmpdir() — on Linux
// /tmp is RAM-backed tmpfs, and the compile-cache section writes one file per module (~14k files),
// which would waste memory and can exhaust tmpfs inodes.
const benchTmpBase = fileURLToPath(new URL("../.tmp/", import.meta.url));
mkdirSync(benchTmpBase, { recursive: true });

// Entry points to measure, imported one per fresh process. Ordered from the leanest graph (a pure
// RPC client) to the full public entry, so the table reads as "what does each extra layer cost".
const targets = [
    { label: "rpc-client (pure RPC graph)", file: "clients/rpc-client/pkc-rpc-client.js" },
    { label: "challenges subsystem", file: "runtime/node/community/challenges/index.js" },
    { label: "pkc core class", file: "pkc/pkc.js" },
    { label: "pkc-with-rpc-client (extends PKC)", file: "pkc/pkc-with-rpc-client.js" },
    { label: "index.js (public entry)", file: "index.js" },
    // cache disabled in cold runs (NODE_DISABLE_COMPILE_CACHE=1), so this row isolates the
    // bootstrap wrapper's own overhead vs index.js — it should be ~0
    { label: "index-with-compile-cache.js (npm import entry, cache disabled)", file: "index-with-compile-cache.js" }
];

const median = (xs) => {
    const sorted = [...xs].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

// Run a single isolated import in a fresh process and return the elapsed ms it prints to stderr.
// `compileCacheDir`, when set, enables V8's bytecode cache (NODE_COMPILE_CACHE) so we can separate
// parse/compile cost (recoverable via the cache) from module linking + top-level execution cost.
function measureOnce(absFile, compileCacheDir) {
    const code = `const t=performance.now();await import(${JSON.stringify(absFile)});process.stderr.write(String(performance.now()-t));process.exit(0);`;
    const env = { ...process.env, TMPDIR: benchTmpBase };
    if (compileCacheDir) {
        env.NODE_COMPILE_CACHE = compileCacheDir;
        delete env.NODE_DISABLE_COMPILE_CACHE;
    } else {
        // Genuinely cold: index-with-compile-cache.js self-enables the cache (defaulting to
        // os.tmpdir()), so without this a "cold" run would silently warm up across iterations.
        delete env.NODE_COMPILE_CACHE;
        env.NODE_DISABLE_COMPILE_CACHE = "1";
    }
    const res = spawnSync(process.execPath, ["--input-type=module", "-e", code], { env, encoding: "utf8" });
    if (res.status !== 0) {
        throw new Error(`import of ${absFile} failed:\n${res.stderr}`);
    }
    return Number(res.stderr.trim());
}

function measureMedian(absFile, compileCacheDir) {
    const samples = [];
    for (let i = 0; i < ITERATIONS; i++) samples.push(measureOnce(absFile, compileCacheDir));
    return median(samples);
}

console.log(`# pkc-js import-time benchmark (issue #120)`);
console.log(`node ${process.version}, ${ITERATIONS} iterations/measurement, fresh process each, median reported.\n`);

// 1) Per-layer cold import (no compile cache). The marginal jump between rows attributes the cost.
console.log(`## Per-layer cold import (no V8 compile cache)\n`);
console.log(`| Layer | Median |`);
console.log(`| --- | --- |`);
let prev = null;
for (const t of targets) {
    const abs = path.join(distNode, t.file);
    const ms = measureMedian(abs, null);
    const delta = prev === null ? "" : ` (+${(ms - prev).toFixed(0)}ms vs prev)`;
    console.log(`| ${t.label} | ${ms.toFixed(0)}ms${delta} |`);
    prev = ms;
}

// 2) Full index.js: cold vs warm V8 compile cache, to size the parse/compile portion.
console.log(`\n## index.js — cold vs warm V8 compile cache\n`);
const indexAbs = path.join(distNode, "index.js");
const cacheDir = mkdtempSync(path.join(benchTmpBase, "pkc-bench-cc-"));
try {
    // Cold: first run with an empty cache dir also POPULATES the bytecode cache.
    const cold = measureOnce(indexAbs, cacheDir);
    // Warm: subsequent runs reuse the populated bytecode.
    const warm = measureMedian(indexAbs, cacheDir);
    console.log(`| Run | Time |`);
    console.log(`| --- | --- |`);
    console.log(`| cold (populates bytecode cache) | ${cold.toFixed(0)}ms |`);
    console.log(`| warm (bytecode reused) | ${warm.toFixed(0)}ms |`);
    console.log(`\nParse/compile portion ≈ ${(cold - warm).toFixed(0)}ms; linking + top-level exec ≈ ${warm.toFixed(0)}ms.`);
} finally {
    rmSync(cacheDir, { recursive: true, force: true });
}

// 3) The npm "import"-condition entry (index-with-compile-cache.js): it enables Node's compile
// cache itself before dynamic-importing index.js, so consumers get the warm-cache speedup by
// default — no NODE_COMPILE_CACHE env needed. First run with an empty cache dir populates it
// (and pays a small write cost); subsequent runs reuse the bytecode. We point NODE_COMPILE_CACHE
// at a scratch dir under .tmp/ so the benchmark controls (and cleans up) where the entry's
// self-enabled cache lands, instead of polluting the real os.tmpdir().
console.log(`\n## index-with-compile-cache.js (npm import entry) — self-enabled compile cache\n`);
const bootstrapAbs = path.join(distNode, "index-with-compile-cache.js");
const bootstrapCacheDir = mkdtempSync(path.join(benchTmpBase, "pkc-bench-bootstrap-cc-"));
try {
    const first = measureOnce(bootstrapAbs, bootstrapCacheDir);
    const warm = measureMedian(bootstrapAbs, bootstrapCacheDir);
    console.log(`| Run | Time |`);
    console.log(`| --- | --- |`);
    console.log(`| first (self-populates bytecode cache) | ${first.toFixed(0)}ms |`);
    console.log(`| warm (bytecode reused) | ${warm.toFixed(0)}ms |`);
    console.log(`\nThis is the default experience for Node ESM consumers importing the package.`);
} finally {
    rmSync(bootstrapCacheDir, { recursive: true, force: true });
}

// 4) Per-file self-time attribution — the "where in our code is it slow" answer. We run the import
// once under V8's CPU sampling profiler (--cpu-prof), then aggregate self-time per source file from
// the .cpuprofile. Self-time per profiler node = sum of the sample timeDeltas attributed to that
// node id; we map each node to its callFrame.url (the source file) and sum across all nodes sharing
// a file. This captures parse/compile + top-level execution, and needs no source rewriting (unlike
// a loader hook), so it is robust to "use strict" directives, hashbangs and import attributes.
console.log(`\n## Per-file self-time attribution (CPU profile of index.js import)\n`);
const profDir = mkdtempSync(path.join(benchTmpBase, "pkc-bench-prof-"));
try {
    const code = `await import(${JSON.stringify(indexAbs)});process.exit(0);`;
    const res = spawnSync(
        process.execPath,
        ["--cpu-prof", "--cpu-prof-dir", profDir, "--cpu-prof-interval", "200", "--input-type=module", "-e", code],
        { encoding: "utf8", env: { ...process.env, TMPDIR: benchTmpBase } }
    );
    if (res.status !== 0) throw new Error(`profiled import failed:\n${res.stderr}`);

    const profFile = readdirSync(profDir).find((f) => f.endsWith(".cpuprofile"));
    if (!profFile) throw new Error(`no .cpuprofile produced in ${profDir}`);
    const profile = JSON.parse(readFileSync(path.join(profDir, profFile), "utf8"));

    // node id -> total self time (µs). samples[i] ran for timeDeltas[i] µs and is attributed to that
    // sample's node id (its top-of-stack frame).
    const selfByNodeId = new Map();
    for (let i = 0; i < profile.samples.length; i++) {
        const id = profile.samples[i];
        const dt = profile.timeDeltas[i] ?? 0;
        selfByNodeId.set(id, (selfByNodeId.get(id) ?? 0) + dt);
    }

    // Roll node self-time up to its source file (callFrame.url), splitting our dist/ code from deps.
    const repoRoot = fileURLToPath(new URL("../", import.meta.url));
    const ourSelf = new Map(); // dist-relative file -> µs
    const depSelf = new Map(); // node_modules package -> µs
    // Coarse buckets so the reader can see whether the cost is in file bodies or the module loader.
    const buckets = { ourCode: 0, deps: 0, nodeInternal: 0, runtime: 0 };
    let total = 0;
    for (const node of profile.nodes) {
        const us = selfByNodeId.get(node.id) ?? 0;
        total += us;
        let url = node.callFrame?.url ?? "";
        if (url.startsWith("node:")) {
            buckets.nodeInternal += us; // ESM resolve/read/compile/link machinery, builtins
            continue;
        }
        if (url.startsWith("file://")) url = fileURLToPath(url);
        if (!url || !path.isAbsolute(url)) {
            buckets.runtime += us; // (program), (idle), (garbage collector), native
            continue;
        }
        const nm = url.lastIndexOf("node_modules/");
        if (nm !== -1) {
            buckets.deps += us;
            const rest = url.slice(nm + "node_modules/".length);
            const parts = rest.split("/");
            const pkg = rest.startsWith("@") ? `${parts[0]}/${parts[1]}` : parts[0];
            depSelf.set(pkg, (depSelf.get(pkg) ?? 0) + us);
        } else if (url.startsWith(repoRoot)) {
            buckets.ourCode += us;
            const rel = path.relative(repoRoot, url);
            ourSelf.set(rel, (ourSelf.get(rel) ?? 0) + us);
        } else {
            buckets.runtime += us;
        }
    }

    const topN = (map, n) => [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
    const ms = (us) => (us / 1000).toFixed(0);
    const pct = (us) => `${((us / total) * 100).toFixed(0)}%`;

    console.log(`Sampled ${(total / 1000).toFixed(0)}ms total. Where it goes:\n`);
    console.log(`| Bucket | Self | Share |`);
    console.log(`| --- | --- | --- |`);
    console.log(`| our code (dist/node/...) | ${ms(buckets.ourCode)}ms | ${pct(buckets.ourCode)} |`);
    console.log(`| dependencies (node_modules) | ${ms(buckets.deps)}ms | ${pct(buckets.deps)} |`);
    console.log(`| node internals (ESM resolve/link, builtins) | ${ms(buckets.nodeInternal)}ms | ${pct(buckets.nodeInternal)} |`);
    console.log(`| runtime ((program)/gc/native) | ${ms(buckets.runtime)}ms | ${pct(buckets.runtime)} |`);
    console.log(`\n### Top our-code files (dist/node/...) by self-time\n`);
    console.log(`| File | Self |`);
    console.log(`| --- | --- |`);
    for (const [file, us] of topN(ourSelf, 20)) console.log(`| ${file} | ${ms(us)}ms |`);
    console.log(`\n### Top dependencies by self-time\n`);
    console.log(`| Package | Self |`);
    console.log(`| --- | --- |`);
    for (const [pkg, us] of topN(depSelf, 20)) console.log(`| ${pkg} | ${ms(us)}ms |`);
} finally {
    rmSync(profDir, { recursive: true, force: true });
}

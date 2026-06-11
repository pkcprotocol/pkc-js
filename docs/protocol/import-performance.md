# Import / startup performance

Tracking doc for [issue #120](https://github.com/pkcprotocol/pkc-js/issues/120): importing the
package is slow, and the cost is paid by every process that imports it — including CLIs and
companion processes that only talk to a remote daemon over RPC and never start a local node.

This doc is **measurement-first**. It records how to reproduce the numbers, the current baseline,
where the time actually goes, and a checklist of optimizations. Each optimization, once landed,
appends a row to the [Benchmark history](#benchmark-history) so we can see its delta.

## Problem

Importing `@pkcprotocol/pkc-js` (`dist/node/index.js`) — a pure `import`, no PKC instance created,
no RPC connection, no work done — takes **~9s on slower hardware** and **~0.5s on a fast dev
machine**. A consumer that only uses the RPC client to talk to a remote daemon pays this full
startup, which makes trivial read-only commands feel broken (10–20s) on modest hardware.

## Root cause (confirmed)

`PKCWithRpcClient` — the _remote_ RPC client wrapper — is declared as
`class PKCWithRpcClient extends PKC` in [`src/pkc/pkc-with-rpc-client.ts`](../../src/pkc/pkc-with-rpc-client.ts).
Extending the core [`src/pkc/pkc.ts`](../../src/pkc/pkc.ts) class statically pulls in the entire
local-node runtime: local community classes (→ `better-sqlite3`), the challenges subsystem, the
IPFS/helia helpers, and the full zod schema set. An RPC-only consumer needs none of that to start,
yet pays for all of it.

The benchmark confirms two compounding costs:

1. **The full local-node runtime is loaded eagerly.** Importing just the RPC-client graph is
   ~2.7× cheaper than the full entry (see the per-layer table); the jump happens the moment the
   core `pkc.js` is touched.
2. **Most of the time is the module graph itself, not our code.** ~65% of import time is spent in
   Node's ESM resolve/link/compile machinery and only ~1% in our own file bodies — i.e. it is the
   _number_ of modules (157 `dist/node` files plus a large dependency closure), not expensive
   top-level code, that dominates.

## Running the benchmark

```sh
npm run build                      # the harness imports from dist/, so build first
node scripts/bench-import-time.js
```

Tune iterations with `BENCH_IMPORT_ITERATIONS` (default 5). Each measurement runs in a **fresh Node
process** (ESM caches a graph after the first import), and the median is reported. Scratch files go
to `.tmp/` (never `/tmp`, which is RAM-backed tmpfs on Linux).

The benchmark prints four sections:

-   **Per-layer cold import** — imports each layer in isolation; the marginal jump between rows
    attributes cost. The leanest layer (`rpc-client`) vs the full `index.js` shows what the RPC-only
    path is forced to over-pay.
-   **Cold vs warm V8 compile cache** — sizes the parse/compile portion (recoverable via
    `NODE_COMPILE_CACHE` / `module.enableCompileCache()`) separately from linking + execution.
-   **npm import entry, self-enabled compile cache** — measures `index-with-compile-cache.js`
    (the `"."` → `import` export condition), which enables the compile cache itself: first run
    (populates the cache) vs warm runs. This is the default experience for Node ESM consumers.
-   **Per-file self-time attribution** — runs the import under V8's native sampling profiler
    (`--cpu-prof`) and aggregates the resulting `.cpuprofile` into self-time per source file, plus a
    coarse bucket breakdown (our code / deps / node internals / runtime). This is the
    "where is it slow" signal.

> Absolute milliseconds are hardware-dependent (fast machine ~0.5s, slow machine ~9s); the **ratios
> between layers** and the **bucket shares** are the portable signal — they hold across machines.

## Baseline measurements (before any optimization)

Captured on `master` before the fixes below, on a fast 8-core host, Node v22.22.0, warm OS cache.
Reproduce with `node scripts/bench-import-time.js`. For the current numbers see
[Benchmark history](#benchmark-history).

### Per-layer cold import (no V8 compile cache)

| Layer                             | Median                      |
| --------------------------------- | --------------------------- |
| rpc-client (pure RPC graph)       | ~173ms                      |
| challenges subsystem              | ~165ms                      |
| pkc core class                    | **~476ms (+310ms vs prev)** |
| pkc-with-rpc-client (extends PKC) | ~475ms                      |
| index.js (public entry)           | ~480ms                      |

The +310ms jump at `pkc core class` is the local-node runtime being loaded. `pkc-with-rpc-client`
adds nothing on top because, via `extends PKC`, it has already pulled the whole thing in. A pure
RPC client (~173ms) is ~2.7× cheaper than the full entry (~480ms).

### index.js — cold vs warm V8 compile cache

| Run                             | Time   |
| ------------------------------- | ------ |
| cold (populates bytecode cache) | ~535ms |
| warm (bytecode reused)          | ~395ms |

Parse/compile ≈ **~140ms (~26%)**; linking + top-level execution ≈ ~395ms. The ~26% is recoverable
with a compile cache — cheap and immediate.

### Per-file self-time attribution (CPU profile of index.js import)

| Bucket                                      | Share    |
| ------------------------------------------- | -------- |
| our code (`dist/node/...`)                  | ~1%      |
| dependencies (`node_modules`)               | ~10%     |
| node internals (ESM resolve/link, builtins) | **~65%** |
| runtime (`(program)`/gc/native)             | ~23%     |

No single file body is hot. Top dependency self-times are small and spread out: `zod` ~17ms, then
`@noble/curves`, `asn1js`, `entities`, `undici`, `axios`, `multiformats` at ~2–3ms each. The cost is
the graph size, not a hotspot — which is why bundling and loading fewer modules are the big levers.

## Optimization directions

Ranked by effort/payoff. Tick each item and add a [history](#benchmark-history) row when it lands.
The first three landed together in PR #126 (one commit each; the originally stacked #124 and #125
were consolidated into it).

-   [x] **Lazy-load the local-node runtime off the RPC-client path** (done in #126) — the two
        heaviest leaves are now deferred behind dynamic `import()` on the code paths that actually
        start/run a local node, instead of being statically imported by the base `PKC` class:

    -   **helia/libp2p** (~683ms standalone, the single biggest subgraph) — loaded inside
        `_initLibp2pJsClientsIfNeeded()` in [`src/pkc/pkc.ts`](../../src/pkc/pkc.ts); `Libp2pJsClient`
        is now a type-only import.
    -   **LocalCommunity → db-handler → `better-sqlite3`** (~283ms standalone) — loaded inside
        `_createLocalCommunity()`; the class is now a type-only import at module scope.

        Result: `index.js` cold ~535ms → ~290ms and warm ~395ms → ~206ms on the reference host
        (~46% faster import); the `pkc core` jump collapsed from +310ms to +88ms. The same ratio
        takes the issue's ~9s slow-host import to roughly ~5s. Verified with the `helia` (17),
        local `create.community` (15) and `pkc` (6) test suites.

        Not pursued (measured ~free): lazy-loading `better-sqlite3`-via-`util`/`Storage` and the
        challenges subsystem — each imports in ≈ the bare-Node baseline (~165ms), so deferring them
        saves only ~10ms for real churn/risk. The residual ~88ms is the many-small-modules tail,
        which only bundling addresses.

-   [x] **V8 compile cache** (done in #126) — the `"."` → `import` export condition now points at a
        thin bootstrap, [`src/index-with-compile-cache.ts`](../../src/index-with-compile-cache.ts),
        that calls `module.enableCompileCache()` (via
        [`src/runtime/node/compile-cache.ts`](../../src/runtime/node/compile-cache.ts), no-op on
        Node < 22.8 and in browsers) and only then dynamic-imports the real `index.js`.

    The bootstrap exists because the cache only covers modules compiled _after_ the call, and
    Node's ESM loader compiles the whole static graph before any module body runs — so calling
    it from inside `index.ts` would always be too late; the dynamic `import()` is what delays
    the graph's compilation until the cache is on. The `require` condition keeps pointing at
    plain `index.js` since `require(esm)` rejects graphs with top-level await; CJS consumers
    keep the previous (uncached) behavior.

    Result: Node ESM consumers get the warm-cache import by default — ~272ms cold → ~208ms on
    every run after the first (~24% faster) on the reference host, no consumer config needed.
    The wrapper itself adds ~0ms (272ms vs 272ms with the cache disabled), and the first run
    pays a one-time ~30ms cache-population cost. Cache dir is Node's default
    (`os.tmpdir()/node-compile-cache`), overridable with `NODE_COMPILE_CACHE`; opt out with
    `NODE_DISABLE_COMPILE_CACHE=1`.
-   [ ] **Thin client entry point** — e.g. a `./client` export that pulls a minimal graph so RPC-only
        consumers never resolve/link the local-node modules at all. Likely unnecessary now that the
        heavy leaves are lazy; revisit only if the residual is still too high on slow hardware.
-   [x] **Bundle the published `dist` (our files; deps external)** (done in #126) — a rolldown step
        ([`config/build-node-bundle.js`](../../config/build-node-bundle.js)) collapses the compiled
        `dist/node/*.js` graph into a few ESM chunks under `dist/bundled/`, and the package.json
        Node runtime conditions (`import`/`require` for `.`, `./challenges`, `./rpc`) now point
        there. The dist layout after this change:

    -   `dist/node` — per-file tsc output. Still the source of truth for the `types` condition,
        for tests (they deep-import individual files), and as the input to both the browser copy
        step and the bundler.
    -   `dist/browser` — unchanged per-file output; downstream bundlers (e.g. vite apps) keep
        tree-shaking it. `browser` conditions untouched.
    -   `dist/bundled` — what npm consumers on Node actually load: 4 entries plus shared chunks,
        with the lazy boundaries (helia/libp2p, LocalCommunity → `better-sqlite3`, the
        compile-cache bootstrap's dynamic `import("./index.js")`) preserved as real lazy chunks.

    Rule: **one dist flavor per process.** Never import `dist/node` files and `dist/bundled`
    entries into the same process — module-level state (the nativeFunctions registry, caches,
    zod schema identity) would duplicate. Tests use per-file `dist/node` only; the build gates
    ([`config/verify-bundle.js`](../../config/verify-bundle.js)) and
    [`scripts/smoke-pack-install.js`](../../scripts/smoke-pack-install.js) exercise the bundle in
    fresh child processes.

    Notes from landing it:

    -   **rolldown, not esbuild.** esbuild's code splitting does not guarantee Node-like
        evaluation order across chunks shared by multiple entries; with our import cycles
        (comment schema ↔ pages schema, clients ↔ pkc managers) it evaluated a cycle in the
        wrong order ("Class extends value undefined"), and it cannot combine top-level await
        with splitting at all (which the compile-cache bootstrap needs). rolldown orders module
        bodies topologically like Node and handled both.
    -   One real cycle bug surfaced and was fixed in `src`: `CommentUpdateSchema`'s `replies`
        shape getter dereferenced `RepliesPagesIpfsSchema` at module-eval time (`.strict()`
        materializes the shape); it now wraps the reference in `z.lazy` inside the getter, so it
        is robust to any evaluation order.
    -   Result on the reference host: cold import 266ms → 245ms and warm-cache 208ms → 196ms
        (~8%). Modest, because with all deps external the remaining ESM overhead is dominated by
        the node_modules closure, not our 157 files — which sets up the next step.

-   [x] **Inline pure-JS dependencies into the bundle** (done in #126, two commits) — bare imports
        are now inlined into `dist/bundled` unless the shared denylist
        ([`config/bundle-externals.js`](../../config/bundle-externals.js), used by both the build
        and the verify gate) keeps them external. What stays external, and why: node builtins
        (checked first so the npm `assert`/`buffer` browser polyfills never shadow them),
        `better-sqlite3` (native), the helia/libp2p subtree (lazy-chunk-only so zero index win,
        plus native subdeps), `multiformats`/`uint8arrays`/`ipns` (imported by both our static
        graph and the external helia graph — keeping them external preserves a single runtime
        copy for CID/peer-id identity), `rpc-websockets` (its `ws` does optional native requires
        that rolldown would hoist), and `typestub-ipfs-only-hash` (legacy CJS graph with nested
        `uint8arrays` 2.x/3.x copies that break when rewritten to the root ESM-only v5, plus a
        protobufjs `eval("require")` hazard — and it computes CIDs for signatures, so correctness
        wins). `kubo-rpc-client` (~371 modules, the largest remaining graph) and
        `ipfs-unixfs-importer` ARE inlined.

    The zod audit came out safe: zod v4 `instanceof` is structural (`Symbol.hasInstance` checks
    `_zod.traits`), so a consumer's own zod copy still recognizes our errors, and external
    challenge plugins load by path with their own `node_modules` anyway. Guards added:
    verify-bundle gained an external-allowlist gate (no inlinable dep may survive as a bare
    import) and smoke-pack-install a self-containment pass (hides every inlined dep from the
    consumer's `node_modules` and re-runs imports + the createCommunity lifecycle). Inlined deps
    stay in `dependencies` because browser consumers still resolve the per-file `dist/browser`;
    the same commit declared six deps `dist/browser` imported but `package.json` omitted (cborg,
    ipfs-unixfs-importer, ipns, multiformats, node-forge, uint8arrays — previously worked only
    via hoisting).

    Bundle sourcemaps are no longer emitted: with deps inlined they were ~16MB of the tarball,
    Node ignores maps without `--enable-source-maps`, and the per-file `dist/node` ships anyway
    as the readable reference. Net tarball: 2.8MB packed / 14.8MB unpacked, smaller than before
    inlining (4.7MB / 23.6MB). (Possible follow-up: the `dist/node`/`dist/browser` tsc maps that
    still ship are dead weight too — they reference `../src` paths that are not in the tarball
    and carry no `sourcesContent`.)

    Result on the reference host: bundled index cold 245ms → ~205ms and the warm-compile-cache
    npm entry 196ms → ~155ms (~21%). The throwaway experiment's ~165/~115ms assumed inlining
    everything; the gap is the externals kept for identity/correctness above.

## Benchmark history

After every optimization, re-run `node scripts/bench-import-time.js` on the same/comparable hardware and append a
row here so each change shows its delta against the prior one. (Fast 8-core host, Node v22.22.0.)

| Change                           | index cold | index warm-cache | rpc-client only | pkc-with-rpc | dominant cost              | Notes / PR                  |
| -------------------------------- | ---------- | ---------------- | --------------- | ------------ | -------------------------- | --------------------------- |
| baseline                         | ~535ms     | ~395ms           | ~173ms          | ~475ms       | ~65% node ESM resolve/link | #120 (measurement only)     |
| lazy-load helia + LocalCommunity | ~290ms     | ~206ms           | ~164ms          | ~249ms       | ~64% node ESM resolve/link | #126 (~46% faster index.js) |
| self-enabled compile cache       | ~272ms     | ~208ms (now the default) | ~185ms  | ~257ms       | ~66% node ESM resolve/link | #126 (warm-by-default ESM entry) |
| bundle dist (our files; deps external) | ~245ms | ~196ms          | ~173ms (unbundled) | ~258ms (unbundled) | node_modules ESM closure  | #126 (rolldown -> dist/bundled)  |
| inline pure-JS deps (zod, undici, ...) | ~253ms | ~195ms          | ~179ms (unbundled) | ~256ms (unbundled) | kubo-rpc-client closure   | #126 (config/bundle-externals.js) |
| inline kubo-rpc-client + unixfs-importer | ~205ms | ~155ms        | ~176ms (unbundled) | ~256ms (unbundled) | remaining externals + link | #126 (~21% vs deps-external bundle) |

### Production validation (2026-06-10)

Tested out on production: deployed this branch's `dist/` plus `package.json` (the bundled
entries are activated by the `main`/`exports` fields, so copying `dist/` alone changes nothing)
into the bitsocial CLI's pkc-js install on a production server (slow host, Node v22.22.2), then
timed an RPC-only command end to end with `time bitsocial community list`:

| Run                          | before (v0.0.45 from npm) | after (#120 bundled dist)        |
| ---------------------------- | ------------------------- | -------------------------------- |
| first run (cold)             | ~22.1s                    | ~7.4s (populates compile cache)  |
| steady state (repeat runs)   | ~12.2-13.6s               | **~5.5-6.0s** (~55% faster)      |

Output verified correct (full community table). The remaining ~5.5s is the node_modules ESM
closure plus the actual RPC round trip, which is what the "inline pure-JS dependencies into the
bundle" item above targets next.

#### Decomposition of the remaining ~5.5s (same host, steady state, warm compile cache)

Measured by timing each layer in isolation (3 runs, median). `community list --help` was not
usable as a layer: oclif help reads `oclif.manifest.json` and never loads the command module, so
the command graph was instead imported directly with `node --input-type=module -e 'await
import("./dist/cli/commands/community/list.js")'` from the CLI install dir.

| Layer                                              | Median  | Marginal share                       |
| -------------------------------------------------- | ------- | ------------------------------------ |
| bare `node -e 0`                                   | ~0.05s  | process boot                         |
| `import("@pkcprotocol/pkc-js")` alone              | ~2.9s   | **pkc-js import (~50%)**             |
| command graph (list.js → BaseCommand → pkc-js)     | ~3.6s   | +0.7s CLI's own dist graph           |
| oclif boot (`bitsocial --version`)                 | ~0.5s   | oclif framework (no pkc-js)          |
| full `bitsocial community list`                    | ~5.8s   | +~2s RPC round trips + table         |

So the import side still dominates: ~2.9s is the pkc-js graph (almost entirely the external
node_modules ESM closure — our own files are already one bundle), ~1.2s is the CLI's own
uncached graph + oclif (the CLI does not enable a compile cache for modules compiled before
pkc-js's bootstrap runs — tracked as a bitsocial-cli issue), and ~2s is actual RPC work.

#### After inlining dependencies into the bundle (same host, same method)

Re-deployed this branch's `dist/` + `package.json` after the dep-inlining commits and re-timed
(3-4 runs, median, steady state):

| Layer                                 | before (deps-external bundle) | after (deps inlined)        |
| ------------------------------------- | ----------------------------- | --------------------------- |
| `import("@pkcprotocol/pkc-js")` alone | ~2.9s                         | **~1.8s** (~38% faster)     |
| full `bitsocial community list`       | ~5.8s                         | **~4.9s**                   |

Output verified correct (full community table). Of the remaining ~4.9s: ~1.8s pkc-js import
(now mostly the kept externals — typestub-ipfs-only-hash's CJS closure, rpc-websockets, the
multiformats identity layer — plus link/exec of the bundle itself), ~1.2s the CLI's own
uncached graph (bitsocial-cli compile-cache issue), ~2s RPC work (daemon-side; next lever
would be batching the per-community `createCommunity` round trips or including `started` in
the communities subscription).

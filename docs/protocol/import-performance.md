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

The benchmark prints three sections:

-   **Per-layer cold import** — imports each layer in isolation; the marginal jump between rows
    attributes cost. The leanest layer (`rpc-client`) vs the full `index.js` shows what the RPC-only
    path is forced to over-pay.
-   **Cold vs warm V8 compile cache** — sizes the parse/compile portion (recoverable via
    `NODE_COMPILE_CACHE` / `module.enableCompileCache()`) separately from linking + execution.
-   **Per-file self-time attribution** — runs the import under V8's native sampling profiler
    (`--cpu-prof`) and aggregates the resulting `.cpuprofile` into self-time per source file, plus a
    coarse bucket breakdown (our code / deps / node internals / runtime). This is the
    "where is it slow" signal.

> Absolute milliseconds are hardware-dependent (fast machine ~0.5s, slow machine ~9s); the **ratios
> between layers** and the **bucket shares** are the portable signal — they hold across machines.

## Baseline measurements

Captured on a fast 8-core host, Node v22.22.0, warm OS cache. Reproduce with `node scripts/bench-import-time.js`.

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

Ranked by effort/payoff. Each is a follow-up PR; tick it and add a [history](#benchmark-history) row
when it lands.

-   [ ] **V8 compile cache** — `module.enableCompileCache()` on the Node entry (Node ≥ 22.8), or
        document `NODE_COMPILE_CACHE`. Recovers the ~26% parse/compile portion. Cheap, low-risk.
-   [ ] **Lazy-load the local-node runtime off the RPC-client path** — the RPC client should not
        statically import `better-sqlite3`, IPFS/helia helpers, the challenges subsystem, or local
        community classes. Defer them behind dynamic `import()` on the code paths that actually start
        or run a local node. This is the structural fix for the ~310ms (≈ ~7s on slow hardware) jump.
-   [ ] **Thin client entry point** — e.g. a `./client` export that pulls a minimal graph so RPC-only
        consumers never resolve/link the local-node modules at all.
-   [ ] **Bundle the published `dist`** — collapse the 157-file `dist/node` graph (and as much of the
        dependency closure as practical) into a small number of files to cut the ~65% ESM
        resolve/link overhead. Biggest engineering lift; must not break the browser build or tree-shaking.

## Benchmark history

After every optimization, re-run `node scripts/bench-import-time.js` on the same/comparable hardware and append a
row here so each change shows its delta against the prior one. (Fast 8-core host, Node v22.22.0.)

| Change   | index cold | index warm-cache | rpc-client only | pkc-with-rpc | dominant cost              | Notes / PR              |
| -------- | ---------- | ---------------- | --------------- | ------------ | -------------------------- | ----------------------- |
| baseline | ~535ms     | ~395ms           | ~173ms          | ~475ms       | ~65% node ESM resolve/link | #120 (measurement only) |

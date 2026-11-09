// Shared helpers for the leak suite under test/node/leaks/ (issue #496).
//
// Every leak we have shipped so far grew by a fixed amount per repeated operation: one retained
// community per publish (#490), one prepared statement per sync cycle (#488), one abort listener
// per loop iteration (#144-#147), one fd per call (#380). So the suite does not compare heap sizes
// against a threshold, which is noisy on shared runners and blind to native and OS-resource leaks.
// It runs an operation N times and asserts that what the operation leaves behind does not scale
// with N:
//
// - createCollectionTracker(): instances the caller has dropped must be garbage collectable. A
//   registry, subscription or listener that closes over an instance keeps it alive and fails this.
// - countOpenFds(): open file descriptors, Linux only.
// - countActiveResources(): process.getActiveResourcesInfo() grouped by resource type.
//
// Registry sizes (RPC client subscription maps, DbHandler statement cache, ...) are read directly
// by each test, since they are private fields that only that test knows about.
import { readdirSync } from "node:fs";
import { EventEmitter, getEventListeners } from "node:events";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

type GcFunction = () => void;

let cachedGc: GcFunction | undefined;

// Runtime equivalent of `node --expose-gc`, so the suite needs no change to the worker execArgv.
// The flag only makes `gc` visible in contexts created after it is set, hence the new context.
function getGc(): GcFunction {
    if (cachedGc) return cachedGc;
    const existing = (globalThis as { gc?: GcFunction }).gc;
    if (typeof existing === "function") {
        cachedGc = existing;
        return cachedGc;
    }
    setFlagsFromString("--expose-gc");
    cachedGc = runInNewContext("gc") as GcFunction;
    return cachedGc;
}

// One gc() is not always enough: finalizers run on a later task, and objects reachable only from
// pending microtasks or timers become garbage after those settle.
export async function forceGc(rounds = 3): Promise<void> {
    const gc = getGc();
    for (let i = 0; i < rounds; i++) {
        gc();
        await new Promise((resolve) => setImmediate(resolve));
    }
}

export interface CollectionTracker {
    track(target: object, label: string): void;
    // Labels of tracked objects that are still alive after repeated full collections
    aliveLabels(opts?: { attempts?: number }): Promise<string[]>;
}

export function createCollectionTracker(): CollectionTracker {
    const refs: { ref: WeakRef<object>; label: string }[] = [];
    return {
        track(target, label) {
            refs.push({ ref: new WeakRef(target), label });
        },
        async aliveLabels(opts) {
            const attempts = opts?.attempts ?? 10;
            let alive = refs;
            for (let i = 0; i < attempts; i++) {
                await forceGc();
                alive = alive.filter(({ ref }) => ref.deref() !== undefined);
                if (alive.length === 0) return [];
                // Give in-flight cleanup (websocket round trips of an unsubscribe, for example) a moment
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            return alive.map(({ label }) => label);
        }
    };
}

// Open file descriptors of this process, or undefined where /proc is not available
export function countOpenFds(): number | undefined {
    try {
        return readdirSync("/proc/self/fd").length;
    } catch {
        return undefined;
    }
}

export function countActiveResources(): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const type of process.getActiveResourcesInfo()) counts[type] = (counts[type] ?? 0) + 1;
    return counts;
}

// ---------------------------------------------------------------------------------------------
// Retention snapshots: a generic walk of an object graph (a PKC, a community) that records the
// size of every container it reaches, so a test does not have to know which private registry an
// operation might grow. Compare two snapshots taken N iterations apart with findPerIterationGrowth.
//
// Recorded per path:
// - Map / Set size, array length, own property count of every other object
// - total listener count of every EventEmitter (path suffix `#listeners`)
// - abort listener count of every AbortSignal (path suffix `#abortListeners`, the #144-#147 class)
//
// Skipped: LRUCache instances (bounded by construction), typed arrays and buffers, accessors (a
// getter can have side effects), and anything past maxDepth or the node budget.
// ---------------------------------------------------------------------------------------------

export type RetentionSnapshot = Map<string, number>;

const SKIPPED_CONSTRUCTOR_NAMES = new Set(["LRUCache", "Promise", "Date", "RegExp", "WeakMap", "WeakSet", "WeakRef"]);

// Paths of the AbortSignals reachable from `roots`, so a report can name a signal instead of "a signal"
export function findAbortSignalPaths(roots: Record<string, unknown>): Map<AbortSignal, string> {
    const paths = new Map<AbortSignal, string>();
    snapshotRetention(roots, { onAbortSignal: (signal, path) => paths.set(signal, path) });
    return paths;
}

export function snapshotRetention(
    roots: Record<string, unknown>,
    opts?: { maxDepth?: number; maxNodes?: number; onAbortSignal?: (signal: AbortSignal, path: string) => void }
): RetentionSnapshot {
    const maxDepth = opts?.maxDepth ?? 4;
    const maxNodes = opts?.maxNodes ?? 50_000;
    const snapshot: RetentionSnapshot = new Map();
    const visited = new WeakSet<object>();
    let nodes = 0;

    const visit = (value: unknown, path: string, depth: number): void => {
        if (value === null || (typeof value !== "object" && typeof value !== "function")) return;
        if (typeof value === "function") return;
        const obj = value as object;
        if (visited.has(obj) || nodes >= maxNodes) return;
        visited.add(obj);
        nodes++;
        if (ArrayBuffer.isView(obj) || obj instanceof ArrayBuffer) return;
        const constructorName = (obj as { constructor?: { name?: string } }).constructor?.name;
        if (constructorName && SKIPPED_CONSTRUCTOR_NAMES.has(constructorName)) return;

        if (obj instanceof EventEmitter) {
            const total = obj.eventNames().reduce((sum, name) => sum + obj.listenerCount(name), 0);
            snapshot.set(`${path}#listeners`, total);
        }
        if (typeof AbortSignal !== "undefined" && obj instanceof AbortSignal) {
            opts?.onAbortSignal?.(obj, path);
            snapshot.set(`${path}#abortListeners`, getEventListeners(obj, "abort").length);
            return;
        }
        if (typeof AbortController !== "undefined" && obj instanceof AbortController) {
            visit(obj.signal, `${path}.signal`, depth + 1);
            return;
        }
        if (obj instanceof Map) {
            snapshot.set(path, obj.size);
            if (depth < maxDepth) for (const [key, entry] of obj) visit(entry, `${path}[${String(key)}]`, depth + 1);
            return;
        }
        if (obj instanceof Set) {
            snapshot.set(path, obj.size);
            return;
        }
        if (Array.isArray(obj)) {
            snapshot.set(path, obj.length);
            return;
        }
        // Own property names, not keys: hideClassPrivateProps makes private fields non-enumerable.
        // Recorded for every object, not only plain records: TrackedInstanceRegistry is a Proxy whose
        // ownKeys are the aliases it tracks, and a class instance that keeps gaining properties grows too.
        const names = Object.getOwnPropertyNames(obj);
        snapshot.set(path, names.length);
        if (depth >= maxDepth) return;
        for (const name of names) {
            const descriptor = Object.getOwnPropertyDescriptor(obj, name);
            if (!descriptor || !("value" in descriptor)) continue;
            visit(descriptor.value, `${path}.${name}`, depth + 1);
        }
    };

    for (const [name, root] of Object.entries(roots)) visit(root, name, 0);
    return snapshot;
}

export interface RetentionGrowth {
    path: string;
    before: number;
    after: number;
}

// Paths present in both snapshots that grew by at least minGrowth. Paths that only exist in one
// snapshot are ignored: they are per-entry paths (a Map value keyed by an id) or new subtrees.
export function findPerIterationGrowth(before: RetentionSnapshot, after: RetentionSnapshot, minGrowth: number): RetentionGrowth[] {
    const growth: RetentionGrowth[] = [];
    for (const [path, afterSize] of after) {
        const beforeSize = before.get(path);
        if (beforeSize === undefined) continue;
        if (afterSize - beforeSize >= minGrowth) growth.push({ path, before: beforeSize, after: afterSize });
    }
    return growth.sort((a, b) => b.after - b.before - (a.after - a.before));
}

export interface ProcessResourceSnapshot {
    openFds: number | undefined;
    activeResources: Record<string, number>;
}

export function snapshotProcessResources(): ProcessResourceSnapshot {
    return { openFds: countOpenFds(), activeResources: countActiveResources() };
}

// Process-level resources (fds, timers, sockets, ...) that grew by at least minGrowth
export function findProcessResourceGrowth(before: ProcessResourceSnapshot, after: ProcessResourceSnapshot, minGrowth: number): RetentionGrowth[] {
    const growth: RetentionGrowth[] = [];
    if (before.openFds !== undefined && after.openFds !== undefined && after.openFds - before.openFds >= minGrowth)
        growth.push({ path: "process.openFds", before: before.openFds, after: after.openFds });
    for (const [type, afterCount] of Object.entries(after.activeResources)) {
        const beforeCount = before.activeResources[type] ?? 0;
        if (afterCount - beforeCount >= minGrowth) growth.push({ path: `process.activeResources.${type}`, before: beforeCount, after: afterCount });
    }
    return growth;
}

// Per-type minimum over a few samples: a loader's background work (libp2p dials, gossipsub heartbeats,
// an updating community's loop) keeps short-lived timers in flight at any moment. A per-operation leak
// is present in every sample; a transient timer is not.
async function settledProcessResources(samples = 3, intervalMs = 200): Promise<ProcessResourceSnapshot> {
    const snapshots: ProcessResourceSnapshot[] = [];
    for (let i = 0; i < samples; i++) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, intervalMs));
        snapshots.push(snapshotProcessResources());
    }
    const types = new Set(snapshots.flatMap((snapshot) => Object.keys(snapshot.activeResources)));
    const activeResources: Record<string, number> = {};
    for (const type of types) activeResources[type] = Math.min(...snapshots.map((snapshot) => snapshot.activeResources[type] ?? 0));
    const fds = snapshots.map((snapshot) => snapshot.openFds).filter((count): count is number => count !== undefined);
    return { openFds: fds.length ? Math.min(...fds) : undefined, activeResources };
}

// Sources still un-aborted after the runs that received at least minGrowth AbortSignal.any() registrations:
// a signal that lives across iterations and is composed once per iteration
function findLongLivedAnySources(anyCallsPerSource: Map<AbortSignal, number>, minGrowth: number, paths: Map<AbortSignal, string>) {
    return [...anyCallsPerSource.entries()]
        .filter(([source, calls]) => !source.aborted && calls >= minGrowth)
        .map(([source, calls]) => ({ source: paths.get(source) ?? "(signal not reachable from the roots)", anyCalls: calls }))
        .sort((a, b) => b.anyCalls - a.anyCalls);
}

// Runs `iteration` N times after one warm-up run, and reports everything that grew by at least one
// entry per two iterations: instances that were not collected, containers under `roots`, and
// process resources. A shared harness so every scenario asserts the same way.
export async function measureRepeatedOperation(opts: {
    roots: () => Record<string, unknown>;
    iterations: number;
    // Returns the objects the iteration created and then dropped; they must be collectable
    iteration: (i: number) => Promise<Record<string, object>>;
    // Containers that grow per iteration by design but are bounded some other way (a time-based
    // grace queue, for example). Every entry must say why, so the allow-list stays reviewable.
    allowedGrowth?: { path: RegExp; reason: string }[];
}): Promise<{
    instancesStillAlive: string[];
    containerGrowth: RetentionGrowth[];
    processResourceGrowth: RetentionGrowth[];
    abortSignalAnyOnLongLivedSources: { source: string; anyCalls: number }[];
}> {
    const tracker = createCollectionTracker();
    // Kept out of this frame: a suspended async frame holds its last value in a saved register
    const runOnce = async (i: number, track: boolean) => {
        const created = await opts.iteration(i);
        if (track) for (const [label, target] of Object.entries(created)) tracker.track(target, `#${i} ${label}`);
    };
    await runOnce(-1, false);
    await forceGc();
    const containersBefore = snapshotRetention(opts.roots());
    const resourcesBefore = snapshotProcessResources();

    // On Node 20/22 every AbortSignal.any() over a source that has not aborted retains memory for as long
    // as that source lives (#502). Count the registrations each source receives during the measured runs.
    const anyCallsPerSource = new Map<AbortSignal, number>();
    const originalAny = AbortSignal.any;
    AbortSignal.any = function (signals: Iterable<AbortSignal>) {
        const list = [...signals];
        for (const source of list) if (!source.aborted) anyCallsPerSource.set(source, (anyCallsPerSource.get(source) ?? 0) + 1);
        return originalAny.call(AbortSignal, list);
    } as typeof AbortSignal.any;
    try {
        for (let i = 0; i < opts.iterations; i++) await runOnce(i, true);
    } finally {
        AbortSignal.any = originalAny;
    }

    const instancesStillAlive = await tracker.aliveLabels();
    const minGrowth = Math.max(2, Math.ceil(opts.iterations / 2));
    return {
        instancesStillAlive,
        containerGrowth: findPerIterationGrowth(containersBefore, snapshotRetention(opts.roots()), minGrowth).filter(
            (growth) => !opts.allowedGrowth?.some((allowed) => allowed.path.test(growth.path))
        ),
        processResourceGrowth: findProcessResourceGrowth(resourcesBefore, await settledProcessResources(), minGrowth),
        abortSignalAnyOnLongLivedSources: findLongLivedAnySources(anyCallsPerSource, minGrowth, findAbortSignalPaths(opts.roots()))
    };
}

// ---------------------------------------------------------------------------------------------
// Memory growth rate (tier 2 soak, #496): sample process memory after a forced gc every few
// iterations and fit a least-squares slope, so the result is bytes retained per iteration rather
// than a single noisy before/after delta. RSS is sampled too: native leaks (#488, SQLite statements
// in malloc) never show up in heapUsed.
// ---------------------------------------------------------------------------------------------
export interface MemorySample {
    iteration: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
    rss: number;
}

export type MemoryMetric = Exclude<keyof MemorySample, "iteration">;

export function slopePerIteration(samples: MemorySample[], metric: MemoryMetric): number {
    const n = samples.length;
    if (n < 2) return 0;
    const meanX = samples.reduce((sum, s) => sum + s.iteration, 0) / n;
    const meanY = samples.reduce((sum, s) => sum + s[metric], 0) / n;
    let numerator = 0;
    let denominator = 0;
    for (const s of samples) {
        numerator += (s.iteration - meanX) * (s[metric] - meanY);
        denominator += (s.iteration - meanX) ** 2;
    }
    return denominator === 0 ? 0 : numerator / denominator;
}

async function sampleMemory(iteration: number): Promise<MemorySample> {
    // Node buffers a PerformanceResourceTiming entry for every fetch() (kubo RPC calls, gateways) in
    // a global timeline capped at 250 entries. It fills during the first iterations and reads as
    // growth, but it is bounded and not pkc-js state.
    performance.clearResourceTimings();
    await forceGc();
    const usage = process.memoryUsage();
    return { iteration, heapUsed: usage.heapUsed, external: usage.external, arrayBuffers: usage.arrayBuffers, rss: usage.rss };
}

export async function measureMemoryGrowth(opts: {
    iteration: (i: number) => Promise<unknown>;
    warmupIterations: number;
    iterations: number;
    // When set, keep iterating until this much time has passed instead of stopping at `iterations`
    durationMs?: number;
    sampleEvery: number;
    // Called once right after warm-up, before the first sample, e.g. to take a baseline heap snapshot
    afterWarmup?: () => Promise<void> | void;
}): Promise<{
    samples: MemorySample[];
    slopes: Record<MemoryMetric, number>;
    fullRunSlopes: Record<MemoryMetric, number>;
    durationMs: number;
}> {
    // Kept out of the sampling frame: a suspended async frame holds its last value in a saved register
    const runOnce = async (i: number) => {
        await opts.iteration(i);
    };
    for (let i = 0; i < opts.warmupIterations; i++) await runOnce(-1 - i);
    await opts.afterWarmup?.();
    const startedAt = Date.now();
    const samples: MemorySample[] = [await sampleMemory(0)];
    const keepGoing = (i: number) => (opts.durationMs !== undefined ? Date.now() - startedAt < opts.durationMs : i <= opts.iterations);
    for (let i = 1; keepGoing(i); i++) {
        await runOnce(i);
        if (i % opts.sampleEvery === 0) samples.push(await sampleMemory(i));
    }
    const metrics: MemoryMetric[] = ["heapUsed", "external", "arrayBuffers", "rss"];
    // Fitted over the second half of the samples: a leak's slope is constant, while allocator and JIT
    // ramp-up (most visible in rss) settles in the first iterations and would otherwise dominate
    const steadyState = samples.slice(Math.floor(samples.length / 2));
    const slopes = Object.fromEntries(metrics.map((metric) => [metric, slopePerIteration(steadyState, metric)])) as Record<
        MemoryMetric,
        number
    >;
    const fullRunSlopes = Object.fromEntries(metrics.map((metric) => [metric, slopePerIteration(samples, metric)])) as Record<
        MemoryMetric,
        number
    >;
    return { samples, slopes, fullRunSlopes, durationMs: Date.now() - startedAt };
}

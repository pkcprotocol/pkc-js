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

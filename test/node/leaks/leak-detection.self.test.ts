// Self-test of test/helpers/leak-detection.ts (#496): every leak class the suite claims to catch is
// planted here on purpose, so a green leak scenario means "nothing grew", not "the detector is blind".
import { describe, it, expect, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { measureRepeatedOperation } from "../../helpers/leak-detection.js";
import { TrackedInstanceRegistry } from "../../../dist/node/pkc/tracked-instance-registry.js";

const ITERATIONS = 10;

class FakeRegistryOwner extends EventEmitter {
    // Non-enumerable like the fields hideClassPrivateProps hides, to prove the walk still sees them
    declare _registry: Map<number, object>;
    declare _nested: { inner: { subscriptions: Record<string, object> } };
    longLivedAbort = new AbortController();
    // A Proxy whose ownKeys are its tracked aliases, like pkc._updatingCommunities
    declare _tracked: TrackedInstanceRegistry<object>;
    constructor() {
        super();
        Object.defineProperty(this, "_registry", { value: new Map(), enumerable: false });
        Object.defineProperty(this, "_nested", { value: { inner: { subscriptions: {} } }, enumerable: false });
        Object.defineProperty(this, "_tracked", { value: new TrackedInstanceRegistry<object>(), enumerable: false });
    }
}

describe("leak-detection self-test", () => {
    const timers: NodeJS.Timeout[] = [];
    afterEach(() => {
        for (const timer of timers.splice(0)) clearInterval(timer);
    });

    it("reports nothing for an operation that leaves nothing behind", async () => {
        const owner = new FakeRegistryOwner();
        const result = await measureRepeatedOperation({
            roots: () => ({ owner }),
            iterations: ITERATIONS,
            iteration: async () => ({ instance: { payload: new Array(1000).fill(0) } })
        });
        expect(result).toEqual({
            instancesStillAlive: [],
            containerGrowth: [],
            processResourceGrowth: [],
            abortSignalAnyOnLongLivedSources: []
        });
    });

    // The AbortSignal.any() counting must not itself retain what it counts: an instance whose own
    // never-aborted signal is composed, with an abort listener that closes over the instance, is
    // collectable once dropped
    it("does not keep an instance alive through its own composed signal", async () => {
        const owner = new FakeRegistryOwner();
        const result = await measureRepeatedOperation({
            roots: () => ({ owner }),
            iterations: ITERATIONS,
            iteration: async () => {
                const ownAbort = new AbortController();
                const instance = { ownAbort, stop: () => undefined as unknown };
                ownAbort.signal.addEventListener("abort", () => instance.stop());
                AbortSignal.any([ownAbort.signal]);
                return { instance };
            }
        });
        expect(result).toEqual({
            instancesStillAlive: [],
            containerGrowth: [],
            processResourceGrowth: [],
            abortSignalAnyOnLongLivedSources: []
        });
    });

    // A stopped libp2p-js node leaves its gossipsub heartbeat timer armed for up to a second, and a worker's
    // queued stdout writes drain a little after the loop. Neither stays, so neither is a leak, however slow
    // the machine is: a fast one never sees them, a slow one has several in flight when the loop ends
    it("does not report a resource that goes away by itself within a second", async () => {
        const owner = new FakeRegistryOwner();
        const result = await measureRepeatedOperation({
            roots: () => ({ owner }),
            iterations: ITERATIONS,
            iteration: async () => {
                setTimeout(() => {}, 1000);
                return { instance: {} };
            }
        });
        expect(result).toEqual({
            instancesStillAlive: [],
            containerGrowth: [],
            processResourceGrowth: [],
            abortSignalAnyOnLongLivedSources: []
        });
    });

    it("catches every planted leak class", async () => {
        const owner = new FakeRegistryOwner();
        const result = await measureRepeatedOperation({
            roots: () => ({ owner }),
            iterations: ITERATIONS,
            iteration: async (i) => {
                const instance = { id: i };
                owner._registry.set(i, instance); // retained instance + growing private Map (#490)
                owner._nested.inner.subscriptions[`sub-${i}`] = {}; // growing nested record
                owner._tracked.track({ value: { id: i }, aliases: [`alias-${i}`] }); // instance registry never untracked
                owner.on("change", () => instance); // listener per operation
                owner.longLivedAbort.signal.addEventListener("abort", () => {}, { once: true }); // #144-#147
                timers.push(setInterval(() => {}, 60_000)); // timer per operation
                AbortSignal.any([new AbortController().signal, owner.longLivedAbort.signal]); // #502
                return { instance };
            }
        });

        expect(result.instancesStillAlive).toHaveLength(ITERATIONS);
        expect(result.containerGrowth.map((g) => g.path).sort()).toEqual(
            [
                "owner#listeners",
                "owner._nested.inner.subscriptions",
                "owner._registry",
                "owner._tracked",
                "owner.longLivedAbort.signal#abortListeners"
            ].sort()
        );
        expect(result.processResourceGrowth.map((g) => g.path)).toContain("process.activeResources.Timeout");
        expect(result.abortSignalAnyOnLongLivedSources).toEqual([{ source: "owner.longLivedAbort.signal", anyCalls: ITERATIONS }]);
    });
});

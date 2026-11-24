// Leak suite (#496): resolveIpnsToCidP2P's abortSignal and timeoutMs must reach the libp2p-js direct fetch
// as `signal` and must not replace the 5 s per-peer fetch timeout.
import { it, expect } from "vitest";
import { mockPKCWithHeliaConfig, publishStaticCommunityWithPostInPages } from "../../../dist/node/test/test-util.js";

// it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
// starts failing once the leak is fixed: remove the .fails then.

type ResolveOptions = Record<string, unknown> | undefined;

it.fails(
    "libp2p-js: a stalled /libp2p/fetch peer is given up on after the per-peer timeout, and a caller abort reaches the fetch",
    async () => {
        const fixture = await publishStaticCommunityWithPostInPages();
        const pkc = await mockPKCWithHeliaConfig({ forceMockPubsub: false });
        const client = Object.values(pkc.clients.libp2pJsClients)[0];
        const fetchService = client._helia.libp2p.services.fetch;
        const originalFetch = fetchService.fetch.bind(fetchService);
        const shim = client.heliaWithKuboRpcClientFunctions;
        const originalResolve = shim.name.resolve.bind(shim.name);
        try {
            // What the shim is handed
            const optionKeysSeenByShim = new Set<string>();
            shim.name.resolve = ((name: string, options: ResolveOptions) => {
                for (const key of Object.keys(options ?? {})) optionKeysSeenByShim.add(key);
                return originalResolve(name, options as Parameters<typeof originalResolve>[1]);
            }) as typeof shim.name.resolve;

            // A peer that accepts the fetch and never answers: resolves only when its signal aborts
            const fetchSignalAbortedAfterMs: number[] = [];
            let fetchCalls = 0;
            fetchService.fetch = ((_peer: unknown, _key: unknown, options?: { signal?: AbortSignal }) => {
                fetchCalls++;
                const startedAt = Date.now();
                return new Promise<undefined>((resolve) => {
                    options?.signal?.addEventListener(
                        "abort",
                        () => {
                            fetchSignalAbortedAfterMs.push(Date.now() - startedAt);
                            resolve(undefined);
                        },
                        { once: true }
                    );
                });
            }) as typeof fetchService.fetch;

            // Run 1: the caller gives the whole resolve 25 s; the stalled peer must be dropped after ~5 s
            const run1Start = Date.now();
            await pkc._clientsManager.resolveIpnsToCidP2P(fixture.communityAddress, { timeoutMs: 25_000, nocache: true }).catch(() => {});
            const run1Ms = Date.now() - run1Start;
            await new Promise((resolve) => setTimeout(resolve, 500));
            const run1 = { fetchCalls, slowestFetchAbortMs: Math.max(-1, ...fetchSignalAbortedAfterMs), run1Ms };

            // Run 2: the caller aborts after 1 s; the stalled fetch must be aborted with it
            fetchSignalAbortedAfterMs.length = 0;
            fetchCalls = 0;
            const controller = new AbortController();
            setTimeout(() => controller.abort(new Error("caller aborted")), 1000);
            await pkc._clientsManager
                .resolveIpnsToCidP2P(fixture.communityAddress, { timeoutMs: 25_000, nocache: true, abortSignal: controller.signal })
                .catch(() => {});
            await new Promise((resolve) => setTimeout(resolve, 1500));
            const run2 = { fetchCalls, fetchesAbortedWithin2500ms: fetchSignalAbortedAfterMs.filter((ms) => ms <= 2500).length };

            expect(run1.fetchCalls).toBeGreaterThan(0); // the stalled peer was really asked
            expect(run2.fetchCalls).toBeGreaterThan(0);
            expect({
                shimGetsSignalKey: optionKeysSeenByShim.has("signal"),
                perPeerTimeoutIs5s: run1.slowestFetchAbortMs >= 0 && run1.slowestFetchAbortMs < 10_000,
                callerAbortReachedEveryFetch: run2.fetchesAbortedWithin2500ms === run2.fetchCalls
            }).toEqual({ shimGetsSignalKey: true, perPeerTimeoutIs5s: true, callerAbortReachedEveryFetch: true });
        } finally {
            fetchService.fetch = originalFetch;
            shim.name.resolve = originalResolve;
            await pkc.destroy();
            await fixture.ipnsObj.pkc.destroy();
        }
    },
    120_000
);

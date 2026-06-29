import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import { MockHttpRouter } from "../../../dist/node/runtime/node/test/mock-http-router.js";
import { pubsubTopicToDhtKeyCid } from "../../../dist/node/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";
import type { CID } from "multiformats/cid";

// Regression coverage for issue #171: a single unreachable (connection-refused) HTTP router used to
// abort the node's ENTIRE content-routing provider lookup. IPNS-over-pubsub resolution warms up a
// topic by calling helia.libp2p.contentRouting.findProviders(cid), which libp2p implements with
// it-merge over every configured router — so one router's iterator throwing (e.g. ECONNREFUSED)
// rejected the whole merged stream and every community load failed instantly, even when other healthy
// routers were returning providers. The fix wraps each router so its errors end ITS iterator instead
// of poisoning the merge (src/helia/helia-for-pkc.ts getDelegatedRoutingFields).
//
// These tests exercise contentRouting.findProviders directly (the shared mechanism behind warmup and
// bitswap provider lookups) against synthetic routers covering every failure mode and their
// combinations, asserting that as long as ONE router has the provider the lookup succeeds and is not
// slowed down by the unhealthy routers. Client-side libp2p only and config-independent, so it runs
// once under non-RPC.
describeSkipIfRpc("Content router fault tolerance (issue #171)", () => {
    // A "slow" router accepts the connection then stalls this long before responding. Far larger than
    // any assertion bound below: if a lookup ever waited on the slow router the test would visibly hang.
    const SLOW_ROUTER_STALL_MS = 30_000;
    // Generous upper bound for "fast": a healthy local router answers in single-digit ms; this leaves
    // huge headroom for CI jitter while staying well under SLOW_ROUTER_STALL_MS.
    const FAST_LOOKUP_MAX_MS = 5_000;

    const queryCid: CID = pubsubTopicToDhtKeyCid("content-router-fault-tolerance-test-topic");
    let providerPeerIdStr: string;
    // Distinct provider ids so timing tests can prove WHICH router's provider arrived first.
    let secondProviderPeerIdStr: string;
    let slowProviderPeerIdStr: string;

    const startedRouters: MockHttpRouter[] = [];
    const clientsToStop: Libp2pJsClient[] = [];
    let keyCounter = 0;

    const newPeerIdStr = async () => peerIdFromPrivateKey(await generateKeyPair("Ed25519")).toString();

    beforeAll(async () => {
        [providerPeerIdStr, secondProviderPeerIdStr, slowProviderPeerIdStr] = await Promise.all([
            newPeerIdStr(),
            newPeerIdStr(),
            newPeerIdStr()
        ]);
    });

    afterEach(async () => {
        // countOfUsesOfInstance starts at 1, so a single stop() tears each helia instance down.
        while (clientsToStop.length) await clientsToStop.pop()!.heliaWithKuboRpcClientFunctions.stop();
        while (startedRouters.length) {
            try {
                await startedRouters.pop()!.destroy();
            } catch {
                // already destroyed (e.g. a "dead" router we closed on purpose)
            }
        }
    });

    // Healthy and every unhealthy shape a real HTTP router can take. "dead"/"slow"/"empty" are the
    // original #171 modes; "error5xx"/"error429"/"malformed"/"reset"/"blackhole" cover the common
    // real-world outages (5xx under load, rate-limiting, a fronting proxy returning garbage, a
    // connection reset mid-stream, and a true black hole that accepts then never replies).
    type RouterKind = "good" | "slow" | "empty" | "dead" | "error5xx" | "error429" | "malformed" | "reset" | "blackhole";

    // Build one synthetic router of the given kind and return its URL. "good" serves the provider for
    // queryCid (optionally after goodDelayMs); "slow" accepts then stalls; "empty" answers instantly
    // with no providers; "dead" is a closed port that refuses connections (ECONNREFUSED); the rest
    // misbehave per their fault mode (see MockHttpRouterFaultMode). Only "good" serves a provider.
    const faultModeForKind: Partial<Record<RouterKind, ConstructorParameters<typeof MockHttpRouter>[0]>> = {
        slow: { providerGetDelayMs: SLOW_ROUTER_STALL_MS },
        error5xx: { faultMode: "errorStatus", errorStatusCode: 503 },
        error429: { faultMode: "errorStatus", errorStatusCode: 429 },
        malformed: { faultMode: "malformed" },
        reset: { faultMode: "resetMidResponse" },
        blackhole: { faultMode: "blackHole" }
    };
    const startRouter = async (kind: RouterKind, goodDelayMs: number): Promise<string> => {
        if (kind === "dead") {
            // Bind to grab a free port, then close it so connections to that port are refused.
            const router = new MockHttpRouter();
            await router.start();
            const url = router.url;
            await router.destroy();
            return url;
        }
        const router =
            kind === "good" ? new MockHttpRouter({ providerGetDelayMs: goodDelayMs }) : new MockHttpRouter(faultModeForKind[kind]);
        await router.start();
        startedRouters.push(router);
        if (kind === "good") router.addProviderForTesting(queryCid.toString(), { ID: providerPeerIdStr, Addrs: ["/ip4/1.2.3.4/tcp/4001"] });
        return router.url;
    };

    const createHeliaWithRouters = async (httpRoutersOptions: string[]): Promise<Libp2pJsClient> => {
        const client = (await createLibp2pJsClientOrUseExistingOne({
            key: `content-router-fault-tolerance-${keyCounter++}`,
            httpRoutersOptions,
            libp2pOptions: {},
            heliaOptions: {}
        })) as Libp2pJsClient;
        clientsToStop.push(client);
        return client;
    };

    // Run a single findProviders lookup, returning the first provider's peer-id, the ms until it
    // arrived, and any thrown error. Breaks after the first provider (matching warmup semantics, which
    // dials peers as they arrive) and aborts so in-flight requests to slow/dead routers are cancelled.
    const lookupFirstProvider = async (
        client: Libp2pJsClient
    ): Promise<{ found: string[]; firstMs: number | null; threw: Error | null }> => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), FAST_LOOKUP_MAX_MS + SLOW_ROUTER_STALL_MS);
        const start = Date.now();
        const found: string[] = [];
        let firstMs: number | null = null;
        let threw: Error | null = null;
        try {
            for await (const peer of client._helia.libp2p.contentRouting.findProviders(queryCid, { signal: ac.signal })) {
                if (firstMs === null) firstMs = Date.now() - start;
                found.push(peer.id.toString());
                break;
            }
        } catch (e) {
            threw = e as Error;
        } finally {
            clearTimeout(timer);
            ac.abort();
        }
        return { found, firstMs, threw };
    };

    const runScenario = async (kinds: RouterKind[], goodDelayMs = 0) => {
        const urls = await Promise.all(kinds.map((kind) => startRouter(kind, goodDelayMs)));
        const client = await createHeliaWithRouters(urls);
        return lookupFirstProvider(client);
    };

    // Start a router that serves `providerId` for queryCid after `delayMs` (0 = immediate). Unlike the
    // fixed "good"/"slow" kinds above, this lets a timing test seed a DISTINCT provider behind a chosen
    // delay so it can assert which router's provider arrived.
    const startServingRouter = async (opts: { delayMs?: number; providerId: string }): Promise<string> => {
        const router = new MockHttpRouter({ providerGetDelayMs: opts.delayMs ?? 0 });
        await router.start();
        startedRouters.push(router);
        router.addProviderForTesting(queryCid.toString(), { ID: opts.providerId, Addrs: ["/ip4/1.2.3.4/tcp/4001"] });
        return router.url;
    };

    // Like startServingRouter but returns the router INSTANCE (registered for cleanup) so a test can
    // inspect its recorded/aborted request counts. Optionally seeds a provider for queryCid.
    const startInspectableRouter = async (opts: ConstructorParameters<typeof MockHttpRouter>[0] & { servesProvider?: boolean } = {}) => {
        const { servesProvider, ...routerOpts } = opts;
        const router = new MockHttpRouter(routerOpts);
        await router.start();
        startedRouters.push(router);
        if (servesProvider) router.addProviderForTesting(queryCid.toString(), { ID: providerPeerIdStr, Addrs: ["/ip4/1.2.3.4/tcp/4001"] });
        return router;
    };

    // Collect up to `want` providers, stopping as soon as we have them (or on the safety deadline).
    // Returns how long the collection took so a test can prove it did not block on a slow router.
    const collectProviders = async (
        client: Libp2pJsClient,
        opts: { want: number; maxMs: number }
    ): Promise<{ found: string[]; elapsedMs: number; threw: Error | null }> => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), opts.maxMs);
        const start = Date.now();
        const found: string[] = [];
        let threw: Error | null = null;
        try {
            for await (const peer of client._helia.libp2p.contentRouting.findProviders(queryCid, { signal: ac.signal })) {
                found.push(peer.id.toString());
                if (found.length >= opts.want) break;
            }
        } catch (e) {
            threw = e as Error;
        } finally {
            clearTimeout(timer);
            ac.abort();
        }
        return { found, elapsedMs: Date.now() - start, threw };
    };

    // The core regression: a healthy router plus one connection-refused router. The good router is
    // given a small head start so the dead router's ECONNREFUSED is observed first — before the fix
    // that refusal rejected the merged stream and the lookup threw before ever yielding the provider.
    it("a connection-refused router does not abort a lookup that another router can satisfy", async () => {
        const { found, threw } = await runScenario(["good", "dead"], 300);
        expect(threw, threw ? `lookup threw: ${threw.name}: ${threw.message}` : undefined).to.equal(null);
        expect(found).to.deep.equal([providerPeerIdStr]);
    });

    // Every combination of unhealthy routers alongside one good router must still yield the provider
    // without throwing. (goodDelayMs 0: post-fix the dead router is swallowed regardless of timing.)
    const goodPlusBadCombos: { name: string; kinds: RouterKind[] }[] = [
        { name: "good only", kinds: ["good"] },
        { name: "good + dead", kinds: ["good", "dead"] },
        { name: "good + slow", kinds: ["good", "slow"] },
        { name: "good + empty", kinds: ["good", "empty"] },
        { name: "dead + good (dead first)", kinds: ["dead", "good"] },
        { name: "good + dead + slow + empty", kinds: ["good", "dead", "slow", "empty"] },
        // Real-world outage shapes: each bad router must be swallowed per-router, never thrown out of
        // the merged stream, and must not delay the provider the good router can serve.
        { name: "good + 5xx", kinds: ["good", "error5xx"] },
        { name: "good + 429", kinds: ["good", "error429"] },
        { name: "good + malformed body", kinds: ["good", "malformed"] },
        { name: "good + connection reset mid-response", kinds: ["good", "reset"] },
        { name: "5xx first + good", kinds: ["error5xx", "good"] },
        {
            name: "every failure mode + good",
            kinds: ["good", "dead", "slow", "empty", "error5xx", "error429", "malformed", "reset", "blackhole"]
        }
    ];
    for (const { name, kinds } of goodPlusBadCombos)
        it(`yields the provider quickly for: ${name}`, async () => {
            const { found, firstMs, threw } = await runScenario(kinds);
            expect(threw, threw ? `lookup threw: ${threw.name}: ${threw.message}` : undefined).to.equal(null);
            expect(found).to.deep.equal([providerPeerIdStr]);
            // Slow/dead/empty routers must not delay the result that the good router can serve.
            expect(firstMs).to.be.a("number");
            expect(firstMs!).to.be.lessThan(FAST_LOOKUP_MAX_MS);
        });

    // Explicit "speed is unaffected" guard: adding a slow, a dead and an empty router alongside the
    // good one must not meaningfully slow down the lookup versus the good router alone.
    it("unhealthy routers do not slow the lookup down vs a healthy router alone", async () => {
        const baseline = await runScenario(["good"]);
        expect(baseline.found).to.deep.equal([providerPeerIdStr]);
        expect(baseline.firstMs).to.be.a("number");

        const laden = await runScenario(["good", "slow", "dead", "empty"]);
        expect(laden.threw, laden.threw ? `lookup threw: ${laden.threw.name}` : undefined).to.equal(null);
        expect(laden.found).to.deep.equal([providerPeerIdStr]);
        expect(laden.firstMs).to.be.a("number");
        // The laden lookup is fast in absolute terms and within a generous delta of the baseline,
        // i.e. it did NOT wait on the 30s slow router.
        expect(laden.firstMs!).to.be.lessThan(FAST_LOOKUP_MAX_MS);
        expect(laden.firstMs!).to.be.lessThan(baseline.firstMs! + 2000);
    });

    // When NO router can satisfy the lookup, an unreachable router must still degrade gracefully to
    // "found nothing" rather than throwing — the harmless empty case.
    it("a lookup with only unreachable/empty routers ends with no providers and no error", async () => {
        const { found, threw } = await runScenario(["dead", "empty"]);
        expect(threw, threw ? `lookup threw: ${threw.name}: ${threw.message}` : undefined).to.equal(null);
        expect(found).to.deep.equal([]);
    });

    // Core browser requirement: a router that responds with providers immediately must surface them
    // right away even when another configured router takes 10s to respond. The merged stream yields
    // providers as each router produces them, so the immediate provider arrives in well under 10s — we
    // do NOT block on the slow router. Both routers serve a (distinct) provider so we can assert the
    // FIRST one returned is the immediate router's, not the slow router's.
    it("an immediate router's provider arrives without waiting for a 10s-slow router", async () => {
        const slowUrl = await startServingRouter({ delayMs: 10_000, providerId: slowProviderPeerIdStr });
        const immediateUrl = await startServingRouter({ delayMs: 0, providerId: providerPeerIdStr });
        // Slow router listed FIRST to rule out any ordering luck.
        const client = await createHeliaWithRouters([slowUrl, immediateUrl]);

        const { found, firstMs, threw } = await lookupFirstProvider(client);
        expect(threw, threw ? `lookup threw: ${threw.name}: ${threw.message}` : undefined).to.equal(null);
        expect(found).to.deep.equal([providerPeerIdStr]);
        expect(firstMs).to.be.a("number");
        // Nowhere near the slow router's 10s response time.
        expect(firstMs!).to.be.lessThan(2_000);
    });

    // All immediately-available providers (from multiple fast routers) must be collected without
    // blocking on a 10s-slow router. We ask for the two immediate providers and assert we get both
    // quickly; the slow router's provider does not gate them.
    it("collects all immediately-available providers without blocking on a 10s-slow router", async () => {
        const immediate1 = await startServingRouter({ delayMs: 0, providerId: providerPeerIdStr });
        const immediate2 = await startServingRouter({ delayMs: 0, providerId: secondProviderPeerIdStr });
        const slow = await startServingRouter({ delayMs: 10_000, providerId: slowProviderPeerIdStr });
        const client = await createHeliaWithRouters([slow, immediate1, immediate2]);

        const { found, elapsedMs, threw } = await collectProviders(client, { want: 2, maxMs: 8_000 });
        expect(threw, threw ? `lookup threw: ${threw.name}: ${threw.message}` : undefined).to.equal(null);
        expect(found).to.have.members([providerPeerIdStr, secondProviderPeerIdStr]);
        expect(found).to.not.include(slowProviderPeerIdStr);
        // Both immediate providers were collected long before the slow router's 10s response.
        expect(elapsedMs).to.be.lessThan(2_000);
    });

    // No good router at all: every failure mode must degrade to "found nothing" rather than throwing.
    // (The black hole is excluded here — with no router able to end the merged stream it can only end
    // on abort/timeout, which is exercised by its own bounded test below.)
    const allBadNoGoodModes: RouterKind[] = ["dead", "empty", "error5xx", "error429", "malformed", "reset"];
    for (const mode of allBadNoGoodModes)
        it(`degrades to no-providers-no-error when the only router is: ${mode}`, async () => {
            const { found, threw, firstMs } = await runScenario([mode]);
            expect(threw, threw ? `lookup threw: ${threw.name}: ${threw.message}` : undefined).to.equal(null);
            expect(found).to.deep.equal([]);
            // Even the "no providers" outcome must be fast — a bad router must not stall the lookup.
            expect(firstMs).to.equal(null);
        });

    // Aborting a lookup (subscriber found / maxPeers reached / caller signal) must actually CANCEL the
    // in-flight HTTP request to a slow router rather than leak the socket. Across many warmups a leak
    // here exhausts file descriptors and silently slows the whole node. The good router answers after a
    // short head start; we break on the first provider, which aborts — and the slow router must observe
    // its in-flight GET being cancelled.
    it("aborting after the first provider cancels the in-flight request to a slow router", async () => {
        const slow = await startInspectableRouter({ providerGetDelayMs: SLOW_ROUTER_STALL_MS });
        const goodUrl = await startServingRouter({ delayMs: 200, providerId: providerPeerIdStr });
        const client = await createHeliaWithRouters([slow.url, goodUrl]);

        const { found, threw } = await lookupFirstProvider(client);
        expect(threw, threw ? `lookup threw: ${threw.name}: ${threw.message}` : undefined).to.equal(null);
        expect(found).to.deep.equal([providerPeerIdStr]);
        // The slow router received the GET and then saw the client disconnect when we aborted — i.e.
        // the request was cancelled, not left dangling for its full 30s stall.
        await vi.waitFor(() => expect(slow.abortedProviderGetCount).to.be.greaterThan(0), { timeout: 3_000 });
    });

    // Repeated lookups against a mixed-health fleet must stay fast and bounded: no per-lookup leak, no
    // runaway retries against the good router, and every in-flight slow request cancelled. This is the
    // sequential-warmup load a real node sees (one lookup per community/topic).
    it("stays fast and leak-free across many sequential lookups against a mixed fleet", async () => {
        const REPS = 20;
        const slow = await startInspectableRouter({ providerGetDelayMs: SLOW_ROUTER_STALL_MS });
        const good = await startInspectableRouter({ servesProvider: true });
        const deadUrl = await startRouter("dead", 0);
        const emptyUrl = await startRouter("empty", 0);
        const client = await createHeliaWithRouters([slow.url, good.url, deadUrl, emptyUrl]);

        for (let i = 0; i < REPS; i++) {
            const { found, firstMs, threw } = await lookupFirstProvider(client);
            expect(threw, threw ? `rep ${i} threw: ${threw.name}: ${threw.message}` : undefined).to.equal(null);
            expect(found, `rep ${i}`).to.deep.equal([providerPeerIdStr]);
            expect(firstMs!, `rep ${i} firstMs`).to.be.lessThan(FAST_LOOKUP_MAX_MS);
        }
        // Exactly one GET per lookup to the good router — no retry storm amplifying load.
        const goodGets = good.requests.filter((r) => r.method === "GET").length;
        expect(goodGets).to.equal(REPS);
        // Every slow request was cancelled when its lookup ended — none leaked across the 20 reps.
        await vi.waitFor(() => expect(slow.abortedProviderGetCount).to.equal(REPS), { timeout: 5_000 });
    });

    // Scaling guard: the per-router wrap + it-merge fan-out must add negligible fixed cost, so shipping
    // many routers is not inherently slower than shipping a few. One good router buried behind eight
    // empty ones must resolve about as fast as the good router alone.
    it("a good router buried behind many empty routers is not slowed down", async () => {
        const baseline = await runScenario(["good"]);
        expect(baseline.found).to.deep.equal([providerPeerIdStr]);
        expect(baseline.firstMs).to.be.a("number");

        const manyEmpty: RouterKind[] = ["good", "empty", "empty", "empty", "empty", "empty", "empty", "empty", "empty"];
        const laden = await runScenario(manyEmpty);
        expect(laden.threw, laden.threw ? `lookup threw: ${laden.threw.name}` : undefined).to.equal(null);
        expect(laden.found).to.deep.equal([providerPeerIdStr]);
        expect(laden.firstMs!).to.be.lessThan(FAST_LOOKUP_MAX_MS);
        expect(laden.firstMs!).to.be.lessThan(baseline.firstMs! + 2000);
    });

    // A lookup whose signal is already aborted must return immediately with nothing and without
    // throwing a non-abort error — the wrap swallows the abort per-router. Guards against an
    // already-cancelled warmup wasting time or surfacing a spurious failure.
    it("an already-aborted lookup ends immediately with no providers and no error", async () => {
        const goodUrl = await startServingRouter({ delayMs: 0, providerId: providerPeerIdStr });
        const client = await createHeliaWithRouters([goodUrl]);

        const ac = new AbortController();
        ac.abort();
        const start = Date.now();
        const found: string[] = [];
        let threw: Error | null = null;
        try {
            for await (const peer of client._helia.libp2p.contentRouting.findProviders(queryCid, { signal: ac.signal })) {
                found.push(peer.id.toString());
                break;
            }
        } catch (e) {
            threw = e as Error;
        }
        expect(threw, threw ? `lookup threw: ${threw.name}: ${threw.message}` : undefined).to.equal(null);
        expect(found).to.deep.equal([]);
        expect(Date.now() - start).to.be.lessThan(1_000);
    });

    // Cross-router de-duplication: when the SAME provider is announced by several routers, libp2p's
    // CompoundContentRouting yields it only ONCE across the merged stream. This is what keeps warmup
    // from dialing one peer N times when it's announced to the whole fleet (the common case — every
    // healthy router serves the same record). Pins the behaviour so a libp2p upgrade can't regress it
    // into an N-fold dial amplification.
    it("yields the same provider only once even when three routers announce it", async () => {
        const urls = await Promise.all([
            startServingRouter({ delayMs: 0, providerId: providerPeerIdStr }),
            startServingRouter({ delayMs: 0, providerId: providerPeerIdStr }),
            startServingRouter({ delayMs: 0, providerId: providerPeerIdStr })
        ]);
        const client = await createHeliaWithRouters(urls);

        const { found, threw } = await collectProviders(client, { want: 10, maxMs: 2_000 });
        expect(threw, threw ? `lookup threw: ${threw.name}: ${threw.message}` : undefined).to.equal(null);
        const occurrences = found.filter((id) => id === providerPeerIdStr).length;
        expect(occurrences).to.equal(1);
    });

    // A true black hole (accepts the connection, never replies, never closes) must not hang a lookup
    // another router can satisfy: the good router's provider arrives promptly and the black hole's
    // dangling request is cancelled on abort rather than gating the result. This is the dangerous mode
    // ECONNREFUSED/404 don't reproduce — those end instantly, a black hole would otherwise wait forever.
    it("a black-hole router does not stall a lookup another router can satisfy", async () => {
        const blackhole = await startInspectableRouter({ faultMode: "blackHole" });
        const goodUrl = await startServingRouter({ delayMs: 0, providerId: providerPeerIdStr });
        // Black hole listed FIRST so any "wait for the first router" bug would surface as a hang.
        const client = await createHeliaWithRouters([blackhole.url, goodUrl]);

        const { found, firstMs, threw } = await lookupFirstProvider(client);
        expect(threw, threw ? `lookup threw: ${threw.name}: ${threw.message}` : undefined).to.equal(null);
        expect(found).to.deep.equal([providerPeerIdStr]);
        expect(firstMs!).to.be.lessThan(FAST_LOOKUP_MAX_MS);
        await vi.waitFor(() => expect(blackhole.abortedProviderGetCount).to.be.greaterThan(0), { timeout: 3_000 });
    });
});

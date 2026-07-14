import { afterEach, describe, expect, it } from "vitest";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import { MockHttpRouter } from "../../../dist/node/runtime/node/test/mock-http-router.js";
import { pubsubTopicToDhtKeyCid } from "../../../dist/node/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";

// Regression coverage for issue #218 part 1: @helia/delegated-routing-v1-http-api-client defaults to
// concurrentRequests: 4 per router, so when many boards/communities resolve in parallel their
// findProviders lookups drain 4 at a time behind the client's internal queue — production profiling
// measured this queueing as ~65% of a parallel all-boards load (lookups waited seconds for a slot
// while the router itself answered in <500ms). getDelegatedRoutingFields must construct the client
// with a higher concurrentRequests so parallel lookups actually reach the router in parallel.
//
// The test fires many concurrent findProviders (distinct CIDs, so no request de-duplication) at a
// single slow mock router and reads the router's observed in-flight ceiling: with the default queue
// it is deterministically pinned at 4 no matter how many lookups are outstanding.
//
// Client-side libp2p only and config-independent, so it runs once under non-RPC.
describeSkipIfRpc("Delegated-routing provider lookup concurrency (issue #218)", () => {
    // Enough parallel lookups to make queue serialization unmistakable: far above both the default
    // queue (4) and the assertion floor below, while staying under the configured concurrency (32)
    // so every lookup can be in flight simultaneously.
    const PARALLEL_LOOKUPS = 24;
    // How long the router holds each provider GET before answering. Long enough that all lookups
    // pile up in flight together even under CI scheduling jitter.
    const ROUTER_RESPONSE_DELAY_MS = 1_500;
    // The in-flight ceiling the router must observe. Master's default queue pins it at exactly 4;
    // with concurrentRequests: 32 all 24 lookups go out together, so 12 leaves huge headroom for
    // undici connection setup staggering while still failing fast on any re-serialization.
    const MIN_OBSERVED_CONCURRENCY = 12;
    // Generous per-lookup safety deadline so a regression fails by assertion, not by test timeout.
    const LOOKUP_SAFETY_DEADLINE_MS = 60_000;

    const startedRouters: MockHttpRouter[] = [];
    const clientsToStop: Libp2pJsClient[] = [];
    let keyCounter = 0;

    afterEach(async () => {
        // countOfUsesOfInstance starts at 1, so a single stop() tears each helia instance down.
        // Isolate each stop() so a failing client shutdown still lets every router get destroyed.
        let stopError: unknown;
        while (clientsToStop.length) {
            try {
                await clientsToStop.pop()!.heliaWithKuboRpcClientFunctions.stop();
            } catch (e) {
                stopError ??= e;
            }
        }
        while (startedRouters.length) {
            try {
                await startedRouters.pop()!.destroy();
            } catch {
                // already destroyed
            }
        }
        if (stopError) throw stopError;
    });

    const createHeliaWithRouters = async (httpRoutersOptions: string[]): Promise<Libp2pJsClient> => {
        const client = (await createLibp2pJsClientOrUseExistingOne({
            key: `delegated-routing-concurrency-${keyCounter++}`,
            httpRoutersOptions,
            libp2pOptions: {},
            heliaOptions: {}
        })) as Libp2pJsClient;
        clientsToStop.push(client);
        return client;
    };

    // Run one findProviders lookup to completion (the router answers 404/no providers after its
    // delay, which ends the merged stream without yielding). The safety deadline only exists so a
    // hung lookup cannot stall the whole test file.
    const runLookup = async (client: Libp2pJsClient, topic: string): Promise<void> => {
        const cid = pubsubTopicToDhtKeyCid(topic);
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), LOOKUP_SAFETY_DEADLINE_MS);
        try {
            for await (const _peer of client._helia.libp2p.contentRouting.findProviders(cid, { signal: ac.signal })) {
                break;
            }
        } finally {
            clearTimeout(timer);
            ac.abort();
        }
    };

    it("parallel findProviders lookups are not serialized behind the client's request queue", async () => {
        const router = new MockHttpRouter({ providerGetDelayMs: ROUTER_RESPONSE_DELAY_MS });
        await router.start();
        startedRouters.push(router);
        const client = await createHeliaWithRouters([router.url]);

        await Promise.all(Array.from({ length: PARALLEL_LOOKUPS }, (_, i) => runLookup(client, `delegated-routing-concurrency-test-${i}`)));

        // Every lookup must have reached the router (distinct CIDs, one GET each)...
        const providerGets = router.requests.filter((r) => r.method === "GET").length;
        expect(providerGets).to.be.at.least(PARALLEL_LOOKUPS);
        // ...and they must have been in flight together, not drained 4 at a time.
        expect(
            router.maxConcurrentProviderGetCount,
            `router observed at most ${router.maxConcurrentProviderGetCount} concurrent provider GETs across ${PARALLEL_LOOKUPS} parallel lookups`
        ).to.be.at.least(MIN_OBSERVED_CONCURRENCY);
    });
});

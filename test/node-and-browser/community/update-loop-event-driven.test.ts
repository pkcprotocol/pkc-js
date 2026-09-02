import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import {
    getAvailablePKCConfigsToTestAgainst,
    isRunningInBrowser,
    publishCommunityRecordWithExtraProp
} from "../../../dist/node/test/test-util.js";
import { signCommunity } from "../../../dist/node/signer/signatures.js";
import { timestamp } from "../../../dist/node/util.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

// Repro suite for issue #308: with a libp2p-js client the update loop re-runs updateOnce every
// second per community even though the transport is push-based (gossipsub delivers new records
// the moment they are published, and since issue #301 they land in the routing-layer cache).
// Post-#302 each 1s tick is a local cache read, but it still walks the full
// updateOnce -> fetchNewUpdateForCommunity pipeline and oscillates updatingState between
// waiting-retry and fetching-ipns, emitting two real updatingstatechange events per tick per
// community while nothing changed (~110 events/s measured at 64 communities). The loop should
// instead react to pushed records, with only a slow jittered safety-net poll for missed pushes.
//
// Expected on master: the churn test FAILS (an idle community emits ~2 transitions/s in the
// observation window); the delivery test passes (polling delivers the new record) and must stay
// green after the fix, where gossip push replaces polling as the delivery mechanism.
//
// remote-libp2pjs only: the event-driven path applies when the default record resolver is a
// libp2p-js client. The kubo-RPC path keeps its polling loop for now (its push channel needs
// kubo-side pubsub plumbing, tracked separately in issue #308) and gateways already poll at
// pkc.updateInterval.
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-libp2pjs"] }).map((config) => {
    describe(`community update loop is event-driven, not 1s polling (issue #308) - ${config.name}`, () => {
        let pkc: PKCType;
        const communitiesToStop: RemoteCommunity[] = [];
        const staticRecordsToCleanUp: Awaited<ReturnType<typeof publishCommunityRecordWithExtraProp>>[] = [];

        beforeAll(async () => {
            // Test pkc instances default to updateInterval: 500 (test-util's mockPKC), and the
            // event-driven loop honors updateInterval as its safety-net period — a 500ms net is
            // polling again, which is exactly what this suite pins against. Use the production
            // default (60s) so the loop's quiet steady state is observable in the window.
            pkc = await config.pkcInstancePromise({ pkcOptions: { updateInterval: 60_000 } });
        });
        afterAll(async () => {
            for (const community of communitiesToStop.splice(0)) {
                try {
                    await community.stop();
                } catch {
                    // already stopped
                }
            }
            for (const staticRecord of staticRecordsToCleanUp.splice(0)) await staticRecord.ipnsObj.pkc.destroy();
            await pkc.destroy();
        });

        const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

        // Node-only, and this is a load decision rather than a correctness one. The safety-net
        // test below parks a real jittered period (45-75s observed) with a live updating
        // community. CI runs the browser jobs with --parallel, which turns on fileParallelism, so
        // all ~126 node-and-browser files share ONE page and one Helia node; adding a minute of
        // extra concurrent load there measurably worsens a suite that is already flaky in that
        // configuration (the issue #138 class: state-order assertions racing concurrent community
        // loops — reproduced locally on the unmodified base commit too). The behavior under test
        // is update-loop timing with no browser-specific component, so the three node libp2p-js
        // jobs cover it.
        const itSkipIfBrowser = isRunningInBrowser() ? it.skip : it;

        // kubo 0.43's name.publish default ttl is 300s, so the routing-layer cache would serve a
        // stale record for 225s+ (the ttl is jittered down to [0.75, 1.0) of itself, issue #307).
        // The safety-net test has to observe a cache expiry inside its own timeout, so it
        // publishes with a short ttl instead of waiting out kubo's default.
        const SHORT_RECORD_TTL = "10s";

        // Every call publishes a fresh static community record under a fresh IPNS key, so each
        // test drives its own update loop instead of attaching as a mirror to a loop another
        // test already started for a shared address.
        const startUpdatingStaticCommunityAndAwaitFirstUpdate = async () => {
            const staticRecord = await publishCommunityRecordWithExtraProp();
            staticRecordsToCleanUp.push(staticRecord);
            const community = (await pkc.createCommunity({ address: staticRecord.ipnsObj.signer.address })) as RemoteCommunity;
            communitiesToStop.push(community);
            const firstUpdate = new Promise<void>((resolve) => community.once("update", () => resolve()));
            await community.update();
            await firstUpdate;
            return { community, staticRecord };
        };

        it("an updating community whose record does not change stops churning updatingstatechange", async () => {
            const { community } = await startUpdatingStaticCommunityAndAwaitFirstUpdate();
            // Let the tail of the first update cycle (fetching-ipfs -> succeeded and any
            // background name classification) settle before judging steady state.
            await sleep(2000);

            const observationWindowMs = 12_000;
            const recordedStates: string[] = [];
            const onStateChange = (newState: RemoteCommunity["updatingState"]) => recordedStates.push(newState);
            community.on("updatingstatechange", onStateChange);
            await sleep(observationWindowMs);
            community.removeListener("updatingstatechange", onStateChange);

            // On master this is ~2 transitions per second (waiting-retry -> fetching-ipns and
            // back on every 1s tick), i.e. ~24 in this window. Event-driven, an idle community
            // in a 12s window sees no safety-net tick (its jittered period is much longer), so
            // at most a stray transition pair may land.
            expect(
                recordedStates.length,
                `an idle updating community must not churn updatingstatechange; saw [${recordedStates.join(", ")}]`
            ).to.be.at.most(4);
        }, 120_000);

        it("stop() unsubscribes every gossip arrival listener the update loop registered", async () => {
            // Spy BEFORE the loop starts so every subscribe the loop makes is captured. The
            // arrival listener map lives on the SHARED libp2p-js client and outlives any one
            // community, so a listener stop() fails to remove would retain the stopped
            // community's whole manager graph for the life of the client.
            const libp2pJsClient = pkc.clients.libp2pJsClients[Object.keys(pkc.clients.libp2pJsClients)[0]];
            const arrivals = libp2pJsClient.heliaWithKuboRpcClientFunctions.ipnsRecordArrivals;
            const subscribeSpy = vi.spyOn(arrivals, "subscribe");
            const unsubscribeSpy = vi.spyOn(arrivals, "unsubscribe");
            try {
                const { community } = await startUpdatingStaticCommunityAndAwaitFirstUpdate();

                // The update loop (and so the arrival subscriptions) runs on the TRACKED
                // updating instance; the instance createCommunity returned may be a mirror
                // attached to it, whose own manager never runs a loop. Inspect the instance
                // that actually loops. The update event also fires INSIDE updateOnce while
                // the loop syncs subscriptions right after it returns, so poll briefly
                // instead of racing that ordering.
                const updatingInstance = community._updatingCommunityInstanceWithListeners?.community ?? community;
                const managerInternals = updatingInstance._clientsManager as unknown as {
                    _subscribedIpnsArrivalTopics: Set<string>;
                };
                const deadline = Date.now() + 10_000;
                while (Date.now() < deadline && managerInternals._subscribedIpnsArrivalTopics.size === 0) await sleep(100);
                expect(
                    managerInternals._subscribedIpnsArrivalTopics.size,
                    "the loop must have registered at least one arrival subscription after the first update"
                ).to.be.greaterThan(0);
                // Scope all spy assertions to THIS community's topics: the spies sit on the
                // shared client, and another test's still-updating community may add its own
                // (legitimately still-subscribed) calls while this test runs.
                const communityTopics = [...managerInternals._subscribedIpnsArrivalTopics];
                for (const topic of communityTopics)
                    expect(
                        subscribeSpy.mock.calls.some(([subscribedTopic]) => subscribedTopic === topic),
                        `subscribe must have been called for the community's topic ${topic}`
                    ).to.equal(true);

                await community.stop();

                expect(
                    managerInternals._subscribedIpnsArrivalTopics.size,
                    "stop() must clear the manager's arrival subscriptions"
                ).to.equal(0);
                // Every (topic, listener) pair this community subscribed must have been
                // unsubscribed, so the shared client's listener map holds nothing of it.
                for (const [topic, listener] of subscribeSpy.mock.calls) {
                    if (!communityTopics.includes(topic)) continue;
                    expect(
                        unsubscribeSpy.mock.calls.some(([unsubTopic, unsubListener]) => unsubTopic === topic && unsubListener === listener),
                        `stop() must unsubscribe the arrival listener it subscribed for topic ${topic}`
                    ).to.equal(true);
                }
            } finally {
                subscribeSpy.mockRestore();
                unsubscribeSpy.mockRestore();
            }
        }, 120_000);

        // The arrival listener fires from the wrapped localStore.put MID-updateOnce (inside
        // resolveIpnsToCidP2P's direct-fetch cache write), BEFORE updateOnce records the cid in
        // _updateCidsAlreadyLoaded / updateCid. The filter in _onIpnsRecordArrival therefore
        // cannot tell the loop's own fetch of a new record from a genuinely unconsumed push, and
        // the park must re-check pending arrivals against POST-updateOnce state instead of
        // fast-returning on a stale boolean — otherwise every record change the loop discovers
        // itself (a missed gossip push picked up by the safety net) triggers one redundant full
        // updateOnce plus a phantom fetching-ipns/waiting-retry pair, reintroducing #308 churn.
        // Exercised as a unit sequence on a non-updating community's manager so the mid-flight
        // ordering is deterministic instead of raced through the real network.
        describe("the park re-checks pending arrivals against post-update state", () => {
            type ManagerParkInternals = {
                _onIpnsRecordArrival(arrival: { pubsubTopic: string; record: { value: string } }): void;
                _sleepUntilIpnsArrivalOrTimeoutOrAbort(ms: number, signal?: AbortSignal): Promise<void>;
                _updateCidsAlreadyLoaded: { add(cid: string): void };
            };
            const makeIdleManager = async () => {
                // A fresh, never-updated community: its manager has no running loop, so parking it
                // directly cannot collide with a live loop's wake slot.
                const signer = await pkc.createSigner();
                const community = (await pkc.createCommunity({ address: signer.address })) as RemoteCommunity;
                return { manager: community._clientsManager as unknown as ManagerParkInternals, community };
            };
            const CID_A = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
            const CID_B = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

            it("an arrival consumed by the update cycle it woke does not fast-return the park (issue #308)", async () => {
                const { manager } = await makeIdleManager();
                // Mid-updateOnce: the loop's own cache write reports the record being consumed.
                manager._onIpnsRecordArrival({ pubsubTopic: "/record/test", record: { value: `/ipfs/${CID_A}` } });
                // updateOnce then finishes consuming exactly that record.
                manager._updateCidsAlreadyLoaded.add(CID_A);
                const parkStartedAt = Date.now();
                await manager._sleepUntilIpnsArrivalOrTimeoutOrAbort(400);
                expect(
                    Date.now() - parkStartedAt,
                    "the park must sleep its full period: its only pending arrival was consumed by the cycle that produced it"
                ).to.be.at.least(350);
            });

            it("an arrival the update cycle did not consume still fast-returns the park", async () => {
                const { manager } = await makeIdleManager();
                manager._onIpnsRecordArrival({ pubsubTopic: "/record/test", record: { value: `/ipfs/${CID_B}` } });
                manager._updateCidsAlreadyLoaded.add(CID_A); // the cycle consumed something else
                const parkStartedAt = Date.now();
                await manager._sleepUntilIpnsArrivalOrTimeoutOrAbort(10_000);
                expect(
                    Date.now() - parkStartedAt,
                    "a genuinely unconsumed arrival must skip the park so the loop reacts to the push"
                ).to.be.below(2000);
            });

            it("an intermediate-hop (/ipns/ value) arrival fast-returns the park", async () => {
                const { manager } = await makeIdleManager();
                manager._onIpnsRecordArrival({ pubsubTopic: "/record/test", record: { value: "/ipns/someintermediatehopname" } });
                const parkStartedAt = Date.now();
                await manager._sleepUntilIpnsArrivalOrTimeoutOrAbort(10_000);
                expect(
                    Date.now() - parkStartedAt,
                    "a hop record pointing outside any walked chain always warrants an immediate walk"
                ).to.be.below(2000);
            });

            // The /ipns/ (hop) arrivals need the SAME self-arrival dedupe the /ipfs/ (cid)
            // arrivals get, keyed by the hop target the record delegates to. Without it, a
            // delegated community re-runs updateOnce on every republish of its anchor's record
            // (bumped sequence, unchanged /ipns/<minter> value — kubo republishes on a timer):
            // the walk's own cache write of the anchor record fires the arrival mid-updateOnce,
            // an undiscriminating hop-wake survives the park's re-check, and the loop skips its
            // park for a fully redundant updateOnce plus a phantom fetching-ipns/waiting-retry
            // pair — the exact #308 churn this PR removes, at the anchor's republish cadence.
            it("a hop arrival whose target the update cycle walked does not fast-return the park (issue #308, delegated communities)", async () => {
                const { manager, community } = await makeIdleManager();
                // Mid-updateOnce: the walk's own cache write of the ANCHOR record reports the
                // anchor's /ipns/ value (the minter it delegates to) BEFORE ipnsHops is updated.
                manager._onIpnsRecordArrival({ pubsubTopic: "/record/anchor", record: { value: "/ipns/minterhopname" } });
                // updateOnce then finishes having walked exactly that chain.
                community.ipnsHops = ["anchorhopname", "minterhopname"];
                const parkStartedAt = Date.now();
                await manager._sleepUntilIpnsArrivalOrTimeoutOrAbort(400);
                expect(
                    Date.now() - parkStartedAt,
                    "the park must sleep its full period: the pending hop arrival names a hop the cycle that produced it already walked (an anchor republish, not a delegation change)"
                ).to.be.at.least(350);
            });

            it("a hop arrival delegating to a hop outside the walked chain still fast-returns the park", async () => {
                const { manager, community } = await makeIdleManager();
                community.ipnsHops = ["anchorhopname", "minterhopname"];
                // The anchor's record now delegates to a DIFFERENT minter: genuinely news.
                manager._onIpnsRecordArrival({ pubsubTopic: "/record/anchor", record: { value: "/ipns/replacementminter" } });
                const parkStartedAt = Date.now();
                await manager._sleepUntilIpnsArrivalOrTimeoutOrAbort(10_000);
                expect(
                    Date.now() - parkStartedAt,
                    "a delegation change must skip the park so the loop walks the new chain now"
                ).to.be.below(2000);
            });
        });

        // Between update()'s first resolve and the end of the first updateOnce (IPFS fetch,
        // parse, signature verification — seconds on a cold client) a gossiped record fires no
        // listener and is recorded nowhere if the arrival subscriptions only sync AFTER
        // updateOnce returns: the first pushed record is then only picked up by the first
        // safety-net tick, 45-75s later at the production interval, where master's 1s poll
        // closed the same window in a second. The subscription topic is derivable pre-resolve
        // for every non-domain address (ipnsName === address), so the loop must arm it before
        // its first updateOnce. Oracle: snapshot the manager's subscription set at the FIRST
        // fetching-ipns emission — that state fires inside fetchNewUpdateForCommunity before
        // the resolve begins, strictly before the post-updateOnce sync could ever run, so the
        // reading is deterministic (no sleep racing the first cycle's duration).
        it("the arrival subscription is armed before the first updateOnce so a record pushed mid-first-fetch is not missed", async () => {
            const staticRecord = await publishCommunityRecordWithExtraProp();
            staticRecordsToCleanUp.push(staticRecord);
            const community = (await pkc.createCommunity({ address: staticRecord.ipnsObj.signer.address })) as RemoteCommunity;
            communitiesToStop.push(community);
            let topicsAtFirstFetchingIpns: number | undefined;
            const onStateChange = (newUpdatingState: RemoteCommunity["updatingState"]) => {
                if (newUpdatingState !== "fetching-ipns" || topicsAtFirstFetchingIpns !== undefined) return;
                // The loop runs on the TRACKED updating instance (this instance may be a mirror
                // attached to it); by the time any state event flows, the mirror link is set.
                const updatingInstance = community._updatingCommunityInstanceWithListeners?.community ?? community;
                topicsAtFirstFetchingIpns = (updatingInstance._clientsManager as unknown as { _subscribedIpnsArrivalTopics: Set<string> })
                    ._subscribedIpnsArrivalTopics.size;
            };
            community.on("updatingstatechange", onStateChange);
            const firstUpdate = new Promise<void>((resolve) => community.once("update", () => resolve()));
            await community.update();
            await firstUpdate;
            community.removeListener("updatingstatechange", onStateChange);
            expect(topicsAtFirstFetchingIpns, "the first update cycle must have emitted fetching-ipns").to.be.a("number");
            expect(
                topicsAtFirstFetchingIpns,
                "the arrival subscription must be armed before the first updateOnce; unarmed, a record pushed during the initial fetch waits for the first safety-net tick instead of waking the loop"
            ).to.be.greaterThan(0);
        }, 120_000);

        // The safety net exists for pushes that never arrived — mesh partition, a record
        // published while we had no subscribers, a regression in the arrival plumbing. A tick
        // that goes through the routing-layer cache gate cannot see any of those: the cache
        // still holds the OLD record well inside its ttl (kubo 0.43 publishes 300s, jittered
        // down to no less than 225s, issue #307), so the tick does zero network work, serves
        // the stale cid, and parks again — a missed push then strands the community for the
        // record's whole ttl instead of the bound the safety net promises (master's 1s poll was
        // bounded by ~ttl too, but re-checked every second). Timer-fired (non-arrival) wakes
        // must therefore resolve with nocache: true — bounded by the 30s revalidation floor, so
        // a sub-30s updateInterval (every test pkc defaults to 500ms) does not force the
        // network on each tick: unfloored, the loop's duty cycle flips from parked-in-
        // waiting-retry to mid-fetching-ipns, which tripped the browser CI legs' state-sampling
        // assertions. The promised staleness bound is max(updateInterval, floor). Oracle: spy
        // the resolver's name.resolve options rather than racing a real 225s staleness window.
        //
        // Node only for the same load reason as the park test above: with the floor, observing
        // two forced revalidations keeps an updating community live for ~65s on the shared
        // browser page, and the logic has no browser-specific component.
        itSkipIfBrowser(
            "safety-net ticks revalidate against the network at the floored cadence instead of riding the cache",
            async () => {
                const SAFETY_NET_INTERVAL_MS = 3000;
                // Own pkc: the suite instance runs the production 60s interval, which would park
                // this test for minutes per tick.
                const shortIntervalPkc = await config.pkcInstancePromise({ pkcOptions: { updateInterval: SAFETY_NET_INTERVAL_MS } });
                const libp2pJsClient = shortIntervalPkc.clients.libp2pJsClients[Object.keys(shortIntervalPkc.clients.libp2pJsClients)[0]];
                const clientFunctions = libp2pJsClient.heliaWithKuboRpcClientFunctions;
                const originalResolve = clientFunctions.name.resolve.bind(clientFunctions.name);
                const safetyNetResolveNocacheValues: (boolean | undefined)[] = [];
                let recording = false;
                try {
                    const staticRecord = await publishCommunityRecordWithExtraProp();
                    staticRecordsToCleanUp.push(staticRecord);
                    const community = (await shortIntervalPkc.createCommunity({
                        address: staticRecord.ipnsObj.signer.address
                    })) as RemoteCommunity;
                    const firstUpdate = new Promise<void>((resolve) => community.once("update", () => resolve()));
                    await community.update();
                    await firstUpdate;

                    // Record only resolves of THIS community's name from after the first update
                    // cycle: the record is static and nothing publishes to it, so every recorded
                    // resolve is a timer-fired safety-net tick, never an arrival-woken one. The
                    // client functions object is shared across pkc instances (test-util keys the
                    // helia client by a constant), hence the name filter.
                    clientFunctions.name.resolve = ((name, options) => {
                        if (recording && String(name) === staticRecord.ipnsObj.signer.address)
                            safetyNetResolveNocacheValues.push(options?.nocache);
                        return originalResolve(name, options);
                    }) as typeof clientFunctions.name.resolve;
                    recording = true;

                    // The floor counts from the loop start, so the two forced revalidations land
                    // ~30s and ~60s in; the deadline leaves headroom for a loaded runner and the
                    // tick jitter.
                    const forcedCount = () => safetyNetResolveNocacheValues.filter((nocache) => nocache === true).length;
                    const deadline = Date.now() + 90_000;
                    while (forcedCount() < 2 && Date.now() < deadline) await sleep(500);
                    await community.stop();

                    expect(
                        forcedCount(),
                        "timer-fired safety-net ticks must force nocache revalidations at the floored cadence — through the cache gate the net can never observe a push it missed, leaving the community stale for the record's whole ttl instead of max(updateInterval, floor)"
                    ).to.be.greaterThanOrEqual(2);
                    expect(
                        safetyNetResolveNocacheValues.filter((nocache) => nocache !== true).length,
                        "ticks inside the 30s revalidation floor must keep riding the routing-layer cache: a sub-30s updateInterval must not force the network on every tick"
                    ).to.be.greaterThanOrEqual(2);
                } finally {
                    clientFunctions.name.resolve = originalResolve;
                    await shortIntervalPkc.destroy();
                }
            },
            150_000
        );

        it("a newer record published while updating is still delivered", async () => {
            const { community, staticRecord } = await startUpdatingStaticCommunityAndAwaitFirstUpdate();

            const newerRecord = JSON.parse(JSON.stringify(staticRecord.communityRecord)) as typeof staticRecord.communityRecord;
            newerRecord.updatedAt = Math.max(newerRecord.updatedAt + 1, timestamp());
            newerRecord.signature = await signCommunity({ community: newerRecord, signer: staticRecord.ipnsObj.signer });

            const onUpdate = () => {
                if (community.updatedAt === newerRecord.updatedAt) deliveredResolve();
            };
            let deliveredResolve!: () => void;
            const delivered = new Promise<void>((resolve) => {
                deliveredResolve = resolve;
                community.on("update", onUpdate);
            });
            await staticRecord.ipnsObj.publishToIpns(JSON.stringify(newerRecord));

            // On master the 1s polling loop delivers this within a couple of seconds. After the
            // fix delivery rides the gossipsub push channel; if the push is missed, worst case is
            // a safety-net tick that still serves the stale record inside its jittered effective
            // ttl (up to 60s, issue #307) followed by one full jittered safety-net period (up to
            // 75s) before the revalidating tick — ~135s total, so allow 150s. The losing timer is
            // cleared so no 150s handle outlives the test.
            let deliveredInTime = true;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const timeout = new Promise<void>((resolve) => {
                timer = setTimeout(() => {
                    deliveredInTime = false;
                    resolve();
                }, 150_000);
            });
            await Promise.race([delivered, timeout]);
            clearTimeout(timer);
            community.removeListener("update", onUpdate);
            expect(deliveredInTime, "the newer community record must reach the updating community").to.equal(true);
        }, 240_000);

        // The safety net is the whole reason it is safe to stop polling, and nothing exercised
        // it: every other test here is satisfied by the push channel, so a loop that ONLY ever
        // woke on pushes would pass them all and then strand a community forever the first time
        // a push was missed (mesh partition, a record published while we had no subscribers, or
        // a regression in the arrival plumbing itself).
        //
        // The suppression is scoped to THIS community's own manager, never to the shared client's
        // ipnsRecordArrivals.subscribe. The libp2p-js client is shared by every pkc in the test
        // run (test-util keys it by a constant so a browser tab does not accumulate Helia nodes),
        // so stubbing subscribe there would mute the push channel for every other community for
        // the ~50s this test parks — in the browser, where all suites share one page, that
        // silently perturbs whichever state-order suites happen to run alongside it.
        //
        // Instead: stub the manager's own _syncIpnsArrivalSubscriptions so the loop stops
        // re-registering, THEN drop the listener it already registered. That order matters — the
        // loop re-syncs in its finally on every iteration, so clearing first would just be undone
        // on the next pass. Gossipsub itself keeps running underneath (the record may still land
        // in the routing-layer cache), which is deliberate: this pins the loss of the WAKE SIGNAL,
        // the failure mode PR #311 actually introduces, not a total pubsub outage.
        //
        // The record carries a 10s ttl instead of kubo 0.43's 300s default so the bound holds on
        // both branches: whether or not gossip warmed the cache, the safety-net tick that fires
        // at updateInterval * [0.75, 1.25] (45-75s) is guaranteed to find the cache expired and
        // revalidate against the network. Observed at 49.6s and 73.6s across local runs, i.e. the
        // full jitter range. The budget is 180s rather than ~90s so that one transient resolve
        // failure (which costs another whole jittered park) does not turn a slow CI runner into a
        // red build; the test still fails outright if the safety net never fires at all, which is
        // the property being pinned.
        itSkipIfBrowser(
            "a newer record still arrives via the safety-net poll when the push wake is lost",
            async () => {
                type ManagerArrivalInternals = {
                    _subscribedIpnsArrivalTopics: Set<string>;
                    _syncIpnsArrivalSubscriptions(client: unknown): void;
                    _clearIpnsArrivalSubscriptions(): void;
                };
                let managerInternals: ManagerArrivalInternals | undefined;
                let originalSync: ManagerArrivalInternals["_syncIpnsArrivalSubscriptions"] | undefined;
                try {
                    const staticRecord = await publishCommunityRecordWithExtraProp({ ttl: SHORT_RECORD_TTL });
                    staticRecordsToCleanUp.push(staticRecord);
                    const community = (await pkc.createCommunity({
                        address: staticRecord.ipnsObj.signer.address
                    })) as RemoteCommunity;
                    communitiesToStop.push(community);
                    const firstUpdate = new Promise<void>((resolve) => community.once("update", () => resolve()));
                    await community.update();
                    await firstUpdate;

                    // The loop runs on the TRACKED updating instance; the instance createCommunity
                    // returned may be a mirror attached to it. The update event also fires INSIDE
                    // updateOnce, while the loop syncs its arrival subscriptions immediately AFTER
                    // updateOnce returns, so poll instead of racing that ordering (same reason as the
                    // stop() test above).
                    const updatingInstance = community._updatingCommunityInstanceWithListeners?.community ?? community;
                    managerInternals = updatingInstance._clientsManager as unknown as ManagerArrivalInternals;
                    const subscribeDeadline = Date.now() + 10_000;
                    while (Date.now() < subscribeDeadline && managerInternals._subscribedIpnsArrivalTopics.size === 0) await sleep(100);
                    expect(
                        managerInternals._subscribedIpnsArrivalTopics.size,
                        "the loop must have registered an arrival subscription, otherwise this test is not suppressing anything"
                    ).to.be.greaterThan(0);

                    originalSync = managerInternals._syncIpnsArrivalSubscriptions;
                    managerInternals._syncIpnsArrivalSubscriptions = () => {};
                    managerInternals._clearIpnsArrivalSubscriptions();
                    expect(
                        managerInternals._subscribedIpnsArrivalTopics.size,
                        "the community under test must hold no arrival subscription once suppressed"
                    ).to.equal(0);

                    const newerRecord = JSON.parse(JSON.stringify(staticRecord.communityRecord)) as typeof staticRecord.communityRecord;
                    newerRecord.updatedAt = Math.max(newerRecord.updatedAt + 1, timestamp());
                    newerRecord.signature = await signCommunity({ community: newerRecord, signer: staticRecord.ipnsObj.signer });

                    const onUpdate = () => {
                        if (community.updatedAt === newerRecord.updatedAt) deliveredResolve();
                    };
                    let deliveredResolve!: () => void;
                    const delivered = new Promise<void>((resolve) => {
                        deliveredResolve = resolve;
                        community.on("update", onUpdate);
                    });
                    await staticRecord.ipnsObj.publishToIpns(JSON.stringify(newerRecord), { ttl: SHORT_RECORD_TTL });

                    let deliveredInTime = true;
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    const timeout = new Promise<void>((resolve) => {
                        timer = setTimeout(() => {
                            deliveredInTime = false;
                            resolve();
                        }, 180_000);
                    });
                    await Promise.race([delivered, timeout]);
                    clearTimeout(timer);
                    community.removeListener("update", onUpdate);
                    expect(
                        deliveredInTime,
                        "with the push wake suppressed the jittered safety-net poll must still deliver the newer record; a miss here means a missed push strands the community until it is restarted"
                    ).to.equal(true);
                } finally {
                    // Hand the loop its real sync back so the community resubscribes on its next
                    // iteration and afterAll's stop() unsubscribes a consistent set.
                    if (managerInternals && originalSync) managerInternals._syncIpnsArrivalSubscriptions = originalSync;
                }
            },
            240_000
        );
    });
});

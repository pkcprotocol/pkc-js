import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import {
    getAvailablePKCConfigsToTestAgainst,
    isRunningInBrowser,
    publishCommunityRecordWithExtraProp
} from "../../../dist/node/test/test-util.js";
import { signCommunity } from "../../../dist/node/signer/signatures.js";
import { ipnsNameToIpnsOverPubsubTopic, timestamp } from "../../../dist/node/util.js";
import { createKuboIpnsRecordArrivals } from "../../../dist/node/clients/kubo-ipns-record-arrivals.js";
import { createIPNSRecord, marshalIPNSRecord } from "ipns";
import { generateKeyPair } from "@libp2p/crypto/keys";

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
// Both P2P resolvers: libp2p-js (issue #308, PR #311) and kubo-RPC (issue #322, whose push
// channel is a pubsub RPC stream per IPNS record topic on the resolver daemon). Gateways keep
// polling at pkc.updateInterval. Where the two differ — the kubo resolver may only arm a topic
// AFTER a resolve walked its name (kubo's namesys cannot join a topic the RPC subscription
// joined first, see src/clients/kubo-ipns-record-arrivals.ts), and it always resolves with
// nocache — the tests below branch per resolver and say why.
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-libp2pjs", "remote-kubo-rpc"] }).map((config) => {
    describe(`community update loop is event-driven, not 1s polling (issues #308, #322) - ${config.name}`, () => {
        let pkc: PKCType;
        const isKuboResolver = config.testConfigCode === "remote-kubo-rpc";
        const itIfKuboResolver = isKuboResolver ? it : it.skip;
        const itIfLibp2pJsResolver = isKuboResolver ? it.skip : it;
        // The arrival registry of the resolver the update loop is push-driven on.
        const arrivalsOf = (instance: PKCType) => {
            const kuboRpcClient = instance.clients.kuboRpcClients[Object.keys(instance.clients.kuboRpcClients)[0]];
            if (kuboRpcClient) return kuboRpcClient.ipnsRecordArrivals;
            return instance.clients.libp2pJsClients[Object.keys(instance.clients.libp2pJsClients)[0]].heliaWithKuboRpcClientFunctions
                .ipnsRecordArrivals;
        };
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
            // arrival listener map lives on the SHARED resolver client and outlives any one
            // community, so a listener stop() fails to remove would retain the stopped
            // community's whole manager graph for the life of the client.
            const arrivals = arrivalsOf(pkc);
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
                        subscribeSpy.mock.calls.some(([subscribed]) => subscribed.pubsubTopic === topic),
                        `subscribe must have been called for the community's topic ${topic}`
                    ).to.equal(true);

                await community.stop();

                expect(
                    managerInternals._subscribedIpnsArrivalTopics.size,
                    "stop() must clear the manager's arrival subscriptions"
                ).to.equal(0);
                // Every (topic, listener) pair this community subscribed must have been
                // unsubscribed, so the shared client's listener map holds nothing of it.
                for (const [{ pubsubTopic: topic, listener }] of subscribeSpy.mock.calls) {
                    if (!communityTopics.includes(topic)) continue;
                    expect(
                        unsubscribeSpy.mock.calls.some(
                            ([unsubscribed]) => unsubscribed.pubsubTopic === topic && unsubscribed.listener === listener
                        ),
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
                _sleepUntilIpnsArrivalOrTimeoutOrAbort(args: { ms: number; signal?: AbortSignal }): Promise<void>;
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
                await manager._sleepUntilIpnsArrivalOrTimeoutOrAbort({ ms: 400 });
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
                await manager._sleepUntilIpnsArrivalOrTimeoutOrAbort({ ms: 10_000 });
                expect(
                    Date.now() - parkStartedAt,
                    "a genuinely unconsumed arrival must skip the park so the loop reacts to the push"
                ).to.be.below(2000);
            });

            it("an intermediate-hop (/ipns/ value) arrival fast-returns the park", async () => {
                const { manager } = await makeIdleManager();
                manager._onIpnsRecordArrival({ pubsubTopic: "/record/test", record: { value: "/ipns/someintermediatehopname" } });
                const parkStartedAt = Date.now();
                await manager._sleepUntilIpnsArrivalOrTimeoutOrAbort({ ms: 10_000 });
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
                await manager._sleepUntilIpnsArrivalOrTimeoutOrAbort({ ms: 400 });
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
                await manager._sleepUntilIpnsArrivalOrTimeoutOrAbort({ ms: 10_000 });
                expect(
                    Date.now() - parkStartedAt,
                    "a delegation change must skip the park so the loop walks the new chain now"
                ).to.be.below(2000);
            });
        });

        // The arrival plumbing must follow the community's identity wherever the identity is
        // decided, not only at the two loop-owned sync points (pre-first-cycle and post-
        // updateOnce). Each case below is a state the old 1s poll covered for free and the
        // event-driven loop must cover explicitly, exercised as unit sequences on idle
        // managers so the ordering is deterministic.
        describe("arrival subscriptions and pending arrivals follow identity changes", () => {
            type ManagerIdentityInternals = {
                _subscribedIpnsArrivalTopics: Set<string>;
                _pendingIpnsArrivalHopTargets: Set<string>;
                _nextResolveRevalidatesNetwork: boolean;
                _ipnsArrivalsRequireWalkedName: boolean;
                _ipnsNamesWalkedByResolver: Set<string>;
                _syncIpnsArrivalSubscriptions(source: unknown): { established: Promise<void> };
                _dropDeadIpnsArrivalSubscriptions(source: unknown): void;
                _clearIpnsArrivalSubscriptions(): void;
                _applyKeyMigration(args: { communityName: string; newPublicKey: string }): void;
                _onIpnsRecordArrival(arrival: { pubsubTopic: string; record: { value: string } }): void;
                _sleepUntilIpnsArrivalOrTimeoutOrAbort(args: { ms: number; signal?: AbortSignal }): Promise<void>;
                resolveIpnsToCidP2P(ipnsName: string, opts: { nocache?: boolean }): Promise<unknown>;
                fetchNewUpdateForCommunity(communityAddress: string): Promise<unknown>;
            };
            // An idle manager configured the way startUpdatingLoop configures it for this
            // resolver (the walked-name gate is a loop-start decision, not a constructor one).
            const idleManagerOf = (community: RemoteCommunity) => {
                const manager = community._clientsManager as unknown as ManagerIdentityInternals;
                manager._ipnsArrivalsRequireWalkedName = isKuboResolver;
                return manager;
            };
            // A subscribe + establishment that must succeed: on kubo the RPC stream has to come
            // up (the pkc under test and the daemon are both local), on libp2p-js it is sync.
            const syncAndAwait = async (manager: ManagerIdentityInternals) => {
                await manager._syncIpnsArrivalSubscriptions(arrivalsOf(pkc)).established;
            };

            itIfLibp2pJsResolver(
                "a domain community created with a known publicKey arms that key's topic before its first update",
                async () => {
                    // createCommunity({ address: domain, publicKey }) skips name resolution: the first
                    // fetch pins to publicKey (fetchNewUpdateForCommunity). The pre-loop arm must derive
                    // the same name, otherwise the first cycle runs with no listener and a record
                    // pushed mid-first-fetch is dropped at the source until the first safety-net tick.
                    const signer = await pkc.createSigner();
                    const community = (await pkc.createCommunity({ address: "plebbit.bso", publicKey: signer.address })) as RemoteCommunity;
                    const manager = idleManagerOf(community);
                    try {
                        await syncAndAwait(manager);
                        expect(
                            [...manager._subscribedIpnsArrivalTopics],
                            "the pre-loop arm must watch the pinned publicKey's topic for a domain+publicKey community"
                        ).to.deep.equal([ipnsNameToIpnsOverPubsubTopic(signer.address)]);
                    } finally {
                        manager._clearIpnsArrivalSubscriptions();
                    }
                }
            );

            // kubo's namesys joins a record topic on the first resolve of its name. If the RPC
            // subscription joins the topic first, namesys can never join it on that daemon and
            // every later name.resolve of the name fails until the daemon restarts (verified on
            // kubo 0.43; the RPC subscription being cancelled again does not repair it). So on
            // kubo the pre-resolve name derivation (pinned publicKey / non-domain address) must
            // NOT arm anything, and neither must a mirror-restored hop list: only names this
            // manager's resolver walked are armed.
            itIfKuboResolver("never arms a record topic before the resolver walked its name (kubo namesys join hazard)", async () => {
                const signer = await pkc.createSigner();
                const community = (await pkc.createCommunity({ address: "plebbit.bso", publicKey: signer.address })) as RemoteCommunity;
                const manager = idleManagerOf(community);
                try {
                    await syncAndAwait(manager);
                    expect(
                        [...manager._subscribedIpnsArrivalTopics],
                        "a pinned publicKey that no resolve walked yet must not be armed on kubo"
                    ).to.deep.equal([]);
                    // A hop list restored from a mirror / persisted state is not proof of a walk either.
                    community.ipnsHops = [signer.address];
                    await syncAndAwait(manager);
                    expect([...manager._subscribedIpnsArrivalTopics], "a restored hop list must not be armed on kubo").to.deep.equal([]);
                    // The resolve walked the name: now, and only now, the topic is armed.
                    manager._ipnsNamesWalkedByResolver.add(signer.address);
                    await syncAndAwait(manager);
                    expect([...manager._subscribedIpnsArrivalTopics]).to.deep.equal([ipnsNameToIpnsOverPubsubTopic(signer.address)]);
                    expect(
                        arrivalsOf(pkc).isSubscribed?.({ pubsubTopic: ipnsNameToIpnsOverPubsubTopic(signer.address) }),
                        "the kubo RPC stream must be live once established"
                    ).to.equal(true);
                } finally {
                    manager._clearIpnsArrivalSubscriptions();
                }
            });

            // The daemon restarted (or the RPC stream died for any reason): the topic must be
            // forgotten BEFORE the next resolve, together with the walked mark of its name, so
            // the resolve re-joins namesys first and the post-update sync re-arms afterwards.
            it("a dead arrival subscription is dropped with its walked mark so the next resolve re-walks before re-arming", async () => {
                const signer = await pkc.createSigner();
                const community = (await pkc.createCommunity({ address: signer.address })) as RemoteCommunity;
                const manager = idleManagerOf(community);
                manager._ipnsArrivalsRequireWalkedName = true;
                const topic = ipnsNameToIpnsOverPubsubTopic(signer.address);
                let live = true;
                const unsubscribed: string[] = [];
                const fakeSource = {
                    subscribe: () => {},
                    unsubscribe: ({ pubsubTopic }: { pubsubTopic: string }) => unsubscribed.push(pubsubTopic),
                    isSubscribed: () => live
                };
                try {
                    manager._ipnsNamesWalkedByResolver.add(signer.address);
                    community.ipnsHops = [signer.address];
                    await manager._syncIpnsArrivalSubscriptions(fakeSource).established;
                    expect([...manager._subscribedIpnsArrivalTopics]).to.deep.equal([topic]);

                    live = false;
                    manager._dropDeadIpnsArrivalSubscriptions(fakeSource);
                    expect([...manager._subscribedIpnsArrivalTopics], "the dead topic must be forgotten").to.deep.equal([]);
                    expect(unsubscribed, "the dead topic's listener must be released at the source").to.deep.equal([topic]);
                    expect(
                        manager._ipnsNamesWalkedByResolver.has(signer.address),
                        "the walked mark must go with it, otherwise the next sync re-arms before the resolve re-joined namesys"
                    ).to.equal(false);
                    // Without a fresh walk the sync must stay unarmed...
                    live = true;
                    await manager._syncIpnsArrivalSubscriptions(fakeSource).established;
                    expect([...manager._subscribedIpnsArrivalTopics]).to.deep.equal([]);
                    // ...and re-arm once the name was walked again.
                    manager._ipnsNamesWalkedByResolver.add(signer.address);
                    await manager._syncIpnsArrivalSubscriptions(fakeSource).established;
                    expect([...manager._subscribedIpnsArrivalTopics]).to.deep.equal([topic]);
                } finally {
                    manager._clearIpnsArrivalSubscriptions();
                }
            });

            it("a key migration moves the arrival subscription to the new key and drops the old key's pending arrivals", async () => {
                const oldSigner = await pkc.createSigner();
                const newSigner = await pkc.createSigner();
                const community = (await pkc.createCommunity({
                    address: "migrating.bso",
                    publicKey: oldSigner.address
                })) as RemoteCommunity;
                const manager = idleManagerOf(community);
                try {
                    // On kubo the old key counts as walked (the loop only ever arms walked names).
                    manager._ipnsNamesWalkedByResolver.add(oldSigner.address);
                    await syncAndAwait(manager);
                    expect([...manager._subscribedIpnsArrivalTopics]).to.deep.equal([ipnsNameToIpnsOverPubsubTopic(oldSigner.address)]);
                    // An old-key arrival queued before the migration fires: with updateCid and the
                    // loaded set cleared by the migration nothing filters it, so unless the
                    // migration drops it the next park fast-returns into a wasted old-key cycle.
                    manager._onIpnsRecordArrival({
                        pubsubTopic: ipnsNameToIpnsOverPubsubTopic(oldSigner.address),
                        record: { value: "/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi" }
                    });

                    manager._applyKeyMigration({ communityName: "migrating.bso", newPublicKey: newSigner.address });

                    expect(community.publicKey).to.equal(newSigner.address);
                    if (isKuboResolver) {
                        // The new key's name has not been resolved yet, so namesys has not joined
                        // its topic: arming it now would be the join hazard. The old key's topic
                        // must still be gone immediately; the new one follows the first resolve.
                        expect(
                            [...manager._subscribedIpnsArrivalTopics],
                            "after a key migration on kubo the old key's topic is dropped at once and the new key's waits for its first resolve"
                        ).to.deep.equal([]);
                        manager._ipnsNamesWalkedByResolver.add(newSigner.address);
                        await syncAndAwait(manager);
                    }
                    expect(
                        [...manager._subscribedIpnsArrivalTopics],
                        "after a key migration the loop must watch ONLY the new key's topic, immediately on libp2p-js, and right after the new key's first resolve on kubo"
                    ).to.deep.equal([ipnsNameToIpnsOverPubsubTopic(newSigner.address)]);
                    const parkStartedAt = Date.now();
                    await manager._sleepUntilIpnsArrivalOrTimeoutOrAbort({ ms: 400 });
                    expect(
                        Date.now() - parkStartedAt,
                        "the old key's pending arrival must not survive the migration and fast-return the park"
                    ).to.be.at.least(350);
                } finally {
                    manager._clearIpnsArrivalSubscriptions();
                }
            });

            it("an arrival that wakes the park is consumed by that wake, so a cycle that fails to change the chain is not re-run", async () => {
                // A hop record delegating outside the walked chain wakes the park; if the walk it
                // triggers fails without updating ipnsHops (e.g. ERR_IPNS_MAX_HOPS_EXCEEDED, a
                // non-retriable error), the still-pending hop target must not fast-return the next
                // park into an identical failing walk: two error events per push instead of one.
                const signer = await pkc.createSigner();
                const community = (await pkc.createCommunity({ address: signer.address })) as RemoteCommunity;
                const manager = community._clientsManager as unknown as ManagerIdentityInternals;
                community.ipnsHops = ["anchorhopname", "minterhopname"];
                const wokenPark = manager._sleepUntilIpnsArrivalOrTimeoutOrAbort({ ms: 10_000 });
                await sleep(100);
                manager._onIpnsRecordArrival({ pubsubTopic: "/record/anchor", record: { value: "/ipns/replacementminter" } });
                const wokenParkStartedAt = Date.now();
                await wokenPark;
                expect(Date.now() - wokenParkStartedAt, "the arrival must wake the park").to.be.below(2000);

                // The walk that followed failed: the chain is unchanged.
                const parkStartedAt = Date.now();
                await manager._sleepUntilIpnsArrivalOrTimeoutOrAbort({ ms: 400 });
                expect(
                    Date.now() - parkStartedAt,
                    "the park that follows the woken cycle must sleep its full period: the arrival was already reacted to"
                ).to.be.at.least(350);
            });

            it("a forced network revalidation is consumed by the first resolve attempt so retries within the cycle ride the cache", async () => {
                // _nextResolveRevalidatesNetwork is set by a timer-fired park and read per
                // resolve. updateOnce retries fetchNewUpdateForCommunity forever on retriable
                // errors (e.g. a CID fetch timeout AFTER a successful resolve), and every attempt
                // must not re-resolve IPNS over the network: master's retries re-read the cache.
                const signer = await pkc.createSigner();
                const community = (await pkc.createCommunity({ address: signer.address })) as RemoteCommunity;
                const manager = community._clientsManager as unknown as ManagerIdentityInternals;
                const resolveSpy = vi
                    .spyOn(manager, "resolveIpnsToCidP2P")
                    .mockImplementation((): Promise<never> => Promise.reject(new Error("simulated resolve failure")));
                try {
                    manager._nextResolveRevalidatesNetwork = true;
                    for (let attempt = 0; attempt < 2; attempt++) {
                        try {
                            await manager.fetchNewUpdateForCommunity(signer.address);
                        } catch {
                            // every attempt fails at the resolve: only its options matter here
                        }
                    }
                    expect(resolveSpy.mock.calls.length).to.equal(2);
                    expect(
                        resolveSpy.mock.calls[0][1].nocache,
                        "the first attempt after a timer-fired park must revalidate on the network"
                    ).to.equal(true);
                    expect(
                        resolveSpy.mock.calls[1][1].nocache,
                        "the retry attempt within the same cycle must not force the network again"
                    ).to.not.equal(true);
                } finally {
                    resolveSpy.mockRestore();
                }
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
        itIfLibp2pJsResolver(
            "the arrival subscription is armed before the first updateOnce so a record pushed mid-first-fetch is not missed",
            async () => {
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
                    topicsAtFirstFetchingIpns = (
                        updatingInstance._clientsManager as unknown as { _subscribedIpnsArrivalTopics: Set<string> }
                    )._subscribedIpnsArrivalTopics.size;
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
            },
            120_000
        );

        // The kubo mirror image of the test above: the first cycle must run UNARMED (arming
        // first is the namesys join hazard), the loop arms right after it, and — the property
        // that actually matters — the daemon must still resolve the name afterwards, i.e. the
        // RPC subscription did not lock namesys out of the topic. Also pins that the loop's
        // own kubo pubsub subscription shows up on the daemon.
        itIfKuboResolver(
            "arms the record topic only after the first resolve, and kubo's namesys still resolves the name afterwards",
            async () => {
                const staticRecord = await publishCommunityRecordWithExtraProp();
                staticRecordsToCleanUp.push(staticRecord);
                const community = (await pkc.createCommunity({ address: staticRecord.ipnsObj.signer.address })) as RemoteCommunity;
                communitiesToStop.push(community);
                const topic = ipnsNameToIpnsOverPubsubTopic(staticRecord.ipnsObj.signer.address);
                let topicsAtFirstFetchingIpns: number | undefined;
                const onStateChange = (newUpdatingState: RemoteCommunity["updatingState"]) => {
                    if (newUpdatingState !== "fetching-ipns" || topicsAtFirstFetchingIpns !== undefined) return;
                    const updatingInstance = community._updatingCommunityInstanceWithListeners?.community ?? community;
                    topicsAtFirstFetchingIpns = (
                        updatingInstance._clientsManager as unknown as { _subscribedIpnsArrivalTopics: Set<string> }
                    )._subscribedIpnsArrivalTopics.size;
                };
                community.on("updatingstatechange", onStateChange);
                const firstUpdate = new Promise<void>((resolve) => community.once("update", () => resolve()));
                await community.update();
                await firstUpdate;
                community.removeListener("updatingstatechange", onStateChange);
                expect(topicsAtFirstFetchingIpns, "the first cycle must run with no armed topic on kubo").to.equal(0);

                const updatingInstance = community._updatingCommunityInstanceWithListeners?.community ?? community;
                const managerInternals = updatingInstance._clientsManager as unknown as { _subscribedIpnsArrivalTopics: Set<string> };
                const deadline = Date.now() + 10_000;
                while (Date.now() < deadline && !arrivalsOf(pkc).isSubscribed?.({ pubsubTopic: topic })) await sleep(100);
                expect(
                    [...managerInternals._subscribedIpnsArrivalTopics],
                    "the loop must arm the walked name right after its first cycle"
                ).to.deep.equal([topic]);
                expect(arrivalsOf(pkc).isSubscribed?.({ pubsubTopic: topic }), "the kubo RPC stream must be live").to.equal(true);

                const kuboRpcClient = pkc.clients.kuboRpcClients[Object.keys(pkc.clients.kuboRpcClients)[0]];
                const namesysSubscriptions = await kuboRpcClient._client.name.pubsub.subs();
                expect(
                    namesysSubscriptions.map((ipnsPath) => ipnsNameToIpnsOverPubsubTopic(ipnsPath.replace("/ipns/", ""))),
                    "kubo's namesys must hold its own subscription to the name after the loop armed the RPC one"
                ).to.include(topic);
                let resolved: string | undefined;
                for await (const value of kuboRpcClient._client.name.resolve(staticRecord.ipnsObj.signer.address, {
                    nocache: true,
                    recursive: false
                }))
                    resolved = value;
                expect(resolved, "name.resolve must keep working on the daemon after the RPC subscription joined the topic").to.match(
                    /^\/ipfs\//
                );
            },
            120_000
        );

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
        // kubo-RPC always resolves with nocache: true (its namesys store is a local read, there is
        // no routing-layer cache gate to bypass), so the floored revalidation cadence is a
        // libp2p-js-only property.
        (isKuboResolver ? it.skip : itSkipIfBrowser)(
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
                    _syncIpnsArrivalSubscriptions(source: unknown): { established: Promise<void> };
                    _clearIpnsArrivalSubscriptions(): void;
                };
                let managerInternals: ManagerArrivalInternals | undefined;
                let syncSpy: { mockRestore(): void } | undefined;
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

                    // The stub must look like a sync that armed nothing new and has nothing to
                    // establish; a thrown/undefined result would make the loop treat the push
                    // channel as down and fall back to its 1s poll, which is not the safety net.
                    syncSpy = vi
                        .spyOn(managerInternals, "_syncIpnsArrivalSubscriptions")
                        .mockImplementation(() => ({ established: Promise.resolve() }));
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
                    syncSpy?.mockRestore();
                }
            },
            240_000
        );

        // On kubo the first cycle must arm its topic from INSIDE updateOnce, right after the
        // resolve walked the name, and must not run a second cycle to compensate for having
        // started unarmed: that extra cycle emitted a second fetching-ipns per community start,
        // which every comment and publication mirrors into its own state sequence (the PR #324
        // CI failures in libp2pjsClient.kuboRpc.clients and publishingstate.comment). Pins: the
        // topic is in the manager's set by the time the first `update` fires, and one second
        // later (far inside the 45-75s safety net) the name was resolved exactly once and
        // fetching-ipns was entered exactly once.
        itIfKuboResolver(
            "arms during the first cycle, right after its resolve, without running an extra cycle afterwards",
            async () => {
                const staticRecord = await publishCommunityRecordWithExtraProp();
                staticRecordsToCleanUp.push(staticRecord);
                const topic = ipnsNameToIpnsOverPubsubTopic(staticRecord.ipnsObj.signer.address);
                const kuboRpcClient = pkc.clients.kuboRpcClients[Object.keys(pkc.clients.kuboRpcClients)[0]];
                const originalResolve = kuboRpcClient._client.name.resolve;
                let resolvesOfThisName = 0;
                const resolveSpy = vi.spyOn(kuboRpcClient._client.name, "resolve").mockImplementation((name, options) => {
                    if (String(name) === staticRecord.ipnsObj.signer.address) resolvesOfThisName++;
                    return originalResolve(name, options);
                });
                try {
                    const community = (await pkc.createCommunity({ address: staticRecord.ipnsObj.signer.address })) as RemoteCommunity;
                    communitiesToStop.push(community);
                    let fetchingIpnsEntries = 0;
                    community.on("updatingstatechange", (newUpdatingState) => {
                        if (newUpdatingState === "fetching-ipns") fetchingIpnsEntries++;
                    });
                    let topicsArmedAtFirstUpdate: string[] | undefined;
                    const firstUpdate = new Promise<void>((resolve) =>
                        community.once("update", () => {
                            const updatingInstance = community._updatingCommunityInstanceWithListeners?.community ?? community;
                            topicsArmedAtFirstUpdate = [
                                ...(updatingInstance._clientsManager as unknown as { _subscribedIpnsArrivalTopics: Set<string> })
                                    ._subscribedIpnsArrivalTopics
                            ];
                            resolve();
                        })
                    );
                    await community.update();
                    await firstUpdate;
                    expect(
                        topicsArmedAtFirstUpdate,
                        "the walked name's topic must be armed inside the first cycle, before its update event"
                    ).to.deep.equal([topic]);
                    await sleep(1000);
                    expect(arrivalsOf(pkc).isSubscribed?.({ pubsubTopic: topic }), "the kubo RPC stream must be live").to.equal(true);
                    expect(resolvesOfThisName, "the arming cycle must not be followed by an extra resolve").to.equal(1);
                    expect(fetchingIpnsEntries, "a community start must enter fetching-ipns exactly once").to.equal(1);
                } finally {
                    resolveSpy.mockRestore();
                }
            },
            60_000
        );

        // The delivery test earlier in this suite would also pass under the old 1s poll (a poll tick lands within
        // a second). This pins the mechanism: once the topic is armed, a newer record must reach
        // the community through the push channel, i.e. with exactly ONE name.resolve after the
        // publish (the arrival-woken cycle's), not through a poll cadence.
        itIfKuboResolver(
            "a newer record is delivered by the push channel with a single resolve, not by polling",
            async () => {
                const { community, staticRecord } = await startUpdatingStaticCommunityAndAwaitFirstUpdate();
                const topic = ipnsNameToIpnsOverPubsubTopic(staticRecord.ipnsObj.signer.address);
                const deadline = Date.now() + 10_000;
                while (Date.now() < deadline && !arrivalsOf(pkc).isSubscribed?.({ pubsubTopic: topic })) await sleep(100);
                expect(arrivalsOf(pkc).isSubscribed?.({ pubsubTopic: topic }), "the topic must be armed before measuring").to.equal(true);
                // Let the first cycle's establishment settle before counting.
                await sleep(2000);

                const kuboRpcClient = pkc.clients.kuboRpcClients[Object.keys(pkc.clients.kuboRpcClients)[0]];
                const originalResolve = kuboRpcClient._client.name.resolve;
                let resolvesOfThisName = 0;
                const resolveSpy = vi.spyOn(kuboRpcClient._client.name, "resolve").mockImplementation((name, options) => {
                    if (String(name) === staticRecord.ipnsObj.signer.address) resolvesOfThisName++;
                    return originalResolve(name, options);
                });
                try {
                    const newerRecord = JSON.parse(JSON.stringify(staticRecord.communityRecord)) as typeof staticRecord.communityRecord;
                    newerRecord.updatedAt = Math.max(newerRecord.updatedAt + 1, timestamp());
                    newerRecord.signature = await signCommunity({ community: newerRecord, signer: staticRecord.ipnsObj.signer });
                    const delivered = new Promise<void>((resolve) => {
                        const onUpdate = () => {
                            if (community.updatedAt !== newerRecord.updatedAt) return;
                            community.removeListener("update", onUpdate);
                            resolve();
                        };
                        community.on("update", onUpdate);
                    });
                    await staticRecord.ipnsObj.publishToIpns(JSON.stringify(newerRecord));
                    await Promise.race([delivered, sleep(20_000)]);
                    expect(community.updatedAt, "the pushed record must be delivered").to.equal(newerRecord.updatedAt);
                    // The post-publish resolve count: the helper's own post-publish sanity resolve goes
                    // through the PUBLISHER's client, not this one, so every call here is the loop's.
                    expect(
                        resolvesOfThisName,
                        "delivery must ride the push channel: one arrival-woken resolve, not a 1s poll cadence"
                    ).to.equal(1);
                } finally {
                    resolveSpy.mockRestore();
                }
            },
            120_000
        );

        // The push channel can be unavailable (pubsub disabled on the daemon, the daemon mid-
        // restart). Then the loop must not park a whole safety-net period with nothing to wake it:
        // it drops the topic it could not arm and keeps the pre-#322 1s poll until a later sync
        // succeeds, so delivery is as prompt as before this change.
        itIfKuboResolver(
            "falls back to the 1s poll while the kubo push channel cannot be established",
            async () => {
                // Own pkc: the stub below disables the push channel for every community on the client.
                const noPushPkc = await config.pkcInstancePromise({ pkcOptions: { updateInterval: 60_000 } });
                const kuboRpcClient = noPushPkc.clients.kuboRpcClients[Object.keys(noPushPkc.clients.kuboRpcClients)[0]];
                const subscribeSpy = vi
                    .spyOn(kuboRpcClient._client.pubsub, "subscribe")
                    .mockImplementation(() => Promise.reject(new Error("simulated: pubsub is disabled on this daemon")));
                const originalResolve = kuboRpcClient._client.name.resolve;
                let resolvesOfThisName = 0;
                let resolveSpy: { mockRestore(): void } | undefined;
                try {
                    const staticRecord = await publishCommunityRecordWithExtraProp();
                    staticRecordsToCleanUp.push(staticRecord);
                    const community = (await noPushPkc.createCommunity({
                        address: staticRecord.ipnsObj.signer.address
                    })) as RemoteCommunity;
                    const firstUpdate = new Promise<void>((resolve) => community.once("update", () => resolve()));
                    await community.update();
                    await firstUpdate;
                    await sleep(1500); // past the first cycle's failed arming attempt

                    const updatingInstance = community._updatingCommunityInstanceWithListeners?.community ?? community;
                    const managerInternals = updatingInstance._clientsManager as unknown as { _subscribedIpnsArrivalTopics: Set<string> };
                    expect(subscribeSpy.mock.calls.length, "the loop must have tried to arm the topic").to.be.greaterThan(0);
                    expect(
                        managerInternals._subscribedIpnsArrivalTopics.size,
                        "a topic whose stream could not be established must not be kept as armed"
                    ).to.equal(0);

                    resolveSpy = vi.spyOn(kuboRpcClient._client.name, "resolve").mockImplementation((name, options) => {
                        if (String(name) === staticRecord.ipnsObj.signer.address) resolvesOfThisName++;
                        return originalResolve(name, options);
                    });
                    await sleep(5000);
                    expect(
                        resolvesOfThisName,
                        "with no push channel the loop must keep the 1s poll, not park at the safety-net interval"
                    ).to.be.within(3, 8);

                    const newerRecord = JSON.parse(JSON.stringify(staticRecord.communityRecord)) as typeof staticRecord.communityRecord;
                    newerRecord.updatedAt = Math.max(newerRecord.updatedAt + 1, timestamp());
                    newerRecord.signature = await signCommunity({ community: newerRecord, signer: staticRecord.ipnsObj.signer });
                    const delivered = new Promise<void>((resolve) => {
                        const onUpdate = () => {
                            if (community.updatedAt !== newerRecord.updatedAt) return;
                            community.removeListener("update", onUpdate);
                            resolve();
                        };
                        community.on("update", onUpdate);
                    });
                    await staticRecord.ipnsObj.publishToIpns(JSON.stringify(newerRecord));
                    await Promise.race([delivered, sleep(15_000)]);
                    expect(community.updatedAt, "the 1s poll must still deliver a newer record promptly").to.equal(newerRecord.updatedAt);
                    await community.stop();
                } finally {
                    resolveSpy?.mockRestore();
                    subscribeSpy.mockRestore();
                    await noPushPkc.destroy();
                }
            },
            120_000
        );

        // The adapter behind KuboRpcClient.ipnsRecordArrivals, driven by a fake kubo-rpc-client
        // pubsub so its lifecycle is deterministic: one RPC stream per topic shared by every
        // listener, delivery parsed and fanned out, a dead stream reported (never silently
        // re-subscribed — the namesys join hazard), a failed establishment surfaced, destroy.
        (isKuboResolver ? describe : describe.skip)("kubo ipnsRecordArrivals adapter", () => {
            type FakeHandler = (message: { data: Uint8Array; topic: string }) => void;
            const makeFakeKuboPubsub = () => {
                const streams = new Map<string, { handler: FakeHandler; onError: (err: Error) => void }>();
                const subscribe = vi.fn(
                    async (topic: string, handler: FakeHandler, options?: { onError?: (err: Error) => void }): Promise<void> => {
                        streams.set(topic, { handler, onError: options?.onError ?? (() => {}) });
                    }
                );
                const unsubscribe = vi.fn(async (topic: string): Promise<void> => {
                    streams.delete(topic);
                });
                const client = { pubsub: { subscribe, unsubscribe } } as unknown as Parameters<
                    typeof createKuboIpnsRecordArrivals
                >[0]["kuboRpcClient"];
                return { client, streams, subscribe, unsubscribe };
            };
            const TOPIC = "/record/fake-topic";
            const flush = () => sleep(50); // delivery parses through a lazily imported module

            it("shares one RPC stream per topic across listeners and cancels it with the last one", async () => {
                const { client, subscribe, unsubscribe } = makeFakeKuboPubsub();
                const arrivals = createKuboIpnsRecordArrivals({ kuboRpcClient: client, kuboRpcClientUrl: "fake" });
                const listenerA = vi.fn();
                const listenerB = vi.fn();
                await arrivals.subscribe({ pubsubTopic: TOPIC, listener: listenerA });
                await arrivals.subscribe({ pubsubTopic: TOPIC, listener: listenerB });
                expect(subscribe.mock.calls.length, "two listeners on one topic must share one RPC stream").to.equal(1);
                expect(arrivals.isSubscribed?.({ pubsubTopic: TOPIC })).to.equal(true);
                arrivals.unsubscribe({ pubsubTopic: TOPIC, listener: listenerA });
                await flush();
                expect(unsubscribe.mock.calls.length, "the stream must survive while a listener remains").to.equal(0);
                expect(arrivals.isSubscribed?.({ pubsubTopic: TOPIC })).to.equal(true);
                arrivals.unsubscribe({ pubsubTopic: TOPIC, listener: listenerB });
                await flush();
                expect(unsubscribe.mock.calls.length, "the last listener leaving must cancel the RPC stream").to.equal(1);
                expect(arrivals.isSubscribed?.({ pubsubTopic: TOPIC })).to.equal(false);
            });

            it("parses a delivered record and fans it out to every listener, ignoring unparsable messages", async () => {
                const { client, streams } = makeFakeKuboPubsub();
                const arrivals = createKuboIpnsRecordArrivals({ kuboRpcClient: client, kuboRpcClientUrl: "fake" });
                const listenerA = vi.fn();
                const listenerB = vi.fn();
                await arrivals.subscribe({ pubsubTopic: TOPIC, listener: listenerA });
                await arrivals.subscribe({ pubsubTopic: TOPIC, listener: listenerB });
                const stream = streams.get(TOPIC)!;
                stream.handler({ data: new TextEncoder().encode("not an ipns record"), topic: TOPIC });
                await flush();
                expect(listenerA.mock.calls.length, "garbage on the topic must not reach listeners").to.equal(0);

                const value = "/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
                const record = await createIPNSRecord(await generateKeyPair("Ed25519"), value, 1n, 60_000);
                stream.handler({ data: marshalIPNSRecord(record), topic: TOPIC });
                await flush();
                expect(listenerA.mock.calls.length).to.equal(1);
                expect(listenerB.mock.calls.length).to.equal(1);
                expect(listenerA.mock.calls[0][0].pubsubTopic).to.equal(TOPIC);
                expect(listenerA.mock.calls[0][0].record.value).to.equal(value);
            });

            it("a throwing listener does not starve the other listeners of the shared topic", async () => {
                const { client, streams } = makeFakeKuboPubsub();
                const arrivals = createKuboIpnsRecordArrivals({ kuboRpcClient: client, kuboRpcClientUrl: "fake" });
                const throwingListener = vi.fn(() => {
                    throw new Error("simulated listener failure");
                });
                const listenerB = vi.fn();
                await arrivals.subscribe({ pubsubTopic: TOPIC, listener: throwingListener });
                await arrivals.subscribe({ pubsubTopic: TOPIC, listener: listenerB });
                const value = "/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
                const record = await createIPNSRecord(await generateKeyPair("Ed25519"), value, 1n, 60_000);
                streams.get(TOPIC)!.handler({ data: marshalIPNSRecord(record), topic: TOPIC });
                await flush();
                expect(throwingListener.mock.calls.length).to.equal(1);
                expect(listenerB.mock.calls.length, "the listener after the throwing one must still get the record").to.equal(1);
                expect(listenerB.mock.calls[0][0].record.value).to.equal(value);
            });

            it("reports a dead stream through isSubscribed and never re-subscribes on its own (namesys join hazard)", async () => {
                const { client, streams, subscribe, unsubscribe } = makeFakeKuboPubsub();
                const arrivals = createKuboIpnsRecordArrivals({ kuboRpcClient: client, kuboRpcClientUrl: "fake" });
                const listener = vi.fn();
                await arrivals.subscribe({ pubsubTopic: TOPIC, listener });
                streams.get(TOPIC)!.onError(new Error("simulated: daemon restarted"));
                await flush();
                expect(arrivals.isSubscribed?.({ pubsubTopic: TOPIC }), "a dead stream must read as not subscribed").to.equal(false);
                expect(unsubscribe.mock.calls.length, "the dead stream's client-side subscription must be released").to.equal(1);
                expect(
                    subscribe.mock.calls.length,
                    "the adapter must NOT re-subscribe by itself: only the update loop may, after a resolve re-joined namesys"
                ).to.equal(1);
                // The loop re-arms after re-walking the name: a new subscribe establishes a new stream.
                await arrivals.subscribe({ pubsubTopic: TOPIC, listener });
                expect(subscribe.mock.calls.length).to.equal(2);
                expect(arrivals.isSubscribed?.({ pubsubTopic: TOPIC })).to.equal(true);
            });

            it("surfaces a failed establishment to the caller and stays unsubscribed, retrying on the next subscribe", async () => {
                const { client, subscribe } = makeFakeKuboPubsub();
                subscribe.mockRejectedValueOnce(new Error("simulated: pubsub disabled"));
                const arrivals = createKuboIpnsRecordArrivals({ kuboRpcClient: client, kuboRpcClientUrl: "fake" });
                const listener = vi.fn();
                await expect(arrivals.subscribe({ pubsubTopic: TOPIC, listener })).rejects.toThrow("pubsub disabled");
                expect(arrivals.isSubscribed?.({ pubsubTopic: TOPIC })).to.equal(false);
                await arrivals.subscribe({ pubsubTopic: TOPIC, listener });
                expect(subscribe.mock.calls.length, "a later subscribe must try to establish again").to.equal(2);
                expect(arrivals.isSubscribed?.({ pubsubTopic: TOPIC })).to.equal(true);
            });

            it("destroy cancels every stream", async () => {
                const { client, unsubscribe } = makeFakeKuboPubsub();
                const arrivals = createKuboIpnsRecordArrivals({ kuboRpcClient: client, kuboRpcClientUrl: "fake" });
                await arrivals.subscribe({ pubsubTopic: TOPIC, listener: vi.fn() });
                await arrivals.subscribe({ pubsubTopic: `${TOPIC}-2`, listener: vi.fn() });
                await arrivals.destroy();
                expect(unsubscribe.mock.calls.map(([topic]) => topic).sort()).to.deep.equal([TOPIC, `${TOPIC}-2`].sort());
                expect(arrivals.isSubscribed?.({ pubsubTopic: TOPIC })).to.equal(false);
            });
        });
    });
});

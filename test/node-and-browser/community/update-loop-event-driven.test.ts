import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { getAvailablePKCConfigsToTestAgainst, publishCommunityRecordWithExtraProp } from "../../../dist/node/test/test-util.js";
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
                return community._clientsManager as unknown as ManagerParkInternals;
            };
            const CID_A = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
            const CID_B = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

            it("an arrival consumed by the update cycle it woke does not fast-return the park (issue #308)", async () => {
                const manager = await makeIdleManager();
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
                const manager = await makeIdleManager();
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
                const manager = await makeIdleManager();
                manager._onIpnsRecordArrival({ pubsubTopic: "/record/test", record: { value: "/ipns/someintermediatehopname" } });
                const parkStartedAt = Date.now();
                await manager._sleepUntilIpnsArrivalOrTimeoutOrAbort(10_000);
                expect(Date.now() - parkStartedAt, "a newer delegated-chain hop record always warrants an immediate walk").to.be.below(
                    2000
                );
            });
        });

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
    });
});

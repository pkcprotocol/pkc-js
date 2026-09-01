import { describe, it, beforeAll, afterAll, expect } from "vitest";
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
            pkc = await config.pkcInstancePromise();
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

        it("a newer record published while updating is still delivered", async () => {
            const { community, staticRecord } = await startUpdatingStaticCommunityAndAwaitFirstUpdate();

            const newerRecord = JSON.parse(JSON.stringify(staticRecord.communityRecord)) as typeof staticRecord.communityRecord;
            newerRecord.updatedAt = Math.max(newerRecord.updatedAt + 1, timestamp());
            newerRecord.signature = await signCommunity({ community: newerRecord, signer: staticRecord.ipnsObj.signer });

            const delivered = new Promise<void>((resolve) => {
                const onUpdate = () => {
                    if (community.updatedAt === newerRecord.updatedAt) {
                        community.removeListener("update", onUpdate);
                        resolve();
                    }
                };
                community.on("update", onUpdate);
            });
            await staticRecord.ipnsObj.publishToIpns(JSON.stringify(newerRecord));

            // On master the 1s polling loop delivers this within a couple of seconds. After
            // the fix delivery rides the gossipsub push channel (or, if the push is missed,
            // the safety-net poll), so allow one full jittered safety-net period.
            let deliveredInTime = true;
            const timer = sleep(120_000).then(() => {
                deliveredInTime = false;
            });
            await Promise.race([delivered, timer]);
            expect(deliveredInTime, "the newer community record must reach the updating community").to.equal(true);
        }, 180_000);
    });
});

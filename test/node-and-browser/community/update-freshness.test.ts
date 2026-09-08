import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { getAvailablePKCConfigsToTestAgainst, publishCommunityRecordWithExtraProp } from "../../../dist/node/test/test-util.js";
import { signCommunity } from "../../../dist/node/signer/signatures.js";
import { timestamp } from "../../../dist/node/util.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

// Transport-agnostic freshness pins for the community update loop.
//
// Everything else in the suite that checks "did the subscriber see the change" waits on
// resolveWhenConditionIsTrue, which has no internal timeout and is bounded only by the 120s
// vitest default. That answers "does it arrive at all" and says nothing about how fast, or
// about whether updatedAt can go backwards. Two properties that no other test pins:
//
//   1. Delivery is FAST. After PR #311 the libp2p-js loop parks on gossip pushes with a slow
//      jittered safety-net poll, so a broken push channel degrades update latency from ~20ms
//      to a minute or more WITHOUT failing any functional test: the safety net still delivers,
//      just late. A latency bound is the only thing that separates "push works" from "push is
//      dead and the safety net is carrying us".
//   2. updatedAt never goes backwards, and consecutive generations each land. Strict
//      monotonicity was previously asserted only on LOCAL communities
//      (test/node/community/update.community.test.ts); on the remote subscriber path
//      update.community.test.ts only asserted `!==`, so a community that regressed to an older
//      record would have passed.
//
// Both properties are transport-independent, so this suite runs against BOTH the libp2p-js
// (helia) and kubo-RPC resolvers. They deliver by different mechanisms — gossip push for
// libp2p-js, a 1s poll for kubo-RPC (src/community/community-client-manager.ts) — but the
// observable contract is the same, and pinning it on both is what stops the two paths from
// silently diverging.
//
// Gateways are excluded on purpose: they poll at pkc.updateInterval by design, which this
// suite pins to the production 60s, so a sub-25s delivery bound does not describe them.
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-libp2pjs", "remote-kubo-rpc"] }).map((config) => {
    describe(`community update freshness - ${config.name}`, () => {
        let pkc: PKCType;
        const communitiesToStop: RemoteCommunity[] = [];
        const staticRecordsToCleanUp: Awaited<ReturnType<typeof publishCommunityRecordWithExtraProp>>[] = [];

        // The production default. test-util's mockPKC defaults to updateInterval: 500, which on
        // the libp2p-js path makes the safety net poll twice a second — that masks a dead push
        // channel completely and would make the latency bound below meaningless.
        const PRODUCTION_UPDATE_INTERVAL_MS = 60_000;

        // Generous enough for delivery on a loaded CI runner, and still under the fallback
        // path: the libp2p-js safety net cannot fire before updateInterval * 0.75 = 45s. So a
        // delivery inside this budget can only have come from the push channel on libp2p-js,
        // or from the 1s poll on kubo-RPC. Always measured from AFTER the publish (see
        // awaitUpdatedAtWithin's callers): publish overhead on a loaded runner must eat into
        // neither the budget nor the safety-net margin.
        const DELIVERY_BUDGET_MS = 25_000;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise({ pkcOptions: { updateInterval: PRODUCTION_UPDATE_INTERVAL_MS } });
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

        // Each call publishes a fresh static record under a fresh IPNS key, so every test drives
        // its own update loop instead of attaching as a mirror to a loop another test started.
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

        // Mint and publish the next generation of a static community record: a strictly greater
        // updatedAt, re-signed, so it lands under a different CID (an unchanged CID is dropped by
        // the loop's _updateCidsAlreadyLoaded filter and would never produce an update event).
        const publishNextGeneration = async ({
            staticRecord,
            previousUpdatedAt
        }: {
            staticRecord: Awaited<ReturnType<typeof publishCommunityRecordWithExtraProp>>;
            previousUpdatedAt: number;
        }) => {
            const nextRecord = JSON.parse(JSON.stringify(staticRecord.communityRecord)) as typeof staticRecord.communityRecord;
            nextRecord.updatedAt = Math.max(previousUpdatedAt + 1, timestamp());
            nextRecord.signature = await signCommunity({ community: nextRecord, signer: staticRecord.ipnsObj.signer });
            await staticRecord.ipnsObj.publishToIpns(JSON.stringify(nextRecord));
            return nextRecord;
        };

        // Resolve once the community reaches `targetUpdatedAt`, or after `budgetMs`. The losing
        // timer is always cleared so no long handle outlives the test, and the listener is always
        // detached (issue #145's pattern applied to the test side).
        const awaitUpdatedAtWithin = async ({
            community,
            targetUpdatedAt,
            budgetMs
        }: {
            community: RemoteCommunity;
            targetUpdatedAt: number;
            budgetMs: number;
        }) => {
            const startedAt = Date.now();
            let timer: ReturnType<typeof setTimeout> | undefined;
            let onUpdate!: () => void;
            const delivered = new Promise<boolean>((resolve) => {
                onUpdate = () => {
                    if (community.updatedAt === targetUpdatedAt) resolve(true);
                };
                community.on("update", onUpdate);
                if (community.updatedAt === targetUpdatedAt) resolve(true); // may already have landed
                timer = setTimeout(() => resolve(false), budgetMs);
            });
            const deliveredInTime = await delivered;
            clearTimeout(timer);
            community.removeListener("update", onUpdate);
            return { deliveredInTime, elapsedMs: Date.now() - startedAt };
        };

        it("a newer record reaches an updating community well inside the safety-net period", async () => {
            const { community, staticRecord } = await startUpdatingStaticCommunityAndAwaitFirstUpdate();
            const previousUpdatedAt = community.updatedAt!;

            // The budget clock starts AFTER the publish (matching the generations test below):
            // publishNextGeneration does addStringToIpfs plus a retried name.publish plus the
            // helper's verify-resolve poll, so a budget started before it can go zero or
            // negative on a loaded runner and fail here blaming the push channel when delivery
            // was never given a chance. A record that lands before publishToIpns even returns
            // is caught by awaitUpdatedAtWithin's immediate updatedAt check, so nothing is
            // missed by starting late.
            const newerRecord = await publishNextGeneration({ staticRecord, previousUpdatedAt });
            const { deliveredInTime, elapsedMs } = await awaitUpdatedAtWithin({
                community,
                targetUpdatedAt: newerRecord.updatedAt,
                budgetMs: DELIVERY_BUDGET_MS
            });

            expect(
                deliveredInTime,
                `a newer community record must reach the updating community within ${DELIVERY_BUDGET_MS}ms of being published (took over ${elapsedMs}ms); on the libp2p-js path a miss here means the gossip push channel is dead and only the safety-net poll is delivering (issue #308)`
            ).to.equal(true);
        }, 240_000);

        it("consecutive record generations each arrive and updatedAt never goes backwards", async () => {
            const { community, staticRecord } = await startUpdatingStaticCommunityAndAwaitFirstUpdate();

            // Every update event's updatedAt, for the backwards check. Not every event carries a
            // new record (a background name resolution emits one too), so the invariant across
            // the whole stream is non-decreasing; the strict increase is asserted per generation.
            const observedUpdatedAts: number[] = [];
            const recordObserved = () => {
                if (typeof community.updatedAt === "number") observedUpdatedAts.push(community.updatedAt);
            };
            community.on("update", recordObserved);
            recordObserved();

            try {
                let previousUpdatedAt = community.updatedAt!;
                const generations = 3;
                for (let generation = 1; generation <= generations; generation++) {
                    const nextRecord = await publishNextGeneration({ staticRecord, previousUpdatedAt });
                    const { deliveredInTime } = await awaitUpdatedAtWithin({
                        community,
                        targetUpdatedAt: nextRecord.updatedAt,
                        budgetMs: DELIVERY_BUDGET_MS
                    });
                    expect(
                        deliveredInTime,
                        `generation ${generation} of ${generations} must reach the updating community; a loop that delivers the first change and then stops waking is exactly the #308 regression this pins`
                    ).to.equal(true);
                    expect(
                        community.updatedAt,
                        `generation ${generation} must strictly advance updatedAt (was ${previousUpdatedAt})`
                    ).to.be.greaterThan(previousUpdatedAt);
                    previousUpdatedAt = community.updatedAt!;
                }

                for (let i = 1; i < observedUpdatedAts.length; i++)
                    expect(
                        observedUpdatedAts[i],
                        `updatedAt must never go backwards on an updating community; saw [${observedUpdatedAts.join(", ")}]`
                    ).to.be.at.least(observedUpdatedAts[i - 1]);
            } finally {
                community.removeListener("update", recordObserved);
            }
        }, 300_000);
    });
});

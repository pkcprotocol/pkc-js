import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { getAvailablePKCConfigsToTestAgainst, publishCommunityRecordWithExtraProp } from "../../../dist/node/test/test-util.js";
import { signCommunity } from "../../../dist/node/signer/signatures.js";
import { timestamp } from "../../../dist/node/util.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

// Gateway companion to update-freshness.test.ts, pinning the freshness contract that suite
// deliberately excludes gateways from. Reproduction for issue #328: the ipfs-gateway resolver
// is the last update path with no push signal at all, so a gateway-backed reader learns about
// a new community record only on its next pkc.updateInterval tick (60s in production).
//
// The mechanism is startUpdatingLoop in src/community/community-client-manager.ts:
//
//     const updateInterval = areWeConnectedToKuboOrHelia ? 1000 : this._pkc.updateInterval;
//
// where areWeConnectedToKuboOrHelia counts only clients.kuboRpcClients and
// clients.libp2pJsClients. clients.pubsubKuboRpcClients is a separate map, so the normal
// production browser shape (gateways for content, a pubsub kubo RPC provider to publish)
// still lands in the slow branch even though the client holds a pubsub transport that could
// carry the community's IPNS record topic as a wake signal. The suite asserts that shape
// explicitly below so the pin describes the client issue #328 is about.
//
// The assertion mirrors update-freshness.test.ts: production updateInterval, and a delivery
// bound that separates "a wake signal delivered this" from "the updateInterval poll delivered
// this". The budget must sit far below the 60s poll and comfortably above what a push-driven
// delivery can cost on a loaded runner, including the test daemons' gateway-side IPNS cache
// (Ipns.MaxCacheTTL is 10s in test/server/test-server.js). 25s, the same bound the libp2p-js
// and kubo-RPC paths are held to, satisfies both.
//
// Unlike the sibling suite, delivery is awaited well past the poll tick and the elapsed time
// is asserted afterwards, so the failure reports the actual propagation delay (expected ~60s
// today) instead of just "did not arrive within budget".
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe(`community update freshness over gateways - ${config.name}`, () => {
        let pkc: PKCType;
        const communitiesToStop: RemoteCommunity[] = [];
        const staticRecordsToCleanUp: Awaited<ReturnType<typeof publishCommunityRecordWithExtraProp>>[] = [];

        // The production default. test-util's mockPKC defaults to updateInterval: 500, which
        // makes the gateway poll fire twice a second and would mask the missing wake signal
        // completely.
        const PRODUCTION_UPDATE_INTERVAL_MS = 60_000;

        // See the header: below the 60s poll with margin, above worst-case push-driven
        // delivery plus the 10s gateway IPNS cache, and equal to the bound the other two
        // transports are pinned to in update-freshness.test.ts.
        const DELIVERY_BUDGET_MS = 25_000;

        // How long to wait for the record to arrive at all before giving up on measuring: past
        // the poll tick at updateInterval plus the gateway cache and a loaded-runner margin, so
        // today's failure carries the measured delay instead of a timeout.
        const DELIVERY_MEASUREMENT_CUTOFF_MS = 110_000;

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

        // Same helpers as update-freshness.test.ts: a fresh static record under a fresh IPNS
        // key per test, so the test drives its own update loop.
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
        // timer is always cleared and the listener always detached (issue #145's pattern).
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

        it("gateway reader holds a pubsub provider that could carry a wake signal (the #328 shape)", async () => {
            expect(Object.keys(pkc.clients.ipfsGateways).length).to.be.greaterThan(0);
            expect(Object.keys(pkc.clients.kuboRpcClients).length).to.equal(0);
            expect(Object.keys(pkc.clients.libp2pJsClients).length).to.equal(0);
            expect(
                Object.keys(pkc.clients.pubsubKuboRpcClients).length,
                "the production gateway shape carries a pubsub provider for publishing; issue #328 is that it is not used as an update wake signal"
            ).to.be.greaterThan(0);
        });

        it("a newer record reaches a gateway-backed updating community well inside the updateInterval poll period", async () => {
            const { community, staticRecord } = await startUpdatingStaticCommunityAndAwaitFirstUpdate();
            const previousUpdatedAt = community.updatedAt!;

            // The budget clock starts AFTER the publish, matching update-freshness.test.ts:
            // publishToIpns includes a verify-resolve poll, and publish overhead on a loaded
            // runner must not eat into the delivery budget.
            const newerRecord = await publishNextGeneration({ staticRecord, previousUpdatedAt });
            const { deliveredInTime, elapsedMs } = await awaitUpdatedAtWithin({
                community,
                targetUpdatedAt: newerRecord.updatedAt,
                budgetMs: DELIVERY_MEASUREMENT_CUTOFF_MS
            });

            expect(
                deliveredInTime,
                `the newer community record never arrived at all within ${DELIVERY_MEASUREMENT_CUTOFF_MS}ms, which is past the updateInterval poll tick; that is a delivery failure, not the #328 latency gap`
            ).to.equal(true);
            expect(
                elapsedMs,
                `a newer community record must reach a gateway-backed updating community within ${DELIVERY_BUDGET_MS}ms of being published, took ${elapsedMs}ms; a delay at ~updateInterval (${PRODUCTION_UPDATE_INTERVAL_MS}ms) means no wake signal exists for gateway readers and the poll is the only delivery mechanism (issue #328)`
            ).to.be.at.most(DELIVERY_BUDGET_MS);
        }, 240_000);
    });
});

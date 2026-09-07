import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { getAvailablePKCConfigsToTestAgainst, publishCommunityRecordWithExtraProp } from "../../../dist/node/test/test-util.js";
import { signCommunity } from "../../../dist/node/signer/signatures.js";
import { timestamp } from "../../../dist/node/util.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

// Gateway companion to update-freshness.test.ts, pinning the freshness contract that suite
// deliberately excludes gateways from. Regression pin for issue #328: gateway readers used to
// learn about a new community record only on their next flat pkc.updateInterval tick (60s in
// production; this suite measured 59994ms pre-fix). The fix paces the gateway poll on the
// Cache-Control max-age countdown the gateway itself advertises (the remaining ttl of the
// record in its cache, an exact countdown per the path-gateway spec: see
// docs/protocol/README.md's external-specs link), with a working RFC 9110 If-None-Match so an
// unchanged tick costs a bodyless 304.
//
// Delivery for a gateway reader is therefore bounded by poll pacing + the gateway's own IPNS
// cache window (Ipns.MaxCacheTTL is 10s in test/server/test-server.js), NOT by
// pkc.updateInterval, which this suite pins at the production 60s precisely so a regression to
// interval-paced polling fails loudly. Budget: ~10s pacing + ~10s gateway cache + loaded-CI
// margin = 30s, still half the updateInterval poll it must never regress to.
//
// Unlike the sibling suite, delivery is awaited well past the old poll tick and the elapsed
// time is asserted afterwards, so a failure reports the actual propagation delay (an
// interval-paced regression shows up as ~60000ms) instead of just "did not arrive within
// budget".
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe(`community update freshness over gateways - ${config.name}`, () => {
        let pkc: PKCType;
        const communitiesToStop: RemoteCommunity[] = [];
        const staticRecordsToCleanUp: Awaited<ReturnType<typeof publishCommunityRecordWithExtraProp>>[] = [];

        // The production default. test-util's mockPKC defaults to updateInterval: 500, which
        // (as the pacing ceiling) makes the gateway poll fire twice a second and would mask an
        // interval-paced regression completely.
        const PRODUCTION_UPDATE_INTERVAL_MS = 60_000;

        // See the header: pacing + gateway cache + margin, and still far below the 60s
        // interval-paced poll this must never regress to.
        const DELIVERY_BUDGET_MS = 30_000;

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

        it("the suite runs against the gateway-only reader shape #328 is about", async () => {
            expect(Object.keys(pkc.clients.ipfsGateways).length).to.be.greaterThan(0);
            expect(Object.keys(pkc.clients.kuboRpcClients).length).to.equal(0);
            expect(Object.keys(pkc.clients.libp2pJsClients).length).to.equal(0);
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
                `a newer community record must reach a gateway-backed updating community within ${DELIVERY_BUDGET_MS}ms of being published, took ${elapsedMs}ms; a delay at ~updateInterval (${PRODUCTION_UPDATE_INTERVAL_MS}ms) means the gateway poll regressed to interval pacing instead of the max-age countdown (issue #328)`
            ).to.be.at.most(DELIVERY_BUDGET_MS);
        }, 240_000);
    });
});

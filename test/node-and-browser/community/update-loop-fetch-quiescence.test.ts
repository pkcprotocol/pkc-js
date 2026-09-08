import { describe, it, afterAll, expect, onTestFinished, vi } from "vitest";
import { getAvailablePKCConfigsToTestAgainst, publishCommunityRecordWithExtraProp } from "../../../dist/node/test/test-util.js";
import { signCommunity } from "../../../dist/node/signer/signatures.js";
import { timestamp } from "../../../dist/node/util.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

// Issue #330 steady-state pin for the UPDATE LOOP (the resolver-level behavior is pinned in
// test/node/helia/ipns-push-channel-watchdog.unit.test.ts): an updating community whose push
// channel is healthy (the serving daemon is subscribed to the record topic and a valid record
// arrived within the watchdog window) must make ZERO IPNS fetch-protocol calls at steady state.
//
// This pins the update-loop half of the fix specifically: the issue #308/#311 loop forces
// `nocache: true` on every safety-net-timer wake (bounded by the 30s revalidation floor),
// which bypasses the resolver's cache gate entirely — so serving from cache while healthy is
// not enough; the loop must also skip the forced revalidation while the watchdog can vouch for
// the channel. Written red-first: with only the resolver half in place this test still failed
// (one forced fetch per 30s floor window per name, the exact per-minute churn the PR #331
// 5-minute benchmark measured as unchanged).
//
// The measurement window spans the 30s forced-revalidation floor so a forced tick MUST land
// inside it if the loop still forces; the ending publish proves the quiescent loop is parked on
// a live push channel rather than dead.
//
// libp2p-js only: the kubo-RPC resolver polls kubo's own namesys (always nocache) by design.
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-libp2pjs"] }).map((config) => {
    describe(`update loop fetch quiescence (issue #330) - ${config.name}`, () => {
        let pkc: PKCType;
        const communitiesToStop: RemoteCommunity[] = [];
        const staticRecordsToCleanUp: Awaited<ReturnType<typeof publishCommunityRecordWithExtraProp>>[] = [];

        afterAll(async () => {
            for (const community of communitiesToStop.splice(0)) {
                try {
                    await community.stop();
                } catch {
                    // already stopped
                }
            }
            for (const staticRecord of staticRecordsToCleanUp.splice(0)) await staticRecord.ipnsObj.pkc.destroy();
            if (pkc) await pkc.destroy();
        });

        const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

        // Above the forced-revalidation floor divided by anything: with a 1s safety-net period
        // the loop ticks ~26-52 times in the window, and the 30s floor guarantees at least one
        // of those ticks is ARMED to force the network — if the loop still forces at all.
        const UPDATE_INTERVAL_MS = 1_000;
        const QUIESCENCE_WINDOW_MS = 35_000;
        const DELIVERY_BUDGET_MS = 25_000;

        it("safety-net ticks make zero IPNS fetch calls while the push channel is healthy (issue #330)", async () => {
            pkc = await config.pkcInstancePromise({ pkcOptions: { updateInterval: UPDATE_INTERVAL_MS } });
            const staticRecord = await publishCommunityRecordWithExtraProp();
            staticRecordsToCleanUp.push(staticRecord);

            const community = (await pkc.createCommunity({ address: staticRecord.ipnsObj.signer.address })) as RemoteCommunity;
            communitiesToStop.push(community);
            const firstUpdate = new Promise<void>((resolve) => community.once("update", () => resolve()));
            await community.update();
            await firstUpdate;

            // Let the first-update tail (warmup dials, retried fetches) settle before measuring.
            await sleep(3_000);

            const libp2pJsClient = pkc.clients.libp2pJsClients[Object.keys(pkc.clients.libp2pJsClients)[0]];
            const fetchService = libp2pJsClient._helia.libp2p.services.fetch;
            let fetchCalls = 0;
            const originalFetch = fetchService.fetch.bind(fetchService);
            const fetchSpy = vi.spyOn(fetchService, "fetch").mockImplementation((...args) => {
                fetchCalls++;
                return originalFetch(...args);
            });
            onTestFinished(() => fetchSpy.mockRestore());

            await sleep(QUIESCENCE_WINDOW_MS);
            expect(
                fetchCalls,
                `an updating community with a healthy push channel must make ZERO IPNS fetch calls at steady state; ` +
                    `${fetchCalls} calls in ${QUIESCENCE_WINDOW_MS}ms means the safety-net tick still forces a network revalidation ` +
                    `the watchdog should have vouched away (issue #330)`
            ).to.equal(0);

            // The quiescent loop must still be ALIVE: a newer record published now must arrive
            // over the push channel well inside the delivery budget (same bound as
            // update-freshness.test.ts), proving the zero above is a parked loop on a healthy
            // channel, not a dead one.
            const nextRecord = JSON.parse(JSON.stringify(staticRecord.communityRecord)) as typeof staticRecord.communityRecord;
            nextRecord.updatedAt = Math.max(community.updatedAt! + 1, timestamp());
            nextRecord.signature = await signCommunity({ community: nextRecord, signer: staticRecord.ipnsObj.signer });
            let onUpdate!: () => void;
            let timer: ReturnType<typeof setTimeout> | undefined;
            const delivered = new Promise<boolean>((resolve) => {
                onUpdate = () => {
                    if (community.updatedAt === nextRecord.updatedAt) resolve(true);
                };
                community.on("update", onUpdate);
                timer = setTimeout(() => resolve(false), DELIVERY_BUDGET_MS);
            });
            await staticRecord.ipnsObj.publishToIpns(JSON.stringify(nextRecord));
            const deliveredInTime = await delivered;
            clearTimeout(timer);
            community.removeListener("update", onUpdate);
            expect(deliveredInTime, "the quiescent loop must still consume a pushed newer record within the delivery budget").to.equal(
                true
            );
        }, 180_000);
    });
});

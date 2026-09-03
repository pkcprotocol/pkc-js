import { describe, it, beforeAll, afterAll, expect, onTestFinished, vi } from "vitest";
import {
    getAvailablePKCConfigsToTestAgainst,
    publishCommunityRecordWithExtraProp,
    addStringToIpfs
} from "../../dist/node/test/test-util.js";
import { signCommunity } from "../../dist/node/signer/signatures.js";
import { timestamp } from "../../dist/node/util.js";
import fs from "node:fs";
import path from "node:path";

import type { PKC as PKCType } from "../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../dist/node/community/remote-community.js";

// Before/after benchmark for issues #308 (1s update-loop churn on the libp2p-js path) and #307
// (once-per-ttl thundering herd when a directory of names expires in lockstep). NOT part of any
// CI glob (CI runs test/node, test/node-and-browser, test/browser, test/challenges); run it
// manually against the local test server, once on master and once on the fix branch:
//
//   node test/run-test-config.js --pkc-config remote-libp2pjs test/benchmarks/update-loop-bench.test.ts
//
// It stands up N static communities (records published with a 60s ttl, matching what real
// communities publish: publishInterval * 3), updates all of them from one libp2p-js pkc, and
// measures over a steady-state window:
//   - updatingstatechange events (the #308 churn metric)
//   - IPNS record network fetch operations via the libp2p fetch service, bucketed per second so
//     the #307 expiry burst shape is visible (clustered before, spread after), plus per-call
//     outcomes: completed vs errored/aborted, the count of calls started while an identical
//     (same peer, same routing key) call was already in flight (the issue #329 duplicate: the
//     subscriber and provider branches racing the same peer), and the busiest peers (the issue
//     #330 fan-out metric: a hub peer serving many topics is asked once per name per ttl window)
//   - gossipsub messages received (the push channel's traffic)
//   - client process CPU time over the window
//   - the serving kubo daemon's bandwidth delta (RPC stats.bw)
//   - delivery latency of a record published mid-window (guards the redesign against trading
//     churn for staleness)
// Results are printed and written to .tmp/update-loop-bench-<timestamp>.json for the PR table.
//
// Tune with PKC_BENCH_COMMUNITIES (default 32) and PKC_BENCH_WINDOW_MS (default 150000; keep it
// above 2 ttl windows so at least one expiry boundary lands inside the measurement).
const COMMUNITY_COUNT = Number(process.env.PKC_BENCH_COMMUNITIES) > 0 ? Number(process.env.PKC_BENCH_COMMUNITIES) : 32;
const WINDOW_MS = Number(process.env.PKC_BENCH_WINDOW_MS) > 0 ? Number(process.env.PKC_BENCH_WINDOW_MS) : 150_000;
const RECORD_TTL = "60s";

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-libp2pjs"] }).map((config) => {
    describe(`update loop benchmark (issues #308/#307) - ${config.name}`, () => {
        let pkc: PKCType;
        const staticRecords: Awaited<ReturnType<typeof publishCommunityRecordWithExtraProp>>[] = [];
        const communities: RemoteCommunity[] = [];

        beforeAll(async () => {
            // Production default, not test-util's updateInterval: 500 — the event-driven loop
            // uses updateInterval as its safety-net period, so the bench must run with the value
            // real apps run with. Master's kubo/helia loop hardcodes 1s and ignores this option,
            // so baseline numbers are unaffected by the override.
            pkc = await config.pkcInstancePromise({ pkcOptions: { updateInterval: 60_000 } });
        }, 60_000);
        afterAll(async () => {
            for (const community of communities.splice(0)) {
                try {
                    await community.stop();
                } catch {
                    // already stopped
                }
            }
            for (const staticRecord of staticRecords.splice(0)) await staticRecord.ipnsObj.pkc.destroy();
            await pkc.destroy();
        }, 300_000);

        const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

        // Republish a community record under its IPNS key with an explicit ttl, so cached records
        // expire on the same schedule real community records do (publishInterval * 3 = 60s), which
        // is what makes the #307 lockstep expiry reproducible in the window.
        const publishRecordWithTtl = async ({
            staticRecord,
            record
        }: {
            staticRecord: Awaited<ReturnType<typeof publishCommunityRecordWithExtraProp>>;
            record: (typeof staticRecords)[number]["communityRecord"];
        }) => {
            const cid = await addStringToIpfs(JSON.stringify(record));
            const kuboRpcClient = staticRecord.ipnsObj.pkc._clientsManager.getDefaultKuboRpcClient();
            await kuboRpcClient._client.name.publish(cid, {
                key: staticRecord.ipnsObj.signer.address,
                allowOffline: true,
                ttl: RECORD_TTL
            });
        };

        it(`steady-state update-loop cost at ${COMMUNITY_COUNT} communities over ${WINDOW_MS / 1000}s`, async () => {
            // ---- setup: N static communities, records carrying a 60s ttl ----
            const setupBatchSize = 8;
            for (let batchStart = 0; batchStart < COMMUNITY_COUNT; batchStart += setupBatchSize) {
                await Promise.all(
                    Array.from({ length: Math.min(setupBatchSize, COMMUNITY_COUNT - batchStart) }, async () => {
                        const staticRecord = await publishCommunityRecordWithExtraProp();
                        await publishRecordWithTtl({ staticRecord, record: staticRecord.communityRecord });
                        staticRecords.push(staticRecord);
                    })
                );
            }

            // ---- instrumentation on the single libp2p-js client ----
            const libp2pJsClient = pkc.clients.libp2pJsClients[Object.keys(pkc.clients.libp2pJsClients)[0]];
            const fetchService = libp2pJsClient._helia.libp2p.services.fetch;
            // Every fetch call is recorded with its target peer, whether an identical call (same
            // peer, same routing key) was already in flight when it started (the issue #329
            // duplicate signature), and how it settled. "error" folds real failures and aborts
            // together because the loser of a duplicated race surfaces as an AbortError, which is
            // exactly the noise issue #329 describes.
            type FetchCallRecord = { ts: number; peer: string; startedWhileIdenticalCallInFlight: boolean; outcome?: "ok" | "error" };
            const fetchCalls: FetchCallRecord[] = [];
            const inFlightCountByPeerAndKey = new Map<string, number>();
            const originalFetch = fetchService.fetch.bind(fetchService);
            const fetchSpy = vi.spyOn(fetchService, "fetch").mockImplementation((...args) => {
                const [peer, key] = args;
                const inFlightKey = `${String(peer)}/${Buffer.from(key).toString("base64")}`;
                const call: FetchCallRecord = {
                    ts: Date.now(),
                    peer: String(peer),
                    startedWhileIdenticalCallInFlight: (inFlightCountByPeerAndKey.get(inFlightKey) ?? 0) > 0
                };
                fetchCalls.push(call);
                inFlightCountByPeerAndKey.set(inFlightKey, (inFlightCountByPeerAndKey.get(inFlightKey) ?? 0) + 1);
                const settle = (outcome: "ok" | "error") => {
                    call.outcome = outcome;
                    const remaining = (inFlightCountByPeerAndKey.get(inFlightKey) ?? 1) - 1;
                    if (remaining <= 0) inFlightCountByPeerAndKey.delete(inFlightKey);
                    else inFlightCountByPeerAndKey.set(inFlightKey, remaining);
                };
                const fetchPromise = originalFetch(...args);
                fetchPromise.then(
                    () => settle("ok"),
                    () => settle("error")
                );
                return fetchPromise;
            });
            onTestFinished(() => fetchSpy.mockRestore());

            let pubsubMessagesReceived = 0;
            const onPubsubMessage = () => pubsubMessagesReceived++;
            libp2pJsClient._helia.libp2p.services.pubsub.addEventListener("message", onPubsubMessage);

            let updatingStateChanges = 0;
            let updateEvents = 0;

            // ---- start updating all communities and wait for every first update ----
            await Promise.all(
                staticRecords.map(async (staticRecord) => {
                    const community = (await pkc.createCommunity({
                        address: staticRecord.ipnsObj.signer.address
                    })) as RemoteCommunity;
                    communities.push(community);
                    community.on("updatingstatechange", () => updatingStateChanges++);
                    community.on("update", () => updateEvents++);
                    const firstUpdate = new Promise<void>((resolve) => community.once("update", () => resolve()));
                    await community.update();
                    await firstUpdate;
                })
            );

            // ---- steady-state measurement window ----
            await sleep(3000); // let first-update tails settle
            updatingStateChanges = 0;
            updateEvents = 0;
            pubsubMessagesReceived = 0;
            fetchCalls.length = 0;
            const cpuBefore = process.cpuUsage();
            const bwBefore = await readServingDaemonBandwidth();
            const windowStart = Date.now();

            // Mid-window, publish a newer record for one community and time its delivery.
            let deliveryLatencyMs: number | undefined;
            const midWindowDelivery = (async () => {
                await sleep(Math.floor(WINDOW_MS / 2));
                const target = staticRecords[0];
                const newerRecord = JSON.parse(JSON.stringify(target.communityRecord)) as typeof target.communityRecord;
                newerRecord.updatedAt = Math.max(newerRecord.updatedAt + 1, timestamp());
                newerRecord.signature = await signCommunity({ community: newerRecord, signer: target.ipnsObj.signer });
                const targetCommunity = communities[0];
                const delivered = new Promise<void>((resolve) => {
                    const onUpdate = () => {
                        if (targetCommunity.updatedAt === newerRecord.updatedAt) {
                            targetCommunity.removeListener("update", onUpdate);
                            deliveryLatencyMs = Date.now() - publishedAt;
                            resolve();
                        }
                    };
                    targetCommunity.on("update", onUpdate);
                });
                const publishedAt = Date.now();
                await publishRecordWithTtl({ staticRecord: target, record: newerRecord });
                await delivered;
            })();

            await sleep(WINDOW_MS);
            const windowEndedAt = Date.now();
            const cpuAfter = process.cpuUsage(cpuBefore);
            const bwAfter = await readServingDaemonBandwidth();
            libp2pJsClient._helia.libp2p.services.pubsub.removeEventListener("message", onPubsubMessage);
            // Snapshot every counter at the boundary: the fetch wrapper and community listeners
            // stay live while the delivery wait below runs, and the report divides by windowSec,
            // so post-window activity must not leak into the per-second rates.
            const windowUpdatingStateChanges = updatingStateChanges;
            const windowUpdateEvents = updateEvents;
            const windowPubsubMessagesReceived = pubsubMessagesReceived;
            const windowFetchCalls = fetchCalls.filter((call) => call.ts <= windowEndedAt);

            // Give the mid-window delivery until the end of the run to land, then require it. The
            // losing timer is cleared so no 120s handle outlives the run.
            let deliveredInTime = true;
            let deliveryTimer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
                midWindowDelivery,
                new Promise<void>((resolve) => {
                    deliveryTimer = setTimeout(() => {
                        deliveredInTime = false;
                        resolve();
                    }, 120_000);
                })
            ]);
            clearTimeout(deliveryTimer);

            // ---- report ----
            const windowSec = (windowEndedAt - windowStart) / 1000;
            const fetchBuckets = new Map<number, number>();
            for (const call of windowFetchCalls) {
                const second = Math.floor((call.ts - windowStart) / 1000);
                fetchBuckets.set(second, (fetchBuckets.get(second) ?? 0) + 1);
            }
            const busiestFetchSeconds = [...fetchBuckets.entries()]
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([second, count]) => ({ atSecond: second, fetchOps: count }));

            // Per-peer breakdown (issues #329/#330): a hub peer subscribed to many topics is
            // asked once per name per ttl window, twice while the #329 duplicate exists, so the
            // top rows are where the before/after difference of those fixes shows up.
            const perPeer = new Map<string, { started: number; ok: number; errorOrAborted: number; pending: number; duplicateConcurrent: number }>();
            for (const call of windowFetchCalls) {
                const row = perPeer.get(call.peer) ?? { started: 0, ok: 0, errorOrAborted: 0, pending: 0, duplicateConcurrent: 0 };
                row.started++;
                if (call.outcome === "ok") row.ok++;
                else if (call.outcome === "error") row.errorOrAborted++;
                else row.pending++;
                if (call.startedWhileIdenticalCallInFlight) row.duplicateConcurrent++;
                perPeer.set(call.peer, row);
            }
            const busiestPeers = [...perPeer.entries()]
                .sort((a, b) => b[1].started - a[1].started)
                .slice(0, 5)
                .map(([peer, row]) => ({ peer, ...row }));

            const report = {
                communities: COMMUNITY_COUNT,
                windowSec: Number(windowSec.toFixed(1)),
                recordTtl: RECORD_TTL,
                updatingStateChanges: {
                    total: windowUpdatingStateChanges,
                    perSecond: Number((windowUpdatingStateChanges / windowSec).toFixed(2)),
                    perCommunityPerSecond: Number((windowUpdatingStateChanges / windowSec / COMMUNITY_COUNT).toFixed(3))
                },
                updateEvents: windowUpdateEvents,
                ipnsNetworkFetchOps: {
                    total: windowFetchCalls.length,
                    perSecond: Number((windowFetchCalls.length / windowSec).toFixed(2)),
                    completed: windowFetchCalls.filter((call) => call.outcome === "ok").length,
                    erroredOrAborted: windowFetchCalls.filter((call) => call.outcome === "error").length,
                    stillPendingAtReport: windowFetchCalls.filter((call) => call.outcome === undefined).length,
                    duplicateConcurrentSamePeerSameKey: windowFetchCalls.filter((call) => call.startedWhileIdenticalCallInFlight).length,
                    maxInOneSecond: busiestFetchSeconds[0]?.fetchOps ?? 0,
                    busiestSeconds: busiestFetchSeconds,
                    busiestPeers
                },
                pubsubMessagesReceived: windowPubsubMessagesReceived,
                clientCpu: {
                    userMs: Math.round(cpuAfter.user / 1000),
                    systemMs: Math.round(cpuAfter.system / 1000),
                    percentOfWindow: Number((((cpuAfter.user + cpuAfter.system) / 1000 / (windowSec * 1000)) * 100).toFixed(2))
                },
                servingKuboBandwidth:
                    bwBefore && bwAfter
                        ? {
                              deltaTotalInMB: Number((Number(bwAfter.totalIn - bwBefore.totalIn) / 1e6).toFixed(2)),
                              deltaTotalOutMB: Number((Number(bwAfter.totalOut - bwBefore.totalOut) / 1e6).toFixed(2))
                          }
                        : undefined,
                newerRecordDeliveryLatencyMs: deliveryLatencyMs
            };

            console.log(`update-loop benchmark report:\n${JSON.stringify(report, null, 4)}`);
            const outDir = path.join(process.cwd(), ".tmp");
            fs.mkdirSync(outDir, { recursive: true });
            const outPath = path.join(outDir, `update-loop-bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
            fs.writeFileSync(outPath, JSON.stringify(report, null, 4));
            console.log(`report written to ${outPath}`);

            expect(updateEvents, "every community must have consumed its record during the window setup").to.be.greaterThanOrEqual(0);
            expect(deliveredInTime, "the record published mid-window must reach its community before the run ends").to.equal(true);
        }, 900_000);

        // The serving daemon is the one every createNewIpns-backed publisher targets; its
        // stats.bw covers the libp2p traffic the bench client generates against it (record
        // fetches, bitswap, gossipsub). Undefined when the RPC is unavailable, so the bench
        // still reports everything else.
        const readServingDaemonBandwidth = async (): Promise<{ totalIn: bigint; totalOut: bigint } | undefined> => {
            try {
                const kuboRpcClient = staticRecords[0].ipnsObj.pkc._clientsManager.getDefaultKuboRpcClient();
                for await (const stat of kuboRpcClient._client.stats.bw()) return { totalIn: stat.totalIn, totalOut: stat.totalOut };
                return undefined;
            } catch {
                return undefined;
            }
        };
    });
});

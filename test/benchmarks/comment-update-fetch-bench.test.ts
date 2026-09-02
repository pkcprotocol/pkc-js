import { describe, it, beforeAll, afterAll, expect, onTestFinished, vi } from "vitest";
import {
    getAvailablePKCConfigsToTestAgainst,
    publishRandomPost,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue
} from "../../dist/node/test/test-util.js";
import signers from "../fixtures/signers.js";
import fs from "node:fs";
import path from "node:path";

import type { PKC as PKCType } from "../../dist/node/pkc/pkc.js";
import type { Comment } from "../../dist/node/publications/comment/comment.js";
import type { RemoteCommunity } from "../../dist/node/community/remote-community.js";

// Measurement harness for issue #312: the network and compute cost of the comment update
// pipeline for posts whose CommentUpdate does NOT change. NOT part of any CI glob; run manually
// against the local test server:
//
//   node test/run-test-config.js --pkc-config remote-libp2pjs test/benchmarks/comment-update-fetch-bench.test.ts
//
// Comments carry no polling timer (handleUpdateEventFromCommunity runs once per community update
// event); the waste is that each invocation walks <folderCid>/<postCid>/update over the network,
// parses, and signature-verifies for posts that did not change (see issue #312 for the two
// dedupe gaps).
//
// DIFFERENTIAL DESIGN for attribution: the publisher pkc that drives community updates (filler
// posts) lives in the same process, so raw process counters would blame its challenge-exchange
// work on the comment pipeline. The bench therefore runs two equal phases at the same filler
// cadence: phase A with K idle posts updating, phase B with those posts stopped (only the
// community instance still updating). Publisher and community-loop costs appear in both phases
// and cancel; the per-community-update DELTA is what the K idle posts cost.
//
// Metrics per phase, all captured on the measuring libp2p-js client:
//   - postUpdates path walks (cat calls whose path contains a '/') and the bytes their streams
//     actually delivered
//   - total cat calls and bytes (community records included)
//   - process CPU (user+system)
//   - community update events, and how many posts received an actually-newer CommentUpdate
//     WITHIN the phase (the initial CommentUpdate consumption is settled before phase A starts)
const POST_COUNT = Number(process.env.PKC_BENCH_POSTS) > 0 ? Number(process.env.PKC_BENCH_POSTS) : 8;
const PHASE_MS = Number(process.env.PKC_BENCH_PHASE_MS) > 0 ? Number(process.env.PKC_BENCH_PHASE_MS) : 75_000;
const FILLER_INTERVAL_MS = 15_000;

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-libp2pjs"] }).map((config) => {
    describe(`comment update fetch cost benchmark (issue #312) - ${config.name}`, () => {
        let pkc: PKCType;
        let publisherPkc: Awaited<ReturnType<typeof mockPKCNoDataPathWithOnlyKuboClient>>;
        const commentsToStop: Comment[] = [];
        let communityInstance: RemoteCommunity | undefined;

        beforeAll(async () => {
            // Production updateInterval so community updates arrive via gossip push (issue #308),
            // not the test default's 500ms safety-net polling.
            pkc = await config.pkcInstancePromise({ pkcOptions: { updateInterval: 60_000 } });
            publisherPkc = await mockPKCNoDataPathWithOnlyKuboClient({});
        }, 120_000);
        afterAll(async () => {
            for (const comment of commentsToStop.splice(0)) {
                try {
                    await comment.stop();
                } catch {
                    // already stopped
                }
            }
            if (communityInstance)
                try {
                    await communityInstance.stop();
                } catch {
                    // already stopped
                }
            await publisherPkc.destroy();
            await pkc.destroy();
        }, 300_000);

        const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

        it(`attributable cost of ${POST_COUNT} idle updating posts across two ${PHASE_MS / 1000}s phases`, async () => {
            const communityAddress = signers[0].address;

            // ---- instrumentation on the measuring client, before anything updates ----
            const libp2pJsClient = pkc.clients.libp2pJsClients[Object.keys(pkc.clients.libp2pJsClients)[0]];
            const clientFunctions = libp2pJsClient.heliaWithKuboRpcClientFunctions;
            const catCalls: { path: string; bytes: number }[] = [];
            const originalCat = clientFunctions.cat.bind(clientFunctions);
            const catSpy = vi.spyOn(clientFunctions, "cat").mockImplementation((...args) => {
                const call = { path: String(args[0]), bytes: 0 };
                catCalls.push(call);
                const iterable = originalCat(...args);
                // Count the bytes the stream actually delivers, passing chunks through.
                return (async function* () {
                    for await (const chunk of iterable) {
                        call.bytes += chunk.length;
                        yield chunk;
                    }
                })();
            });
            onTestFinished(() => catSpy.mockRestore());

            // ---- setup: K posts, all set updating and settled ----
            const publishedPosts: Comment[] = [];
            for (let i = 0; i < POST_COUNT; i++) publishedPosts.push(await publishRandomPost({ communityAddress, pkc: publisherPkc }));
            let communityUpdateEvents = 0;
            communityInstance = (await pkc.createCommunity({ address: communityAddress })) as RemoteCommunity;
            communityInstance.on("update", () => communityUpdateEvents++);
            await communityInstance.update();
            let newerCommentUpdatesInPhase = 0;
            await Promise.all(
                publishedPosts.map(async (publishedPost) => {
                    const comment = await pkc.createComment({ cid: publishedPost.cid! });
                    commentsToStop.push(comment);
                    await comment.update();
                    // Settle past BOTH update events (CommentIpfs load and the first
                    // CommentUpdate), so phase counters only ever see in-phase changes.
                    await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
                    comment.on("update", () => newerCommentUpdatesInPhase++);
                })
            );
            await sleep(3000);

            // One phase: reset counters, publish fillers at a fixed cadence for PHASE_MS,
            // return what accumulated. Identical mechanics in both phases so the publisher's
            // own cost cancels in the delta.
            const runPhase = async (label: string) => {
                catCalls.length = 0;
                communityUpdateEvents = 0;
                newerCommentUpdatesInPhase = 0;
                const cpuBefore = process.cpuUsage();
                const phaseStart = Date.now();
                while (Date.now() - phaseStart < PHASE_MS - FILLER_INTERVAL_MS) {
                    await sleep(FILLER_INTERVAL_MS);
                    try {
                        await publishRandomPost({ communityAddress, pkc: publisherPkc });
                    } catch (e) {
                        console.error(`${label}: filler post publish failed, continuing`, e);
                    }
                }
                await sleep(Math.max(0, PHASE_MS - (Date.now() - phaseStart)));
                await sleep(3000); // let in-flight handlers drain before reading counters
                const cpu = process.cpuUsage(cpuBefore);
                const walks = catCalls.filter((c) => c.path.includes("/"));
                return {
                    label,
                    phaseSec: Number(((Date.now() - phaseStart) / 1000).toFixed(1)),
                    communityUpdates: communityUpdateEvents,
                    postUpdatesWalks: walks.length,
                    postUpdatesWalkBytes: walks.reduce((sum, c) => sum + c.bytes, 0),
                    totalCatCalls: catCalls.length,
                    totalCatBytes: catCalls.reduce((sum, c) => sum + c.bytes, 0),
                    newerCommentUpdatesInPhase,
                    cpuMs: Math.round((cpu.user + cpu.system) / 1000)
                };
            };

            const withPosts = await runPhase("with-idle-posts");
            for (const comment of commentsToStop.splice(0)) await comment.stop();
            const withoutPosts = await runPhase("without-posts");

            const perUpdate = (metric: number, updates: number) => metric / Math.max(1, updates);
            const attributablePerCommunityUpdate = {
                postUpdatesWalks: Number(
                    (
                        perUpdate(withPosts.postUpdatesWalks, withPosts.communityUpdates) -
                        perUpdate(withoutPosts.postUpdatesWalks, withoutPosts.communityUpdates)
                    ).toFixed(2)
                ),
                postUpdatesWalkKB: Number(
                    (
                        (perUpdate(withPosts.postUpdatesWalkBytes, withPosts.communityUpdates) -
                            perUpdate(withoutPosts.postUpdatesWalkBytes, withoutPosts.communityUpdates)) /
                        1000
                    ).toFixed(2)
                ),
                cpuMs: Number(
                    (
                        perUpdate(withPosts.cpuMs, withPosts.communityUpdates) -
                        perUpdate(withoutPosts.cpuMs, withoutPosts.communityUpdates)
                    ).toFixed(0)
                )
            };

            const report = {
                posts: POST_COUNT,
                fillerIntervalMs: FILLER_INTERVAL_MS,
                withPosts,
                withoutPosts,
                attributablePerCommunityUpdate,
                attributablePerCommunityUpdatePerPost: {
                    postUpdatesWalks: Number((attributablePerCommunityUpdate.postUpdatesWalks / POST_COUNT).toFixed(2)),
                    postUpdatesWalkKB: Number((attributablePerCommunityUpdate.postUpdatesWalkKB / POST_COUNT).toFixed(2)),
                    cpuMs: Number((attributablePerCommunityUpdate.cpuMs / POST_COUNT).toFixed(1))
                }
            };
            console.log(`comment update fetch benchmark report:\n${JSON.stringify(report, null, 4)}`);
            const outDir = path.join(process.cwd(), ".tmp");
            fs.mkdirSync(outDir, { recursive: true });
            const outPath = path.join(outDir, `comment-update-bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
            fs.writeFileSync(outPath, JSON.stringify(report, null, 4));
            console.log(`report written to ${outPath}`);

            expect(withPosts.communityUpdates, "phase A must have community updates").to.be.greaterThan(0);
            expect(withoutPosts.communityUpdates, "phase B must have community updates").to.be.greaterThan(0);
        }, 900_000);
    });
});

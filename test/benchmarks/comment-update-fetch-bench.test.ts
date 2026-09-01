import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
    getAvailablePKCConfigsToTestAgainst,
    publishRandomPost,
    mockPKCNoDataPathWithOnlyKuboClient
} from "../../dist/node/test/test-util.js";
import signers from "../fixtures/signers.js";

import type { PKC as PKCType } from "../../dist/node/pkc/pkc.js";
import type { Comment } from "../../dist/node/publications/comment/comment.js";
import type { RemoteCommunity } from "../../dist/node/community/remote-community.js";

// Measurement harness for the comment-side follow-up to issue #308: how much of the comment
// update pipeline's work is redundant once community updates are push-driven. NOT part of any CI
// glob; run manually against the local test server:
//
//   node test/run-test-config.js --pkc-config remote-libp2pjs test/benchmarks/comment-update-fetch-bench.test.ts
//
// Comments carry no polling timer of their own: handleUpdateEventFromCommunity runs once per
// community update event. The suspected waste is what each such invocation does for a post whose
// CommentUpdate did NOT change:
//   - a post found in the community's preloaded pages with an unchanged updatedAt still falls
//     into useCommunityPostUpdatesToFetchCommentUpdateForPost (the pages hit only short-circuits
//     when the pages copy is strictly NEWER), and
//   - the postUpdates folder-cid dedupe only engages when _commentUpdateIpfsPath was set by a
//     previous postUpdates fetch, which a post served from pages never sets,
// so every community update can cost each updating post a full postUpdates path walk (cat of
// <folderCid>/<postCid>/update), a signature verification, and a discard.
//
// Method: K posts are published to the live test community and set updating on a libp2p-js pkc.
// A filler post is published every FILLER_INTERVAL_MS so the community record keeps changing for
// reasons unrelated to the K posts. Over the window we count community update events, cat() calls
// on the measuring client classified as postUpdates path walks (path contains '/'), how many of
// the K posts ever received an actually-newer CommentUpdate, and comment updatingstatechange
// churn. postUpdates walks per (community update x post) approaching 1 with zero newer
// CommentUpdates is the measured waste.
const POST_COUNT = Number(process.env.PKC_BENCH_POSTS) > 0 ? Number(process.env.PKC_BENCH_POSTS) : 8;
const WINDOW_MS = Number(process.env.PKC_BENCH_WINDOW_MS) > 0 ? Number(process.env.PKC_BENCH_WINDOW_MS) : 120_000;
const FILLER_INTERVAL_MS = 15_000;

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-libp2pjs"] }).map((config) => {
    describe(`comment update fetch cost benchmark (issue #308 follow-up) - ${config.name}`, () => {
        let pkc: PKCType;
        let publisherPkc: Awaited<ReturnType<typeof mockPKCNoDataPathWithOnlyKuboClient>>;
        const commentsToStop: Comment[] = [];
        let communityInstance: RemoteCommunity | undefined;

        beforeAll(async () => {
            // updateInterval is the event-driven loop's safety-net period; use the production
            // default so community updates arrive via gossip push, not fast polling.
            pkc = await config.pkcInstancePromise({ pkcOptions: { updateInterval: 60_000 } });
            // Publishing runs on a separate kubo-backed pkc so the measuring client's cat()
            // counts are not polluted by the publishing flow's own fetches.
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

        it(`postUpdates fetch cost of ${POST_COUNT} idle updating posts over ${WINDOW_MS / 1000}s of unrelated community activity`, async () => {
            const communityAddress = signers[0].address;

            // ---- setup: K posts that will then sit idle for the whole window ----
            const publishedPosts: Comment[] = [];
            for (let i = 0; i < POST_COUNT; i++) publishedPosts.push(await publishRandomPost({ communityAddress, pkc: publisherPkc }));

            // ---- instrumentation on the measuring client, BEFORE any updating starts ----
            const libp2pJsClient = pkc.clients.libp2pJsClients[Object.keys(pkc.clients.libp2pJsClients)[0]];
            const clientFunctions = libp2pJsClient.heliaWithKuboRpcClientFunctions;
            const catCalls: { path: string; atMs: number }[] = [];
            const originalCat = clientFunctions.cat.bind(clientFunctions);
            clientFunctions.cat = ((...args: Parameters<typeof originalCat>) => {
                catCalls.push({ path: String(args[0]), atMs: Date.now() });
                return originalCat(...args);
            }) as typeof clientFunctions.cat;

            let communityUpdateEvents = 0;
            communityInstance = (await pkc.createCommunity({ address: communityAddress })) as RemoteCommunity;
            communityInstance.on("update", () => communityUpdateEvents++);
            await communityInstance.update();

            let commentUpdatingStateChanges = 0;
            let newerCommentUpdatesReceived = 0;
            await Promise.all(
                publishedPosts.map(async (publishedPost) => {
                    const comment = await pkc.createComment({ cid: publishedPost.cid! });
                    commentsToStop.push(comment);
                    comment.on("updatingstatechange", () => commentUpdatingStateChanges++);
                    const firstUpdate = new Promise<void>((resolve) =>
                        comment.once("update", () => {
                            resolve();
                        })
                    );
                    await comment.update();
                    await firstUpdate;
                })
            );

            // ---- steady-state window: only unrelated filler activity changes the record ----
            await sleep(3000);
            catCalls.length = 0;
            communityUpdateEvents = 0;
            commentUpdatingStateChanges = 0;
            for (const comment of commentsToStop) comment.on("update", () => newerCommentUpdatesReceived++);
            const cpuBefore = process.cpuUsage();
            const windowStart = Date.now();

            const fillerLoop = (async () => {
                while (Date.now() - windowStart < WINDOW_MS - FILLER_INTERVAL_MS) {
                    await sleep(FILLER_INTERVAL_MS);
                    try {
                        await publishRandomPost({ communityAddress, pkc: publisherPkc });
                    } catch (e) {
                        console.error("filler post publish failed, continuing", e);
                    }
                }
            })();
            await sleep(WINDOW_MS);
            await fillerLoop;
            const windowSec = (Date.now() - windowStart) / 1000;
            const cpuAfter = process.cpuUsage(cpuBefore);

            const postUpdatesWalks = catCalls.filter((c) => c.path.includes("/"));
            const report = {
                posts: POST_COUNT,
                windowSec: Number(windowSec.toFixed(1)),
                communityUpdateEvents,
                postUpdatesPathFetches: {
                    total: postUpdatesWalks.length,
                    perCommunityUpdatePerPost: Number(
                        (postUpdatesWalks.length / Math.max(1, communityUpdateEvents) / POST_COUNT).toFixed(2)
                    )
                },
                otherCatFetches: catCalls.length - postUpdatesWalks.length,
                newerCommentUpdatesReceived,
                commentUpdatingStateChanges,
                clientCpu: {
                    userMs: Math.round(cpuAfter.user / 1000),
                    systemMs: Math.round(cpuAfter.system / 1000)
                }
            };
            console.log(`comment update fetch benchmark report:\n${JSON.stringify(report, null, 4)}`);

            expect(communityUpdateEvents, "the filler posts must have produced community updates in the window").to.be.greaterThan(0);
        }, 900_000);
    });
});

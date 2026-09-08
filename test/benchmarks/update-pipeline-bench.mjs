// Whole update-pipeline cost benchmark (issue #355): how long one publish cycle of a LocalCommunity takes end to end
// against a REAL kubo daemon, IPFS included, and how much memory it holds while doing it. The other page
// benchmarks stub the kubo client out, so nothing here was measurable before: the reply-page and posts-page
// adds, the postUpdates MFS writes and flushes, the community record add and the IPNS publish. NOT part of
// any CI glob; run manually with the test server up (mockPKC points at its kubo on :15001) and dist/ freshly
// built:
//
//   npm run build && node --expose-gc --max-old-space-size=4096 test/benchmarks/update-pipeline-bench.mjs
//
// The iteration body is syncIpnsWithDb's body inlined so every phase can be timed on its own; keep it in
// step with ipns-publishing.ts when that function changes. The postUpdates MFS writes land in the
// CommentUpdates phase on a code state that streams them and in the record phase on one that does not.
// Every kubo RPC method the cycle touches is wrapped, so the per-method table below the phases says how
// much of the cycle is the daemon.
//
// Env: BENCH_POSTS (default 300 here, not the 20000 of page-generation-bench: every post is a real MFS
// write), BENCH_MIN_REPLIES / BENCH_MAX_REPLIES (10 / 100), BENCH_POSTS_PER_AUTHOR (25), BENCH_SEED (1),
// BENCH_MODE (default | active | nobump), BENCH_ITERATIONS (3; iteration 0 writes every postUpdates file
// for the first time, later ones overwrite), BENCH_STUB_KUBO=1 (swap the daemon for the immediate stub of
// page-generation-bench, which is how the IPFS share of the cycle is attributed: same board, same code,
// only the client differs), BENCH_DATA_PATH (where the community's database goes; the PKC default puts it
// in the working directory, which is the wrong place for the multi-GB database of a large board).
import { performance } from "node:perf_hooks";
import path from "node:path";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { mockPKC } from "../../dist/node/test/test-util.js";
import {
    adjustPostUpdatesBucketsIfNeeded,
    updateCommentsThatNeedToBeUpdated
} from "../../dist/node/runtime/node/community/local-community/comment-updates.js";
import * as ipnsPublishing from "../../dist/node/runtime/node/community/local-community/ipns-publishing.js";
import { cleanUpIpfsRepoIfDue, purgeDisapprovedCommentsOlderThan } from "../../dist/node/runtime/node/community/local-community/cleanup.js";
import { providePubsubTopicRoutingCidsIfNeeded } from "../../dist/node/runtime/node/community/local-community/pubsub.js";
import { calculateStringSizeSameAsIpfsAddCidV0 } from "../../dist/node/util.js";
import { CommunityIpfsSchema } from "../../dist/node/community/schema.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";

if (!process.env.BENCH_POSTS) process.env.BENCH_POSTS = "300";
process.env.BENCH_PIPELINE = "1"; // seedBoard: comment rows only, so every comment needs a CommentUpdate
const { seedBoard } = await import("./page-generation-bench.mjs");

const ITERATIONS = Number(process.env.BENCH_ITERATIONS) > 0 ? Number(process.env.BENCH_ITERATIONS) : 3;
// Whether this code state hands the rows over batch by batch (the publish cycle then keeps only the posts'
// rows and the cids) or accumulates and returns every one of them.
const STREAMS_UPDATES = updateCommentsThatNeedToBeUpdated.length > 1;
// Whether this code state writes each slice's postUpdates files as it goes (the cycle then keeps nothing
// but the cids) or collects every post row first and writes them in one pass at record-build time.
const STREAMS_POST_UPDATES = typeof ipnsPublishing.updateCommentsAndWritePostUpdates === "function";
const { requireCommunityUpdateIfModQueueChanged, updateCommunityIpnsIfNeeded } = ipnsPublishing;
const MODE = process.env.BENCH_MODE || "default";
const STUB_KUBO = process.env.BENCH_STUB_KUBO === "1";
const NO_BUMP_FIXTURE = path.resolve(process.cwd(), "test/fixtures/page-sorts/active-no-bump-keyword.js");

// Per-method kubo cost of the cycle. An async-iterable method (pin.rm, block.rm, routing.provide, repo.gc)
// is timed over its full consumption, not over the call that returns the iterator.
const kubo = new Map();
// Per-method ms is summed over calls and the cycle runs them concurrently, so the sum can exceed the
// cycle. kuboWall counts the wall time during which at least one kubo call was in flight, which is the
// number that can be compared against the cycle.
const kuboWall = { inFlight: 0, since: 0, ms: 0 };
const kuboCallStarted = () => {
    if (kuboWall.inFlight++ === 0) kuboWall.since = performance.now();
};
const recordKubo = (label, ms, bytes = 0) => {
    const entry = kubo.get(label) ?? { ms: 0, calls: 0, bytes: 0 };
    entry.ms += ms;
    entry.calls++;
    entry.bytes += bytes;
    kubo.set(label, entry);
    if (--kuboWall.inFlight === 0) kuboWall.ms += performance.now() - kuboWall.since;
};
// Wrapped by explicit path, not by walking the client: a kubo-rpc-client instance carries frozen module
// namespaces among its properties, and a blind walk trips over them. Every method the publish cycle can
// reach is listed; anything unlisted simply does not show up in the table.
const KUBO_METHODS = [
    "add",
    "cat",
    "block.rm",
    "block.stat",
    "dag.get",
    "files.write",
    "files.flush",
    "files.rm",
    "files.stat",
    "files.mkdir",
    "files.cp",
    "files.ls",
    "key.list",
    "key.rm",
    "key.import",
    "name.publish",
    "name.resolve",
    "pin.add",
    "pin.rm",
    "pin.ls",
    "repo.gc",
    "repo.stat",
    "routing.provide",
    "routing.findprovs"
];
const instrumentKubo = (client) => {
    for (const methodPath of KUBO_METHODS) {
        const segments = methodPath.split(".");
        const owner = segments.slice(0, -1).reduce((object, segment) => object?.[segment], client);
        const name = segments[segments.length - 1];
        if (!owner || typeof owner[name] !== "function") continue;
        owner[name] = timedKuboMethod(owner[name].bind(owner), methodPath);
    }
    return client;
};
const timedKuboMethod = (fn, label) =>
    function (...args) {
        const start = performance.now();
        kuboCallStarted();
        const contentArg = label === "add" ? args[0] : label === "files.write" ? args[1] : undefined;
        const bytes = typeof contentArg === "string" ? Buffer.byteLength(contentArg) : 0;
        let result;
        try {
            result = fn(...args);
        } catch (e) {
            recordKubo(label, performance.now() - start, bytes);
            throw e;
        }
        if (result && typeof result.then === "function") return result.finally(() => recordKubo(label, performance.now() - start, bytes));
        if (result && typeof result[Symbol.asyncIterator] === "function") {
            const iterable = result;
            return (async function* () {
                try {
                    yield* iterable;
                } finally {
                    recordKubo(label, performance.now() - start, bytes);
                }
            })();
        }
        recordKubo(label, performance.now() - start, bytes);
        return result;
    };

// The stub of page-generation-bench, so the same harness yields the IPFS-excluded number of the same board.
const stubKuboClient = () => {
    let added = 0;
    const noop = async () => {};
    return {
        add: async (content) => {
            await new Promise((resolve) => setImmediate(resolve)); // yield like the real I/O does, so the heap sampler runs
            return { cid: `Qm${(++added).toString(36).padStart(44, "0")}`, path: `Qm${added.toString(36).padStart(44, "0")}`, size: content.length };
        },
        pin: { rm: noop, add: noop },
        files: {
            write: noop,
            rm: noop,
            flush: async () => "QmstubFlush",
            stat: async () => ({ cid: "QmstubStat", blocks: 1 }),
            mkdir: noop
        },
        key: { rm: noop, list: async () => [] },
        name: { publish: async () => ({ name: "stub", value: "stub" }) },
        block: { rm: async function* () {} },
        repo: { gc: async function* () {} },
        routing: { provide: async function* () {} }
    };
};

async function main() {
    const pkc = await mockPKC(process.env.BENCH_DATA_PATH ? { dataPath: process.env.BENCH_DATA_PATH } : undefined);
    const community = await pkc.createCommunity();
    const iterations = [];
    try {
        if (MODE !== "default") {
            const posts =
                MODE === "active"
                    ? [{ name: "active", preloaded: true }]
                    : [{ path: NO_BUMP_FIXTURE, options: { noBumpKeywords: "sage" }, preloaded: true }];
            await community.edit({ settings: { ...community.settings, pages: { posts } } });
        }

        // Start for real (IPNS key import, MFS root, page sorts, pubsub listen), then let the publish loop
        // exit after its first empty-board cycle so the iterations below are the only thing touching kubo.
        await community.start();
        community._stopHasBeenCalled = true;
        await community._publishLoopPromise;

        // The record's pre-publish check keeps its size calculation and its schema parse, which are what
        // scale with the board, and loses the two verifyCommunity calls that follow them: those verify
        // every comment of the preloaded page against its author key, and a seeded board's comments carry
        // placeholder signatures. That excludes a fixed per-cycle cost (one preloaded page, verified
        // twice) from every number below; it does not grow with the board.
        community._validateCommunitySizeSchemaAndSignatureBeforePublishing = async (record) => {
            await calculateStringSizeSameAsIpfsAddCidV0(deterministicStringify(record));
            CommunityIpfsSchema.safeParse(record);
        };

        // Instrumented in place on the client object the community already holds: replacing the client object
        // itself would drop whatever the clients manager keeps on it (url, state).
        const kuboRpcClient = community._clientsManager.getDefaultKuboRpcClient();
        if (STUB_KUBO) kuboRpcClient._client = stubKuboClient();
        instrumentKubo(kuboRpcClient._client);

        const seedStart = performance.now();
        const { replyTotal } = seedBoard(community);
        const dbMB = databaseMB(community);
        const posts = Number(process.env.BENCH_POSTS);
        console.log(
            JSON.stringify({
                event: "seeded",
                posts,
                replies: replyTotal,
                comments: posts + replyTotal,
                seedMs: Math.round(performance.now() - seedStart),
                dbMB
            })
        );

        for (let i = 0; i < ITERATIONS; i++) {
            if (i > 0) community._dbHandler["_db"].exec("DELETE FROM commentUpdates"); // every comment needs an update again
            if (global.gc) global.gc();
            kubo.clear();
            kuboWall.ms = 0;
            kuboWall.inFlight = 0;
            const heapBefore = process.memoryUsage().heapUsed;
            let heapPeak = heapBefore;
            let rssPeak = process.memoryUsage().rss;
            const sampler = setInterval(() => {
                const usage = process.memoryUsage();
                heapPeak = Math.max(heapPeak, usage.heapUsed);
                rssPeak = Math.max(rssPeak, usage.rss);
            }, 25);
            const cpuBefore = process.cpuUsage();
            const phases = {};
            const time = async (name, fn) => {
                const start = performance.now();
                try {
                    return await fn();
                } finally {
                    phases[name] = Math.round(performance.now() - start);
                }
            };

            const cycleStart = performance.now();
            // syncIpnsWithDb's body, phase by phase
            await time("listenMs", () => community._listenToIncomingRequests());
            await time("provideMs", () => providePubsubTopicRoutingCidsIfNeeded(community));
            await time("bucketsMs", () => adjustPostUpdatesBucketsIfNeeded(community));
            await time("purgeMs", () => purgeDisapprovedCommentsOlderThan(community));
            // What the cycle keeps from the CommentUpdates it writes. Newest state: nothing but the cids,
            // since each slice's postUpdates files are written as the slice is calculated. Before that:
            // the posts' rows, collected through the per-slice consumer. Before that again (arity 1):
            // every row of the board, which is the state the memory numbers are measured against.
            let postRows = [];
            let updatedCids = [];
            const collect = (rows) => {
                for (const row of rows) {
                    updatedCids.push(row.newCommentUpdate.cid);
                    if (typeof row.localMfsPath === "string") postRows.push(row);
                }
            };
            let allRows;
            await time("commentUpdatesMs", async () => {
                if (STREAMS_POST_UPDATES) {
                    updatedCids = await ipnsPublishing.updateCommentsAndWritePostUpdates(community);
                    return;
                }
                if (STREAMS_UPDATES) return updateCommentsThatNeedToBeUpdated(community, collect);
                allRows = await updateCommentsThatNeedToBeUpdated(community);
                collect(allRows);
            });
            const heapAfterCommentUpdates = process.memoryUsage().heapUsed;
            requireCommunityUpdateIfModQueueChanged(community);
            await time("publishRecordMs", () => {
                if (STREAMS_POST_UPDATES) return updateCommunityIpnsIfNeeded(community, updatedCids);
                return STREAMS_UPDATES
                    ? updateCommunityIpnsIfNeeded(community, postRows, updatedCids)
                    : updateCommunityIpnsIfNeeded(community, allRows);
            });
            await time("repoGcMs", () => cleanUpIpfsRepoIfDue(community));
            const cycleMs = performance.now() - cycleStart;

            clearInterval(sampler);
            const cpu = process.cpuUsage(cpuBefore);
            // What the returned rows actually hold: heap with them alive minus heap after dropping them,
            // both after a full gc. This is the memory the cycle carries from the first CommentUpdate to
            // the IPNS publish, and everything generated afterwards peaks on top of it.
            const commentsUpdated = updatedCids.length;
            const retainedBytes = allRows ? retainedSizeOfUpdates(allRows) : retainedSizeOfUpdates(postRows) + updatedCids.length * 48;
            let heapHeldByUpdatesMB;
            let heapLiveAfterCycleDeltaMB;
            if (global.gc) {
                global.gc();
                const withUpdates = process.memoryUsage().heapUsed;
                heapLiveAfterCycleDeltaMB = Math.round((withUpdates - heapBefore) / 1024 / 1024);
                postRows = undefined;
                updatedCids = undefined;
                allRows = undefined;
                global.gc();
                heapHeldByUpdatesMB = Math.round((withUpdates - process.memoryUsage().heapUsed) / 1024 / 1024);
            }
            const kuboMs = [...kubo.values()].reduce((sum, entry) => sum + entry.ms, 0);
            const row = {
                event: "iteration",
                i,
                comments: commentsUpdated,
                cycleMs: Math.round(cycleMs),
                ...phases,
                kuboSummedMs: Math.round(kuboMs), // over concurrent calls, so it can exceed the cycle
                kuboWallMs: Math.round(kuboWall.ms),
                kuboWallPct: Math.round((kuboWall.ms / cycleMs) * 1000) / 10,
                heapPeakDeltaMB: Math.round((heapPeak - heapBefore) / 1024 / 1024),
                heapAfterCommentUpdatesDeltaMB: Math.round((heapAfterCommentUpdates - heapBefore) / 1024 / 1024),
                updatesSerializedMB: Math.round(retainedBytes / 1024 / 1024),
                heapHeldByUpdatesMB,
                heapLiveAfterCycleDeltaMB, // live heap at the end of the cycle: the peak above is mostly uncollected garbage
                rssPeakMB: Math.round(rssPeak / 1024 / 1024),
                cpuUserMs: Math.round(cpu.user / 1000),
                cpuSystemMs: Math.round(cpu.system / 1000),
                addedMB: Math.round(((kubo.get("add")?.bytes ?? 0) / 1024 / 1024) * 10) / 10,
                kuboCalls: Object.fromEntries(
                    [...kubo.entries()]
                        .sort((a, b) => b[1].ms - a[1].ms)
                        .map(([label, entry]) => [label, { ms: Math.round(entry.ms), calls: entry.calls }])
                )
            };
            iterations.push(row);
            console.log(JSON.stringify(row));
        }

        const medianOf = (key) => {
            const values = iterations.map((row) => row[key]).sort((a, b) => a - b);
            return values[Math.floor(values.length / 2)];
        };
        const result = {
            event: "result",
            mode: MODE,
            kubo: STUB_KUBO ? "stubbed" : "real",
            codeState: STREAMS_POST_UPDATES
                ? "streams comment updates and postUpdates files"
                : STREAMS_UPDATES
                  ? "streams comment updates, collects post rows"
                  : "accumulates every row",
            posts: Number(process.env.BENCH_POSTS),
            comments: iterations[0]?.comments,
            seededDbMB: dbMB,
            finalDbMB: databaseMB(community),
            iterations: ITERATIONS,
            medianCycleMs: medianOf("cycleMs"),
            medianCommentUpdatesMs: medianOf("commentUpdatesMs"),
            medianPublishRecordMs: medianOf("publishRecordMs"),
            medianKuboWallMs: medianOf("kuboWallMs"),
            medianKuboWallPct: medianOf("kuboWallPct"),
            medianHeapPeakDeltaMB: medianOf("heapPeakDeltaMB"),
            medianHeapHeldByUpdatesMB: medianOf("heapHeldByUpdatesMB"),
            medianHeapLiveAfterCycleDeltaMB: medianOf("heapLiveAfterCycleDeltaMB"),
            medianRssPeakMB: medianOf("rssPeakMB")
        };
        console.log(JSON.stringify(result));
        mkdirSync(".tmp", { recursive: true });
        const file = path.resolve(`.tmp/update-pipeline-bench-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
        writeFileSync(file, JSON.stringify({ result, iterations }, null, 2));
        console.log(JSON.stringify({ event: "written", file }));
    } finally {
        await community.stop().catch(() => {});
        await community.delete().catch(() => {});
        await pkc.destroy();
    }
}

// The community's database on disk, its write-ahead log included.
function databaseMB(community) {
    const file = community._dbHandler["_db"]?.name;
    if (!file || file === ":memory:") return undefined;
    try {
        const bytes = statSync(file).size + (existsSync(`${file}-wal`) ? statSync(`${file}-wal`).size : 0);
        return Math.round((bytes / 1024 / 1024) * 10) / 10;
    } catch {
        return undefined;
    }
}

// What the cycle is still holding when the CommentUpdates are written: the serialized size of the rows it
// kept, which stay alive until the record is published.
function retainedSizeOfUpdates(updates) {
    let bytes = 0;
    for (const row of updates) bytes += JSON.stringify(row).length;
    return bytes;
}

main().then(
    () => process.exit(0),
    (error) => {
        console.error(error);
        process.exit(1);
    }
);

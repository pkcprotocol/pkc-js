// Page generation cost benchmark (issue #73, PR #346): how long generateCommunityPosts takes on a seeded board,
// IPFS excluded (the kubo client is a stub whose `add` returns immediately). NOT part of any CI glob; run manually
// with the test server up (mockPKC points at its kubo):
//
//   node --max-old-space-size=12288 test/benchmarks/page-generation-bench.mjs
//
// Env: BENCH_POSTS (default 20000), BENCH_MIN_REPLIES / BENCH_MAX_REPLIES (10 / 100, uniform per post),
// BENCH_MODE = default | active | nobump (settings.pages; default = unset, what master generates too),
// BENCH_ITERATIONS (3), BENCH_SEED (1). The script also runs unchanged on master and on the pre-rewrite branch
// (it detects the generator's signature), which is how the before/after numbers in the PR were taken.
import { performance } from "node:perf_hooks";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mockPKC } from "../../dist/node/test/test-util.js";
import env from "../../dist/node/version.js";
import { updateCommentsThatNeedToBeUpdated } from "../../dist/node/runtime/node/community/local-community/comment-updates.js";

const POSTS = Number(process.env.BENCH_POSTS) > 0 ? Number(process.env.BENCH_POSTS) : 20_000;
const MIN_REPLIES = Number(process.env.BENCH_MIN_REPLIES) >= 0 ? Number(process.env.BENCH_MIN_REPLIES) : 10;
const MAX_REPLIES = Number(process.env.BENCH_MAX_REPLIES) >= 0 ? Number(process.env.BENCH_MAX_REPLIES) : 100;
const MODE = process.env.BENCH_MODE || "default";
const ITERATIONS = Number(process.env.BENCH_ITERATIONS) > 0 ? Number(process.env.BENCH_ITERATIONS) : 3;
// Production posts embed their preloaded reply pages (the DB `replies` column lists each parent's children per
// preloaded sort, and the generator rebuilds the trees from the reply rows a batch of posts at a time, issue #351).
// BENCH_NESTED=0 seeds bare posts instead. Iterations after the first run with the generator's entry cache warm,
// the way a steady board publishes; BENCH_COLD=1 drops it before every iteration.
const NESTED = process.env.BENCH_NESTED !== "0";
const COLD = process.env.BENCH_COLD === "1";
// BENCH_PIPELINE=1 measures the whole publish cycle instead of only the posts pages: the board is seeded with comment
// rows alone, then updateCommentsThatNeedToBeUpdated (every comment's CommentUpdate: counts, reply pages, signing,
// the row with its wire replies) runs the way the sync loop does, then the posts pages are generated; time and the
// sampled peak heap are reported per phase and over the cycle.
const PIPELINE = process.env.BENCH_PIPELINE === "1";
// BENCH_NO_STATEMENT_CACHE=1 prepares every statement on every call, the way the code did before the per-connection
// statement cache (issue #351), so the cache's share of the cycle can be measured with BENCH_PIPELINE=1.
const NO_STATEMENT_CACHE = process.env.BENCH_NO_STATEMENT_CACHE === "1";
let seed = Number(process.env.BENCH_SEED) > 0 ? Number(process.env.BENCH_SEED) : 1;
const NO_BUMP_FIXTURE = path.resolve(process.cwd(), "test/fixtures/page-sorts/active-no-bump-keyword.js");
const CONTENT = "x".repeat(200);
const SIGNATURE = { type: "ed25519", signature: "sig", publicKey: "pk", signedPropertyNames: [] };

const random = () => {
    // xorshift32, deterministic across runs and code states
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 1_000_000) / 1_000_000;
};
const randomInt = (min, max) => min + Math.floor(random() * (max - min + 1));
const fakeCid = (n) => `Qm${n.toString(36).padStart(44, "0")}`;

async function main() {
    const pkc = await mockPKC();
    const community = await pkc.createCommunity();
    await community._dbHandler.initDbIfNeeded();
    await community._dbHandler.createOrMigrateTablesIfNeeded();
    let addCounter = 0;
    let addedBytes = 0;
    const noop = async () => {};
    community._clientsManager.getDefaultKuboRpcClient = () => ({
        _client: {
            add: async (content) => {
                await new Promise((resolve) => setImmediate(resolve)); // yield like the real I/O does, so the heap sampler runs
                addedBytes += content.length;
                return { cid: fakeCid(++addCounter), path: fakeCid(addCounter), size: content.length };
            },
            pin: { rm: noop },
            files: { rm: noop },
            key: { rm: noop },
            routing: { async *provide() {} }
        }
    });
    try {
        if (MODE !== "default") {
            const posts =
                MODE === "active"
                    ? [{ name: "active", preloaded: true }]
                    : [{ path: NO_BUMP_FIXTURE, options: { noBumpKeywords: "sage" }, preloaded: true }];
            await community.edit({ settings: { ...community.settings, pages: { posts } } });
            await community._dbHandler.initDbIfNeeded();
        }

        if (NO_STATEMENT_CACHE) community._dbHandler["_prepareCached"] = (sql) => community._dbHandler["_db"].prepare(sql);

        const seedStart = performance.now();
        const { replyTotal } = seedBoard(community);
        const seedMs = performance.now() - seedStart;
        console.log(JSON.stringify({ event: "seeded", posts: POSTS, replies: replyTotal, seedMs: Math.round(seedMs) }));
        reportStorage(community);

        if (PIPELINE) {
            for (let i = 0; i < ITERATIONS; i++) {
                if (i > 0) community._dbHandler["_db"].exec("DELETE FROM commentUpdates"); // every comment needs an update again
                if (global.gc) global.gc();
                const heapBefore = process.memoryUsage().heapUsed;
                let heapPeak = heapBefore;
                const sampler = setInterval(() => (heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed)), 50);
                addedBytes = 0;
                const updatesStart = performance.now();
                const updates = await updateCommentsThatNeedToBeUpdated(community);
                community._dbHandler.markCommentsAsPublishedToPostUpdates(updates.map((u) => u.newCommentUpdate.cid));
                const updatesMs = performance.now() - updatesStart;
                if (i === 0) reportStorage(community); // commentUpdates rows exist now, so every index has its final size
                const updatesHeapPeak = heapPeak;
                const updatesPageBytes = addedBytes;
                const postsStart = performance.now();
                await community._pageGenerator.generateCommunityPosts({ preloadedPageSizeBytes: 1024 * 1024 });
                const postsMs = performance.now() - postsStart;
                clearInterval(sampler);
                console.log(
                    JSON.stringify({
                        event: "pipeline",
                        i,
                        comments: updates.length,
                        updatesMs: Math.round(updatesMs),
                        updatesHeapPeakDeltaMB: Math.round((updatesHeapPeak - heapBefore) / 1024 / 1024),
                        replyPageMB: Math.round(updatesPageBytes / 1024 / 1024),
                        postsMs: Math.round(postsMs),
                        cycleMs: Math.round(updatesMs + postsMs),
                        cycleHeapPeakDeltaMB: Math.round((heapPeak - heapBefore) / 1024 / 1024),
                        postsPageMB: Math.round((addedBytes - updatesPageBytes) / 1024 / 1024)
                    })
                );
            }
            return;
        }

        const generator = community._pageGenerator;
        const legacySignature = generator.generateCommunityPosts.length === 2; // master: (preloadedPageSortName, preloadedPageSizeBytes)
        const budget = 1024 * 1024;
        const times = [];
        for (let i = 0; i < ITERATIONS; i++) {
            if (COLD) generator["_postEntryCache"] = undefined;
            if (global.gc) global.gc();
            const heapBefore = process.memoryUsage().heapUsed;
            // Peak heap while generating, sampled: what a sort configuration needs at once, garbage included
            let heapPeakSampled = heapBefore;
            const sampler = setInterval(() => (heapPeakSampled = Math.max(heapPeakSampled, process.memoryUsage().heapUsed)), 50);
            addedBytes = 0;
            const start = performance.now();
            const result = legacySignature
                ? await generator.generateCommunityPosts("hot", budget)
                : await generator.generateCommunityPosts({ preloadedPageSizeBytes: budget });
            const ms = performance.now() - start;
            clearInterval(sampler);
            const heapPeak = Math.max(heapPeakSampled, process.memoryUsage().heapUsed);
            const sortKeys =
                result &&
                ("singlePreloadedPage" in result
                    ? Object.keys(result.singlePreloadedPage)
                    : Object.keys(result.allPageCids ?? result.pageCids ?? {}));
            times.push(ms);
            console.log(
                JSON.stringify({
                    event: "iteration",
                    i,
                    ms: Math.round(ms),
                    sorts: sortKeys,
                    heapPeakDeltaMB: Math.round((heapPeak - heapBefore) / 1024 / 1024),
                    pageMB: Math.round(addedBytes / 1024 / 1024)
                })
            );
        }
        const sorted = [...times].sort((a, b) => a - b);
        const median = sorted[Math.floor(sorted.length / 2)];
        console.log(
            JSON.stringify({
                event: "result",
                mode: MODE,
                codeState: legacySignature ? "master" : "branch",
                posts: POSTS,
                replies: replyTotal,
                medianMs: Math.round(median),
                usPerPost: Math.round((median * 1000) / POSTS),
                extrapolatedTo1MPostsSeconds: Math.round((median / POSTS) * 1_000_000) / 1000
            })
        );
    } finally {
        await community._dbHandler.destoryConnection();
        await community.delete();
        await pkc.destroy();
    }
}

// What every table and index of the seeded board takes on disk, from sqlite's dbstat: the cost of the indexes added
// for the update cycle (issue #351) next to the tables they index. Percent is of the whole database file.
function reportStorage(community) {
    const db = community._dbHandler["_db"];
    const rows = db.prepare("SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY bytes DESC").all();
    const total = rows.reduce((sum, row) => sum + row.bytes, 0);
    const kinds = new Map(db.prepare("SELECT name, type FROM sqlite_schema").all().map((row) => [row.name, row.type]));
    console.log(
        JSON.stringify({
            event: "storage",
            totalMB: Math.round((total / 1024 / 1024) * 10) / 10,
            objects: rows.map((row) => ({
                name: row.name,
                type: kinds.get(row.name) ?? "internal",
                MB: Math.round((row.bytes / 1024 / 1024) * 100) / 100,
                pct: Math.round((row.bytes / total) * 1000) / 10
            }))
        })
    );
}

export function seedBoard(community) {
    const db = community._dbHandler;
    const now = Math.floor(Date.now() / 1000);
    const base = now - POSTS * 60;
    let cidCounter = 0;
    let replyTotal = 0;
    const BATCH = 5000;
    let commentRows = [];
    let updateRows = [];
    const flush = () => {
        if (commentRows.length) db.insertComments(commentRows);
        if (updateRows.length && !PIPELINE) db.upsertCommentUpdates(updateRows);
        commentRows = [];
        updateRows = [];
    };
    const comment = ({ cid, parentCid, postCid, depth, timestamp, content, title }) => ({
        cid,
        authorSignerAddress: `author-${cid}`,
        author: { address: `author-${cid}` },
        parentCid,
        postCid,
        communityPublicKey: community.signer.address,
        content,
        timestamp,
        signature: SIGNATURE,
        title,
        depth,
        protocolVersion: env.PROTOCOL_VERSION,
        insertedAt: timestamp
    });
    const update = ({ cid, timestamp, replyCount, childCount, lastReplyTimestamp, childCids }) => ({
        cid,
        ...(NESTED && childCids?.length ? { replies: { best: { commentCids: childCids } } } : {}),
        upvoteCount: randomInt(0, 50),
        downvoteCount: randomInt(0, 5),
        replyCount,
        childCount,
        updatedAt: timestamp + 1,
        protocolVersion: env.PROTOCOL_VERSION,
        signature: SIGNATURE,
        author: { community: {} },
        lastReplyTimestamp,
        publishedToPostUpdatesMFS: true,
        insertedAt: timestamp + 1
    });

    for (let i = 0; i < POSTS; i++) {
        const postCid = fakeCid(++cidCounter);
        const postTimestamp = base + i * 60;
        const replyCount = randomInt(MIN_REPLIES, MAX_REPLIES);
        const replies = []; // { cid, depth, children }
        let lastReplyTimestamp;
        commentRows.push(
            comment({ cid: postCid, parentCid: null, postCid, depth: 0, timestamp: postTimestamp, content: CONTENT, title: `post ${i}` })
        );
        for (let r = 0; r < replyCount; r++) {
            const cid = fakeCid(++cidCounter);
            const nested = replies.length > 0 && random() < 0.2 ? replies[randomInt(0, replies.length - 1)] : undefined;
            const parentCid = nested ? nested.cid : postCid;
            const depth = nested ? nested.depth + 1 : 1;
            const timestamp = postTimestamp + (r + 1) * 5;
            const content = MODE === "nobump" && random() < 0.05 ? "sage" : CONTENT;
            commentRows.push(comment({ cid, parentCid, postCid, depth, timestamp, content, title: null }));
            replies.push({ cid, depth, children: 0, childCids: [], timestamp });
            if (nested) {
                nested.children++;
                nested.childCids.push(cid);
            }
            lastReplyTimestamp = Math.max(lastReplyTimestamp ?? 0, timestamp);
        }
        const replyUpdates = new Map();
        for (const reply of replies)
            replyUpdates.set(
                reply.cid,
                update({
                    cid: reply.cid,
                    timestamp: reply.timestamp,
                    replyCount: reply.children,
                    childCount: reply.children,
                    lastReplyTimestamp: undefined,
                    childCids: reply.childCids
                })
            );
        const directChildren = replies.filter((x) => x.depth === 1);
        updateRows.push(
            update({
                cid: postCid,
                timestamp: postTimestamp,
                replyCount,
                childCount: directChildren.length,
                lastReplyTimestamp,
                childCids: directChildren.map((x) => x.cid)
            })
        );
        for (const reply of replies) updateRows.push(replyUpdates.get(reply.cid));
        replyTotal += replyCount;
        if (commentRows.length >= BATCH) flush();
    }
    flush();
    return { replyTotal };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
    main().then(
        () => process.exit(0),
        (error) => {
            console.error(error);
            process.exit(1);
        }
    );

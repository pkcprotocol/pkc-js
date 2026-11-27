// What one publication costs when its author holds the whole board (issue #471): the author cascade of the flag
// query (arm 7 of _collectCommentsToBeUpdated) re-flags every other comment by the author of a flagged comment, so
// on a board written by one signer (a mirror bot) a single new comment or vote turns the next cycle into a
// recalculation of every CommentUpdate. This bench seeds a board of BENCH_COMMENTS comments by one author, brings
// it to the steady state (every CommentUpdate calculated and marked published), then measures, kubo stubbed:
//
// Every row carries the node process's CPU (user + system, all threads) and, with the real daemon on Linux, the
// kubo process's CPU over the same window (kuboCpuMs, from /proc/<pid>/stat of the process on the RPC port).
//
//   idle      the flag query when nothing changed (rows flagged, ms)
//   comment   one new reply by the board's author: rows flagged, flag-query ms, full cycle ms
//   vote      one vote on one of the author's comments: same
//   reply-by-new-author   one new reply by an author with no other comments, under a post by the board's author
//   post-by-new-author    one new top-level post by an author with no other comments (the true control: no parent
//                         by the board's author, so nothing of the board's author is flagged)
//
// NOT part of any CI glob. Run with dist/ freshly built (no test server needed; the kubo client is stubbed):
//
//   npm run build && BENCH_COMMENTS=100000 npm run bench:author-cascade
//   (= node --expose-gc --max-old-space-size=8192 test/benchmarks/author-cascade-bench.mjs)
//
// Env: BENCH_COMMENTS (default 1000; posts = comments / 56, the mean of the seeder's 10..100 replies per post),
// BENCH_DATA_PATH (where the community database goes; default ~/.cache/pkc-js-bench, never the working directory),
// BENCH_OUT (JSON result file; default .tmp/bench/author-cascade-<comments>.json), BENCH_KEEP=1 to keep the board,
// BENCH_REAL_KUBO=1 to run the real publish cycle (reply-page adds, postUpdates MFS writes, record add, IPNS
// publish) against the test server's kubo instead of the stub, the way update-pipeline-bench does; the cycle is
// then what the publisher actually waits for. Needs the test server up. BENCH_SCENARIOS (comma list; default all
// four) picks the publications to measure; every cascading one costs a whole-board cycle, so a huge board runs fewer.
// BENCH_STAGES=1 adds a per-stage breakdown of each measured cycle: wall-clock timers on the DbHandler and
// PageGenerator methods and on every kubo RPC call, reported as the wall time during which at least one call of
// that label was in flight (concurrent calls are not double counted) plus the summed per-call time, together with
// the GC pause time. Labels nest (a page generation contains its DB reads and kubo adds), so they do not add up to
// the cycle; whatever no label covers (signing and verifying each CommentUpdate, the JSON work around them) is the
// cycle minus the outermost stages. BENCH_CPU_PROF=<dir> also writes one V8 CPU profile per measured cycle, for
// test/benchmarks/cpuprofile-summary.mjs. BENCH_STAGES_PRIVATE=1 also times the DbHandler's private _query* helpers.
// Every measured cycle reports its peak memory (peakRssMB, peakHeapUsedMB and, with the real kubo, peakKuboRssMB).
// BENCH_DIFF=1 reports which CommentUpdate columns (and author.community fields) each measured cycle really changed.
// BENCH_VERIFY_POSTUPDATES=1 (real kubo) reads every post's postUpdates file by path from the bucket CID after each
// measured cycle and checks it against the DB. BENCH_PRAGMAS="cache_size=-262144;synchronous=NORMAL" applies SQLite
// pragmas to the community DB, to measure a configuration pkc-js does not ship.
import { performance, PerformanceObserver } from "node:perf_hooks";
import path from "node:path";
import os from "node:os";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { mockPKC } from "../../dist/node/test/test-util.js";
import env from "../../dist/node/version.js";
import { updateCommentsThatNeedToBeUpdated } from "../../dist/node/runtime/node/community/local-community/comment-updates.js";
import {
    updateCommentsAndWritePostUpdates,
    updateCommunityIpnsIfNeeded
} from "../../dist/node/runtime/node/community/local-community/ipns-publishing.js";
import { calculateStringSizeSameAsIpfsAddCidV0 } from "../../dist/node/util.js";
import { CommunityIpfsSchema } from "../../dist/node/community/schema.js";
import { DbHandler } from "../../dist/node/runtime/node/community/db-handler.js";
import { PageGenerator } from "../../dist/node/runtime/node/community/page-generator.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";

const COMMENTS = Number(process.env.BENCH_COMMENTS) > 0 ? Number(process.env.BENCH_COMMENTS) : 1000;
const POSTS = Math.max(1, Math.round(COMMENTS / 56));
// One author for the whole board: the seeder draws every comment from POSTS / POSTS_PER_AUTHOR authors.
process.env.BENCH_POSTS = String(POSTS);
process.env.BENCH_POSTS_PER_AUTHOR = String(POSTS);
process.env.BENCH_PIPELINE = "1"; // comment rows only; the first cycle calculates every CommentUpdate
const DATA_PATH = process.env.BENCH_DATA_PATH || path.join(os.homedir(), ".cache", "pkc-js-bench");
const REAL_KUBO = process.env.BENCH_REAL_KUBO === "1";
const SCENARIOS = (
    process.env.BENCH_SCENARIOS || "comment-by-board-author,vote-on-board-author,reply-by-new-author,post-by-new-author"
).split(",");
const OUT =
    process.env.BENCH_OUT || path.resolve(process.cwd(), ".tmp", "bench", `author-cascade-${COMMENTS}${REAL_KUBO ? "-kubo" : ""}.json`);
const STAGES = process.env.BENCH_STAGES === "1";
const CPU_PROF_DIR = process.env.BENCH_CPU_PROF ? path.resolve(process.env.BENCH_CPU_PROF) : undefined;
const { seedBoard } = await import("./page-generation-bench.mjs");

// Stage timers. A label's wall time is the union of the intervals during which one of its calls was in flight, so
// fifty concurrent page generations count once; sumMs adds every call's own duration.
const stages = new Map();
let stagesOn = false;
const stageEnter = (label) => {
    let stage = stages.get(label);
    if (!stage) stages.set(label, (stage = { inflight: 0, since: 0, wallMs: 0, sumMs: 0, calls: 0 }));
    const start = performance.now();
    if (stage.inflight++ === 0) stage.since = start;
    stage.calls++;
    return { stage, start };
};
const stageExit = ({ stage, start }) => {
    const end = performance.now();
    stage.sumMs += end - start;
    if (--stage.inflight === 0) stage.wallMs += end - stage.since;
};
const timeStage = (target, name, label) => {
    const original = target[name];
    if (typeof original !== "function" || original.__benchStage) return;
    const wrapped = function (...args) {
        if (!stagesOn) return original.apply(this, args);
        const token = stageEnter(label);
        let result;
        try {
            result = original.apply(this, args);
        } catch (error) {
            stageExit(token);
            throw error;
        }
        if (result && typeof result.then === "function") return result.finally(() => stageExit(token));
        if (result && typeof result[Symbol.asyncIterator] === "function")
            return (async function* () {
                try {
                    yield* result;
                } finally {
                    stageExit(token);
                }
            })();
        stageExit(token);
        return result;
    };
    wrapped.__benchStage = true;
    try {
        target[name] = wrapped;
    } catch {
        // a read-only property stays untimed
    }
};
const publicMethods = (proto) =>
    Object.getOwnPropertyNames(proto).filter(
        (name) => name !== "constructor" && typeof Object.getOwnPropertyDescriptor(proto, name).value === "function"
    );
if (STAGES) {
    // BENCH_STAGES_PRIVATE=1 also times the private _query* helpers of the batched field calc
    for (const name of publicMethods(DbHandler.prototype).filter(
        (name) => !name.startsWith("_") || (process.env.BENCH_STAGES_PRIVATE === "1" && name.startsWith("_query"))
    ))
        timeStage(DbHandler.prototype, name, `db.${name}`);
    for (const name of publicMethods(PageGenerator.prototype)) timeStage(PageGenerator.prototype, name, `pages.${name}`);
}
const timeKuboClient = (client) => {
    for (const name of Object.keys(client)) {
        const value = client[name];
        if (typeof value === "function") timeStage(client, name, `kubo.${name}`);
        else if (value && typeof value === "object")
            for (const sub of Object.keys(value)) if (typeof value[sub] === "function") timeStage(value, sub, `kubo.${name}.${sub}`);
    }
};
let gcMs = 0;
if (STAGES)
    new PerformanceObserver((list) => list.getEntries().forEach((entry) => (gcMs += entry.duration))).observe({ entryTypes: ["gc"] });
const startStages = () => {
    stages.clear();
    gcMs = 0;
    stagesOn = STAGES;
};
const stopStages = () => {
    stagesOn = false;
    if (!STAGES) return undefined;
    const out = { gcMs: Math.round(gcMs) };
    const sorted = [...stages.entries()].sort((a, b) => b[1].wallMs - a[1].wallMs);
    for (const [label, stage] of sorted)
        if (stage.wallMs >= 1 || stage.sumMs >= 1)
            out[label] = { wallMs: Math.round(stage.wallMs), sumMs: Math.round(stage.sumMs), calls: stage.calls };
    return out;
};
let profilerSession;
const startProfile = async () => {
    if (!CPU_PROF_DIR) return;
    if (!profilerSession) {
        const { Session } = await import("node:inspector/promises");
        profilerSession = new Session();
        profilerSession.connect();
        await profilerSession.post("Profiler.enable");
        await profilerSession.post("Profiler.setSamplingInterval", { interval: 2000 });
    }
    await profilerSession.post("Profiler.start");
};
const stopProfile = async (label) => {
    if (!profilerSession) return undefined;
    const { profile } = await profilerSession.post("Profiler.stop");
    mkdirSync(CPU_PROF_DIR, { recursive: true });
    const file = path.join(CPU_PROF_DIR, `author-cascade-${COMMENTS}-${label}.cpuprofile`);
    writeFileSync(file, JSON.stringify(profile));
    return file;
};

const SIGNATURE = { type: "ed25519", signature: "sig", publicKey: Buffer.alloc(32, 7).toString("base64"), signedPropertyNames: [] };
const BOARD_AUTHOR = "author-0"; // what the seeder names its only author
let fakeCounter = 10_000_000;
const fakeCid = (n) => "Qm" + String(n).padStart(44, "b"); // never read back through the schema here

const now = () => Math.floor(Date.now() / 1000);
const ms = (start) => Math.round(performance.now() - start);
const rows = [];
const log = (row) => {
    rows.push(row);
    console.log(JSON.stringify(row));
};

async function runCycle(community) {
    if (REAL_KUBO) {
        // The real cycle, as syncIpnsWithDb runs it: CommentUpdates with their reply pages and postUpdates MFS writes,
        // then the record (posts pages, MFS stat, add, IPNS publish), which also marks the cids published.
        const start = performance.now();
        const cids = await updateCommentsAndWritePostUpdates(community);
        const commentUpdatesMs = ms(start);
        community._communityUpdateTrigger = true; // a vote inserted straight into the DB does not arm it
        const recordStart = performance.now();
        await updateCommunityIpnsIfNeeded(community, cids);
        return { updated: cids.length, cycleMs: ms(start), commentUpdatesMs, recordMs: ms(recordStart) };
    }
    // The publish cycle's consumer: keep only cids, the way syncIpnsWithDb does, so the heap does not grow with the board
    let updated = 0;
    const cids = [];
    const start = performance.now();
    await updateCommentsThatNeedToBeUpdated(community, (slice) => {
        updated += slice.length;
        for (const row of slice) cids.push(row.newCommentUpdate.cid);
    });
    const cycleMs = ms(start);
    community._dbHandler.markCommentsAsPublishedToPostUpdates(cids);
    return { updated, cycleMs };
}

function flagQuery(community) {
    const start = performance.now();
    const byDepth = community._dbHandler.queryCidsToBeUpdatedByDepth();
    const flagMs = ms(start);
    let flagged = 0;
    for (const cids of byDepth.values()) flagged += cids.length;
    return { flagged, flagMs };
}

function latestPost(db) {
    return db.prepare("SELECT cid FROM comments WHERE depth = 0 ORDER BY rowid DESC LIMIT 1").get().cid;
}

function insertReply(community, authorSignerAddress, { topLevel = false } = {}) {
    const db = community._dbHandler["_db"];
    const cid = fakeCid(++fakeCounter);
    const postCid = topLevel ? cid : latestPost(db);
    const timestamp = now();
    community._dbHandler.insertComments([
        {
            cid,
            authorSignerAddress,
            author: { address: authorSignerAddress },
            parentCid: topLevel ? null : postCid,
            postCid,
            communityPublicKey: community.signer.address,
            content: "one more reply",
            timestamp,
            signature: SIGNATURE,
            title: topLevel ? "one more post" : null,
            depth: topLevel ? 0 : 1,
            protocolVersion: env.PROTOCOL_VERSION,
            insertedAt: timestamp
        }
    ]);
    return cid;
}

function insertVote(community, commentCid) {
    const timestamp = now();
    community._dbHandler.insertVotes([
        { commentCid, vote: 1, timestamp, insertedAt: timestamp, authorSignerAddress: "voter-1", protocolVersion: env.PROTOCOL_VERSION }
    ]);
}

// The daemon's own CPU (Linux only): utime + stime of the process listening on the kubo RPC port, read from
// /proc/<pid>/stat before and after a cycle. Everything the daemon does in that window counts, not only our calls.
const KUBO_PID = (() => {
    if (!REAL_KUBO || process.platform !== "linux") return undefined;
    try {
        const port = new URL(process.env.KUBO_RPC_URL || "http://localhost:15001/api/v0").port;
        const match = execSync(`ss -ltnp 'sport = :${port}'`, { encoding: "utf8" }).match(/pid=(\d+)/);
        return match ? Number(match[1]) : undefined;
    } catch {
        return undefined;
    }
})();
const CLK_TCK = 100;
const kuboCpuMs = () => {
    if (!KUBO_PID) return undefined;
    const fields = readFileSync(`/proc/${KUBO_PID}/stat`, "utf8").split(") ").pop().split(" ");
    return Math.round(((Number(fields[11]) + Number(fields[12])) * 1000) / CLK_TCK); // utime, stime: fields 14 and 15 of stat
};

// BENCH_DIFF=1: which columns of each CommentUpdate row a cycle really changed. author is split into its
// author.community fields; replies is the DB's CID-ref form, so a change there means a new page CID or a new inline page.
const snapshotCommentUpdates = (community) => {
    const map = new Map();
    for (const row of community._dbHandler["_db"]
        .prepare("SELECT cu.*, c.depth FROM commentUpdates cu JOIN comments c USING (cid)")
        .iterate())
        map.set(row.cid, row);
    return map;
};
const diffCommentUpdates = (before, after) => {
    const ignore = new Set(["cid", "updatedAt", "signature", "insertedAt", "publishedToPostUpdatesMFS", "depth"]);
    const changedColumns = {};
    const authorFields = {};
    let rewritten = 0;
    let onlyUpdatedAtAndSignature = 0;
    let onlyRepliesBesidesThat = 0;
    for (const [cid, now] of after) {
        const old = before.get(cid);
        if (!old || old.updatedAt === now.updatedAt) continue;
        rewritten++;
        const changed = Object.keys(now).filter((col) => !ignore.has(col) && now[col] !== old[col]);
        for (const col of changed) changedColumns[col] = (changedColumns[col] || 0) + 1;
        if (changed.includes("author")) {
            const a = JSON.parse(old.author || "{}").community || {};
            const b = JSON.parse(now.author || "{}").community || {};
            for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
                if (JSON.stringify(a[key]) !== JSON.stringify(b[key])) authorFields[key] = (authorFields[key] || 0) + 1;
        }
        if (changed.length === 0) onlyUpdatedAtAndSignature++;
        else if (changed.length === 1 && changed[0] === "replies") onlyRepliesBesidesThat++;
    }
    return { rewritten, onlyUpdatedAtAndSignature, onlyRepliesBesidesThat, changedColumns, authorFields };
};

// BENCH_VERIFY_POSTUPDATES=1: every post's postUpdates file, read by path from the bucket CID the record would publish, must be
// the CommentUpdate the DB holds (same updatedAt and signature), and the bucket must list exactly the board's posts.
const verifyPostUpdates = async (community) => {
    const kubo = community._clientsManager.getDefaultKuboRpcClient()._client;
    const posts = community._dbHandler["_db"]
        .prepare(
            "SELECT cu.cid, cu.updatedAt, cu.signature, cu.postUpdatesBucket FROM commentUpdates cu JOIN comments c USING (cid) WHERE c.depth = 0"
        )
        .all();
    let checked = 0;
    let mismatched = 0;
    let firstMismatch;
    const listed = {};
    const buckets = [...new Set(posts.map((post) => post.postUpdatesBucket))];
    const bucketCids = {};
    for (const bucket of buckets) {
        bucketCids[bucket] = (await kubo.files.stat(`/${community.address}/postUpdates/${bucket}`)).cid.toString();
        listed[bucket] = 0;
        for await (const _ of kubo.ls(`/ipfs/${bucketCids[bucket]}`)) listed[bucket]++;
    }
    for (const post of posts) {
        const chunks = [];
        for await (const chunk of kubo.cat(`/ipfs/${bucketCids[post.postUpdatesBucket]}/${post.cid}/update`)) chunks.push(chunk);
        const update = JSON.parse(Buffer.concat(chunks).toString());
        checked++;
        if (update.updatedAt !== post.updatedAt || update.signature.signature !== JSON.parse(post.signature).signature) {
            if (mismatched === 0)
                firstMismatch = {
                    cid: post.cid,
                    fileUpdatedAt: update.updatedAt,
                    dbUpdatedAt: post.updatedAt,
                    sameSig: update.signature.signature === JSON.parse(post.signature).signature
                };
            mismatched++;
        }
    }
    return { posts: posts.length, checked, mismatched, firstMismatch, listed };
};

// Peak memory during a measured cycle, sampled every 250 ms: this process's RSS and V8 heap, and the
// kubo daemon's RSS (VmRSS from /proc, Linux only). Peaks, not averages, since the question is how much the cycle needs.
const kuboRssMB = () => {
    if (!KUBO_PID) return undefined;
    const match = readFileSync(`/proc/${KUBO_PID}/status`, "utf8").match(/VmRSS:\s+(\d+) kB/);
    return match ? Math.round(Number(match[1]) / 1024) : undefined;
};
const startMemSampler = () => {
    const peak = { rssMB: 0, heapUsedMB: 0, kuboRssMB: 0 };
    const sample = () => {
        const mem = process.memoryUsage();
        peak.rssMB = Math.max(peak.rssMB, Math.round(mem.rss / 1024 / 1024));
        peak.heapUsedMB = Math.max(peak.heapUsedMB, Math.round(mem.heapUsed / 1024 / 1024));
        const kubo = kuboRssMB();
        if (kubo !== undefined) peak.kuboRssMB = Math.max(peak.kuboRssMB, kubo);
    };
    sample();
    const timer = setInterval(sample, 250);
    return () => {
        clearInterval(timer);
        sample();
        return { peakRssMB: peak.rssMB, peakHeapUsedMB: peak.heapUsedMB, ...(KUBO_PID ? { peakKuboRssMB: peak.kuboRssMB } : {}) };
    };
};

const nextSecond = () => new Promise((resolve) => setTimeout(resolve, 1100));

async function scenario(community, label, mutate) {
    if (!SCENARIOS.includes(label)) return;
    // Measure the cost of one publication: the flag query it triggers and the full cycle that follows. insertedAt
    // is in seconds and arm 2 compares with >= (issue #209: nothing inserted during a batch may be missed), so a row
    // inserted in the same second a cycle starts is re-flagged once more by the next cycle. Land the insert in a
    // later second than the previous cycle and the cycle in a later second than the insert, as a live board does.
    await nextSecond();
    mutate();
    await nextSecond();
    if (global.gc) global.gc();
    const cpuBefore = process.cpuUsage();
    const kuboBefore = kuboCpuMs();
    const { flagged, flagMs } = flagQuery(community);
    const cycleCpuBefore = process.cpuUsage();
    await startProfile();
    startStages();
    const diffBefore = process.env.BENCH_DIFF === "1" ? snapshotCommentUpdates(community) : undefined;
    const stopMem = startMemSampler();
    const { updated, cycleMs, ...phases } = await runCycle(community);
    const memory = stopMem();
    const stageBreakdown = stopStages();
    if (diffBefore) log({ event: `${label}:diff`, ...diffCommentUpdates(diffBefore, snapshotCommentUpdates(community)) });
    if (REAL_KUBO && process.env.BENCH_VERIFY_POSTUPDATES === "1")
        log({ event: `${label}:verify-postUpdates`, ...(await verifyPostUpdates(community)) });
    const cycleCpu = process.cpuUsage(cycleCpuBefore);
    const profile = await stopProfile(label);
    const cpu = process.cpuUsage(cpuBefore);
    const kuboAfter = kuboCpuMs();
    log({
        event: label,
        flagged,
        flagMs,
        updated,
        cycleMs,
        ...phases,
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        cycleCpuMs: Math.round((cycleCpu.user + cycleCpu.system) / 1000),
        ...(kuboBefore !== undefined ? { kuboCpuMs: kuboAfter - kuboBefore } : {}),
        ...memory,
        ...(stageBreakdown ? { stages: stageBreakdown } : {}),
        ...(profile ? { profile } : {})
    });
}

async function main() {
    mkdirSync(DATA_PATH, { recursive: true });
    const pkc = await mockPKC({ dataPath: DATA_PATH });
    const community = await pkc.createCommunity();
    await community._dbHandler.initDbIfNeeded();
    await community._dbHandler.createOrMigrateTablesIfNeeded();
    // BENCH_PRAGMAS="cache_size=-262144;synchronous=NORMAL" applies SQLite pragmas to the community DB, to measure a
    // configuration pkc-js does not ship (issue #471 lists it as an option)
    const applyPragmas = () => {
        for (const pragma of (process.env.BENCH_PRAGMAS || "").split(";").filter(Boolean)) community._dbHandler["_db"].pragma(pragma);
    };
    applyPragmas();
    const noop = async () => {};
    if (REAL_KUBO) {
        // Start for real (IPNS key, MFS root, pubsub), let the publish loop exit after its first (empty) cycle, and
        // drop the record's two verifyCommunity calls: a seeded board's comments carry placeholder signatures.
        await community.start();
        community._stopHasBeenCalled = true;
        await community._publishLoopPromise;
        community._validateCommunitySizeSchemaAndSignatureBeforePublishing = async (record) => {
            await calculateStringSizeSameAsIpfsAddCidV0(deterministicStringify(record));
            CommunityIpfsSchema.safeParse(record);
        };
        if (STAGES) timeKuboClient(community._clientsManager.getDefaultKuboRpcClient()._client);
    } else
        community._clientsManager.getDefaultKuboRpcClient = () => ({
            _client: {
                add: async (content) => ({ cid: fakeCid(++fakeCounter), path: fakeCid(fakeCounter), size: content.length }),
                pin: { rm: noop },
                files: { rm: noop },
                key: { rm: noop },
                routing: { async *provide() {} }
            }
        });
    applyPragmas(); // start() may have reopened the connection
    if (process.env.BENCH_PRAGMAS)
        console.log(
            JSON.stringify({
                event: "pragmas",
                ...Object.fromEntries(
                    ["cache_size", "synchronous", "mmap_size", "temp_store", "journal_mode"].map((p) => [
                        p,
                        community._dbHandler["_db"].pragma(p, { simple: true })
                    ])
                )
            })
        );
    if (STAGES) timeStage(community, "_calculateNewPostUpdates", "record.calculateNewPostUpdates");
    const dbFile = path.join(DATA_PATH, "communities", community.address);
    try {
        const seedStart = performance.now();
        const { replyTotal } = seedBoard(community);
        const db = community._dbHandler["_db"];
        // The seeder dates the last posts' replies up to 500 s into the future; a row inserted after its CommentUpdate
        // is re-flagged by arm 2 on every cycle, so the board would never reach the steady state. Shift it into the past.
        db.exec("UPDATE comments SET timestamp = timestamp - 3600, insertedAt = insertedAt - 3600");
        const counts = () => ({
            comments: db.prepare("SELECT count(*) AS n FROM comments").get().n,
            authors: db.prepare("SELECT count(DISTINCT authorSignerAddress) AS n FROM comments").get().n,
            dbMB: Math.round(statSync(dbFile).size / 1024 / 1024)
        });
        log({ event: "seeded", posts: POSTS, replies: replyTotal, ...counts(), seedMs: ms(seedStart) });

        // Cycle 0: every comment is flagged by arm 1 (no CommentUpdate yet). This is also what one cascade costs,
        // measured without the flag query.
        const firstCpu = process.cpuUsage();
        const firstKubo = kuboCpuMs();
        const stopFirstMem = startMemSampler();
        const first = await runCycle(community);
        const firstMemory = stopFirstMem();
        const firstCpuAfter = process.cpuUsage(firstCpu);
        log({
            event: "first-cycle",
            ...first,
            cpuMs: Math.round((firstCpuAfter.user + firstCpuAfter.system) / 1000),
            ...(firstKubo !== undefined ? { kuboCpuMs: kuboCpuMs() - firstKubo } : {}),
            ...firstMemory,
            ...counts()
        });

        await nextSecond();
        const idle = flagQuery(community);
        log({ event: "idle", ...idle });

        await scenario(community, "comment-by-board-author", () => insertReply(community, BOARD_AUTHOR));
        await scenario(community, "vote-on-board-author", () => insertVote(community, latestPost(db)));
        await scenario(community, "reply-by-new-author", () => insertReply(community, "author-new"));
        await scenario(community, "post-by-new-author", () => insertReply(community, "author-new-2", { topLevel: true }));
        await nextSecond();
        const idleAfter = flagQuery(community);
        log({ event: "idle-after", ...idleAfter });

        const summary = {
            comments: COMMENTS,
            posts: POSTS,
            kubo: REAL_KUBO ? "real" : "stubbed",
            node: process.version,
            date: new Date().toISOString(),
            rows
        };
        mkdirSync(path.dirname(OUT), { recursive: true });
        writeFileSync(OUT, JSON.stringify(summary, null, 2));
        console.log(JSON.stringify({ event: "done", out: OUT, dbFile }));
    } finally {
        await community.stop().catch(() => {});
        if (process.env.BENCH_KEEP !== "1") await community.delete().catch((error) => console.error("delete failed", error));
        await pkc.destroy().catch(() => {});
    }
}

main().then(
    () => process.exit(0),
    (error) => {
        console.error(error);
        process.exit(1);
    }
);

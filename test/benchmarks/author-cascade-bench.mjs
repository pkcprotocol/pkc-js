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
import { performance } from "node:perf_hooks";
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
const { seedBoard } = await import("./page-generation-bench.mjs");

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
        community._communityUpdateTrigger = true; // a vote inserted straight into the DB does not arm it
        await updateCommunityIpnsIfNeeded(community, cids);
        return { updated: cids.length, cycleMs: ms(start) };
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
    const { updated, cycleMs } = await runCycle(community);
    const cpu = process.cpuUsage(cpuBefore);
    const kuboAfter = kuboCpuMs();
    log({
        event: label,
        flagged,
        flagMs,
        updated,
        cycleMs,
        cpuMs: Math.round((cpu.user + cpu.system) / 1000),
        ...(kuboBefore !== undefined ? { kuboCpuMs: kuboAfter - kuboBefore } : {})
    });
}

async function main() {
    mkdirSync(DATA_PATH, { recursive: true });
    const pkc = await mockPKC({ dataPath: DATA_PATH });
    const community = await pkc.createCommunity();
    await community._dbHandler.initDbIfNeeded();
    await community._dbHandler.createOrMigrateTablesIfNeeded();
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
        const first = await runCycle(community);
        const firstCpuAfter = process.cpuUsage(firstCpu);
        log({
            event: "first-cycle",
            ...first,
            cpuMs: Math.round((firstCpuAfter.user + firstCpuAfter.system) / 1000),
            ...(firstKubo !== undefined ? { kuboCpuMs: kuboCpuMs() - firstKubo } : {}),
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

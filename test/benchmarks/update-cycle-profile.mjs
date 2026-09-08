// Per-method time of one update cycle (issue #352): which statements and steps of
// updateCommentsThatNeedToBeUpdated cost what on the seeded bench board, kubo stubbed. NOT part of any CI glob;
// run manually with the test server up (mockPKC points at its kubo) and dist/ freshly built:
//
//   BENCH_POSTS=2000 node --max-old-space-size=8192 test/benchmarks/update-cycle-profile.mjs
//
// Env: the seeding knobs of page-generation-bench.mjs (BENCH_POSTS, BENCH_MIN_REPLIES / BENCH_MAX_REPLIES,
// BENCH_POSTS_PER_AUTHOR, BENCH_SEED). Every comment is flagged for an update (commentUpdates is cleared after
// seeding), the way the pipeline bench's later iterations run. Timers wrap leaf DB methods and the page generator's
// entry points, so a wrapped method's total is exclusive of the other wrapped ones only where they do not nest;
// signing and verification are module exports and are sampled on one representative CommentUpdate instead. For CPU
// attribution across everything use --cpu-prof on page-generation-bench.mjs and cpuprofile-summary.mjs.
import { performance } from "node:perf_hooks";
import { mockPKC } from "../../dist/node/test/test-util.js";
import { seedBoard } from "./page-generation-bench.mjs";
import * as commentUpdates from "../../dist/node/runtime/node/community/local-community/comment-updates.js";
import { DbHandler } from "../../dist/node/runtime/node/community/db-handler.js";
import { PageGenerator } from "../../dist/node/runtime/node/community/page-generator.js";
import * as signatures from "../../dist/node/signer/signatures.js";

const totals = new Map();
const add = (label, ms) => {
    const total = totals.get(label) ?? { ms: 0, calls: 0 };
    total.ms += ms;
    total.calls++;
    totals.set(label, total);
};
const wrap = (target, name, label) => {
    const original = target[name];
    if (typeof original !== "function") return;
    target[name] = function (...args) {
        const start = performance.now();
        const result = original.apply(this, args);
        if (result && typeof result.then === "function") return result.finally(() => add(label, performance.now() - start));
        add(label, performance.now() - start);
        return result;
    };
};
const DB_LEAVES = [
    "queryCommentsToBeUpdated",
    "queryCalculatedCommentUpdates",
    "queryCommentUpdateTimestampBucketRepliesByCids",
    "queryPageCommentsWithResolvedReplies",
    "queryFlattenedPageReplies",
    "queryAllRepliesForPageSort",
    "upsertCommentUpdates",
    "markCommentsAsPublishedToPostUpdates"
];
for (const name of DB_LEAVES) wrap(DbHandler.prototype, name, `db.${name}`);
for (const name of ["generatePostPages", "generateReplyPages", "_addChunksToIpfs", "sortAndChunkComments"])
    wrap(PageGenerator.prototype, name, `gen.${name}`);

const pkc = await mockPKC();
const community = await pkc.createCommunity();
await community._dbHandler.initDbIfNeeded();
await community._dbHandler.createOrMigrateTablesIfNeeded();
let added = 0;
const noop = async () => {};
community._clientsManager.getDefaultKuboRpcClient = () => ({
    _client: {
        add: async (content) => ({ cid: `Qm${(++added).toString(36).padStart(44, "0")}`, path: "x", size: content.length }),
        pin: { rm: noop },
        files: { rm: noop },
        key: { rm: noop },
        routing: { async *provide() {} }
    }
});
try {
    seedBoard(community);
    community._dbHandler["_db"].exec("DELETE FROM commentUpdates");
    totals.clear();
    {
        const row = community._dbHandler["_db"].prepare("SELECT * FROM comments WHERE depth = 0 LIMIT 1").get();
        const comment = community._dbHandler["_parseCommentsTableRow"](row);
        const calculated = community._dbHandler.queryCalculatedCommentUpdate({ comment });
        const update = signatures.cleanUpBeforePublishing({ ...calculated, updatedAt: Math.round(Date.now() / 1000), protocolVersion: "1.0.0" });
        const N = 2000;
        let signed;
        let start = performance.now();
        for (let i = 0; i < N; i++) signed = { ...update, signature: await signatures.signCommentUpdate({ update, signer: community.signer }) };
        add("sign.signCommentUpdate (sampled)", performance.now() - start);
        start = performance.now();
        for (let i = 0; i < N; i++) await commentUpdates.validateCommentUpdateSignature(community, signed, comment, { error() {} });
        add("sign.validateCommentUpdateSignature (sampled)", performance.now() - start);
        for (const label of ["sign.signCommentUpdate (sampled)", "sign.validateCommentUpdateSignature (sampled)"]) totals.get(label).calls = N;
    }
    const start = performance.now();
    const updates = await commentUpdates.updateCommentsThatNeedToBeUpdated(community);
    const total = performance.now() - start;
    console.log(`cycle: ${Math.round(total)} ms for ${updates.length} comments`);
    for (const [label, t] of [...totals.entries()].sort((a, b) => b[1].ms - a[1].ms))
        console.log(
            `${label.padEnd(55)} ${String(Math.round(t.ms)).padStart(7)} ms ${String(t.calls).padStart(8)} calls ${(t.ms / t.calls)
                .toFixed(3)
                .padStart(8)} ms/call ${((t.ms / total) * 100).toFixed(1).padStart(5)}%`
        );
} finally {
    await community._dbHandler.destoryConnection();
    await community.delete();
    await pkc.destroy();
}
process.exit(0);

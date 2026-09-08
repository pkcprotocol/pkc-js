// Self and inclusive time per function from a V8 .cpuprofile (issue #352). NOT part of any CI glob. Usage:
//
//   node --cpu-prof --cpu-prof-dir=.tmp/prof test/benchmarks/page-generation-bench.mjs
//   node test/benchmarks/cpuprofile-summary.mjs .tmp/prof/CPU.*.cpuprofile [functionName ...]
//
// Prints the top 30 functions by self time, then the inclusive time of the named functions (defaults to the update
// cycle's steps). Inclusive time follows the sampled stack, so an async function's continuations count toward it
// only while they are on the stack.
import { readFileSync } from "node:fs";
import path from "node:path";

const [file, ...wanted] = process.argv.slice(2);
if (!file) {
    console.error("usage: cpuprofile-summary.mjs <profile.cpuprofile> [functionName ...]");
    process.exit(1);
}
const profile = JSON.parse(readFileSync(file, "utf8"));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const label = (node) => {
    const frame = node.callFrame;
    return `${frame.functionName || "(anon)"} ${frame.url ? path.basename(frame.url) : ""}:${frame.lineNumber + 1}`;
};
const selfByFn = new Map();
const inclusiveByFn = new Map();
const bump = (map, key, us) => map.set(key, (map.get(key) ?? 0) + us);
let total = 0;
profile.samples.forEach((id, index) => {
    const us = profile.timeDeltas[index];
    total += us;
    bump(selfByFn, label(nodes.get(id)), us);
    const seen = new Set();
    for (let current = id; current !== undefined && !seen.has(current); current = parent.get(current)) {
        seen.add(current);
        bump(inclusiveByFn, label(nodes.get(current)), us);
    }
});
const DEFAULT_WANTED = [
    "updateCommentsThatNeedToBeUpdated",
    "calculateNewCommentUpdate",
    "queryCalculatedCommentUpdates",
    "queryCommentsToBeUpdated",
    "_generatePagesForSorts",
    "verifyCommentUpdate",
    "signCommentUpdate",
    "upsertCommentUpdates",
    "queryPageCommentsWithResolvedReplies",
    "generateCommunityPosts",
    "_prepareCached"
];
const seconds = (us) => `${(us / 1e6).toFixed(2).padStart(7)}s ${((us / total) * 100).toFixed(1).padStart(5)}%`;
console.log(`total sampled ${(total / 1e6).toFixed(1)}s\n\n== self time (top 30)`);
for (const [fn, us] of [...selfByFn].sort((a, b) => b[1] - a[1]).slice(0, 30)) console.log(`${seconds(us)}  ${fn}`);
console.log("\n== inclusive time");
const names = new Set(wanted.length ? wanted : DEFAULT_WANTED);
for (const [fn, us] of [...inclusiveByFn].filter(([fn]) => names.has(fn.split(" ")[0])).sort((a, b) => b[1] - a[1]))
    console.log(`${seconds(us)}  ${fn}`);

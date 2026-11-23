// Who calls a hot leaf function in a V8 .cpuprofile (issue #576). NOT part of any CI glob. cpuprofile-summary.mjs
// says that a native such as `readdir` or `Database` is hot; this says which pkc-js code called it. Usage:
//
//   node test/benchmarks/cpuprofile-callers.mjs <profile.cpuprofile> <functionName> [functionName ...]
//
// For every sample whose leaf is one of the named functions it prints the self time grouped by the nearest five
// pkc-js frames (dist/node) above it, innermost first.
import { readFileSync } from "node:fs";
import path from "node:path";

const [file, ...targets] = process.argv.slice(2);
if (!file || targets.length === 0) {
    console.error("usage: cpuprofile-callers.mjs <profile.cpuprofile> <functionName> [functionName ...]");
    process.exit(1);
}
const profile = JSON.parse(readFileSync(file, "utf8"));
const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
const parent = new Map();
for (const node of profile.nodes) for (const child of node.children ?? []) parent.set(child, node.id);
const label = (node) => {
    const frame = node.callFrame;
    return `${frame.functionName || "(anon)"} ${path.basename(frame.url || "")}:${frame.lineNumber + 1}`;
};
const selfUs = new Map();
profile.samples.forEach((id, index) => selfUs.set(id, (selfUs.get(id) ?? 0) + profile.timeDeltas[index]));

for (const target of targets) {
    const byCallers = new Map();
    for (const [id, us] of selfUs) {
        if (nodes.get(id).callFrame.functionName !== target) continue;
        const callers = [];
        for (let current = parent.get(id); current !== undefined && callers.length < 5; current = parent.get(current)) {
            const node = nodes.get(current);
            if (node.callFrame.url.includes("dist/node")) callers.push(label(node));
        }
        const key = callers.join(" < ") || "(no pkc-js caller)";
        byCallers.set(key, (byCallers.get(key) ?? 0) + us);
    }
    console.log(`== ${target}`);
    for (const [callers, us] of [...byCallers].sort((a, b) => b[1] - a[1]).slice(0, 8))
        console.log(`${(us / 1e6).toFixed(1).padStart(8)}s  ${callers}`);
}

// Imports every module under dist/node in its own fresh Node process and fails if any of them
// throws at import time.
//
// Why: the codebase has hundreds of import cycles, almost all harmless (type-only or only used
// inside functions). A cycle becomes a bug when a module uses another module's export at the
// top level (e.g. `SomeSchema.strict()` / `.extend()`) while that module is still evaluating.
// Whether it explodes depends purely on which module is imported FIRST, so the bug is invisible
// to tsc, to `madge --circular` (drowned in noise) and to most tests (they enter via index.js,
// which happens to pick a benign order). It only surfaces when a test or consumer imports a leaf
// module directly, which is what broke CI on PR #294. Pre-existing failures live in
// config/module-import-order-baseline.json and are tracked in issue #295.
//
// A fresh process per module is required: within one process, ESM caches a module after its first
// evaluation, so later imports can never reproduce a different entry order.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import url from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const distDir = path.join(root, "dist", "node");

if (!fs.existsSync(distDir)) {
    console.error(`verify-module-import-order: ${distDir} does not exist. Run 'npm run build:node' first.`);
    process.exit(1);
}

function walk(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p, out);
        else if (entry.isFile() && p.endsWith(".js")) out.push(p);
    }
    return out;
}

const baselinePath = path.join(__dirname, "module-import-order-baseline.json");
const baseline = new Set(JSON.parse(fs.readFileSync(baselinePath, "utf8")).modules);

const modules = walk(distDir)
    // Test files under src/rpc/test are compiled into dist too; they import vitest and are not library modules.
    .filter((p) => !p.split(path.sep).includes("test"))
    // Browser-only shims that touch `window` at top level; never imported under Node.
    .filter((p) => !p.endsWith(path.join("runtime", "browser", "polyfill.js")))
    .sort();

const concurrency = Math.max(2, Math.min(8, os.cpus().length));
const failures = [];
let next = 0;

async function worker() {
    while (next < modules.length) {
        const file = modules[next++];
        const rel = path.relative(root, file);
        try {
            await execFileAsync(
                process.execPath,
                ["--input-type=module", "-e", `await import(${JSON.stringify(url.pathToFileURL(file).href)});`],
                { cwd: root, timeout: 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, NODE_NO_WARNINGS: "1" } }
            );
        } catch (err) {
            const stderr = (err.stderr ?? "").toString().trim();
            failures.push({ rel, stderr: stderr || err.message });
        }
    }
}

await Promise.all(Array.from({ length: concurrency }, worker));

const failingRel = new Set(failures.map((f) => f.rel.split(path.sep).join("/")));
const newFailures = failures.filter((f) => !baseline.has(f.rel.split(path.sep).join("/")));
const fixed = [...baseline].filter((rel) => !failingRel.has(rel));

if (fixed.length > 0) {
    console.error(
        `verify-module-import-order: ${fixed.length} baselined module(s) now import cleanly. Remove them from ${path.relative(root, baselinePath)} so the baseline keeps shrinking:\n  ${fixed.join("\n  ")}\n`
    );
}

if (newFailures.length > 0) {
    console.error(
        `verify-module-import-order: ${newFailures.length} NEW module(s) (not in the baseline) throw when imported standalone:\n`
    );
    for (const { rel, stderr } of newFailures) {
        console.error(`--- ${rel}`);
        // Keep the first lines: the error type/message and the stack frame pointing at the cycle.
        console.error(stderr.split("\n").slice(0, 12).join("\n"), "\n");
    }
    console.error(
        "A 'Cannot access X before initialization' / 'reading ... of undefined' at import time means a module uses another module's export at top level while a circular import is still evaluating. Move the shared helper into a dependency-free module (see src/domain-util.ts)."
    );
    process.exit(1);
}

if (fixed.length > 0) process.exit(1);

console.log(
    `verify-module-import-order: ${modules.length - failures.length} of ${modules.length} dist/node modules import cleanly standalone (${failures.length} known failures in the baseline).`
);

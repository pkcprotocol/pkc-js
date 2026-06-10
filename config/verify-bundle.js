// Verifies the bundled Node output (dist/bundled, produced by config/build-node-bundle.js)
// before it ships as the package's import/require entry:
//
//   1. Laziness (via dist/bundled/bundle-manifest.json): the helia/libp2p and local-community
//      subgraphs must NOT be in the static import closure of the bundled index.js - they are
//      the lazy boundaries that keep RPC-only consumers from paying for the local-node
//      runtime. A refactor that turns one of them into a static import should fail the build
//      here, not regress consumers silently.
//   2. The user-supplied challenge plugin loader (await import(pathToFileURL(path).href))
//      survived bundling verbatim, and the compile-cache bootstrap kept its dynamic
//      import("./index.js") boundary.
//   3. Export parity: each bundled entry exposes exactly the same named exports as its
//      per-file dist/node counterpart. Compared across fresh child processes so the two
//      flavors are never loaded into one process (module-level state would duplicate).
//   4. require(esm): the require-condition entries load via createRequire - catches
//      top-level await leaking into the index or rpc graphs (ERR_REQUIRE_ASYNC_MODULE).

import fs from "node:fs";
import path from "node:path";
import url from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const bundledDir = path.join(root, "dist", "bundled");

if (!fs.existsSync(bundledDir)) {
    console.error(`verify-bundle: ${bundledDir} does not exist. Run 'npm run build' first.`);
    process.exit(1);
}

const problems = [];

// --- 1. Laziness via the bundle manifest ----------------------------------------------------

const manifest = JSON.parse(fs.readFileSync(path.join(bundledDir, "bundle-manifest.json"), "utf8"));
const outputs = manifest.outputs; // keyed by path relative to dist/bundled

function staticClosure(entryFileName) {
    const seen = new Set();
    const queue = [entryFileName];
    while (queue.length) {
        const current = queue.pop();
        if (seen.has(current)) continue;
        seen.add(current);
        for (const imported of outputs[current]?.imports ?? []) queue.push(imported);
    }
    return seen;
}

function outputContainingInput(inputPath) {
    for (const [fileName, out] of Object.entries(outputs)) {
        if (out.inputs.includes(inputPath)) return fileName;
    }
    return undefined;
}

const indexClosure = staticClosure("index.js");
const lazyInputs = ["dist/node/helia/helia-for-pkc.js", "dist/node/runtime/node/community/local-community.js"];
for (const lazyInput of lazyInputs) {
    const fileName = outputContainingInput(lazyInput);
    if (!fileName) {
        problems.push(`${lazyInput} is in no bundled output - was it renamed? Update verify-bundle.js.`);
    } else if (indexClosure.has(fileName)) {
        problems.push(
            `${lazyInput} (in ${fileName}) is in the STATIC import closure of dist/bundled/index.js - ` +
                `a lazy boundary from the import-time work (issue #120) was lost.`
        );
    }
}

// --- 2. Dynamic-import boundaries survived ---------------------------------------------------

const challengesSubsystemOutput = outputContainingInput("dist/node/runtime/node/community/challenges/index.js");
if (!challengesSubsystemOutput) {
    problems.push("challenges subsystem (runtime/node/community/challenges/index.js) is in no bundled output.");
} else if (!fs.readFileSync(path.join(bundledDir, challengesSubsystemOutput), "utf8").includes("pathToFileURL(")) {
    problems.push(`${challengesSubsystemOutput} lost the pathToFileURL() user-plugin dynamic import.`);
}

const bootstrap = fs.readFileSync(path.join(bundledDir, "index-with-compile-cache.js"), "utf8");
if (!bootstrap.includes('import("./index.js")')) {
    problems.push(
        'dist/bundled/index-with-compile-cache.js lost its dynamic import("./index.js") boundary - ' +
            "the compile cache would no longer cover the main graph."
    );
}

// --- 3 + 4. Export parity and require(esm), in fresh child processes -------------------------

const entries = ["index.js", "index-with-compile-cache.js", "challenges.js", "rpc/src/index.js"];

function exportKeysInChildProcess(fileAbsPath) {
    const script = `const m = await import(${JSON.stringify(url.pathToFileURL(fileAbsPath).href)}); console.log(JSON.stringify(Object.keys(m).sort()));`;
    const stdout = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf8" });
    return JSON.parse(stdout.trim().split("\n").pop());
}

for (const entry of entries) {
    try {
        const perFileKeys = exportKeysInChildProcess(path.join(root, "dist", "node", entry));
        const bundledKeys = exportKeysInChildProcess(path.join(bundledDir, entry));
        if (JSON.stringify(perFileKeys) !== JSON.stringify(bundledKeys)) {
            problems.push(`export mismatch for ${entry}: dist/node has [${perFileKeys}] but dist/bundled has [${bundledKeys}]`);
        }
    } catch (e) {
        problems.push(`importing ${entry} failed in a child process: ${e.message.split("\n")[0]}`);
    }
}

for (const requireEntry of ["index.js", "rpc/src/index.js"]) {
    const fileAbsPath = path.join(bundledDir, requireEntry);
    const script = `const { createRequire } = require("node:module"); createRequire(process.cwd() + "/")(${JSON.stringify(fileAbsPath)}); console.log("ok");`;
    try {
        execFileSync(process.execPath, ["-e", script], { cwd: root, encoding: "utf8" });
    } catch (e) {
        problems.push(
            `require() of dist/bundled/${requireEntry} failed (top-level await leaked into the require path?): ${e.message.split("\n")[0]}`
        );
    }
}

// --- Report -----------------------------------------------------------------------------------

if (problems.length) {
    console.error(`verify-bundle: found ${problems.length} problem(s):\n`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
}

console.log("verify-bundle: ok (lazy chunks intact, exports match dist/node, require(esm) works)");

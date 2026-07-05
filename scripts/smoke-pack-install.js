// Packs the package (npm pack), installs the tarball into a scratch consumer package, and
// exercises the published artifact the way a real consumer would. This is the only check that
// executes the BUNDLED dist (dist/bundled) doing real work from an installed node_modules
// layout: the test suites deep-import the per-file dist/node files and never touch the bundle.
//
// Not part of `npm run build` (npm pack + npm install are too slow for every build); run it
// manually before publishing or when changing the bundling/packaging setup:
//
//   npm run build && node scripts/smoke-pack-install.js
//
// What it checks, each in a fresh child process:
//   1. ESM import of ".", "./challenges" and "./rpc" through the exports map.
//   2. CJS require(".") and "./rpc" (require(esm) - would catch top-level await leaks).
//   3. A real createCommunity() lifecycle - crosses the lazy local-community chunk boundary and
//      loads the external native better-sqlite3 from the installed layout.
//   4. tsc --noEmit on a tiny moduleResolution=nodenext consumer - proves the types condition
//      (dist/node/*.d.ts) resolves against the bundled runtime entries.
//   5. Self-containment: with every INLINED dependency's directory renamed away inside the
//      consumer's node_modules (the dependency list minus config/bundle-externals.js), the
//      imports and the createCommunity() lifecycle still work - proves the Node bundle never
//      resolves the inlined packages at runtime. They stay in package.json dependencies only
//      for the per-file dist/browser path, which consumers' bundlers resolve themselves.
//
// Scratch lives under .tmp/ (gitignored), never /tmp (RAM-backed tmpfs on Linux).

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync, readdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { inlinedDependencyNames } from "../config/bundle-externals.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const smokeDir = path.join(root, ".tmp", "pack-smoke");
const consumerDir = path.join(smokeDir, "consumer");

rmSync(smokeDir, { recursive: true, force: true });
mkdirSync(consumerDir, { recursive: true });

function run(label, file, args, opts = {}) {
    process.stdout.write(`${label}... `);
    const res = spawnSync(file, args, { encoding: "utf8", ...opts });
    if (res.status !== 0) {
        console.log("FAIL");
        console.error(res.stdout);
        console.error(res.stderr);
        process.exit(1);
    }
    console.log("ok");
    return res.stdout;
}

// 1. Pack the tarball.
const packOut = execFileSync("npm", ["pack", "--pack-destination", smokeDir], { cwd: root, encoding: "utf8" });
const tarball = path.join(smokeDir, packOut.trim().split("\n").pop());
console.log(`packed ${path.basename(tarball)}`);

// 2. Install it into a scratch consumer package.
writeFileSync(
    path.join(consumerDir, "package.json"),
    JSON.stringify({ name: "pkc-js-pack-smoke-consumer", private: true, type: "module" }, null, 4)
);
run("npm install (tarball into scratch consumer)", "npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: consumerDir });

// Make sure the consumer really got the bundle as its entry (guards against the exports map
// silently reverting to per-file dist).
const resolvedEntry = run(
    "resolve check (import resolves into dist/bundled)",
    process.execPath,
    ["--input-type=module", "-e", `console.log(import.meta.resolve("@pkcprotocol/pkc-js"));`],
    { cwd: consumerDir }
);
if (!resolvedEntry.includes("dist/bundled/")) {
    console.error(`expected the "." import to resolve into dist/bundled/, got: ${resolvedEntry.trim()}`);
    process.exit(1);
}

// 3. Import every public subpath, ESM and CJS.
for (const subpath of ["@pkcprotocol/pkc-js", "@pkcprotocol/pkc-js/client", "@pkcprotocol/pkc-js/challenges", "@pkcprotocol/pkc-js/rpc"]) {
    run(`esm import ${subpath}`, process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(subpath)});`], {
        cwd: consumerDir
    });
}
for (const subpath of ["@pkcprotocol/pkc-js", "@pkcprotocol/pkc-js/client", "@pkcprotocol/pkc-js/rpc"]) {
    run(`cjs require ${subpath}`, process.execPath, ["-e", `require(${JSON.stringify(subpath)});`], { cwd: consumerDir });
}
// The slim ./client entry must reject when constructed without an RPC client (it has no local node).
run(
    "client entry rejects without pkcRpcClientsOptions",
    process.execPath,
    [
        "--input-type=module",
        "-e",
        `import PKC from "@pkcprotocol/pkc-js/client";
         await PKC({}).then(() => { console.error("expected client PKC() to reject"); process.exit(1); }, () => {});`
    ],
    { cwd: consumerDir }
);

// 4. Real work: createCommunity() through the installed bundle. This crosses the lazy
// local-community chunk boundary and opens a better-sqlite3 database on disk.
const lifecycleScript = (dataPath) => `
import PKC from "@pkcprotocol/pkc-js";
const dataPath = ${JSON.stringify(dataPath)};
// httpRoutersOptions: [] so the smoke test never reconfigures a local Kubo or calls out to
// production routers (see AGENTS.md).
const pkc = await PKC({ dataPath, httpRoutersOptions: [] });
try {
    const community = await pkc.createCommunity({ title: "pack smoke community" });
    if (typeof community.address !== "string" || community.address.length === 0)
        throw new Error("created community has no address");
    console.log("created community " + community.address);
} finally {
    await pkc.destroy();
}
`;
run(
    "createCommunity via installed bundle (lazy chunk + native better-sqlite3)",
    process.execPath,
    ["--input-type=module", "-e", lifecycleScript(path.join(smokeDir, "pkc-data"))],
    { cwd: consumerDir }
);

// 5. Type resolution: a nodenext consumer compiles against the types condition.
writeFileSync(
    path.join(consumerDir, "consumer-check.ts"),
    [
        `import PKC from "@pkcprotocol/pkc-js";`,
        `import type { NameResolver } from "@pkcprotocol/pkc-js";`,
        `const resolver: NameResolver | undefined = undefined;`,
        `void resolver;`,
        `void PKC;`,
        ``
    ].join("\n")
);
writeFileSync(
    path.join(consumerDir, "tsconfig.json"),
    JSON.stringify(
        {
            compilerOptions: {
                module: "nodenext",
                moduleResolution: "nodenext",
                target: "es2022",
                strict: true,
                noEmit: true,
                // consumer-check.ts itself is still fully checked; this only skips pre-existing
                // .d.ts issues inside node_modules (e.g. it-queue needing a newer lib), which are
                // not what this smoke test is about. Resolution of our types condition is proven
                // by the imports in consumer-check.ts compiling at all.
                skipLibCheck: true
            },
            include: ["consumer-check.ts"]
        },
        null,
        4
    )
);
run("tsc --noEmit (nodenext consumer)", path.join(root, "node_modules", ".bin", "tsc"), ["-p", consumerDir]);

// 6. Self-containment: hide every inlined dependency from the consumer's node_modules and
// prove the Node runtime never resolves them (they are only installed for the browser path).
const packageJson = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const inlinedDeps = inlinedDependencyNames(packageJson);
const consumerModules = path.join(consumerDir, "node_modules");
const hidden = [];
for (const dep of inlinedDeps) {
    const depDir = path.join(consumerModules, dep);
    if (!existsSync(depDir)) continue; // not installed (e.g. platform-specific optional)
    renameSync(depDir, depDir + ".hidden-by-smoke");
    hidden.push(depDir);
}
console.log(`hid ${hidden.length} inlined dependencies from the consumer's node_modules`);
try {
    for (const subpath of [
        "@pkcprotocol/pkc-js",
        "@pkcprotocol/pkc-js/client",
        "@pkcprotocol/pkc-js/challenges",
        "@pkcprotocol/pkc-js/rpc"
    ]) {
        run(
            `esm import ${subpath} (inlined deps hidden)`,
            process.execPath,
            ["--input-type=module", "-e", `await import(${JSON.stringify(subpath)});`],
            {
                cwd: consumerDir
            }
        );
    }
    run(
        "createCommunity via installed bundle (inlined deps hidden)",
        process.execPath,
        ["--input-type=module", "-e", lifecycleScript(path.join(smokeDir, "pkc-data-self-contained"))],
        { cwd: consumerDir }
    );
} finally {
    for (const depDir of hidden) renameSync(depDir + ".hidden-by-smoke", depDir);
}

console.log("\nsmoke-pack-install: all checks passed");

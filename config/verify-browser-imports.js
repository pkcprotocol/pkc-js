// Scans dist/browser for relative imports that point at files that don't exist.
// The browser build (config/build-browser.js) is a string-replace copy of dist/node
// that rewrites `/runtime/node/` -> `/runtime/browser/` in import paths. If shared
// code reaches into a runtime/node/ path that has no runtime/browser/ counterpart,
// the rewrite produces a dangling import which only blows up at vite-serve time
// in CI. This script catches that locally.

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const browserDir = path.join(root, "dist", "browser");

if (!fs.existsSync(browserDir)) {
    console.error(`verify-browser-imports: ${browserDir} does not exist. Run 'npm run build' first.`);
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

// matches:
//   import ... from "..."
//   import "..."
//   export ... from "..."
//   await import("...")
const importRe = /(?:\bimport\s+(?:[\s\S]*?\s+from\s+)?|\bexport\s+[\s\S]*?\s+from\s+|\bimport\s*\(\s*)["']([^"']+)["']/g;

const problems = [];

for (const file of walk(browserDir)) {
    const source = fs.readFileSync(file, "utf8");
    for (const match of source.matchAll(importRe)) {
        const spec = match[1];
        // only check relative imports — bare specifiers are resolved by the bundler
        if (!spec.startsWith(".")) continue;
        const resolved = path.resolve(path.dirname(file), spec);
        // ESM specifiers must include extension; we don't try alternates
        if (!fs.existsSync(resolved)) {
            problems.push({ file: path.relative(root, file), spec, resolved: path.relative(root, resolved) });
        }
    }
}

if (problems.length) {
    console.error(`verify-browser-imports: found ${problems.length} dangling import(s) in dist/browser:\n`);
    for (const p of problems) {
        console.error(`  ${p.file}`);
        console.error(`    imports "${p.spec}"`);
        console.error(`    -> ${p.resolved} (missing)`);
    }
    console.error(`\nThis usually means shared code (e.g. src/pkc/) imports from src/runtime/node/`);
    console.error(`at a path that has no src/runtime/browser/ counterpart. Either:`);
    console.error(`  - re-export the symbols from a module that has both runtime/{node,browser}/ versions, or`);
    console.error(`  - add a browser stub at the missing path.`);
    process.exit(1);
}

console.log(`verify-browser-imports: ok (no dangling imports under dist/browser)`);

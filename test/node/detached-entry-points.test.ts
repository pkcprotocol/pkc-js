// A new async event listener, timer callback or floating `void promise` in src/ must go through guardDetached
// (src/detached-guard.ts): a rejection of one is an unhandled rejection, which ends a Node process. The sites that
// exist today, with why each is not wrapped, are in config/detached-entry-points-baseline.json; it may only shrink.
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { findUnguardedDetachedEntryPoints } from "../helpers/detached-entry-points.js";

const BASELINE_PATH = path.join(process.cwd(), "config/detached-entry-points-baseline.json");

describe("detached entry points in src/", () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as { sites: Record<string, { status: string; reason: string }> };
    const found = findUnguardedDetachedEntryPoints(process.cwd());

    it("has no async listener, timer callback or void promise outside the guard that is not in the baseline", () => {
        const newSites = found.filter((site) => !(site.key in baseline.sites));
        expect(
            newSites.map((site) => `${site.file}:${site.line} ${site.kind}: ${site.text}`),
            "Wrap each of these in guardDetached({ entryPoint, handler, onFailure }) from src/detached-guard.ts"
        ).toEqual([]);
    });

    it("lists no site in the baseline that no longer exists, so the baseline only shrinks", () => {
        const foundKeys = new Set(found.map((site) => site.key));
        expect(Object.keys(baseline.sites).filter((key) => !foundKeys.has(key)), "Remove these from config/detached-entry-points-baseline.json").toEqual(
            []
        );
    });

    it("gives every baseline entry a status and a reason", () => {
        for (const [key, entry] of Object.entries(baseline.sites)) {
            expect(entry.status, key).toMatch(/^(documented|unreproduced|contained|unreviewed)$/);
            expect(entry.reason.length, key).toBeGreaterThan(10);
        }
    });

    it("flags an async listener that is not guarded (the scan itself works)", () => {
        // a deliberate unguarded site would be caught by the first test; here the scanner is shown to see the known ones
        const kinds = new Set(found.map((site) => site.kind));
        expect(kinds).toContain("on listener");
        expect(kinds).toContain("void promise");
        expect(kinds).toContain("setTimeout callback");
        expect(kinds).toContain("async property handler");
    });
});

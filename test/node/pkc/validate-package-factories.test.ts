import { describe, it, expect } from "vitest";
import { validateChallengeFileFactory } from "../../../dist/node/challenges.js";
import { validatePageSortFileFactory } from "../../../dist/node/page-sorts.js";
import { pkcJsChallenges } from "../../../dist/node/runtime/node/community/challenges/index.js";
import { pkcJsPageSorts } from "../../../dist/node/runtime/node/community/page-sorts/index.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
import Logger from "@pkcprotocol/pkc-logger";

const testLog = Logger({ namespace: "pkc-js:test:validate-package-factories" });

// Issue #412: installers (bitsocial-cli's `challenge install` / `page-sort install`) check a package's default export
// with these before registering it, so a wrong-kind or broken package is refused at install time.

const codeOf = (fn: () => unknown): string | undefined => {
    try {
        fn();
    } catch (e) {
        return (e as PKCError).code;
    }
    return undefined;
};

const pageSortFactory = () => ({ sortName: "fromPackage", description: "A sort", score: () => 1 });
const challengeFactory = () => ({ type: "text/plain", description: "A challenge", getChallenge: async () => ({ success: true }) });

describe("validateChallengeFileFactory", () => {
    it("accepts every built-in challenge and returns its file", () => {
        for (const [name, factory] of Object.entries(pkcJsChallenges))
            expect(validateChallengeFileFactory(factory, { name, log: testLog }).getChallenge, name).to.be.a("function");
    });

    it("accepts a package factory", () => {
        expect(validateChallengeFileFactory(challengeFactory, { name: "pkg", log: testLog }).description).to.equal("A challenge");
    });

    it("refuses an export that is not a function", () => {
        expect(codeOf(() => validateChallengeFileFactory({ type: "text/plain" }, { name: "pkg", log: testLog }))).to.equal(
            "ERR_FAILED_TO_IMPORT_CHALLENGE_FILE_FACTORY"
        );
    });

    it("refuses a page sort package installed as a challenge", () => {
        expect(codeOf(() => validateChallengeFileFactory(pageSortFactory, { name: "pkg", log: testLog }))).to.equal(
            "ERR_CHALLENGE_FILE_INVALID"
        );
    });

    it("refuses a factory that throws", () => {
        const throwing = () => {
            throw Error("boom");
        };
        expect(codeOf(() => validateChallengeFileFactory(throwing, { name: "pkg", log: testLog }))).to.equal("ERR_CHALLENGE_FILE_INVALID");
    });
});

describe("validatePageSortFileFactory", () => {
    it("accepts every built-in page sort and returns its file", () => {
        for (const [name, factory] of Object.entries(pkcJsPageSorts))
            expect(validatePageSortFileFactory(factory, { name, log: testLog }).score, name).to.be.a("function");
    });

    it("accepts a package factory", () => {
        expect(validatePageSortFileFactory(pageSortFactory, { name: "pkg", log: testLog }).sortName).to.equal("fromPackage");
    });

    it("refuses an export that is not a function", () => {
        expect(codeOf(() => validatePageSortFileFactory("not a function", { name: "pkg", log: testLog }))).to.equal(
            "ERR_FAILED_TO_IMPORT_PAGE_SORT_FILE_FACTORY"
        );
    });

    it("refuses a challenge package installed as a page sort", () => {
        expect(codeOf(() => validatePageSortFileFactory(challengeFactory, { name: "pkg", log: testLog }))).to.equal(
            "ERR_PAGE_SORT_FILE_INVALID"
        );
    });
});

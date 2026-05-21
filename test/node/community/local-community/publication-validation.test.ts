// Unit tests for src/runtime/node/community/local-community/publication-validation.ts.
// isFlairInAllowedList is a pure predicate and gets thorough coverage. The orchestrator
// checkPublicationValidity and isPublicationAuthorPartOfRoles depend on community._dbHandler
// and the role registry; they are covered end-to-end by test/node/community/features/.
// respondWithErrorIfSignatureOfPublicationIsInvalid wraps real signature verification and is
// covered by the challenges integration suite.

import { describe, it, expect, vi } from "vitest";
import {
    checkPublicationValidity,
    isFlairInAllowedList,
    isPublicationAuthorPartOfRoles,
    respondWithErrorIfSignatureOfPublicationIsInvalid
} from "../../../../dist/node/runtime/node/community/local-community/publication-validation.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { Flair } from "../../../../dist/node/community/types.js";

describe("publication-validation: export shape", () => {
    it("exports all publication-validation helpers", () => {
        expect(typeof checkPublicationValidity).to.equal("function");
        expect(typeof isFlairInAllowedList).to.equal("function");
        expect(typeof isPublicationAuthorPartOfRoles).to.equal("function");
        expect(typeof respondWithErrorIfSignatureOfPublicationIsInvalid).to.equal("function");
    });
});

describe("publication-validation: isFlairInAllowedList", () => {
    it("returns true for an exact-match flair", () => {
        const flair: Flair = { text: "blue" };
        const allowed: Flair[] = [{ text: "red" }, { text: "blue" }];
        expect(isFlairInAllowedList(flair, allowed)).to.equal(true);
    });

    it("returns false when the flair is not in the allowlist", () => {
        const flair: Flair = { text: "green" };
        const allowed: Flair[] = [{ text: "red" }, { text: "blue" }];
        expect(isFlairInAllowedList(flair, allowed)).to.equal(false);
    });

    it("does deep equality (not reference equality)", () => {
        // A fresh object with identical contents should still match.
        const flair: Flair = { text: "blue", backgroundColor: "#0000ff" };
        const allowed: Flair[] = [{ text: "blue", backgroundColor: "#0000ff" }];
        expect(isFlairInAllowedList(flair, allowed)).to.equal(true);
    });

    it("treats differing optional fields as a mismatch", () => {
        const flair: Flair = { text: "blue", backgroundColor: "#0000ff" };
        const allowed: Flair[] = [{ text: "blue" }];
        expect(isFlairInAllowedList(flair, allowed)).to.equal(false);
    });

    it("returns false against an empty allowlist", () => {
        expect(isFlairInAllowedList({ text: "blue" }, [])).to.equal(false);
    });
});

describe("publication-validation: isPublicationAuthorPartOfRoles", () => {
    it("returns false when the community has no roles configured", async () => {
        const community = {
            roles: undefined,
            _clientsManager: { resolveAuthorNameIfNeeded: vi.fn() },
            _pkc: { resolveAuthorNames: false, _timeouts: { "resolve-author-name": 1000 } }
        } as unknown as LocalCommunity;

        const result = await isPublicationAuthorPartOfRoles(
            community,
            // signature.publicKey is sufficient — author may be undefined.
            { author: undefined, signature: { publicKey: "somePub" } } as unknown as Parameters<typeof isPublicationAuthorPartOfRoles>[1],
            ["moderator"]
        );
        expect(result).to.equal(false);
    });

    it("returns false when the author's signer address has no role match", async () => {
        const community = {
            roles: { "12D3KoooSomeOtherAddress": { role: "moderator" } },
            _clientsManager: { resolveAuthorNameIfNeeded: vi.fn() },
            _pkc: { resolveAuthorNames: false, _timeouts: { "resolve-author-name": 1000 } }
        } as unknown as LocalCommunity;

        const result = await isPublicationAuthorPartOfRoles(
            community,
            {
                author: undefined,
                signature: { publicKey: "differentPub" }
            } as unknown as Parameters<typeof isPublicationAuthorPartOfRoles>[1],
            ["owner", "admin"]
        );
        expect(result).to.equal(false);
    });
});

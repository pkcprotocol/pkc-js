// Unit tests for src/runtime/node/community/local-community/publication-validation.ts.
// isFlairInAllowedList is a pure predicate and gets thorough coverage. The orchestrator
// checkPublicationValidity and matchPublicationAuthorAgainstRoles depend on community._dbHandler
// and the role registry; they are covered end-to-end by test/node/community/features/.
// respondWithErrorIfSignatureOfPublicationIsInvalid wraps real signature verification and is
// covered by the challenges integration suite.

import { describe, it, expect, vi } from "vitest";
import Logger from "@pkcprotocol/pkc-logger";
import {
    checkPublicationValidity,
    isFlairInAllowedList,
    matchPublicationAuthorAgainstRoles,
    respondWithErrorIfSignatureOfPublicationIsInvalid
} from "../../../../dist/node/runtime/node/community/local-community/publication-validation.js";
import { createAuthorIdentityMatcher } from "../../../../dist/node/runtime/node/community/local-community/author-identity.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { Flair } from "../../../../dist/node/community/types.js";
import signers from "../../../fixtures/signers.js";

// Local-community helpers log through community._log (issue #493); fakes get the process-default root
const testLog = Logger({ namespace: "pkc-js:test:publication-validation" });

describe("publication-validation: export shape", () => {
    it("exports all publication-validation helpers", () => {
        expect(typeof checkPublicationValidity).to.equal("function");
        expect(typeof isFlairInAllowedList).to.equal("function");
        expect(typeof matchPublicationAuthorAgainstRoles).to.equal("function");
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

describe("publication-validation: matchPublicationAuthorAgainstRoles", () => {
    const matcherFor = (community: LocalCommunity, publicKey: string) =>
        createAuthorIdentityMatcher({
            community,
            // signature.publicKey is sufficient — author may be undefined. It must be a real base64 key:
            // the matcher derives the signer address from it eagerly.
            publication: { author: undefined, signature: { publicKey } }
        });

    it("does not match when the community has no roles configured", async () => {
        const community = {
            _log: testLog,
            roles: undefined,
            _clientsManager: { resolveAuthorNameIfNeeded: vi.fn() },
            _pkc: { resolveAuthorNames: false, _timeouts: { "resolve-author-name": 1000 } }
        } as unknown as LocalCommunity;

        const result = await matchPublicationAuthorAgainstRoles({
            community,
            rolesToCheckAgainst: ["moderator"],
            authorIdentityMatcher: matcherFor(community, "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0")
        });
        expect(result.matched).to.equal(false);
        // No domain role key was involved, so there is nothing to explain to the publisher.
        expect(result.matched === false && result.nameFailure).to.be.undefined;
    });

    it("does not match when the author's signer address has no role match", async () => {
        const community = {
            _log: testLog,
            roles: { "12D3KoooSomeOtherAddress": { role: "moderator" } },
            _clientsManager: { resolveAuthorNameIfNeeded: vi.fn() },
            _pkc: { resolveAuthorNames: false, _timeouts: { "resolve-author-name": 1000 } }
        } as unknown as LocalCommunity;

        const result = await matchPublicationAuthorAgainstRoles({
            community,
            rolesToCheckAgainst: ["owner", "admin"],
            authorIdentityMatcher: matcherFor(community, "ojU0zK7ZudZomVjSQPir7/ZT1u0G7J0IvlqbSx7s1S0")
        });
        expect(result.matched).to.equal(false);
        expect(result.matched === false && result.nameFailure).to.be.undefined;
    });
});

// Issue #424: a role key is a name the owner typed, and `.bso`/`.eth` are one ENS name that ignores letter case.
// A moderator keyed under one spelling must keep their authority when publishing under another, or a mod
// action from the real moderator is rejected. The resolver below answers like production: one record,
// reachable through every spelling.
describe("publication-validation: role keys match across .bso/.eth spellings and letter case (#424)", () => {
    const moderator = signers[6];
    const impostor = signers[7];

    const check = async ({
        roleKey,
        authorName,
        signer = moderator
    }: {
        roleKey: string;
        authorName: string;
        signer?: (typeof signers)[number];
    }) => {
        const community = {
            _log: testLog,
            roles: { [roleKey]: { role: "moderator" } },
            _clientsManager: {
                resolveAuthorNameIfNeeded: async ({ authorName: name }: { authorName: string }) => ({
                    resolvedAuthorName: name.toLowerCase().replace(/\.bso$/, ".eth") === "mod-424.eth" ? moderator.address : null
                })
            },
            _pkc: { resolveAuthorNames: false, _timeouts: { "resolve-author-name": 1000 } }
        } as unknown as LocalCommunity;
        return matchPublicationAuthorAgainstRoles({
            community,
            rolesToCheckAgainst: ["moderator", "admin", "owner"],
            authorIdentityMatcher: createAuthorIdentityMatcher({
                community,
                publication: { author: { address: authorName }, signature: { publicKey: signer.publicKey } }
            })
        });
    };

    for (const [roleKey, authorName] of [
        ["mod-424.eth", "mod-424.bso"],
        ["mod-424.bso", "mod-424.eth"],
        ["Mod-424.bso", "mod-424.bso"],
        ["mod-424.BSO", "mod-424.eth"]
    ] as const) {
        it(`a moderator keyed "${roleKey}" keeps authority when publishing as ${authorName}`, async () => {
            expect((await check({ roleKey, authorName })).matched).to.equal(true);
        });
    }

    it("an impostor claiming the other spelling of a moderator's role key gets no authority", async () => {
        expect(await check({ roleKey: "mod-424.eth", authorName: "mod-424.bso", signer: impostor })).to.deep.equal({ matched: false });
    });
});

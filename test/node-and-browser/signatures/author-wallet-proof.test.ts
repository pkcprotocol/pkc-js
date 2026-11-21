import { describe, it, expect } from "vitest";
import vectors from "../../fixtures/author-wallet-proof/wallet-proof-vectors.json" with { type: "json" };
import { verifyAuthorWalletEntry } from "../../../dist/node/signer/author-wallet-proof.js";

// BSIP-22 test vectors, copied from bitsocialnet/BSIPs assets/bsip-22/wallet-proof-vectors.json.
// Pure function over its inputs (no pkc, no network), so it runs the same in node and browser.
describe("verifyAuthorWalletEntry: BSIP-22 vectors", () => {
    for (const vectorCase of vectors.cases) {
        it(vectorCase.name, () => {
            const authorPublicKey =
                "authorKey" in vectorCase && vectorCase.authorKey === "other" ? vectors.otherKey.address : vectors.authorKey.address;
            const result = verifyAuthorWalletEntry({
                entry: vectorCase.entry,
                authorPublicKey,
                nowSeconds: vectorCase.verifierTime
            });
            expect(result.outcome).to.equal(vectorCase.outcome);
            if (result.outcome === "invalid") expect(result.reason).to.be.a("string").and.not.equal("");
        });
    }
});

describe("verifyAuthorWalletEntry: extra rules", () => {
    const base = vectors.cases[0].entry;
    it("is stateless: the same entry verifies twice", () => {
        const args = { entry: base, authorPublicKey: vectors.authorKey.address, nowSeconds: vectors.timestamp };
        expect(verifyAuthorWalletEntry(args).outcome).to.equal("valid");
        expect(verifyAuthorWalletEntry(args).outcome).to.equal("valid");
    });
    it("does not mutate the entry", () => {
        const entry = structuredClone(base);
        verifyAuthorWalletEntry({ entry, authorPublicKey: vectors.authorKey.address, nowSeconds: vectors.timestamp });
        expect(entry).to.deep.equal(base);
    });
    it("rejects an entry that is not an object", () => {
        const notObjects: unknown[] = [null, undefined, "x", 1, []];
        for (const entry of notObjects) {
            expect(verifyAuthorWalletEntry({ entry, authorPublicKey: vectors.authorKey.address, nowSeconds: 1 }).outcome).to.equal(
                "invalid"
            );
        }
    });
});

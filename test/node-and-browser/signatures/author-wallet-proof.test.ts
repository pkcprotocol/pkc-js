import { describe, it, expect } from "vitest";
import vectors from "../../fixtures/author-wallet-proof/wallet-proof-vectors.json" with { type: "json" };
import { verifyAuthorWalletEntry } from "../../../dist/node/signer/author-wallet-proof.js";
import { AuthorPubsubSchema } from "../../../dist/node/schema/schema.js";

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

// Every wallet entry passes the author schema before verifyAuthorWalletEntry sees it: the community parses the
// request with it and a reader parses the comment record with it. So the schema may only refuse what BSIP-22 calls
// an invalid shape. An entry the BSIP calls valid or unknown (unproven) must get through, or one entry for a chain
// this version does not know rejects the whole publication.
describe("the author schema lets through every wallet entry BSIP-22 does not call invalid", () => {
    const parseAuthorWith = (entry: unknown) => AuthorPubsubSchema.safeParse({ wallets: { eth: entry } });

    for (const vectorCase of vectors.cases.filter((vectorCase) => vectorCase.outcome !== "invalid")) {
        it(`${vectorCase.outcome}: ${vectorCase.name}`, () => {
            expect(parseAuthorWith(vectorCase.entry).success).to.equal(true);
        });
    }

    it("a timestamp of 0 is a valid shape (BSIP-22: not negative)", () => {
        const entry = { address: "0x" + "ab".repeat(20), timestamp: 0, signature: { signature: "0x" + "00".repeat(65), type: "eip191" } };
        expect(parseAuthorWith(entry).success).to.equal(true);
    });

    it("an entry of an unknown type is let through whatever its timestamp and signature string are", () => {
        for (const timestamp of [0, -5])
            for (const signature of ["", "anything"])
                expect(
                    parseAuthorWith({ address: "", timestamp, signature: { signature, type: "a-later-type" } }).success,
                    `timestamp ${timestamp}, signature "${signature}"`
                ).to.equal(true);
    });

    it("still refuses what BSIP-22 calls an invalid shape", () => {
        expect(parseAuthorWith({ address: "0x", timestamp: 1.5, signature: { signature: "x", type: "eip191" } }).success).to.equal(false);
        expect(parseAuthorWith({ address: "0x", timestamp: 1, signature: { signature: "x" } }).success).to.equal(false);
        expect(parseAuthorWith({ address: 5, timestamp: 1, signature: { signature: "x", type: "eip191" } }).success).to.equal(false);
    });
});

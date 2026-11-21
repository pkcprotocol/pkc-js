import { describe, it, expect } from "vitest";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import vectors from "../../fixtures/author-wallet-proof/wallet-proof-vectors.json" with { type: "json" };

// docs/protocol/author-wallet-proofs.md carries a verifier for clients and challenges to copy. Run the exact
// block from the doc against the BSIP-22 vectors so the doc cannot drift from the spec.
// Node-only (so it lives under test/node): it writes the snippet to .tmp/ so its bare @noble imports resolve from the repo's node_modules.
describe("docs/protocol/author-wallet-proofs.md snippet", () => {
    it("classifies every BSIP-22 vector like the spec", async () => {
        // A Windows checkout converts the doc to CRLF (core.autocrlf), so normalize before matching the fence
        const doc = readFileSync(join(process.cwd(), "docs/protocol/author-wallet-proofs.md"), "utf8").replace(/\r\n/g, "\n");
        const match = doc.match(/```js verify-author-wallet\n([\s\S]*?)```/);
        expect(match, "the doc must contain a ```js verify-author-wallet block").to.not.equal(null);
        const dir = join(process.cwd(), ".tmp", "docs-snippet");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, "verify-author-wallet.mjs");
        writeFileSync(file, match![1]);
        const { verifyAuthorWalletEntry } = (await import(pathToFileURL(file).href)) as {
            verifyAuthorWalletEntry: (args: { entry: unknown; authorPublicKey: string; nowSeconds: number }) => string;
        };
        for (const vectorCase of vectors.cases) {
            const authorPublicKey =
                "authorKey" in vectorCase && vectorCase.authorKey === "other" ? vectors.otherKey.address : vectors.authorKey.address;
            const outcome = verifyAuthorWalletEntry({ entry: vectorCase.entry, authorPublicKey, nowSeconds: vectorCase.verifierTime });
            expect(outcome, vectorCase.name).to.equal(vectorCase.outcome);
        }
    });
});

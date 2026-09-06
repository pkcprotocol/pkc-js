import { describe, it, expect } from "vitest";
import { CommunityChallengeSettingSchema, CommunityChallengeSchema } from "../../dist/node/community/schema.js";
import signers from "../fixtures/signers.js";

// Issue #267: the conflated `exclude.address` is gone. An exclude names its identity explicitly:
// `publicKeys` (key-derived, verified against the signature) or `names` (domain, resolved to the signer).

const parseSetting = (exclude: Record<string, unknown>) =>
    CommunityChallengeSettingSchema.parse({ name: "fail", exclude: [exclude] }).exclude![0];

describe("ChallengeExclude identity fields", () => {
    it("accepts publicKeys with key-derived addresses", () => {
        const parsed = parseSetting({ publicKeys: [signers[0].address, signers[1].address] });
        expect(parsed.publicKeys).to.deep.equal([signers[0].address, signers[1].address]);
    });

    it("accepts names with domains", () => {
        const parsed = parseSetting({ names: ["owner.bso", "mod.eth"] });
        expect(parsed.names).to.deep.equal(["owner.bso", "mod.eth"]);
    });

    it("accepts both on the same exclude", () => {
        const parsed = parseSetting({ publicKeys: [signers[0].address], names: ["owner.bso"] });
        expect(parsed.publicKeys).to.deep.equal([signers[0].address]);
        expect(parsed.names).to.deep.equal(["owner.bso"]);
    });

    it("rejects a domain inside publicKeys", () => {
        expect(() => parseSetting({ publicKeys: ["owner.bso"] })).to.throw();
    });

    it("rejects a key-derived address inside names", () => {
        expect(() => parseSetting({ names: [signers[0].address] })).to.throw();
    });

    it("rejects the removed exclude.address field on private settings", () => {
        expect(() => parseSetting({ address: [signers[0].address] })).to.throw();
        expect(() => parseSetting({ address: ["owner.bso"] })).to.throw();
    });

    it("rejects the removed exclude.address field on the public challenge", () => {
        expect(() => CommunityChallengeSchema.parse({ type: "text/plain", exclude: [{ address: ["owner.bso"] }] })).to.throw();
        expect(() => CommunityChallengeSchema.parse({ type: "text/plain", exclude: [{ names: ["owner.bso"] }] })).to.not.throw();
    });

    it("rejects empty identity arrays", () => {
        expect(() => parseSetting({ publicKeys: [] })).to.throw();
        expect(() => parseSetting({ names: [] })).to.throw();
    });
});

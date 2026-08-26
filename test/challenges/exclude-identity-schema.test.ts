import { describe, it, expect } from "vitest";
import { CommunityChallengeSettingSchema, CommunityChallengeSchema } from "../../dist/node/community/schema.js";
import signers from "../fixtures/signers.js";

// Issue #267: the conflated `exclude.address` is gone. An exclude names its identity explicitly:
// `signerAddress` (key-derived, verified against the signature) or `name` (domain, resolved to the signer).

const parseSetting = (exclude: Record<string, unknown>) =>
    CommunityChallengeSettingSchema.parse({ name: "fail", exclude: [exclude] }).exclude![0];

describe("ChallengeExclude identity fields", () => {
    it("accepts signerAddress with key-derived addresses", () => {
        const parsed = parseSetting({ signerAddress: [signers[0].address, signers[1].address] });
        expect(parsed.signerAddress).to.deep.equal([signers[0].address, signers[1].address]);
    });

    it("accepts name with domains", () => {
        const parsed = parseSetting({ name: ["owner.bso", "mod.eth"] });
        expect(parsed.name).to.deep.equal(["owner.bso", "mod.eth"]);
    });

    it("accepts both on the same exclude", () => {
        const parsed = parseSetting({ signerAddress: [signers[0].address], name: ["owner.bso"] });
        expect(parsed.signerAddress).to.deep.equal([signers[0].address]);
        expect(parsed.name).to.deep.equal(["owner.bso"]);
    });

    it("rejects a domain inside signerAddress", () => {
        expect(() => parseSetting({ signerAddress: ["owner.bso"] })).to.throw();
    });

    it("rejects a key-derived address inside name", () => {
        expect(() => parseSetting({ name: [signers[0].address] })).to.throw();
    });

    it("rejects the removed exclude.address field on private settings", () => {
        expect(() => parseSetting({ address: [signers[0].address] })).to.throw();
        expect(() => parseSetting({ address: ["owner.bso"] })).to.throw();
    });

    it("rejects the removed exclude.address field on the public challenge", () => {
        expect(() => CommunityChallengeSchema.parse({ type: "text/plain", exclude: [{ address: ["owner.bso"] }] })).to.throw();
        expect(() => CommunityChallengeSchema.parse({ type: "text/plain", exclude: [{ name: ["owner.bso"] }] })).to.not.throw();
    });

    it("rejects empty identity arrays", () => {
        expect(() => parseSetting({ signerAddress: [] })).to.throw();
        expect(() => parseSetting({ name: [] })).to.throw();
    });
});

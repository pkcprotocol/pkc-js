import { describe, it, expect } from "vitest";
import { CommunityChallengeSettingSchema, CommunityChallengeSchema, CommunityIpfsSchema } from "../../dist/node/community/schema.js";
import { messages } from "../../dist/node/errors.js";
import signers from "../fixtures/signers.js";
import validCommunityIpfs from "../fixtures/signatures/community/valid_community_ipfs.json" with { type: "json" };

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
        expect(() => parseSetting({ address: [signers[0].address] })).to.throw(messages.ERR_CHALLENGE_EXCLUDE_ADDRESS_FIELD_REMOVED);
        expect(() => parseSetting({ address: ["owner.bso"] })).to.throw(messages.ERR_CHALLENGE_EXCLUDE_ADDRESS_FIELD_REMOVED);
    });

    it("rejects the renamed exclude.role field on private settings", () => {
        // A stale owner config must fail loudly: silently accepting `role` would yield an exclude with no conditions,
        // i.e. a pending-approval challenge that no longer exempts moderators
        expect(() => parseSetting({ role: ["moderator"] })).to.throw(messages.ERR_CHALLENGE_EXCLUDE_ROLE_FIELD_RENAMED);
        expect(() => parseSetting({ role: ["moderator"], roles: ["moderator"] })).to.throw(messages.ERR_CHALLENGE_EXCLUDE_ROLE_FIELD_RENAMED);
        expect(parseSetting({ roles: ["moderator"] }).roles).to.deep.equal(["moderator"]);
    });

    it("accepts the new identity fields on the public challenge", () => {
        expect(() => CommunityChallengeSchema.parse({ type: "text/plain", exclude: [{ names: ["owner.bso"] }] })).to.not.throw();
        expect(() =>
            CommunityChallengeSchema.parse({ type: "text/plain", exclude: [{ publicKeys: [signers[0].address], roles: ["admin"] }] })
        ).to.not.throw();
    });

    it("still parses a record published by a community that has not upgraded (old exclude.address and exclude.role)", () => {
        // The record schema stays loose: a client on this version must keep loading communities running older code.
        // The old fields pass through unused; only the private settings schema rejects them.
        const oldRecordExclude = { address: ["owner.bso", signers[0].address], role: ["moderator"], postScore: 10 };
        const parsedChallenge = CommunityChallengeSchema.parse({ type: "text/plain", exclude: [oldRecordExclude] });
        expect(parsedChallenge.exclude![0]).to.deep.equal(oldRecordExclude);
        const record = { ...validCommunityIpfs, challenges: [{ type: "text/plain", exclude: [oldRecordExclude] }] };
        expect(CommunityIpfsSchema.loose().safeParse(record).success).to.be.true;
    });

    it("rejects empty identity arrays", () => {
        expect(() => parseSetting({ publicKeys: [] })).to.throw();
        expect(() => parseSetting({ names: [] })).to.throw();
    });
});

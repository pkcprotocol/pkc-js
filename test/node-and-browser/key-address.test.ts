// BSIP-10, "Key addresses": a key address is the base58btc identity multihash of an Ed25519 key, 52 characters that
// start with 12D3KooW. Every field that holds one must use that form; the base36 and base32 CID forms of the same
// key (k51..., bafz...) and other multihashes (Qm...) are refused, by the writer and by the reader (issue #485).
import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { peerIdFromString } from "@libp2p/peer-id";
import { base36 } from "multiformats/bases/base36";
import { base32 } from "multiformats/bases/base32";
import signers from "../fixtures/signers.js";
import { isKeyAddress } from "../../dist/node/key-address.js";
import { CommunityIpfsSchema, CommunityAnchorSchema, ChallengeExcludeSchema } from "../../dist/node/community/schema.js";
import { CommunityListEntrySchema } from "../../dist/node/community-list/schema.js";
import { CommentIpfsSchema } from "../../dist/node/publications/comment/schema.js";
import { createMockNameResolver, mockRemotePKC } from "../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../helpers/conditional-tests.js";
import validCommunityFixture from "../fixtures/signatures/community/valid_community_ipfs_new_format.json" with { type: "json" };
import validCommentFixture from "../fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json" with { type: "json" };
import type { PKC } from "../../dist/node/pkc/pkc.js";

const keyAddress = signers[0].address;
const sameKeyAsCid = peerIdFromString(keyAddress).toCID();
const base36Form = sameKeyAsCid.toString(base36); // k51...
const base32Form = sameKeyAsCid.toString(base32); // bafz...
const sha256Multihash = "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f";
const otherForms = { base36Form, base32Form, sha256Multihash };

describe("isKeyAddress", () => {
    it("accepts the base58btc form of an Ed25519 key", () => {
        expect(keyAddress.startsWith("12D3KooW") && keyAddress.length === 52).to.equal(true);
        for (const signer of signers) expect(isKeyAddress(signer.address), signer.address).to.equal(true);
    });

    it("refuses every other encoding of the same key, other multihashes and near misses", () => {
        expect(base36Form.startsWith("k51")).to.equal(true);
        expect(base32Form.startsWith("bafz")).to.equal(true);
        for (const [form, value] of Object.entries(otherForms)) expect(isKeyAddress(value), form).to.equal(false);
        for (const value of ["", "memes.bso", keyAddress.slice(0, -1), keyAddress + "1", keyAddress.toLowerCase(), "z" + keyAddress])
            expect(isKeyAddress(value), value).to.equal(false);
    });
});

describe("fields that hold a key address take only the base58btc form", () => {
    const baseCommunity = validCommunityFixture as unknown as Record<string, unknown>;
    const baseComment = validCommentFixture as unknown as Record<string, unknown>;

    it("the fixtures parse as they are", () => {
        expect(CommunityIpfsSchema.safeParse(baseCommunity).success).to.equal(true);
        expect(CommunityIpfsSchema.safeParse({ ...baseCommunity, roles: { [keyAddress]: { role: "moderator" }, "mod.bso": { role: "admin" } } }).success).to.equal(true);
        expect(CommunityAnchorSchema.safeParse({ publicKey: keyAddress }).success).to.equal(true);
        expect(ChallengeExcludeSchema.safeParse({ publicKeys: [keyAddress] }).success).to.equal(true);
        expect(CommunityListEntrySchema.safeParse({ publicKey: keyAddress }).success).to.equal(true);
    });

    for (const [form, value] of Object.entries(otherForms)) {
        it(`a roles key in ${form} makes the community record invalid`, () => {
            expect(CommunityIpfsSchema.safeParse({ ...baseCommunity, roles: { [value]: { role: "moderator" } } }).success).to.equal(false);
        });
        it(`anchor.publicKey in ${form} is refused`, () => {
            expect(CommunityAnchorSchema.safeParse({ publicKey: value }).success).to.equal(false);
        });
        it(`exclude.publicKeys in ${form} is refused`, () => {
            expect(ChallengeExcludeSchema.safeParse({ publicKeys: [value] }).success).to.equal(false);
        });
        it(`a community list entry publicKey in ${form} is refused`, () => {
            expect(CommunityListEntrySchema.safeParse({ publicKey: value }).success).to.equal(false);
        });
        it(`a comment's communityPublicKey in ${form} is refused`, () => {
            // the fixture predates communityPublicKey and still carries the field it replaced
            const { subplebbitAddress: _replaced, ...comment } = baseComment;
            expect(CommentIpfsSchema.safeParse({ ...comment, communityPublicKey: keyAddress }).success, "base58btc").to.equal(true);
            expect(CommentIpfsSchema.safeParse({ ...comment, communityPublicKey: value }).success, form).to.equal(false);
        });
    }
});

// Not under RPC: the resolver runs inside the RPC server, which was started without this test's resolver
describeSkipIfRpc("a name whose record holds a key in another form is not resolved to it", () => {
    let pkc: PKC;
    beforeAll(async () => {
        pkc = await mockRemotePKC({
            mockResolve: false,
            pkcOptions: {
                nameResolvers: [
                    createMockNameResolver({
                        records: new Map([
                            ["base58.bso", keyAddress],
                            ["base36.bso", base36Form],
                            ["sha256.bso", sha256Multihash]
                        ])
                    })
                ]
            }
        });
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    it("resolves a record holding the base58btc form", async () => {
        expect((await pkc.resolveAuthorName({ name: "base58.bso" })).resolvedAuthorName).to.equal(keyAddress);
    });

    for (const name of ["base36.bso", "sha256.bso"])
        it(`${name} is refused with ERR_RESOLVED_TEXT_RECORD_TO_NON_IPNS`, async () => {
            await expect(pkc.resolveAuthorName({ name })).rejects.toMatchObject({ code: "ERR_RESOLVED_TEXT_RECORD_TO_NON_IPNS" });
        });
});

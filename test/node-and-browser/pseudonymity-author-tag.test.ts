import { describe, it, expect } from "vitest";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { toString as uint8ArrayToString, fromString as uint8ArrayFromString } from "uint8arrays";
import { derivePseudonymityTagSharedKey, computePseudonymityAuthorTag } from "../../dist/node/signer/pseudonymity-author-tag.js";
import { getPublicKeyFromPrivateKey } from "../../dist/node/signer/util.js";
import { CommentUpdateSchema, CommentUpdateChallengeReservedFieldNames } from "../../dist/node/publications/comment/schema.js";

// The pseudonymity author tag derivation (issue #381), the contract clients must reproduce byte for
// byte. Lives in node-and-browser so the WebCrypto parity check below also runs in a real browser,
// which is where bitsocial-react-hooks derives the tag. See docs/protocol/pseudonymity-author-tag.md.

// The fixed vectors published in docs/protocol/pseudonymity-author-tag.md. If any assertion here
// changes, the doc and every client are out of sync.
const VECTOR = {
    communityPrivateKey: "AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA",
    communityPublicKey: "ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ",
    authorPrivateKey: "ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1+f4CBgoM",
    authorPublicKey: "C7w0aldmfDgBIL2cf9flHSxf3+o3zS9b9AWyxr9vLXg",
    cid: "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f",
    K: "FcBB8h9Hi7TfAVVr/sxB0euHUQFTT5LcrrsO8MUYo/c",
    tag: "nBUe3DGZKQ8fBcP6YGnpRQ"
};

describe("pseudonymity author tag — derivation (issue #381)", () => {
    it("the derived public keys match the vector seeds", async () => {
        expect(await getPublicKeyFromPrivateKey(VECTOR.communityPrivateKey)).to.equal(VECTOR.communityPublicKey);
        expect(await getPublicKeyFromPrivateKey(VECTOR.authorPrivateKey)).to.equal(VECTOR.authorPublicKey);
    });

    it("the community side produces the documented K and tag", () => {
        const K = derivePseudonymityTagSharedKey({
            communityPrivateKeyBase64: VECTOR.communityPrivateKey,
            authorPublicKeyBase64: VECTOR.authorPublicKey
        });
        expect(uint8ArrayToString(K, "base64")).to.equal(VECTOR.K);
        const tag = computePseudonymityAuthorTag({ sharedKey: K, commentCid: VECTOR.cid });
        expect(tag).to.equal(VECTOR.tag);
        expect(tag).to.have.lengthOf(22);
    });

    it("the author side (author private key + community public key) derives the same K and tag", () => {
        const K = derivePseudonymityTagSharedKey({
            communityPrivateKeyBase64: VECTOR.authorPrivateKey,
            authorPublicKeyBase64: VECTOR.communityPublicKey
        });
        expect(uint8ArrayToString(K, "base64")).to.equal(VECTOR.K);
        expect(computePseudonymityAuthorTag({ sharedKey: K, commentCid: VECTOR.cid })).to.equal(VECTOR.tag);
    });

    it("a WebCrypto-only reimplementation (the client snippet) produces the same tag", async () => {
        // Mirrors docs/protocol/pseudonymity-author-tag.md: noble only for the ed25519->x25519
        // conversion, WebCrypto for HKDF + HMAC. This is the derivation hooks must match.
        const te = new TextEncoder();
        const authorPriv = uint8ArrayFromString(VECTOR.authorPrivateKey, "base64");
        const communityPub = uint8ArrayFromString(VECTOR.communityPublicKey, "base64");
        const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(authorPriv), ed25519.utils.toMontgomery(communityPub));
        const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
        const bits = await crypto.subtle.deriveBits(
            { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode("pkc-pseudonymity-author-tag-v1") },
            hkdfKey,
            256
        );
        const K = new Uint8Array(bits);
        expect(uint8ArrayToString(K, "base64")).to.equal(VECTOR.K);
        const hmacKey = await crypto.subtle.importKey("raw", K, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, te.encode(VECTOR.cid)));
        const tag = uint8ArrayToString(mac.slice(0, 16), "base64");
        expect(tag).to.equal(VECTOR.tag);
    });

    it("different cids give different tags for the same author (per-comment uniqueness)", () => {
        const K = derivePseudonymityTagSharedKey({
            communityPrivateKeyBase64: VECTOR.communityPrivateKey,
            authorPublicKeyBase64: VECTOR.authorPublicKey
        });
        const tagA = computePseudonymityAuthorTag({ sharedKey: K, commentCid: "QmPostAaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
        const tagB = computePseudonymityAuthorTag({ sharedKey: K, commentCid: "QmPostBbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" });
        expect(tagA).to.not.equal(tagB);
    });

    it("derivation throws for a small-order author key (the community's fail-soft trigger)", () => {
        // The identity point 01 00..00 yields an all-zero X25519 shared secret, which noble rejects.
        // calculateNewCommentUpdate catches this and publishes the update without a tag rather than
        // wedging the cycle; this asserts the throw the catch relies on is real.
        const identity = new Uint8Array(32);
        identity[0] = 1;
        const identityPublicKey = uint8ArrayToString(identity, "base64");
        expect(() =>
            derivePseudonymityTagSharedKey({
                communityPrivateKeyBase64: VECTOR.communityPrivateKey,
                authorPublicKeyBase64: identityPublicKey
            })
        ).to.throw();
    });
});

describe("pseudonymity author tag — schema (issue #381)", () => {
    const baseUpdate = {
        cid: VECTOR.cid,
        upvoteCount: 0,
        downvoteCount: 0,
        replyCount: 0,
        updatedAt: 1700000000,
        protocolVersion: "1.0.0",
        signature: { type: "ed25519", signature: "c2ln", publicKey: "cGs", signedPropertyNames: ["cid"] }
    };

    it("accepts a 22-character base64 tag", () => {
        const res = CommentUpdateSchema.safeParse({ ...baseUpdate, pseudonymityAuthorTag: VECTOR.tag });
        expect(res.success, res.success ? "" : JSON.stringify(res.error.issues)).to.equal(true);
    });

    it("rejects a malformed tag (wrong length)", () => {
        expect(CommentUpdateSchema.safeParse({ ...baseUpdate, pseudonymityAuthorTag: "tooShort" }).success).to.equal(false);
        expect(CommentUpdateSchema.safeParse({ ...baseUpdate, pseudonymityAuthorTag: VECTOR.tag + "AA" }).success).to.equal(false);
    });

    it("rejects a tag with non-base64 characters", () => {
        expect(CommentUpdateSchema.safeParse({ ...baseUpdate, pseudonymityAuthorTag: "nBUe3DGZKQ8fBcP6YGnpR!" }).success).to.equal(false);
    });

    it("the field is reserved against challenge-supplied values", () => {
        expect(CommentUpdateChallengeReservedFieldNames).to.include("pseudonymityAuthorTag");
    });
});

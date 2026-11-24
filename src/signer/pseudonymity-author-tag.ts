import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { fromString as uint8ArrayFromString, toString as uint8ArrayToString } from "uint8arrays";

// Pseudonymity author tag (issue #381). On a board that aliases comments (`features.pseudonymityMode`),
// the community strips the author's identity and re-signs with a per-alias key, so a second device
// holding the same account key cannot recognize its own posts. The community publishes an opaque tag
// on each aliased comment's CommentUpdate that only the account key can reproduce, letting a client
// mark "(You)" and replies-to-you without the community learning anything it does not already hold in
// the alias table.
//
// Derivation (the contract clients must match byte for byte; see docs/protocol/pseudonymity-author-tag.md):
//   shared = X25519(ed25519->x25519(communityPrivateKey), ed25519->x25519(authorPublicKey))
//   K      = HKDF-SHA256(ikm = shared, salt = <empty>, info = "pkc-pseudonymity-author-tag-v1", len = 32)
//   tag    = HMAC-SHA256(K, utf8(commentCid))  truncated to the first 16 bytes, base64 (22 chars)
//
// The author's devices compute the same `shared` from their private key and the community's public key
// (the key that signed the CommentUpdate carrying the tag). This module is internal to pkc-js and is
// deliberately NOT re-exported from the package entry: clients reimplement the derivation from the doc.

// Bumping this label changes every tag. It is folded into the HKDF `info`, so a future derivation
// (e.g. a post-quantum one, issue #472) can coexist by changing only the label.
const HKDF_INFO = uint8ArrayFromString("pkc-pseudonymity-author-tag-v1", "utf8");
const TAG_BYTE_LENGTH = 16;

// The per-author shared key K. Derived once per (community key, author key) pair — the X25519 + HKDF is
// the expensive part (~0.7ms); the per-comment HMAC over the cid is ~4µs and is never cached.
export function derivePseudonymityTagSharedKey(opts: { communityPrivateKeyBase64: string; authorPublicKeyBase64: string }): Uint8Array {
    const communityPrivateKey = uint8ArrayFromString(opts.communityPrivateKeyBase64, "base64");
    const authorPublicKey = uint8ArrayFromString(opts.authorPublicKeyBase64, "base64");
    const shared = x25519.getSharedSecret(
        ed25519.utils.toMontgomerySecret(communityPrivateKey),
        ed25519.utils.toMontgomery(authorPublicKey)
    );
    return hkdf(sha256, shared, undefined, HKDF_INFO, 32);
}

// tag = base64(first 16 bytes of HMAC-SHA256(K, utf8(commentCid))). The cid string is hashed verbatim,
// not its decoded multihash bytes, so clients need no CID library to reproduce it.
export function computePseudonymityAuthorTag(opts: { sharedKey: Uint8Array; commentCid: string }): string {
    const mac = hmac(sha256, opts.sharedKey, uint8ArrayFromString(opts.commentCid, "utf8"));
    return uint8ArrayToString(mac.subarray(0, TAG_BYTE_LENGTH), "base64");
}

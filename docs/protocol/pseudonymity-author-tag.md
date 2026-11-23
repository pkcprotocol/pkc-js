# Pseudonymity author tag

`commentUpdate.pseudonymityAuthorTag` lets an account recognize its own posts on a board that hides authorship. Issue #381.

## The problem

On a board with `features.pseudonymityMode` (`per-post`, `per-reply` or `per-author`), the community replaces the author and the signature with a per-alias signer before storing and serving the comment (`prepareCommentWithAnonymity` in `src/runtime/node/community/local-community/publication-store.ts`). A client holding the author's key therefore cannot tell which aliased comments are its own: the only local link is `accountComments`, which lives on the device that published, so the same account on a second device shows no "(You)" and no replies-to-you.

The community still knows the mapping — it keeps `originalAuthorPublicKey` per alias in its `pseudonymityAliases` table. The tag lets the community hand each account a private marker on its own comments without revealing anything to anyone else.

## What the community publishes

On every comment that has an alias row (all three modes; it stays on comments aliased while `pseudonymityMode` was on even after the board turns it off), the community adds one field to the signed `CommentUpdate`:

```
commentUpdate.pseudonymityAuthorTag = base64( HMAC-SHA256(K, utf8(cid))[0..16] )   // 16 bytes, 22 base64 chars
```

Mods are never aliased, so their comments never carry it. The field is community-generated and reserved: a challenge may not set it, and pkc-js rejects a `CommentUpdate` whose tag is not 22 base64 characters.

## Derivation

Let the author's long-term signing keypair be `(authorPriv, authorPub)` (ed25519) and the community's be the key that signed the `CommentUpdate` carrying the tag, `commentUpdate.signature.publicKey`.

```
shared = X25519( ed25519→x25519(communityPriv), ed25519→x25519(authorPub) )     // community side
       = X25519( ed25519→x25519(authorPriv),   ed25519→x25519(communityPub) )   // author side, same value
K      = HKDF-SHA256( ikm = shared, salt = <empty>, info = "pkc-pseudonymity-author-tag-v1", L = 32 )
tag    = base64( HMAC-SHA256(K, utf8(cid))[0..16] )
```

Notes that clients must match exactly:

- The ed25519→x25519 conversion is the Montgomery conversion of the key (the same one `src/signer/encryption.ts` uses for challenge encryption). With `@noble/curves`, `ed25519.utils.toMontgomerySecret(priv)` and `ed25519.utils.toMontgomery(pub)`.
- HKDF salt is empty (zero-length), not a zero-filled block.
- The HMAC message is the **cid string** as it appears in `commentUpdate.cid`, hashed as UTF-8 bytes. It is **not** the decoded multihash, so a client needs no CID library.
- The tag is the first **16 bytes** of the HMAC output, base64 with the standard `+/` alphabet, unpadded (16 bytes → 22 characters).
- `info` carries the version label. A future derivation (for example a post-quantum one, issue #472) changes only the label; because the tag lives in `CommentUpdate` and nothing about it is permanent on the comment, the derivation can be replaced without touching stored comments.

### Community key, not the name

`K` uses the community's signing key, never its name or address. A name can change, and a key change or minter rotation already forces every `CommentUpdate` to be re-signed, so the tags are recomputed in the same pass under the new key.

## Test vectors

Fixed, non-secret keys (32-byte seeds, base64). The two `shared` derivations below agree, which is the whole point: a second device reproduces the tag from the author private key and the community public key alone.

```
communityPrivateKey (base64) = AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA
communityPublicKey  (base64) = ebVWLo/mVPlAeLES6KmLp5AfhTrmlb7X4OORC60ElmQ
authorPrivateKey    (base64) = ZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1+f4CBgoM
authorPublicKey     (base64) = C7w0aldmfDgBIL2cf9flHSxf3+o3zS9b9AWyxr9vLXg
cid                          = QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f

K   (base64) = FcBB8h9Hi7TfAVVr/sxB0euHUQFTT5LcrrsO8MUYo/c
tag          = nBUe3DGZKQ8fBcP6YGnpRQ
```

## Client side

pkc-js generates the tag and exports no helper. A client derives `K` once per (account, community) and checks each loaded comment:

```js
// Browser, WebCrypto + @noble for the ed25519→x25519 conversion only.
import { ed25519, x25519 } from "@noble/curves/ed25519.js";

const te = new TextEncoder();
const b64 = (bytes) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, "");

async function deriveK(authorPrivKey /* Uint8Array seed */, communityPubKey /* Uint8Array */) {
    const shared = x25519.getSharedSecret(ed25519.utils.toMontgomerySecret(authorPrivKey), ed25519.utils.toMontgomery(communityPubKey));
    const hkdfKey = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
        { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: te.encode("pkc-pseudonymity-author-tag-v1") },
        hkdfKey,
        256
    );
    return new Uint8Array(bits); // K
}

async function tagForCid(K, cid) {
    const key = await crypto.subtle.importKey("raw", K, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, te.encode(cid)));
    return b64(mac.slice(0, 16));
}

// Own-post check: communityPubKey is commentUpdate.signature.publicKey (base64-decoded).
const isMyPost = comment.pseudonymityAuthorTag && comment.pseudonymityAuthorTag === (await tagForCid(K, comment.cid));
```

A client that recognizes a comment adds its CID to the account's own-comments index. The check lives in the client (bitsocialnet/bitsocial-react-hooks#153), not in pkc-js.

Anyone who holds the account key can recompute every one of that account's tags, so an exported account key must be treated like a password.

## Security notes

- **What the community learns: nothing new.** The community already holds `originalAuthorPublicKey` for every alias. The tag is derived from a key it already has; it reveals nothing further to the operator.
- **Unlinkability to third parties.** Without `K`, two tags by the same author on the same board are unlinkable: each is an HMAC keyed by a secret only the account and the community can derive, over a distinct cid.
- **Leaked community key.** The signing key sits in the community DB next to the alias table, so a leak of the key is a leak of the table. The tags give such an attacker nothing they do not already have.
- **Quantum.** `K` comes from a static ECDH between the two signing keys, so an attacker who recovers the community private key (for example via a CRQC, issue #472) and holds an author's **public** key can test every archived tag on that board offline. On a pseudonymous board the author's public key does not appear (the alias signature and the ephemeral pubsub signer hide it), so this is testable only for accounts whose public key is visible elsewhere. An account with a BSIP-14 profile has a public author key, so with profiles enabled by default **most** accounts would be testable after a quantum break, not just a few. Tags live in `CommentUpdate` and can be withdrawn or re-derived under a new label later, but that does not protect pages an attacker archived beforehand. This trade-off was accepted deliberately: tagging every existing aliased comment on upgrade, with no change to the publish path, mattered more than post-quantum unlinkability.
- **No opt-out in this version.** Every existing aliased comment is tagged on upgrade without asking the author. A per-author opt-out is tracked as a follow-up in issue #599.

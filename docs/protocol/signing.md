# Signing and Verification

<!-- Note: "subplebbit" is being renamed to "community" — see RENAMING_GUIDE.md -->

## Summary

Every publication and record in the protocol is Ed25519 signed. Each type declares its own `signedPropertyNames` — an explicit list of which fields the signature covers. Verification re-encodes those exact fields with CBORG and checks the Ed25519 signature.

## How Signing Works

1. Determine `signedPropertyNames` for the type (defined per-schema, derived from schema keys minus `keysToOmitFromSignedPropertyNames`)
2. Extract only the named properties from the object, **excluding null/undefined values**
3. CBORG-encode the extracted object (deterministic binary encoding)
4. Sign the CBORG buffer with Ed25519 (`@noble/ed25519`)
5. Attach signature object: `{ signature, publicKey, signedPropertyNames, type: "ed25519" }`

## Who Signs What

| Record | Signed By | Signature Type | signedPropertyNames Const |
|--------|-----------|---------------|--------------------------|
| `CommentPubsubMessage` | Author | `JsonSignature` | `CommentSignedPropertyNames` |
| `CommentIpfs` | Author (preserved) | `JsonSignature` | `CommentSignedPropertyNames` |
| `CommentUpdate` | Subplebbit owner | `JsonSignature` | `CommentUpdateSignedPropertyNames` |
| `Vote` | Author | `JsonSignature` | `VoteSignedPropertyNames` |
| `CommentEdit` | Author | `JsonSignature` | `CommentEditSignedPropertyNames` |
| `CommentModeration` | Moderator | `JsonSignature` | `CommentModerationSignedPropertyNames` |
| `SubplebbitIpfs` | Subplebbit owner | `JsonSignature` | `SubplebbitSignedPropertyNames` |
| Challenge messages | Sender | `PubsubSignature` | Per-message type (binary, not JSON) |

## Signature Object Shapes

### JsonSignature (IPFS records)

```typescript
{
  signature: string;           // Ed25519 signature, base64 encoded
  publicKey: string;           // Ed25519 public key, base64 encoded
  signedPropertyNames: string[]; // Exact list of signed fields
  type: "ed25519";
}
```

### PubsubSignature (pubsub messages)

```typescript
{
  signature: Uint8Array;       // Ed25519 signature (binary)
  publicKey: Uint8Array;       // Ed25519 public key (binary, 32 bytes)
  signedPropertyNames: string[];
  type: string;
}
```

## signedPropertyNames Derivation

Each type's `signedPropertyNames` is computed from the schema:

```typescript
// Example from src/publications/comment/schema.ts
export const CommentSignedPropertyNames = remeda.keys.strict(
    remeda.omit(CreateCommentOptionsSchema.shape, keysToOmitFromSignedPropertyNames)
);
```

Where `keysToOmitFromSignedPropertyNames` = `["signer", "challengeRequest", "communityAddress"]` (defined in `src/signer/constants.ts`).

## Reserved Fields

Each publication type defines reserved fields — all field names that could appear on the full runtime object. These are used to prevent users from injecting fields that could collide with internal or future fields. See `CommentPubsubMessageReservedFields` in `src/publications/comment/schema.ts`.

## Key Functions

All in `src/signer/signatures.ts`:

| Function | Purpose |
|----------|---------|
| `signComment()` | Sign a CommentPubsubMessage |
| `signCommentUpdate()` | Sign a CommentUpdate (subplebbit signs) |
| `signVote()` | Sign a Vote |
| `signCommentEdit()` | Sign a CommentEdit |
| `signSubplebbit()` | Sign a SubplebbitIpfs record |
| `verifyComment()` | Verify CommentIpfs/CommentPubsubMessage signature |
| `verifyCommentUpdate()` | Verify CommentUpdate was signed by the correct subplebbit |
| `verifySubplebbit()` | Verify SubplebbitIpfs signature |
| `verifyPage()` | Verify all comments and updates in a page |

## Invariants

- `signedPropertyNames` is self-describing — the signature only covers the listed fields.
- Null/undefined values are excluded before CBORG encoding.
- The `signature` field itself is never in `signedPropertyNames`.
- `CommentUpdate.edit.signature.publicKey` must match the original comment's `signature.publicKey` — prevents someone else's edit from being injected.
- Old publications may have different `signedPropertyNames` than new ones (backward compat) — always use the list from the actual signature object, not a hardcoded const.

## Common Mistakes

- Including runtime fields in signing — fields like `address`, `publicKey`, `shortAddress` are not signed.
- Adding non-deterministic fields (random IDs, variable timestamps) to signable objects.
- Using the wrong signer — `CommentIpfs` must keep the author's signature; `CommentUpdate` must be signed by the subplebbit owner.
- Assuming `signedPropertyNames` is the same across all versions — old records may differ.

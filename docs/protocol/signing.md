# Signing and Verification

## Summary

Every publication and record in the protocol is Ed25519 signed. Each type declares its own `signedPropertyNames`: an explicit list of which fields the signature covers. Verification re-encodes those exact fields with CBORG and checks the Ed25519 signature.

## How Signing Works

1. Determine `signedPropertyNames` for the type (defined per-schema, derived from schema keys minus `keysToOmitFromSignedPropertyNames`)
2. Extract only the named properties from the object, **excluding null/undefined values**
3. CBORG-encode the extracted object (deterministic binary encoding)
4. Sign the CBORG buffer with Ed25519 (`@noble/curves/ed25519`)
5. Attach signature object: `{ signature, publicKey, signedPropertyNames, type: "ed25519" }`

## Who Signs What

| Record | Signed By | Signature Type | signedPropertyNames Const |
|--------|-----------|---------------|--------------------------|
| `CommentPubsubMessage` | Author | `JsonSignature` | `CommentSignedPropertyNames` |
| `CommentIpfs` | Author (preserved) | `JsonSignature` | `CommentSignedPropertyNames` |
| `CommentUpdate` | Community owner | `JsonSignature` | `CommentUpdateSignedPropertyNames` |
| `Vote` | Author | `JsonSignature` | `VoteSignedPropertyNames` |
| `CommentEdit` | Author | `JsonSignature` | `CommentEditSignedPropertyNames` |
| `CommentModeration` | Moderator | `JsonSignature` | `CommentModerationSignedPropertyNames` |
| `CommunityIpfsType` | Community owner | `JsonSignature` | `CommunitySignedPropertyNames` |
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
| `signCommentUpdate()` | Sign a CommentUpdate (community signs) |
| `signVote()` | Sign a Vote |
| `signCommentEdit()` | Sign a CommentEdit |
| `signCommunity()` | Sign a `CommunityIpfsType` record |
| `verifyComment()` | Verify CommentIpfs/CommentPubsubMessage signature |
| `verifyCommentUpdate()` | Verify CommentUpdate was signed by the correct community |
| `verifyCommunity()` | Verify `CommunityIpfsType` signature |
| `verifyPage()` | Verify all comments and updates in a page |

## Invariants

- `signedPropertyNames` is self-describing: the signature only covers the listed fields.
- Null/undefined values are excluded before CBORG encoding.
- The `signature` field itself is never in `signedPropertyNames`.
- `CommentUpdate.edit.signature.publicKey` must match the original comment's `signature.publicKey`: prevents someone else's edit from being injected.
- `CommentUpdate.edit.commentCid` must equal `CommentUpdate.cid` (`ERR_COMMENT_UPDATE_EDIT_IS_FOR_A_DIFFERENT_COMMENT`): prevents the community from moving the author's genuine edit or deletion of one comment onto another comment by the same author (issue #473).
- Old publications may have different `signedPropertyNames` than new ones (backward compat): always use the list from the actual signature object, not a hardcoded const.
- A publication is accepted only if the community can store it **byte-for-byte**. Two shapes verify as sent but not after the DB round trip, so validation rejects them with their own reason: an empty author object (`ERR_PUBLICATION_AUTHOR_IS_AN_EMPTY_OBJECT`: `cleanWireAuthor` turns `{}` into no author, and cborg encodes the two differently) and any string that is not well-formed Unicode (`ERR_PUBLICATION_HAS_MALFORMED_UNICODE_STRING`: cborg substitutes U+FFFD for a lone surrogate while signing and verifying, SQLite stores it as something else again, so the signature never covered the stored bytes). As a backstop for shapes nobody has named, `storeComment` and `storeCommentEdit` rebuild the record from the row the way the pages and `CommentUpdate.edit` rebuild it, and reject the publication (`ERR_COMMUNITY_CANNOT_STORE_PUBLICATION_VERBATIM`) if it no longer hashes to its cid or verifies. The row is read back from a savepoint that is rolled back before the real insert, because the check awaits and a transaction held open across an await is shared with every other exchange on the connection (issue #417). Without this, the first such row made the community's own pre-publish verification fail on every cycle and the board stopped publishing (issue #387).
- A comment record must sign every signable field it carries: `verifyCommentIpfs` and `_verifyCrosspost` reject a record where a field in `CommentSignedPropertyNames` is present but missing from `signature.signedPropertyNames`, checked on the un-picked record (issue #249). Community-generated `CommentIpfs` fields (`depth`, `thumbnailUrl*`, `previousCid`, `pseudonymityMode`) and unknown extra props from future protocol versions are exempt. Community acceptance is stricter still: `_allFieldsOfRecordInSignedPropertyNames` requires every field of the pubsub record to be signed.

## Common Mistakes

- Including runtime fields in signing: fields like `address`, `publicKey`, `shortAddress` are not signed.
- Adding non-deterministic fields (random IDs, variable timestamps) to signable objects.
- Using the wrong signer: `CommentIpfs` must keep the author's signature; `CommentUpdate` must be signed by the community owner.
- Assuming `signedPropertyNames` is the same across all versions: old records may differ.

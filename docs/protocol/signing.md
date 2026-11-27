# Signing and Verification

## Summary

Every publication and record in the protocol is Ed25519 signed. Each type declares its own `signedPropertyNames`: an explicit list of which fields the signature covers. Verification re-encodes those exact fields with CBORG and checks the Ed25519 signature. A signature whose `type` is not `"ed25519"` is invalid, on JSON records and on pubsub messages alike: the field is checked, so a later scheme can be told apart by it.

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

## Keys Named Like An Object Member

A record is invalid when one of its keys would replace a member of the instance a reader builds from it, whoever signed it. Two rules, one per kind of name:

- **Forbidden keys** (`forbiddenKeysOf` in `src/unknown-props.ts`): `__proto__`, `constructor`, `prototype`, any name `Object.prototype` has (`toString`, `hasOwnProperty`, ...), and any name starting with `_`. Refused at the top level of a record and inside its `author` object.
- **Members of a Comment** (`update`, `stop`, `publish`, `emit`, `on`, ...): in the reserved-field lists (`additionalCommentReservedFields` in `src/publications/comment/schema.ts`), so they are refused by the existing reserved-field checks. `test/node-and-browser/forbidden-record-keys.test.ts` compares the list with a live `Comment` and fails when a method is added without being reserved. Properties of a Comment are covered by the lists and by the compile-time check against `CommentJson`.

**Records stored before the rule.** A community accepted such keys until DB version 47, so its DB can hold comments with them. The open-time sweeps of the v47 migration re-verify every stored comment and comment edit, which purges the offenders (the same purge as for any invalid signature), and drop forbidden keys from stored challenge `commentUpdate` extras (`comments.challengeCommentUpdate`), keeping the comment. Without that, the community would fail its own signature check on every publish cycle. See `test/node/community/v46-to-v47.migration.db.community.test.ts`.

| Where | Rule | Result |
|-------|------|--------|
| `_verifyPublicationSignatureAndAuthor` (every publication type, so the community's acceptance path and every reader that verifies a comment) | forbidden keys, top level and `author` | `ERR_PUBLICATION_INCLUDES_FORBIDDEN_KEY`, `ERR_PUBLICATION_AUTHOR_INCLUDES_FORBIDDEN_KEY` |
| `checkCommentPublication` (community acceptance) | members of a Comment | `ERR_COMMENT_HAS_RESERVED_FIELD` |
| `verifyCommentIpfs` | both rules | `ERR_COMMENT_IPFS_INCLUDES_FORBIDDEN_KEY`, `ERR_COMMENT_IPFS_AUTHOR_INCLUDES_FORBIDDEN_KEY`, `ERR_COMMENT_IPFS_RECORD_INCLUDES_RESERVED_FIELD` |
| `_verifyCrosspost`, once per chain level | both rules | `ERR_CROSSPOST_COMMENT_INCLUDES_FORBIDDEN_KEY`, `ERR_CROSSPOST_COMMENT_AUTHOR_INCLUDES_FORBIDDEN_KEY` (a nested level surfaces through the level above's `ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID`) |
| `verifyCommentUpdate` | both rules | `ERR_COMMENT_UPDATE_INCLUDES_FORBIDDEN_KEY`, `ERR_COMMENT_UPDATE_AUTHOR_INCLUDES_FORBIDDEN_KEY`, `ERR_COMMENT_UPDATE_RECORD_INCLUDES_RESERVED_FIELD` |
| `parseCommentIpfsSchemaWithPKCErrorIfItFails` (the crosspost chain included), `parseCommentUpdateSchemaWithPKCErrorIfItFails` | forbidden keys | the same codes, thrown |
| `validateChallengeResult` (a challenge's `commentUpdate` extras) | reserved names and forbidden keys | `ERR_CHALLENGE_RESULT_OVERRIDES_RESERVED_COMMENT_UPDATE_FIELD` |

Every other unknown key is free-form, top level and in `author`: a future field is fine, and `extraProp` still loads. The loaders refuse the same names again when they build the instance, for a record that never went through a gate (see [wire-vs-runtime.md](./wire-vs-runtime.md#unknown-props-and-author-keys-from-a-record)).

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
- Every field of `CommentUpdate.edit` must be in `edit.signature.signedPropertyNames` (`ERR_COMMENT_UPDATE_EDIT_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES`). `signedPropertyNames` is not itself signed, so without this a community could drop `"deleted"` from the author's list and add `deleted: true`, and the author's signature would still verify over the fields the author did sign.
- `verifyCommentUpdate` runs the cid and edit checks before its cache lookup, and the cache key includes the whole `edit`. Pages verify their CommentUpdates with `validateUpdateSignature: false`, so a cache entry keyed only on `update.signature.signature` let a community serve an honest update, then a forged edit reusing its signature, and skip every edit check.
- Old publications may have different `signedPropertyNames` than new ones (backward compat): always use the list from the actual signature object, not a hardcoded const.
- A publication is accepted only if the community can store it **byte-for-byte**. Two shapes verify as sent but not after the DB round trip, so validation rejects them with their own reason: an empty author object (`ERR_PUBLICATION_AUTHOR_IS_AN_EMPTY_OBJECT`: `cleanWireAuthor` turns `{}` into no author, and cborg encodes the two differently) and any string that is not well-formed Unicode (`ERR_PUBLICATION_HAS_MALFORMED_UNICODE_STRING`: cborg substitutes U+FFFD for a lone surrogate while signing and verifying, SQLite stores it as something else again, so the signature never covered the stored bytes). As a backstop for shapes nobody has named, `storeComment` and `storeCommentEdit` rebuild the record from the row the way the pages and `CommentUpdate.edit` rebuild it, and reject the publication (`ERR_COMMUNITY_CANNOT_STORE_PUBLICATION_VERBATIM`) if it no longer hashes to its cid or verifies. The row is read back from a savepoint that is rolled back before the real insert, because the check awaits and a transaction held open across an await is shared with every other exchange on the connection (issue #417). Without this, the first such row made the community's own pre-publish verification fail on every cycle and the board stopped publishing (issue #387).
- A comment record must sign every signable field it carries: `verifyCommentIpfs` and `_verifyCrosspost` reject a record where a field in `CommentSignedPropertyNames` is present but missing from `signature.signedPropertyNames`, checked on the un-picked record (issue #249). Community-generated `CommentIpfs` fields (`depth`, `thumbnailUrl*`, `previousCid`, `pseudonymityMode`) and unknown extra props from future protocol versions are exempt. Community acceptance is stricter still: `_allFieldsOfRecordInSignedPropertyNames` requires every field of the pubsub record to be signed.

## Common Mistakes

- Including runtime fields in signing: fields like `address`, `publicKey`, `shortAddress` are not signed.
- Adding non-deterministic fields (random IDs, variable timestamps) to signable objects.
- Using the wrong signer: `CommentIpfs` must keep the author's signature; `CommentUpdate` must be signed by the community owner.
- Assuming `signedPropertyNames` is the same across all versions: old records may differ.

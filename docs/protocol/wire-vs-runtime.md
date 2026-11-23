# Wire Format vs Runtime Fields

## Summary

The protocol distinguishes between **wire format** (what gets signed and stored on IPFS/pubsub) and **runtime fields** (computed locally by pkc-js). Wire format is minimal: no `address`, no `publicKey`, no state tracking. Runtime fields like `address` are derived from the signature's public key and the record's `name` field.

## The Rule

**Wire format has no `address` field.** The `address` is always computed at runtime:

```
address = name || publicKey
```

Where:
- `name` = domain string (e.g., `"memes.bso"`), optional, set by the entity
- `publicKey` = IPNS address derived from signature's Ed25519 public key, always available

## Runtime-Only Fields

### Author

Defined in `src/publications/publication-author.ts`:

```typescript
const runtimeOnlyAuthorFields = ["address", "publicKey", "shortAddress", "community", "nameResolved"] as const;
```

| Field | Wire? | Runtime? | Source |
|-------|-------|----------|--------|
| `name` | Yes | Yes | Set by author (domain or display name) |
| `displayName` | Yes | Yes | Author's chosen display name |
| `avatar`, `flair`, `wallets` | Yes | Yes | Author-set metadata |
| `address` | **No** | Yes | Computed: `name \|\| publicKey` |
| `publicKey` | **No** | Yes | Derived from `signature.publicKey` |
| `shortAddress` | **No** | Yes | Truncated address for display |
| `community` | **No** | Yes | Per-community stats from CommentUpdate |
| `nameResolved` | **No** | Yes | Whether domain resolution succeeded |

### Community

Defined in `src/community/community-wire.ts`:

```typescript
const runtimeOnlyCommunityFields = ["address", "publicKey", "shortAddress", "nameResolved"] as const;
```

Same pattern: `address = name || publicKey`, computed from the IPNS record's signature.

Note the counter-example: `anchor: { publicKey }` looks runtime-ish but is a **signed wire field**
(#257) — a delegated community's record declares its anchor so a reader who reached it through the
minter can recover the identity. `ipnsHops` stays runtime-only.
See [delegated-ipns.md](delegated-ipns.md).

## Key Functions

### Author Wire/Runtime Conversion

All in `src/publications/publication-author.ts`:

| Function | Purpose |
|----------|---------|
| `omitRuntimeAuthorFields(author)` | Strip runtime fields before storage/wire transmission |
| `cleanWireAuthor(author)` | Get clean wire author (omit runtime fields, return undefined if empty). Only ever applied to an author that is signed as absent or non-empty: an incoming `author: {}` is rejected at validation, because dropping it would change the signed bytes (issue #387) |
| `buildRuntimeAuthor({ author, signaturePublicKey, community })` | Rebuild runtime fields from wire + signature |
| `getAuthorNameFromWire(author)` | Extract `name` from wire format (handles backward compat) |
| `getAuthorDomainFromWire(author)` | Extract domain name if `name` is a domain |

### Community Wire/Runtime Conversion

All in `src/community/community-wire.ts`:

| Function | Purpose |
|----------|---------|
| `omitRuntimeCommunityFields(community)` | Strip runtime fields before storage/wire transmission |
| `cleanWireCommunity(community)` | Get clean wire community |
| `buildRuntimeCommunity({ communityRecord, signaturePublicKey })` | Rebuild `{ address, publicKey, name? }` from wire + signature |
| `getCommunityNameFromWire(community)` | Extract `name` from wire (handles backward compat with old `address` field) |
| `getCommunityDomainFromWire(community)` | Extract domain name if `name` is a domain |

## Unknown Props And Author Keys From A Record

A record can carry props this client does not know yet (a newer protocol field, or a key a challenge put in a `commentUpdate`). They are copied onto the instance so they stay readable, and that copy is the one place a record decides the name of a member of an instance. `src/unknown-props.ts` is the only way a loader does it:

- `assignUnknownProps({ target, record, knownKeys })` copies the keys outside `knownKeys` and returns what it `assigned` and `skipped`. It never replaces a member of the target: a name the instance already has (own or inherited, so methods, private fields and `Object.prototype` members alike) is skipped, as is any name starting with `_`, `__proto__`, `constructor` and `prototype`, and any function value. A name an earlier record assigned (`tip: 1`, then `tip: 2`) stays updatable, tracked per target, so a newer protocol field keeps updating. Used for `CommentIpfs`, `CommentUpdate`, the challenge-verification `commentUpdate` and the Community record.
- `mergeAuthorProps({ target, props })` is the same rule for the `author` object, where known fields must still overwrite: it refuses `_` names, the prototype names and any name `Object.prototype` has (`toString`, `hasOwnProperty`, ...). It builds `comment.author` and the author of every embedded crosspost level.

The rule is applied to the instance at load and also **at the gate**: a record with such a key, at the top level or in its `author`, is invalid, and so is a record that names a member of a Comment (`update`, `stop`, ...), so a community refuses it and no reader is asked to copy it. See [signing.md](./signing.md#keys-named-like-an-object-member).

`deepMergeRuntimeFields` (server-sent RPC `runtimeFields`) ignores `__proto__`, `constructor` and `prototype` keys, so a hostile RPC server cannot walk it into a prototype.

When you add a runtime member to `Comment`, `Community` or another instance, nothing needs updating here: the member is protected by existing on the instance. Add it to the reserved-field list as before, which is what stops a publisher from signing the name at all: a new method of `Comment` has to be reserved, and `forbidden-record-keys.test.ts` fails until it is.

## Backward Compatibility

Old wire records may have `address` in the wire format. The code handles this:

- `getAuthorNameFromWire()` falls back to checking `author.address` if it's a domain
- `getCommunityNameFromWire()` falls back to checking `community.address` if it's a domain
- Schemas use `.loose()` for parsing old records that may have extra fields

## Invariants

- **Never override `author.address` or `community.address`**: they are computed, immutable runtime fields. Use `nameResolved` to indicate domain resolution status.
- **Always use `omitRuntimeAuthorFields()` / `omitRuntimeCommunityFields()`** before serializing to wire or storing in DB.
- **Always use `buildRuntimeAuthor()` / `buildRuntimeCommunity()`** after deserializing from wire: never manually assign `address`.
- When adding a new field, decide: does it go on wire (signed, permanent) or is it runtime-only (computed, ephemeral)?
- **A record never sets a member of an instance**: unknown props go through `assignUnknownProps`, the `author` object through `mergeAuthorProps`. Never `Object.assign(instance, record)`.
- **An author with no fields is omitted, never `{}`**: pkc-js strips an empty author before signing, and a community rejects a publication that signs one (`ERR_PUBLICATION_AUTHOR_IS_AN_EMPTY_OBJECT`), so the wire-to-row-to-wire round trip never has to preserve an empty object (issue #387).

## Common Mistakes

- Storing `address` in wire format: it should never be on wire in new code.
- Manually computing `address` instead of using `buildRuntimeAuthor()` / `buildRuntimeCommunity()`.
- Forgetting to call `omitRuntimeAuthorFields()` before signing: including runtime fields in a signature will make verification fail.
- Confusing `name` (domain, goes on wire) with `address` (computed, runtime only).

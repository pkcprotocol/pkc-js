# Wire Format vs Runtime Fields

<!-- Note: "subplebbit" is being renamed to "community" — see RENAMING_GUIDE.md -->

## Summary

The protocol distinguishes between **wire format** (what gets signed and stored on IPFS/pubsub) and **runtime fields** (computed locally by plebbit-js). Wire format is minimal — no `address`, no `publicKey`, no state tracking. Runtime fields like `address` are derived from the signature's public key and the record's `name` field.

## The Rule

**Wire format has no `address` field.** The `address` is always computed at runtime:

```
address = name || publicKey
```

Where:
- `name` = domain string (e.g., `"plebbit.eth"`) — optional, set by the entity
- `publicKey` = IPNS address derived from signature's Ed25519 public key — always available

## Runtime-Only Fields

### Author

Defined in `src/publications/publication-author.ts`:

```typescript
const runtimeOnlyAuthorFields = ["address", "publicKey", "shortAddress", "subplebbit", "nameResolved"] as const;
```

| Field | Wire? | Runtime? | Source |
|-------|-------|----------|--------|
| `name` | Yes | Yes | Set by author (domain or display name) |
| `displayName` | Yes | Yes | Author's chosen display name |
| `avatar`, `flair`, `wallets` | Yes | Yes | Author-set metadata |
| `address` | **No** | Yes | Computed: `name \|\| publicKey` |
| `publicKey` | **No** | Yes | Derived from `signature.publicKey` |
| `shortAddress` | **No** | Yes | Truncated address for display |
| `subplebbit` | **No** | Yes | Per-community stats from CommentUpdate |
| `nameResolved` | **No** | Yes | Whether domain resolution succeeded |

### Subplebbit

Defined in `src/subplebbit/subplebbit-wire.ts`:

```typescript
const runtimeOnlySubplebbitFields = ["address", "publicKey", "shortAddress", "nameResolved"] as const;
```

Same pattern: `address = name || publicKey`, computed from the IPNS record's signature.

## Key Functions

### Author Wire/Runtime Conversion

All in `src/publications/publication-author.ts`:

| Function | Purpose |
|----------|---------|
| `omitRuntimeAuthorFields(author)` | Strip runtime fields before storage/wire transmission |
| `cleanWireAuthor(author)` | Get clean wire author (omit runtime fields, return undefined if empty) |
| `buildRuntimeAuthor({ author, signaturePublicKey, subplebbit })` | Rebuild runtime fields from wire + signature |
| `getAuthorNameFromWire(author)` | Extract `name` from wire format (handles backward compat) |
| `getAuthorDomainFromWire(author)` | Extract domain name if `name` is a domain |

### Subplebbit Wire/Runtime Conversion

All in `src/subplebbit/subplebbit-wire.ts`:

| Function | Purpose |
|----------|---------|
| `omitRuntimeSubplebbitFields(sub)` | Strip runtime fields before storage/wire transmission |
| `cleanWireSubplebbit(sub)` | Get clean wire subplebbit |
| `buildRuntimeSubplebbit({ subplebbitRecord, signaturePublicKey })` | Rebuild `{ address, publicKey, name? }` from wire + signature |
| `getSubplebbitNameFromWire(sub)` | Extract `name` from wire (handles backward compat with old `address` field) |

## Backward Compatibility

Old wire records may have `address` in the wire format (before Phase 1B). The code handles this:

- `getAuthorNameFromWire()` falls back to checking `author.address` if it's a domain
- `getSubplebbitNameFromWire()` falls back to checking `sub.address` if it's a domain
- Schemas use `.loose()` for parsing old records that may have extra fields

## Invariants

- **Never override `author.address` or `subplebbit.address`** — they are computed, immutable runtime fields. Use `nameResolved` to indicate domain resolution status.
- **Always use `omitRuntimeAuthorFields()` / `omitRuntimeSubplebbitFields()`** before serializing to wire or storing in DB.
- **Always use `buildRuntimeAuthor()` / `buildRuntimeSubplebbit()`** after deserializing from wire — never manually assign `address`.
- When adding a new field, decide: does it go on wire (signed, permanent) or is it runtime-only (computed, ephemeral)?

## Common Mistakes

- Storing `address` in wire format — it should never be on wire in new code.
- Manually computing `address` instead of using `buildRuntimeAuthor()` / `buildRuntimeSubplebbit()`.
- Forgetting to call `omitRuntimeAuthorFields()` before signing — including runtime fields in a signature will make verification fail.
- Confusing `name` (domain, goes on wire) with `address` (computed, runtime only).

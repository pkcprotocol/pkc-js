# Names and Addresses

<!-- Note: "subplebbit" is being renamed to "community" — see RENAMING_GUIDE.md -->

## Summary

Authors and subplebbits are identified by an `address`, which is computed at runtime as `name || publicKey`. A `name` is an optional domain (`.eth`, `.bso`, etc.) that resolves to a public key. If no domain is set, the address is the IPNS public key derived from the Ed25519 signing key.

## The Address Formula

```
address = name || publicKey
```

- `name`: Optional domain string (e.g., `"plebbit.eth"`, `"memes.bso"`). Stored on wire.
- `publicKey`: IPNS address derived from `signature.publicKey` via `getPlebbitAddressFromPublicKeySync()`. Always available.
- `address`: **Runtime-only** — never stored on wire, never signed, never sent over pubsub.

## Domain Resolution

Domains are resolved via the `nameResolvers` plugin system configured on the Plebbit instance:

```typescript
// Each resolver has:
{
  key: string;           // resolver identifier
  resolve: Function;     // domain → publicKey
  canResolve: Function;  // domain → boolean (can this resolver handle it?)
  provider: string;      // provider URL
}
```

- `nameResolved: boolean | undefined` — tracks whether domain resolution succeeded. This is a **runtime-only** field.
- Resolution happens on the RPC server for browser clients — RPC clients don't need `nameResolvers` configured locally.

## RPC-Side Resolution

Name resolution happens on the **RPC server**, not the RPC client. This means:

- **RPC servers** must have `nameResolvers` configured (e.g., `@bitsocial/bso-resolver`) to resolve domain names like `memes.bso`.
- **RPC clients** do **not** need `nameResolvers` — they pass domain names directly to the server via `subplebbitUpdateSubscribe`, `createSubplebbit`, etc., and the server resolves them using its own resolvers.
- This keeps browser and mobile clients lightweight — no web3 dependencies needed on the client side.

If an RPC server has no resolvers configured, any request with a domain name will fail with `ERR_NO_RESOLVER_FOR_NAME`.

## Invariants

- `author.address` and `subplebbit.address` are **immutable** — never override or fall back to a derived address.
- Use `nameResolved` to indicate whether a domain resolved correctly — do NOT change `address`.
- An author and a community **cannot share the same domain name**.
- `shortAddress` is runtime-only — a truncated `address` for display purposes.

## Key Functions

| Function | File | Purpose |
|----------|------|---------|
| `getPlebbitAddressFromPublicKeySync()` | `src/signer/util.ts` | Ed25519 public key → IPNS address |
| `isStringDomain()` | `src/util.ts` | Check if a string is a domain name |
| `getAuthorDomainFromWire()` | `src/publications/publication-author.ts` | Extract domain from wire author |
| `getSubplebbitDomainFromWire()` | `src/subplebbit/subplebbit-wire.ts` | Extract domain from wire subplebbit |
| `buildRuntimeAuthor()` | `src/publications/publication-author.ts` | Compute `address` from wire + signature |
| `buildRuntimeSubplebbit()` | `src/subplebbit/subplebbit-wire.ts` | Compute `address` from wire + signature |

## Address Types

| Example | Type | Derived From |
|---------|------|-------------|
| `12D3KooW...` | IPNS public key | `signature.publicKey` via PeerId |
| `plebbit.eth` | ENS domain | Resolves to IPNS public key via ENS |
| `memes.bso` | BSO domain | Resolves to IPNS public key via BSO resolver |

## Common Mistakes

- Overriding `author.address` when domain resolution fails — use `nameResolved = false` instead.
- Putting `address` in wire format — it's runtime-only in new code (see `wire-vs-runtime.md`).
- Assuming all addresses are domains — most are IPNS public keys with no domain.
- Trying to share a domain between an author and a community — this is not supported.

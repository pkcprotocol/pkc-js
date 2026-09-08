# Names and Addresses

## Summary

Authors and communities are identified by an `address`, which is computed at runtime as `name || publicKey`. A `name` is an optional domain (`.eth`, `.bso`, etc.) that resolves to a public key. If no domain is set, the address is the IPNS public key derived from the Ed25519 signing key.

## The Address Formula

```
address = name || publicKey
```

-   `name`: Optional domain string (e.g., `"memes.bso"`). Stored on wire.
-   `publicKey`: IPNS address. Usually derived from `signature.publicKey` via `getPKCAddressFromPublicKeySync()`. Always available.
-   `address`: **Runtime-only**, never stored on wire, never signed, never sent over pubsub.

> Delegated IPNS exception: for a community published via a delegated IPNS chain, the
> content is signed by the terminal (minter) key, so `publicKey` is the **anchor** IPNS name
> (`ipnsHops[0]`), not the signature-derived key. Identity stays the anchor; the content is
> verified against the terminal name. See [delegated-ipns.md](delegated-ipns.md).

## Domain Resolution

Domains are resolved via the `nameResolvers` plugin system configured on the PKC instance:

```typescript
// Each resolver has:
{
    key: string; // resolver identifier
    resolve: Function; // domain → publicKey
    canResolve: Function; // domain → boolean (can this resolver handle it?)
    provider: string; // provider URL
}
```

-   `nameResolved: boolean | undefined`: tracks whether domain resolution succeeded. This is a **runtime-only** field.
    For a **delegated** community it means specifically "the TXT record points at the **anchor**" — a domain
    pointing at the community's own minter (or any non-anchor hop of its chain) is `nameResolved: false`,
    not a key migration. See [delegated-ipns.md](delegated-ipns.md), "Domains, the anchor claim, and
    `nameResolved`".
-   Resolution happens on the RPC server for browser clients, RPC clients don't need `nameResolvers` configured locally.

## Caching responsibility

**pkc-js owns name-resolution caching. Resolvers should be thin network wrappers.**

-   pkc-js maintains a persistent cache of raw `name → publicKey` resolutions at `${dataPath}/lru-storage/nameResolutions.db` (Node) or in localforage (browser). Falls back to in-memory under `noData: true`.
-   Cache entries record `{ publicKey, resolverKey, provider, resolvedAtMs }` and are keyed by `${name}::${resolverKey}::${sha256(provider)}` so that different resolvers or different RPC providers do not collide.
-   Resolvers should NOT implement their own cache. The contract is plug-in simplicity: `canResolve` + `resolve` + nothing else mandatory. A resolver implementation that just hits the network on every call is a fully valid implementation; pkc-js calls it sparingly.

### Per-call freshness control

Callers control cache freshness via an optional `cache` parameter on `resolveAuthorNameIfNeeded` and `resolveCommunityNameIfNeeded`, modeled on HTTP `Cache-Control: max-age` (seconds):

```typescript
type NameResolveCacheOptions = {
    maxAge?: number; // seconds. undefined = use cache freely; 0 = bypass; N = use if entry younger than N
};
```

Defaults applied at each call site:

| Call site                                    | `maxAge`     |
| -------------------------------------------- | ------------ |
| Mod role check (incoming moderation actions) | `0`          |
| Incoming publication validation              | `1800` (30m) |
| Admin role assignment                        | `0`          |
| Admin domain edit verification               | `600` (10m)  |
| Subscribe-by-domain (initial fetch)          | `3600` (1h)  |
| Background community drift detection         | `3600`       |
| Background author display-name resolution    | `3600`       |

### Negative caching

The persistent cache stores only successful resolutions. Failures are not persisted; the next caller retries. The in-memory verification cache (`PKC._memCaches.nameResolvedCache`) caches `(name + signaturePublicKey) → boolean` for sync hot-path lookups by `Comment._setAuthorNameResolvedFromCache` and friends; it stores `false` only for definitive non-matches and the definitive `ERR_NO_RESOLVER_FOR_NAME` case, never for transient errors.

## RPC-Side Resolution

Name resolution happens on the **RPC server**, not the RPC client. This means:

-   **RPC servers** must have `nameResolvers` configured (e.g., `@bitsocial/bso-resolver`) to resolve domain names like `memes.bso`.
-   **RPC clients** do **not** need `nameResolvers`. They pass domain names directly to the server via `communityUpdateSubscribe`, `createCommunity`, etc., and the server resolves them using its own resolvers.
-   This keeps browser and mobile clients lightweight, no web3 dependencies needed on the client side.

If an RPC server has no resolvers configured, any request with a domain name will fail with `ERR_NO_RESOLVER_FOR_NAME`.

## Invariants

-   `author.address` and `community.address` are **immutable**, never override or fall back to a derived address.
-   `author.address` is never an identity on the community side. Excludes, roles and blacklists match through the signer address or a domain resolved to it (`docs/protocol/challenge-flow.md`, "Author identity in excludes").
-   Use `nameResolved` to indicate whether a domain resolved correctly, do NOT change `address`.
-   An author and a community **cannot share the same domain name**.
-   `shortAddress` is runtime-only, a truncated `address` for display purposes.

## Key Functions

| Function                           | File                                     | Purpose                                 |
| ---------------------------------- | ---------------------------------------- | --------------------------------------- |
| `getPKCAddressFromPublicKeySync()` | `src/signer/util.ts`                     | Ed25519 public key → IPNS address       |
| `isStringDomain()`                 | `src/util.ts`                            | Check if a string is a domain name      |
| `getAuthorNameFromWire()`          | `src/publications/publication-author.ts` | Extract name from wire author           |
| `getCommunityDomainFromWire()`     | `src/community/community-wire.ts`        | Extract domain from wire community      |
| `buildRuntimeAuthor()`             | `src/publications/publication-author.ts` | Compute `address` from wire + signature |
| `buildRuntimeCommunity()`          | `src/community/community-wire.ts`        | Compute `address` from wire + signature |

## Address Types

| Example       | Type            | Derived From                                 |
| ------------- | --------------- | -------------------------------------------- |
| `12D3KooW...` | IPNS public key | `signature.publicKey` via PeerId             |
| `vitalik.eth` | ENS domain      | Resolves to IPNS public key via ENS          |
| `memes.bso`   | BSO domain      | Resolves to IPNS public key via BSO resolver |

## Common Mistakes

-   Overriding `author.address` when domain resolution fails, use `nameResolved = false` instead.
-   Putting `address` in wire format, it's runtime-only in new code (see `wire-vs-runtime.md`).
-   Assuming all addresses are domains, most are IPNS public keys with no domain.
-   Trying to share a domain between an author and a community, this is not supported.

# Proposal: `subplebbitIpfs.name`, `subplebbit.publicKey`, `author.name`, `author.publicKey`, `nameResolved` flag

## Problem

Currently, a subplebbit has a single `address` field that can be either a raw IPNS key (`12D3KooW...`) or a single domain name (`memes.bso`). This creates several problems:

### 1. Publications need both identity and cryptographic linkage

Publications currently carry `subplebbitAddress` only. In this proposal, effective community identity is `name || publicKey` (the `address` value), but clients also need cryptographic linkage for verification/loading flows. If a named community changes its domain name, it creates a new identity string, and old publications remain under the old identity.

Additionally, loading a subplebbit by its IPNS public key currently fails if the record's `address` is a domain name, because validation does a strict string comparison. This blocks the ability to skip blockchain resolution and load directly by public key.

### 2. `address` is no longer universally resolvable

Once domain resolution moves out of plebbit-js into pkc-js clients (see [#68](https://github.com/plebbit/plebbit-js/issues/68)), the idea of a single `address` field that works across all clients is no longer true. A client without the matching resolver cannot resolve a domain address.

This is an acceptable trade-off for protocol neutrality — pkc-js should not mandate which resolvers clients must implement. The `publicKey` provides a universal fallback key that works regardless of resolver choices.

## Protocol neutrality

A key design goal is that **pkc-js remains a neutral protocol layer**. Different clients may ship with different resolvers — one client might support `.bso` (ENS-based), another might support a future `.ton`. This is intentional: pkc-js should not force clients to import specific resolver libraries.

Note: `.sol` support has been removed. Only ENS-based resolution (`.bso`) is supported as the primary naming system.

A client that only supports `.ton` is not "forking pkc-js" — it's a legitimate pkc-js client serving a different naming ecosystem. The protocol supports this via:

-   `address` (`name || publicKey`) as effective identity
-   `publicKey` as universal cryptographic/fallback key (works everywhere)
-   `name` as a human-readable convenience (works if you have a matching resolver)
-   `nameResolved` flag to indicate whether the name has been verified against the publicKey

Specific apps (like bitsocial) can standardize on `.bso` for their ecosystem, but this is an app-level choice, not a protocol requirement.

### Resolver integration boundary (issue #68 direction)

This proposal defines protocol semantics (`name`, `publicKey`) plus runtime semantics (`nameResolved`) and validation behavior.

Resolver composition and provider wiring (for example, chain provider JSON, resolver keys, and UI loading labels like "resolving from ethrpc.xyz") are client/hook concerns outside this protocol document.

pkc-js should treat resolver keys as opaque identifiers and should not require a specific key format.

## Proposal

### 1. Add `name` field to `SubplebbitIpfs`

Add a new optional `name` field to the signed SubplebbitIpfs record:

```ts
name?: string   // e.g., "memes.bso"
```

-   **Simple string** — resolver selection is implementation-defined (for example via `supports({name})` / `canResolve({name})`); TLD suffixes are common but not required
-   **Optional** — communities without domain names simply omit this field
-   **Signed** — part of the SubplebbitIpfs record, included in the subplebbit signature
-   **Editable** — sub owner sets it via `subplebbit.edit({ name: "memes.bso" })`
-   **Untrusted until verified** — `name` in SubplebbitIpfs is a claim by the sub owner, not proof of ownership. The sub owner's signature only proves they _claim_ this name, not that it actually resolves to their public key. Name verification happens automatically via async resolution when both `publicKey` and `name` are provided. Until verified (`nameResolved = false`), the name should be treated as an unverified display hint.
-   **`nameResolved` is runtime-only** — it is not part of SubplebbitIpfs and is not signed on the wire. It exists only on the subplebbit instance.

**`publicKey` on the instance is the cryptographic key:**

`subplebbit.publicKey` is the IPNS key string (`12D3KooW...`) and should always be available on the instance (derived from `signature.publicKey` when needed). Effective identity is `address = name || publicKey`. If `name` exists, that name is the identity string used by publications.

**Decision: `publicKey` is instance-only, not in wire format.** `publicKey` is always derived from `signature.publicKey` on the instance. It is not included in SubplebbitIpfs or any wire protocol records. This is consistent with how other protocols (nostr, bluesky, activitypub) handle computable properties — they are not included in the protocol to avoid redundancy. Since `signature.publicKey` is already present in every signed record, including a separate `publicKey` field would be redundant.

**Serialization requirement:** `address`, `name`, and `publicKey` must all be **enumerable properties** on the subplebbit class instance. This means they must appear in `JSON.stringify(subplebbit)` output and be accessible via object destructuring (`const { address, name, publicKey } = subplebbit`). Implementation-wise, these properties should be plain instance properties (not getters on the prototype) so that they are own enumerable properties of the object.

**`shortAddress` is unchanged** — it remains derived from `address` as it is today. No changes needed.

**Relationship between `address` and `name`:**

**Decision: `address` is instance-only/computed, not in wire format.** `address` is computed as `name || publicKey` on the instance. It is not included in SubplebbitIpfs wire records. Since `address` is fully derivable from `name` (if present in the record) and `publicKey` (derived from `signature.publicKey`), including it in the protocol would violate the principle of not including computable properties — consistent with nostr, bluesky, activitypub, etc. Old records that have `address` in their `signedPropertyNames` will still verify correctly due to the self-describing signature verification.

If a community has a name, that name is its identity string. Changing the name creates a new identity string, so old comments/publications remain associated with the previous name-based identity.

**Editing name/address (backward compatibility):**

Sub owners can set the domain name via either:

-   `subplebbit.edit({ name: "memes.bso" })` — preferred, explicit
-   `subplebbit.edit({ address: "memes.bso" })` — backward compatible, sets `name` if address is a domain

| Edit call                                   | Behavior                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `edit({ name: "memes.bso" })`               | Sets `name = "memes.bso"`, `address = "memes.bso"`                                        |
| `edit({ name: undefined })`                 | Clears `name`, `address` reverts to `publicKey`                                           |
| `edit({ address: "memes.bso" })`            | Same as `edit({ name: "memes.bso" })` — backward compat                                   |
| `edit({ address: "12D3KooW..." })`          | If matches `publicKey`: clears `name`, sets `address = publicKey`. Otherwise: throw error |
| `edit({ name: "a.bso", address: "b.bso" })` | Throw error — conflicting values                                                          |

### 2. Add `communityPublicKey` and `communityName` to publications

Publications (comments, votes, edits, moderations) currently carry only `subplebbitAddress`. This is semantically incomplete for clients that also need cryptographic linkage and resolver-independent loading.

Add two non-computable wire fields to publications:

-   `communityPublicKey` — **wire field**, the IPNS key string (`12D3KooW...`), required for new publications but **optional in the wire schema** for backward compatibility with old publications that only have `subplebbitAddress`
-   `communityName` — **wire field**, optional, the domain name (e.g., `"memes.bso"`) if the community has one
-   `communityAddress` — **instance-only**, computed as `communityName || communityPublicKey` (not in wire format)

This follows the same "no computable props" principle: `communityAddress` is derivable from `communityName` and `communityPublicKey`, so it is not included in the protocol.

**Backward compatibility for old publications:** When parsing old `CommentIpfs` records that have `subplebbitAddress` but no `communityPublicKey`:
-   If `subplebbitAddress` is an IPNS key → use it as `communityPublicKey`
-   If `subplebbitAddress` is a domain → fill `communityPublicKey` from community context (the community serving the page/update knows its own publicKey)
-   Old comments remain loadable.

Identity decisions (resolved):

-   `communityName` — **wire field** on publications (not computable, it's a claim set by the owner)
-   `communityPublicKey` — **wire field** on publications (the community's IPNS key; cannot be derived from the author's `signature.publicKey` since that is the author's key, not the community's)
-   `communityAddress` — **instance-only**, computed as `communityName || communityPublicKey`

Note: On **community records** (CommunityIpfs), the community's own `publicKey` is instance-only (derived from the community's `signature.publicKey`). On **publications**, `communityPublicKey` must be a wire field because the publication's signature belongs to the author, not the community.

-   ~~Whether `address` should remain in `SubplebbitIpfs` or be instance-only/computed~~ — **Resolved: instance-only** (not in wire format)
-   ~~Whether `subplebbit.publicKey` should be an explicit signed field in `SubplebbitIpfs` or derived on instance from `signature.publicKey`~~ — **Resolved: instance-only** (derived from `signature.publicKey`)
-   ~~If explicit `record.publicKey` is adopted~~ — **N/A, not adopted**
-   ~~Whether `author.publicKey` should be part of protocol/wire files or computed on instance from signature~~ — **Resolved: instance-only** (computed from signature)
-   ~~Whether to keep `author.address`~~ — **Resolved: yes, instance-only**, computed as `author.name || author.publicKey`

Implementation decisions (resolved):

-   ~~Address stability in `{publicKey}`-only flow when record later includes `name`~~ — **Resolved:** When caller provides only `publicKey`, `address` stays as `publicKey` even if the fetched record contains `name`. `community.name` IS populated from the record, but `address` remains stable at `publicKey`.
-   ~~Subplebbit indexing key strategy for `_updatingSubplebbits` and `_startedSubplebbits`~~ — **Resolved:** Index by `publicKey` (cryptographic key). Prevents duplicate entries when the same community is accessed by name and publicKey.
-   ~~Backward-compat tests for old publications~~ — **Resolved:** Yes, add tests proving old posts/replies that do not include `communityPublicKey`/`communityName` still load correctly.

### 3. Add `author.name`, `author.publicKey`, and `author.nameResolved`

Add to the Author type:

-   `name?: string` — e.g., "vitalik.bso" — **wire field** (in AuthorIpfsType, AuthorPubsubType), a domain name pointing to the author's public key (same concept as `community.name`). Unrelated to `author.displayName`, which is a free-text label.
-   `publicKey: string` — the author's IPNS key — **instance-only** (derived from signature.publicKey via getPlebbitAddressFromPublicKey, not in wire format)
-   `address: string` — **instance-only** (computed as `name || publicKey`, not in wire format). **Breaking change:** currently `author.address` is a required wire field in `AuthorPubsubSchema`. Old publications with `author.address` as a signed field remain valid via self-describing signature verification; the wired value is ignored and `address` is recomputed as `name || publicKey`.
-   `nameResolved?: boolean` — **instance-only** (runtime verification flag, not in wire format). `undefined` when no name is set, `false` when name is set but not yet verified, `true` when verified.

**Verification pattern (conditional on `resolveAuthorAddresses`):**

-   When `plebbitOptions.resolveAuthorAddresses = true` and author has both name and publicKey, resolve name async in background
-   `comment.author.nameResolved = false` initially
-   Set `nameResolved = true` when name text record resolves to matching publicKey
-   If `resolveAuthorAddresses = false`, `comment.author.nameResolved` stays `false` (no verification attempted)
-   UIs decide their own warning policy based on nameResolved flag

### Discovery hierarchy

The identifiers form a hierarchy:

| Method      | Cross-client compatible | Human readable  | Needs external resolution |
| ----------- | ----------------------- | --------------- | ------------------------- |
| `publicKey` | Yes — direct IPNS key   | No              | No                        |
| `name`      | No — resolver-dependent | Yes             | Yes (blockchain RPCs)     |
| `address`   | No — resolver-dependent | Yes (if domain) | Yes (if domain)           |

### Automatic name verification via async resolution

**Trust model:** `name` in SubplebbitIpfs is an **untrusted claim** by the sub owner. The sub owner's cryptographic signature only proves they _claim_ to own this name — it does not prove the name actually resolves to their public key on the blockchain. A malicious or misconfigured sub could claim any name.

**Key principle:** `address` is stable and does NOT change based on verification status. Instead, the `nameResolved` flag tracks verification state:

-   `address` = `name` (if name is set), otherwise `publicKey`
-   `nameResolved` = `false` initially, `true` when verified
-   UIs decide their own warning policy based on `nameResolved` flag

**Automatic verification:** plebbit-js performs name verification automatically based on how the subplebbit is created:

**Mismatch rule:** behavior depends on whether `publicKey` was explicitly provided by the caller. If it was provided, a name/publicKey mismatch is a critical error (emit `error`, stop updating). If it was not provided (name-driven resolution), the client may switch to the newly resolved publicKey.

#### When created with `{publicKey, name}` (async verification):

1. The client immediately uses `publicKey` to start fetching the IPNS record
2. `address` = `name`, `nameResolved` = `false`
3. Name resolution happens asynchronously in the background
4. Once verified, `nameResolved` is set to `true`

| Outcome                               | Behavior                                                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Name resolves to same publicKey       | `nameResolved = true`, verification complete                                                                                      |
| Name resolves to different publicKey  | **Critical error**: emit `error` event and stop updating (caller explicitly pinned `publicKey`)                                   |
| Name resolution fails (network error) | Emit `error` event, `nameResolved` stays `false`, retry with backoff                                                              |
| No resolver supports this name         | Emit warning, `nameResolved` stays `false`                                                                                        |

#### When created with `{name}` only (sync resolution first):

1. `address` is immediately set to the provided `name`
2. Name resolution must complete before IPNS fetching can begin
3. `updatingState` is `"resolving-address"` during resolution
4. Once resolved, behaves like `createSubplebbit({publicKey: resolvedPublicKey, name})`

| Outcome                               | Behavior                                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------------- |
| Name resolves successfully            | Proceed with `{publicKey: resolvedPublicKey, name}`, `address = name`, `nameResolved = true` |
| Name resolution fails (network error) | Emit `error` event, `updatingState` stays `"resolving-address"`, retry with backoff          |
| No resolver supports this name         | Throw `ERR_NO_RESOLVER_FOR_NAME` — cannot proceed without publicKey                           |

#### When created with `{publicKey}` only and record contains `name`:

1. `address` is set to the provided `publicKey` and **stays as `publicKey`** (caller's intent preserved)
2. IPNS record is fetched using publicKey
3. Record contains `name` field (e.g., `"memes.bso"`)
4. `community.name` = record's name, `nameResolved` = `false`
5. `address` remains `publicKey` — it does NOT switch to `name`
6. Start async name verification in background

| Outcome                               | Behavior                                                                                        |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Name resolves to same publicKey       | `nameResolved = true`                                                                           |
| Name resolves to different publicKey  | **Critical error**: emit `error` event and stop updating (caller explicitly pinned `publicKey`) |
| Name resolution fails (network error) | Emit `error` event, `nameResolved` stays `false`                                                |
| No resolver supports this name         | Emit `error`, `nameResolved` stays `false`                                                      |

**Important tradeoff:** When loading a community using publicKey without having the matching resolver, the client can never verify that `community.name` actually matches the publicKey. pkc-js should emit an error. In this case, `nameResolved` stays `false` and UIs should show appropriate warnings.

### UI and client storage recommendations

**Displaying names:** Since name verification happens automatically, clients should observe the `nameResolved` flag:

-   If `nameResolved = true`: the name has been verified — show normally
-   If `nameResolved = false` and `name` is set: verification is pending, skipped, or failed — UI should show warning based on its policy

### Name resolving

Name resolution is handled by an ordered array of resolver objects passed via `PkcOptions.nameResolvers`. Each resolver targets a single provider, enabling per-provider state tracking so UIs can display messages like "resolving eth address from ethrpc.xyz...".

#### Resolver API

Each resolver in the `nameResolvers` array has the following shape:

```ts
{
  key: string                                           // unique identifier, e.g. "eth-ethrpc.xyz", "dns-cloudflare-dns.com"
  resolve({name, provider}): Promise<string | undefined> // resolves a name to a public key
  canResolve({name}): boolean                            // returns whether this resolver can handle the given name
  provider: string                                       // the provider URL/identifier passed through to resolve()
}
```

-   **`key`** — a unique string identifying this resolver instance. Convention is `"{nameSystem}-{providerHostname}"` (e.g., `"eth-ethrpc.xyz"`, `"dns-cloudflare-dns.com"`). This mirrors the existing `key` convention from `libp2pJsConfig` and viem's optional `key` prop.
-   **`resolve`** — async function that attempts to resolve a name to a public key using the given provider. Returns the resolved value or `undefined` if the name doesn't exist.
-   **`canResolve`** — sync function that returns whether this resolver can handle the given name (e.g., an ENS resolver would return `true` for `"memes.bso"` but `false` for other TLDs).
-   **`provider`** — the provider URL or identifier (e.g., `"https://ethrpc.xyz"`, `"viem"`, `"ethers.js"`), passed through to the `resolve` function.

**Function-based over class-based:** The API uses plain objects with functions rather than class instances. This is simpler for resolver implementors — they export `resolve` and `canResolve` functions rather than implementing a class interface.

#### Resolver composition (client/hook responsibility)

Resolver composition happens at the client/hook level, not in pkc-js. Here's how a client like bitsocial would wire resolvers from account configuration:

```js
import {resolveBso, canResolveBso} from '@bitsocial/resolver-bso'
import {resolveDns, canResolveDns} from '@bitsocial/dns-over-https'

const nameResolvers = []

// add ENS resolvers (for .bso names)
for (const chainProviderUrl of account.nameResolversChainProviders?.eth?.urls || account.chainProviders?.eth?.urls) {
  nameResolvers.push({
    key: `eth-${new URL(chainProviderUrl).hostname}`,
    resolve: resolveBso,
    canResolve: canResolveBso,
    provider: chainProviderUrl
  })
}

// add dns resolvers
const dnsOverHttpsProviders = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/dns-query',
]
for (const provider of dnsOverHttpsProviders) {
  nameResolvers.push({
    key: `dns-${new URL(provider).hostname}`,
    resolve: resolveDns,
    canResolve: canResolveDns,
    provider
  })
}

const pkc = await Pkc({nameResolvers})
```

The account JSON supports two levels of chain provider configuration:

```json
{
  "account": {
    "chainProviders": {
      "eth": {"urls": ["viem", "ethers.js"], "chainId": 1}
    },
    "nameResolversChainProviders": {
      "eth": {"urls": ["https://ethrpc.xyz", "viem", "ethers.js"], "chainId": 1}
    }
  }
}
```

`nameResolversChainProviders` takes precedence over `chainProviders` when wiring name resolvers, allowing clients to use different providers for name resolution vs. other chain operations.

Note: `.sol` support has been removed. Only ENS-based resolution (`.bso`) is supported.

#### Resolution algorithm

pkc-js resolves names serially through the `nameResolvers` array, stopping on the first successful resolution:

```js
let value
for (const nameResolver of pkcOptions.nameResolvers) {
  if (!nameResolver.canResolve({name: community.name})) {
    continue
  }
  try {
    // change client ${nameResolver.key} state to resolving...
    value = await nameResolver.resolve({name: community.name, provider: nameResolver.provider})
  }
  catch (e) {}
  // change client ${nameResolver.key} state to stopped...
  if (value) {
    break
  }
}
```

For each resolver:
1. Check `canResolve({name})` — skip if the resolver doesn't handle this name
2. Update the resolver's client state to `"resolving"`
3. Call `resolve({name, provider})` — catch errors (move to next resolver)
4. Update the resolver's client state to `"stopped"`
5. If a value was returned, stop iterating

#### Client state tracking (`community.clients.nameResolvers`)

pkc-js exposes per-resolver client instances for state tracking:

```js
community.clients.nameResolvers = {
  'eth-ethrpc.xyz': nameResolverClient,
  'eth-viem': nameResolverClient,
  'eth-ethers.js': nameResolverClient,
  'dns-cloudflare-dns.com': nameResolverClient,
  'dns-dns.google': nameResolverClient,
}
```

These are constructed from `pkcOptions.nameResolvers`:

```js
community.clients.nameResolvers = {}
for (const nameResolver of pkcOptions.nameResolvers) {
  community.clients.nameResolvers[nameResolver.key] = new NameResolverClient({
    resolve: nameResolver.resolve,
    canResolve: nameResolver.canResolve,
    provider: nameResolver.provider
  })
}
```

Each `NameResolverClient` emits `statechange` events, enabling UIs to display per-provider resolution status:

```js
community.clients.nameResolvers['eth-ethrpc.xyz'].on('statechange', (state) => {
  console.log('current state is', state)
  // e.g., "resolving eth address from ethrpc.xyz..."
  console.log('current state is', community.clients.nameResolvers['eth-ethrpc.xyz'].state)
})
```

#### Design notes

-   **No `tlds` property** — a resolver does not need a list of TLDs. pkc-js never uses it, and not all name systems have TLDs (or some have hundreds, like DNS). The `canResolve({name})` function handles this responsibility instead.
-   **`key` over `name`** — `key` is the standard identifier convention, consistent with viem's optional `key` prop and the existing `libp2pJsConfig` pattern in plebbit-js.
-   **One resolver per provider** — each resolver instance targets a single provider. A single resolver per name system with multiple providers would make it impossible to map individual client states for per-provider UI feedback like "resolving eth address from ethrpc.xyz...".


## Prerequisite: allow loading subplebbits by public key

### Current behavior (blocker)

Today, `_findErrorInSubplebbitRecord()` in `src/subplebbit/subplebbit-client-manager.ts` does a strict string equality check:

```ts
if (subJson.address !== subInstanceAddress) {
    // ERR_THE_SUBPLEBBIT_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED
}
```

This means if you call `plebbit.getSubplebbit({ address: "12D3KooW..." })` but the fetched record has `address: "business-and-finance.bso"`, verification fails. The error is marked **non-retriable** — the load stops permanently.

### Required change

Relax the address check to accept the record if **either** condition is true:

1. `subJson.address === subInstanceAddress` (current behavior — exact match), **or**
2. The requested address is an IPNS key and it matches the IPNS name derived from the record's signature public key

The signature verification already confirms the record was signed by the IPNS key holder — the address check is redundant for this case.

## createSubplebbit behavior

The `createSubplebbit` function accepts multiple ways to identify a community:

### Parameter combinations

| Parameters                                     | Behavior                                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `{address: "12D3KooW..."}`                     | Use as IPNS key directly, no resolution needed                                                                    |
| `{address: "memes.bso"}`                       | Resolve domain to publicKey first, then fetch IPNS                                                                |
| `{address: "memes.bso", publicKey: "12D3..."}` | Use publicKey immediately for IPNS fetch, verify domain async. `address = name`, `nameResolved = false` initially |
| `{publicKey: "12D3KooW..."}`                   | Same as `{address: "12D3KooW..."}`                                                                                |
| `{publicKey: "12D3...", name: "memes.bso"}`    | Use publicKey for IPNS fetch, verify name async. `address = name`, `nameResolved = false` initially               |

### Conflict handling

| Conflict                                                                   | Resolution                                          |
| -------------------------------------------------------------------------- | --------------------------------------------------- |
| `{address: "12D3A...", publicKey: "12D3B..."}` (both IPNS keys, different) | **Throw error** — conflicting identities            |
| `{address: "memes.bso", publicKey: "12D3..."}`                             | Valid — use publicKey for IPNS, verify domain async |

### Address lifecycle

The `address` property is stable — it is set at creation time based on the caller's intent and does not change during verification. The `nameResolved` flag tracks verification state:

| State                                                   | `address` value | `name` value  | `nameResolved`    | Notes                                                         |
| ------------------------------------------------------- | --------------- | ------------- | ----------------- | ------------------------------------------------------------- |
| Created with publicKey only, no name in record          | `publicKey`     | `undefined`   | `undefined`       | No name to verify                                             |
| Created with publicKey only, record has name            | `publicKey`     | record's name | `false` → verified | `address` stays as `publicKey` (caller's intent preserved)   |
| Created with publicKey + name (unverified)              | `name`          | `name`        | `false`           | Verification in progress                                      |
| Created with name only                                  | `name`          | `name`        | `false` → `true`  | Resolves name first, then fetches IPNS                        |
| Name verified successfully                              | (unchanged)     | `name`        | `true`            | Safe to display name                                          |
| Name verification failed (mismatch, explicit publicKey) | (unchanged)     | `name`        | `false`           | **Critical error**: emit `error`, stop updating               |
| Name verification skipped (no resolver)                 | (unchanged)     | `name`        | `false`           | Name remains unverified                                       |

**Key principles:**
- When caller provides only `publicKey`: `address = publicKey` and stays stable even if the IPNS record contains `name`. The `name` property is populated from the record but does not change `address`.
- When caller provides `name` (explicitly or via domain `address`): `address = name`.
- The `nameResolved` flag indicates verification status. UIs decide their own warning policy for unverified names.

## Implementation plan (plebbit-js)

### Allow loading by public key (`src/subplebbit/subplebbit-client-manager.ts`)

-   Relax the address check in `_findErrorInSubplebbitRecord()`: if the requested address is an IPNS key matching the record's signer, accept the record even if `subJson.address` is a domain.
-   Update existing tests that assert loading by IPNS key fails — they should now succeed.

### Schema changes (`src/subplebbit/schema.ts`)

-   Add `name: z.string().min(1).optional()` to `SubplebbitIpfsSchema`
-   Do **not** add `nameResolved` to `SubplebbitIpfsSchema` (instance-only/runtime field)
-   Add `name: true` to `SubplebbitEditOptionsSchema` (editable by sub owner)
-   **Remove** `address` from `SubplebbitIpfsSchema` — it is instance-only, computed as `name || publicKey`
-   **Do not add** `publicKey` to `SubplebbitIpfsSchema` — it is instance-only, derived from `signature.publicKey`
-   For backward compatibility: accept old records that include `address` in `signedPropertyNames` (self-describing verification handles this automatically)

### Publication schema changes (`src/schema/schema.ts`)

-   **Add** `communityPublicKey` as optional wire field (IPNS key — required for new publications, optional for backward compat with old records)
-   **Add** `communityName` as optional wire field (domain name, if set)
-   `communityAddress` is instance-only, computed as `communityName || communityPublicKey` — not in wire schema
-   For backward compatibility: accept old publications that have `subplebbitAddress` in `signedPropertyNames`. If `communityPublicKey` is absent, derive from `subplebbitAddress` (if IPNS key) or from community context (if domain).

### Author schema changes (`src/schema/schema.ts`)

-   Add `name: z.string().min(1).optional()` to Author wire types (`AuthorPubsubSchema`, `AuthorIpfsSchema`)
-   **Remove** `address` from Author wire types — it is now instance-only (computed as `name || publicKey`). **Breaking change.** Old publications with `author.address` as a signed field remain valid via self-describing signature verification.
-   `publicKey` is instance-only (derived from `signature.publicKey`), not added to wire schema
-   `nameResolved` is instance-only (runtime verification flag, `boolean | undefined`), not added to wire schema
-   Same async verification pattern as subplebbit

### Protocol version

-   **Bump `protocolVersion`** when these wire format changes are applied (removing `address` from SubplebbitIpfs, adding `name`; adding `communityPublicKey`/`communityName` to publications; removing `author.address` from wire)
-   SubplebbitIpfs records are short-lived (IPNS), so backward compat is not a major concern — use `.passthrough()` to accept old records with `address` field during transition
-   Comments are the bigger concern — old `CommentIpfs` records are CID-addressed and immutable, handled by the backward compat rules above

### RemoteSubplebbit (`src/subplebbit/remote-subplebbit.ts`)

-   Add `name`, `publicKey`, and `nameResolved` property declarations
-   `publicKey` derived from `signature.publicKey` (Ed25519 → PeerId → base58) on first update
-   Assign `name` in `initRemoteSubplebbitPropsNoMerge()`
-   Add `_startAsyncNameResolution()` method for background name verification
-   Add `_handlePublicKeyMismatch()` method: if caller provided `publicKey`, emit `error` and stop updating (critical); otherwise clear data and switch IPNS to resolved publicKey
-   `nameResolved` = `false` initially, set to `true` on successful verification

### LocalSubplebbit (`src/runtime/node/subplebbit/local-subplebbit.ts`)

-   `publicKey` set immediately from `signer.address`
-   In IPNS record construction: add `name`
-   Add `name` editing support

### Database changes (`src/runtime/node/subplebbit/db-handler.ts`)

-   Add `communityPublicKey` and `communityName` columns to publication tables (keep existing `subplebbitAddress` for backward compat)
-   Bump DB version, add migration logic

### Backward compatibility

-   **SubplebbitIpfs**: if `address` stays in wire schema, old clients remain non-breaking and new `name` is ignored by old clients using `.loose()` parsing. If `address` is removed from wire schema, backward-compat/migration behavior must be defined.
-   **Publications**: Non-breaking. Old clients continue to use `subplebbitAddress`. New clients use `communityPublicKey` and `communityName`.

## Edge cases and error handling

This section documents all edge cases for `createSubplebbit`, name resolution, and record validation.

### Async name resolution outcomes

| Scenario                                | Behavior                                                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| No name set                             | `nameResolved` = undefined/absent                                                                                                 |
| Name set, not yet verified              | `nameResolved` = `false`                                                                                                          |
| Name verified successfully              | `nameResolved` = `true`                                                                                                           |
| Name resolves to DIFFERENT publicKey (explicit `publicKey` provided by caller) | **Critical error**: emit `error` event and stop updating |
| Name resolves to DIFFERENT publicKey (no explicit `publicKey`, name-driven flow) | **Clear all community data, switch IPNS to resolved publicKey** (name "transferred" to new owner), emit update event, log warning |
| Name resolution fails (network/timeout) | `nameResolved` stays `false`, emit `error` event, retry with backoff                                                              |
| No resolver supports this name          | `nameResolved` stays `false`, emit warning                                                                                        |

### SubplebbitIpfs record validation

| Scenario                                                                                            | Action                                                                                                                            |
| --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| If explicit `record.publicKey` is adopted                                                            | Require `record.publicKey === derived(signature.publicKey)`; otherwise reject record                                               |
| Loaded by IPNS key, record has domain `address`                                                     | Accept if signature's derived publicKey matches the IPNS key we requested                                                         |
| Update arrives with different publicKey and caller explicitly provided `publicKey`                  | **Critical error**: emit `error` event, reject update, stop updating                                                              |
| Update arrives with different publicKey and caller did not explicitly provide `publicKey`           | Clear data, switch to new IPNS                                                                                                    |

### createSubplebbit parameter conflicts

| Scenario                                                                     | Action                                              |
| ---------------------------------------------------------------------------- | --------------------------------------------------- |
| `{address: "12D3A...", publicKey: "12D3B..."}` (both IPNS, different values) | **Throw** `ERR_CONFLICTING_ADDRESS_AND_PUBLICKEY`   |
| `{address: "memes.bso", publicKey: "12D3..."}`                               | Valid — use publicKey for IPNS, verify domain async |
| `{address: "MEMES.BSO"}` (uppercase domain)                                  | **Throw** `ERR_DOMAIN_ADDRESS_HAS_CAPITAL_LETTER`   |
| `{}` (empty options)                                                         | Generate random signer, create local subplebbit     |

### Error codes

| Error Code                                 | When                                                           |
| ------------------------------------------ | -------------------------------------------------------------- |
| `ERR_CONFLICTING_ADDRESS_AND_PUBLICKEY`    | Both `address` and `publicKey` provided as different IPNS keys |
| `ERR_DOMAIN_ADDRESS_HAS_CAPITAL_LETTER`    | Domain address contains uppercase letters                      |
| `ERR_NAME_RESOLUTION_FAILED`               | Blockchain RPC resolution failed (network error, timeout)      |
| `ERR_NO_RESOLVER_FOR_NAME`                 | No resolver registered that supports the provided name          |

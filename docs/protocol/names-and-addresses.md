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

## What `nameResolved` means

> `nameResolved` is `false` **only** when a resolver actually answered and the answer contradicts the claim.
> It is `undefined` whenever no answer was obtained, for any reason. `true` only on a matching answer.

`false` is an accusation: it says this name is not that key. Never make it on evidence you do not have. A
resolver outage, a timeout, or a TLD this client has no resolver for all mean "we could not find out", and
that is `undefined`, which is also the marker that lets a later pass retry.

| What happened                                   | `community.nameResolved`                          | `author.nameResolved`            |
| ----------------------------------------------- | ------------------------------------------------- | -------------------------------- |
| resolved to the expected key                    | `true`                                            | `true`                           |
| resolved to a **different** key                 | `true` (key migration, identity follows the name) | `false`                          |
| resolved to a non-anchor hop of its own chain   | `false`                                           | n/a                              |
| resolvers answered, no TXT record               | `false`                                           | `false`                          |
| one resolver errored, a later one answered      | as the answering resolver says                    | as the answering resolver says   |
| **every** resolver that handles the TLD errored | `undefined`                                       | `undefined`                      |
| no resolver configured for that TLD             | `undefined`, and never attempted                  | `undefined`, and never attempted |
| timed out / aborted                             | `undefined`                                       | `undefined`                      |
| record resolved to a non-IPNS string            | `false`                                           | `false`                          |
| `resolveAuthorNames: false`                     | n/a (it gates author resolution only)             | `undefined`                      |
| address is a raw key, no domain                 | `undefined`                                       | `undefined`                      |

The community row for a key change is the one exception to the rule: a migration **redefines** the claim
rather than contradicting it. `_applyKeyMigration` repoints `community.publicKey` at the key the name now
resolves to, wipes every record from the old key as potentially compromised, and tells the application through
an `ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY` error event rather than through the flag.

`_resolveViaNameResolvers` is what makes the distinction possible. It returns `null` when the resolvers ran and
found no record, and throws `ERR_ALL_NAME_RESOLVERS_FAILED` (with each resolver's error in `details`, keyed by
resolver key) when every resolver that could handle the name errored. Before issue #353 both collapsed into the
same `null`, so neither could be treated as definitive without risking the other. `pkc.resolveAuthorName`
propagates that throw rather than answering `null`, over RPC included.

A name no configured resolver can handle is skipped outright by a synchronous `canResolveName` check rather
than attempted and cached: the verdict would be `undefined` either way, and since `undefined` is also the retry
marker, attempting it would re-run and re-log on every update cycle forever.

Publication validation is a separate question from the verdict, and its policy is unchanged: `checkAuthorIdentity`
refuses any publication whose wire `author.name` it cannot verify against the signer, whatever the reason and
whatever the publication type. What changed is that it now says which of the four things went wrong. See
[challenge-flow.md](challenge-flow.md), "Author identity in excludes, roles and address lists".

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

There are two caches and they hold different things. The **persistent** cache stores only successful resolutions; failures are not persisted, so the next caller retries. The **in-memory verification cache** (`PKC._memCaches.nameResolvedCache`) caches `(name + signaturePublicKey) → boolean` for sync hot-path lookups by `Comment._setAuthorNameResolvedFromCache` and friends. It stores `false` only where the table above says `false`, which means only when a resolver answered, and leaves the entry unset whenever no answer was obtained so the next pass retries.

**How long a verdict lasts.** A verdict in the in-memory cache is terminal while it lives: `resolveAuthorNamesInBackground` skips any entry that is already a boolean, so expiry is the only thing that ever causes a re-resolve. Both verdicts therefore carry a ttl, and they are deliberately different:

| Verdict | Lives for                          | Why                                                                                                                                                                                                                                            |
| ------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`  | `NAME_RESOLVED_TRUE_TTL_MS` (1h)   | Backed by a record in the persistent cache, whose own `maxAge: 3600` this matches. Re-deriving it costs a disk read, not a network resolve. Bounded so a domain transferred away stops reading as verified.                                    |
| `false` | `NAME_RESOLVED_FALSE_TTL_MS` (60s) | An accusation with nothing behind it: the persistent cache holds successes only. The states that produce one (no record yet, a record that is not a key) are what a correctly owned domain looks like while its owner is still configuring it. |

A verdict only lapses in practice if whatever holds it asks again, so no consumer of that cache gates the asking on the field it holds: the community page sweep, `Comment._resolveAuthorNamesInBackground` and the crosspost chain collector queue every domain author they see, and the cache decides. Asking is free while a verdict stands, because `resolveAuthorNamesInBackground` skips every entry the cache still holds. Gating on the instance field would defeat the `true` window in particular: a live `Comment` keeps its author for life, so a lapsed `true` would still sit in the very field a gate reads, and a domain transferred away would read as verified for as long as that object lived. A comment also needs something to do the asking: its author is classified once, when its CommentIpfs loads, so the per-cycle tick lives in `handleUpdateEventFromCommunity` (post) and `handleUpdateEventFromPostToFetchReplyCommentUpdate` (reply), matching the cadence the community's page sweep already runs at.

`community.nameResolved` is not in that cache, it lives on the instance, but it follows the same rule. `_resolveNameInBackground` re-resolves a `false` verdict rather than treating it as settled, and the call sites gate on `nameResolved !== true` rather than "not yet a boolean". Everything that bounds the retry lives inside `_resolveNameInBackground` rather than at the gates, because one of its four call sites has no gate of its own and the update loop can turn over once per second on the kubo-RPC path: a floor of `NAME_RESOLVED_FALSE_TTL_MS` on re-resolving a `false`, an in-flight guard so a slow resolver collects one attempt rather than one per cycle, and the `canResolveName` skip above.

**An attempt that learned nothing is paced too.** The two bounds above cover a verdict and a resolve that has not answered; neither covers the outage this is all about. Every resolver erroring records no verdict, so the `false` floor has nothing to measure from, and a resolver that fails fast (an `ECONNREFUSED`) settles long before the next caller arrives, so the in-flight guard is already released. The verdict stays `undefined`, which is also the marker that invites a retry, so an outage meant one resolve per fetch cycle for as long as it lasted. `NAME_RESOLVE_FAILED_RETRY_FLOOR_MS` (10s) paces it on both sides: the community side stamps `_nameResolveFailedAtMs` and clears it as soon as any answer arrives, and the author side records the cacheKey in `PKC._memCaches.nameResolveFailedCache`, whose entries expire on their own. It is much shorter than the `false` window because it holds no verdict: nothing was learned, and the outage may already be over.

The author side needs the in-flight guard for the same reason the community side does, and it lives on the PKC (`_authorNameResolvesInFlight`) rather than on a clients manager, because the callers that overlap do not share one: a community's page sweep and an updating `Comment` resolve the same author on the same community update.

All three constants live in `src/constants.ts` and are mirrored as per-instance `PKC` fields, `_nameResolvedTrueTtlMs`, `_nameResolvedFalseTtlMs` and `_nameResolveFailedRetryFloorMs`, so a test can shorten one without leaking the change into the other suites sharing the worker. A test that drives a `true` lapsing also has to age the persistent record that backs it, since the re-resolve reads that record first with `maxAge: 3600`; in production the two windows match and expire together.

## RPC-Side Resolution

Name resolution happens on the **RPC server**, not the RPC client. This means:

-   **RPC servers** must have `nameResolvers` configured (e.g., `@bitsocial/bso-resolver`) to resolve domain names like `memes.bso`.
-   **RPC clients** do **not** need `nameResolvers`. They pass domain names directly to the server via `communityUpdateSubscribe`, `createCommunity`, etc., and the server resolves them using its own resolvers.
-   This keeps browser and mobile clients lightweight, no web3 dependencies needed on the client side.

If an RPC server has no resolvers configured, any request with a domain name will fail with `ERR_NO_RESOLVER_FOR_NAME`.

## A community's identity in its comments

Every publication carries the community it was signed for: `communityPublicKey` (required; publish validation rejects
any other key) and `communityName` (required when the community has a name, `ERR_PUBLICATION_MISSING_COMMUNITY_NAME`;
it must equal the community's address, exactly: publish validation does not accept a `.eth`/`.bso` alias). Both fields
are signed, so they never change once a comment is stored, even when the owner later changes the community's name. The
page rule below is looser than publish validation on purpose: it also accepts the alias, because a stored comment may
have been signed under it.

A name is part of the community's identity. Which stored comments a community still publishes is decided by the
**community identity rule** (issue [#401](https://github.com/pkcprotocol/pkc-js/issues/401)), which is exactly what
client page verification (`verifyPageComment`) accepts, so a community never publishes a comment clients reject and never
hides one they accept:

-   **The community has a name `C`:** a comment whose `communityName` is set must carry `C` or its `.eth`/`.bso` alias.
    A comment without a name passes, and its key is not checked (clients tolerate a rotated key on a named community).
-   **The community has no name:** a comment whose `communityPublicKey` is set must carry the community's key. A
    comment without a key passes (migrated pre-v37 domain rows have none). The name is not checked.

The rule is always on, not a page sort option (it replaced `excludeCommentsWithDifferentCommunityAddress`). It applies
to every page, to `replyCount`, `childCount` and `lastReplyTimestamp`, to the stats and to the first-comment lookup, so
the counts always match the pages (`_communityIdentityClause` in `db-handler.ts`, `createCommunityIdentityRowFilter`
in `src/pages/page-sort-scoring.ts`).

What happens to comments published before an address change:

| Address change                    | Comments signed before it  | Published after it                                                                                          |
| --------------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------- |
| key only → `C` (a name added)     | key, no name               | yes: they claim no name, and clients accept them ([#413](https://github.com/pkcprotocol/pkc-js/issues/413)) |
| `a.eth` → `a.bso`                 | named `a.eth`              | yes, the alias matches                                                                                      |
| `N` → `M` (a different name)      | named `N`                  | **no**, they belong to the identity `N`                                                                     |
| `N` → `M`                         | key, no name               | yes                                                                                                         |
| `N` → key only (the name dropped) | named `N`                  | yes: a community without a name does not check names, so clients still accept them                          |
| `N` → key only                    | pre-v37, named `N`, no key | yes                                                                                                         |
| `N` → `M` → `N` (renamed back)    | named `N`                  | yes again, the rule is evaluated against the current name at every page build                               |

### Changing a community's name

A local community's address is its name when it has one, else its identity key (the anchor's key on a delegated
community), so changing the name and changing the address are one operation. `edit({ name })` and `edit({ address })`
both move the community's DB file, its start lock and its MFS `postUpdates` folder to the new address, and from the next
page build the identity rule above filters by the new name:

| Edit                                                               | Result                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| `edit({ name: "m.bso" })` or `edit({ address: "m.bso" })`          | name and address become `m.bso`                       |
| `edit({ name: undefined })` or `edit({ address: <identity key> })` | the name is dropped, the address becomes the key      |
| `edit({ name: "m.bso", address: "m.bso" })`                        | accepted, same as either alone                        |
| `edit({ name: "m.bso", address: "n.bso" })`                        | throws `ERR_COMMUNITY_EDIT_NAME_AND_ADDRESS_MISMATCH` |
| `edit({ name: undefined, address: "m.bso" })`                      | throws `ERR_COMMUNITY_EDIT_NAME_AND_ADDRESS_MISMATCH` |

The mismatch is rejected before anything is changed, so no other field of that edit is applied either: which of the two
the owner meant is not pkc-js's guess. Before issue [#430](https://github.com/pkcprotocol/pkc-js/issues/430),
`edit({ name })` changed only `community.name` and left the address, DB and lock on the old name. The pages then kept
the comments signed with the old name, the community's own pre-publish check rejected every new record
(`ERR_LOCAL_COMMUNITY_PRODUCED_INVALID_SIGNATURE`), and the renamed record was never published.

Readers that loaded the community by its old name do not follow a rename. They keep fetching the same IPNS key, but
the next record claims a different name than the one they asked for, so they refuse it (see "A remote community's
name follows its record" below). They have to load the community again by the new name or by its public key. A name
is part of the community's identity, so this is intended. Readers that loaded it by its public key do follow it.

An owner can also rename the community with a `CommunityEdit` publication over pubsub (`name` or `address`, owner-only).
It goes through the same `edit()`, so it is the same address move. An RPC server keeps a renamed community filed under
its new address whichever way it was renamed, so lookups by the new name, a reconnecting client and auto-start on the
next boot all find it.

A publication created with only a community's key (`createComment({ communityAddress: <key> })`) is signed again at
`publish()` with the name of the community record it loaded, so pkc-js never sends a publication without the name to a
community that has one. Its `signature` therefore changes between `createX` and `publish()` in that case.

### A remote community's name follows its record

Before the first record loads, a remote community's `name` is the name it was loaded by (its address when that is a
domain), and undefined when it was loaded by public key. Once a record has loaded, `name` is the name that record
claims, including none: a community that drops its name stops being shown under it. `address` never changes. What
happens to a newer record that drops or changes the name depends on what the loader asked for:

| Loaded by                                             | Newer record without the name, or with a different one                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public key, `{ address: <key> }`                      | Accepted. `name` follows the record, `nameResolved` is cleared because it described the old name, and the old name no longer routes new loaders to this updating instance.                                                                                                          |
| Name, `{ address: "x.bso" }` or `{ name, publicKey }` | Refused. The loader keeps the last record that claimed the name and emits `ERR_COMMUNITY_RECORD_NAME_DOES_NOT_MATCH_REQUESTED_NAME` once per refused record. It stays updating and accepts a later record that claims the name again. `pkc.getCommunity()` rejects with it at once. |

The error is retriable (`details.retriableError: true`) because the record is genuine, only not the community the
caller asked for. Its details carry `requestedName`, `recordName`, `communityPublicKey` and `recordUpdatedAt`. A name
and its `.eth`/`.bso` alias count as the same name. A publication addressed to a name whose community record no longer
claims it fails `publish()` with the same error.

Loaders by key and by name share one internal updating instance, matched by public key or name. That instance only
checks that the record is signed by the key it resolved, which holds for every loader alike, and each loader checks the
name it asked for when a record is applied to it. So a refusal never stops the shared instance or the other loaders. A
record signed by a different key than the one resolved is still the fatal
`ERR_THE_COMMUNITY_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED` for everyone. Over RPC the server's
instance for the subscription does the check, so only that subscription receives the error.

## Equivalent names in identity lists

The community owner types names into `exclude.names`, `roles` keys and the whitelist/blacklist challenge
`addresses`. An author's published `author.name` matches such an entry when the two are the same name according to
`areEquivalentNames` (`src/domain-util.ts`), not only when the strings are equal (issue
[#424](https://github.com/pkcprotocol/pkc-js/issues/424)):

-   **`.eth` and `.bso` names** are compared after lowercasing both and turning `.bso` into `.eth`. `.bso` is the
    protocol's spelling of an ENS `.eth` name, and ENS names are case-insensitive, so `bot.eth`, `bot.bso`, `Bot.bso` and
    `bot.BSO` are all one name.
-   **Any other name** must match exactly, letter case included. We do not know that its resolver ignores case.

This only widens which entry counts as naming the author. The match still requires that the name the author
**published** resolves, fresh (`cache: { maxAge: 0 }`), to the key that signed the publication; the spelling in the
list is never resolved. So an impostor claiming `bot.bso` gains nothing from a `bot.eth` entry. Stored settings are
not rewritten: the owner's spelling is kept as typed. If two `roles` keys are spellings of one name, the author holds
both roles.

`areEquivalentCommunityAddresses` (`src/util.ts`) applies the same rule to community addresses.

## Invariants

-   `author.address` and `community.address` are **immutable**, never override or fall back to a derived address.
-   `author.address` is never an identity on the community side. Excludes, roles and blacklists match through the signer address or a domain resolved to it (`docs/protocol/challenge-flow.md`, "Author identity in excludes").
-   Use `nameResolved` to indicate whether a domain resolved correctly, do NOT change `address`.
-   An author and a community **cannot share the same domain name**.
-   Domain names are **lowercase**. A community name or address with an uppercase letter throws `ERR_COMMUNITY_NAME_HAS_CAPITAL_LETTER` (create, load, edit). A publication whose `author.name` has an uppercase letter throws `ERR_AUTHOR_NAME_HAS_CAPITAL_LETTER` when it is created (`createComment`, `createVote`, ...), and a community that receives one anyway rejects it with the same error, before any name resolution and whatever the TLD (issue [#447](https://github.com/pkcprotocol/pkc-js/issues/447)). So one name is never spelled two ways on the wire.
-   `shortAddress` is runtime-only, a truncated `address` for display purposes.

## Key Functions

| Function                           | File                                     | Purpose                                 |
| ---------------------------------- | ---------------------------------------- | --------------------------------------- |
| `getPKCAddressFromPublicKeySync()` | `src/signer/util.ts`                     | Ed25519 public key → IPNS address       |
| `isStringDomain()`                 | `src/util.ts`                            | Check if a string is a domain name      |
| `areEquivalentNames()`             | `src/domain-util.ts`                     | Same name? `.eth`/`.bso` alias and case |
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

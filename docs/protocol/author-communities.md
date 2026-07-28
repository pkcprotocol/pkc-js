# Author Communities (profiles as delegated communities)

> **Status: design (issue [#31](https://github.com/pkcprotocol/pkc-js/issues/31)).** Not yet
> implemented. This doc records the agreed design and the open questions.

## Summary

An **author-community** lets an author publish their own profile: display metadata plus a feed of
everything they've posted across the network, resolvable as an IPNS record at `author.publicKey`.
`getCommunity({ name?, publicKey?, address? })` resolves it the same way it resolves a normal
community, returning a community instance populated from the `AuthorCommunityIpfs` record; the
instance's runtime `kind` field tells the client which one it got.

An author-community **is a full community**. It runs the same `LocalCommunity` machinery, both pubsub
topics (the IPNS-over-pubsub record topic **and** the challenge/publication topic), challenge
processing, and reply threads. Others can reply to the owner's posts, challenge-gated, exactly as in
any community. The **only difference is the schema**: an author-community carries a profile schema
(`AuthorCommunityIpfs`) with a single `new`-sorted feed whose top-level entries are the owner's own
comments (references *out* to other communities), where a normal community carries `CommunityIpfs`
with a role map and a multi-author, multi-sort feed of native submissions (references *in*).

It is published as a **delegated community** (anchor → minter, see
[delegated-ipns.md](delegated-ipns.md)): the author's identity key stays offline, and an online
delegate keeps the record fresh and runs the challenge topic on the author's behalf. This is the
mechanism that lets a browser author (who goes offline) own a live, reply-able community without ever
handing out their identity key, and without pkc-js needing a bespoke replicator.

Because every comment already carries `author.publicKey` (an IPNS name) and `author.address`, every
existing comment is already a resolvable pointer to its author's profile. No new index is needed.

## Author-community vs. normal community

Both are the same class tree and the same delegated-publishing mechanism. What differs is the schema
and the policy the schema implies:

| | Normal community | Author-community |
|---|---|---|
| Class | `LocalCommunity` (+ Remote/RPC variants) | `AuthorLocalCommunity`, a thin subclass of `LocalCommunity` |
| Record schema | `CommunityIpfs` | `AuthorCommunityIpfs` (profile metadata + `new` feed) |
| Pubsub | record topic **+** challenge/publication topic | **same:** record topic **+** challenge/publication topic (challenge topic optional, see [read-only mode](#read-only-mode-disabled-challenge-exchange)) |
| Challenges | yes | yes (others can reply to the owner's posts) |
| Top-level content | native submissions from many authors (`communityPublicKey` = this community) | the owner's own comments made **to other communities** (references out) + native posts to the profile |
| Who posts at top level | anyone (challenge-gated) | **only the owner**: default `fail`-challenge config write-side, verification-time invariant read-side |
| Replies | anyone (challenge-gated) | anyone (challenge-gated) |
| Sort types | hot/top/controversial/new, reply trees | single `new` feed, reply trees |
| Roles/moderation | full role map, moderators | single owner (self) in v1 (see [Future improvement](#future-improvement-delegating-profile-moderation)) |
| Publishing | delegated community (anchor → minter) | **same:** delegated community (anchor → minter) |

**Build implication:** an author-community is a **schema/policy variant of the community machinery**,
not a separate class tree, and it is a **delegated community**, not a special replication path. The
two enduring differences are semantic, not architectural: an author-community's top-level content is
the owner's own cross-network comments (references out), and only the owner may post at top level. The
future "converged" milestone (a single name that is *both* a multi-author community and its owner's
author feed) is then nearly free (see [Convergence](#convergence-both-feeds-under-one-name)).

### Implementation shape: `AuthorLocalCommunity`

The machinery is shared via a **thin subclass**: `AuthorLocalCommunity extends LocalCommunity`,
instantiated by the shared create/load path from the persisted local `kind` option (Remote/RPC
variants mirror the kind the same way later). A subclass is the same class tree; it overrides a small
set of seams, most of them data-like (a per-kind descriptor the shared record-build functions
consult), with real method overrides only where behavior changes:

1. **Base record shape** (`_toJSONIpfsBaseNoPosts`): emits profile metadata (displayName, avatar,
   wallets, bio) and no roles map.
2. **Preloaded sort**: `new` (the community record build hardcodes `hot`).
3. **Schema and envelope**: validates and signs against `AuthorCommunityIpfsSchema` and publishes
   under the `authorCommunity` envelope key.
4. **Page generation**: a single-`new` sort table mixing posts and replies in one feed, embedding
   cross-posted entries' foreign-signed `CommentIpfs` + `CommentUpdate` verbatim.
5. **Update loop**: skips cross-posted rows (foreign `communityPublicKey`) when generating
   `CommentUpdate`s; their mod-state is refreshed by the minter's refresh job instead (see
   [Minter-side freshness](#minter-side-freshness-of-cross-posted-entries)).
6. **Default challenges**: creation seeds `settings.challenges` so only the owner can post at top
   level (see [Owner actions](#owner-actions-existing-publication-types)).

Everything else (pubsub topics, challenge pipeline, DB handler, lifecycle, export, IPNS publishing)
is inherited untouched.

## The record: `AuthorCommunityIpfs`

A sibling of `CommunityIpfs`. It **keeps** the fields that make it a working, reply-able community and
differs only where the profile semantics require it:

- **Kept, because it runs the challenge topic:** `challenges` (the public challenge requirements a
  replying author reads), `encryption` (the key a replying author encrypts their publication with; here
  it is the **delegate/minter's** key, since the minter runs the challenge/publication topic), and
  `pubsubTopic`. Others reply to the owner's posts through exactly this machinery, so omitting these
  would break replies. In [read-only mode](#read-only-mode-disabled-challenge-exchange) all three are
  omitted together, which is precisely the signal that replies are disabled.
- **Collapsed:** the multi-`roles` map reduces to the single owner (self); there is no open multi-author
  moderation surface.
- **Added:** profile metadata: `displayName`, `avatar`, `wallets`, bio/links, ...
- `posts: { pages: { new: <preloaded page> }, pageCids: { new: <cid> } }`, reusing the community
  `posts` structure verbatim, but a single `new` sort rather than the multi-sort community feed.
- `stats`, `updatedAt`, `signature`, `protocolVersion`, as in `CommunityIpfs`.

**The record is minter-signed.** As with any delegated community, `AuthorCommunityIpfs.signature`
derives to the **minter** key `Mn` (the online delegate), not the anchor `An` (the author's identity).
The `An → Mn` binding is established by the cryptographically verified IPNS record chain, not by the
content signature (see [Publishing](#publishing-delegated-anchor--minter) and
[delegated-ipns.md](delegated-ipns.md)). Each embedded comment keeps its **own** author/community
signatures (below), which the minter never touches.

### The envelope

Both record kinds are wrapped in a single top-level envelope (`{ authorCommunity? | community? }`) so
one IPNS name can, in the future, carry either payload (or both):

```ts
type IpnsRecordEnvelope = {
  authorCommunity?: AuthorCommunityIpfs;
  community?: CommunityIpfs;
};
```

**v1 rule: exactly one field is present** (`z.refine`; neither and both are rejected). The
"both present" case is reserved for the convergence future where a single IPNS name is simultaneously
a full multi-author community (references *in*) **and** its owner's author feed (references *out*). We
reserve the slot now and disallow it until then.

Why an envelope rather than a `type: "community" | "author"` discriminator on a bare record: the
domain/text-record layer is already unambiguous (one name → one key → one entity; an author and a
community cannot share a domain), so the only thing a domain-first load needs is to know which
*schema* it fetched. The envelope answers that by key presence, reserves the both-at-once future a
flat discriminator cannot express, and keeps the loader schema-blind until it inspects which field is
present. Each payload carries its own `signature`; the reader verifies whichever field is present
(against the chain's terminal/minter key, see below).

> **Wire-format break (communities).** Wrapping `CommunityIpfs` in `{ community: ... }` moves the
> community's signed fields off the root, so a pre-envelope loader fetching an enveloped record fails
> to parse it. This is a **coordinated flag-day** for live communities, gated on a `protocolVersion`
> bump: loaders and publishers must ship together, and old clients cannot read new records until
> updated. Author-communities are new, so nothing old loads them; they emit envelopes from day one.
> **Do not deploy enveloped community publishers before the envelope-aware loader has been
> released**, or un-updated clients are stranded.

### Feed = preloaded page, embedded, `new` sort

The feed **embeds full comments** (not thin `{cid, communityPublicKey}` pointers), exactly like a
community's inline first page, so a profile renders in **one fetch** instead of N round-trips to N
communities. Each entry embeds the signed `CommentIpfs` **and** the signed `CommentUpdate`.

Signature ownership is unchanged by delegation: a cross-posted entry's `CommentIpfs` is
**author-signed** and its `CommentUpdate` is **signed by the foreign community that hosts it**; the
minter that assembles the profile record cannot forge either. A reader verifies both signatures
independently, so embedding does not weaken the trust model. The embedded mod-state is a snapshot the
reader can refresh. The **only** thing the minter signs is the enveloping profile record (and the
mod-state of *native* content it hosts, below).

Posts and replies are mixed in the single `new` feed (like a Reddit user page).

### Two kinds of feed content

1. **Cross-posted** — the author's comments made to *other* communities (`communityPublicKey` =
   someone else's). The canonical copy lives in that community; the embedded `CommentUpdate` is
   **community-signed** and verified against that community.
2. **Native** — posts/replies authored *directly to the author-community itself* (`communityPublicKey`
   = the author-community's own anchor public key). **The author-community is the sole host**: this
   content lives nowhere else. The owner posts these to their own community; other authors may **reply**
   to them, challenge-gated, and those replies are hosted here too. The native mod-state
   (`CommentUpdate`) is **minter-signed**, like any community's mod-state.

Both kinds share the single `new` feed. Top-level entries are owner-only; replies are open.

### Size cap

The **root object** (profile metadata + inline `new` page + `pageCids` list) is capped at **1 MiB**,
exactly like `LocalCommunity`'s root. The feed is unbounded overall (overflow spills into `pageCids`
chunks), but every fetched object is bounded, so loads stay fast. There is **no** 40 KiB cap here:
that limit is on a *comment's publication bytes*, not on an IPNS-pointed record (the IPNS record
itself only carries the signed name→CID pointer, ~10 KiB spec cap; the `AuthorCommunityIpfs` content
is a normal IPFS DAG with no hard protocol cap).

## Publishing: delegated (anchor → minter)

An author-community is published **exactly like a delegated community**
([delegated-ipns.md](delegated-ipns.md)), with two keypairs:

- **`An` / `As`** — the **anchor**. `An` is `author.publicKey` (the immutable identity a reader
  resolves); `As` is held **offline by the author**, in the browser, and only ever signs the anchor
  record.
- **`Mn` / `Ms`** — the **minter**. `Ms` is held by the **online delegate** (bitsocial forge, or a
  profile-node service). It signs the `AuthorCommunityIpfs` content, runs the challenge/publication
  topic, folds in foreign replies, and keeps the record fresh.

The record chain is the delegated-community chain, unchanged:

```text
/ipns/An  ──(signed by As, long EOL)──>  /ipns/Mn
/ipns/Mn  ──(re-signed frequently by Ms)──>  /ipfs/<envelope cid>
/ipfs/<cid> ── { authorCommunity: AuthorCommunityIpfs }, signed by Ms
```

The author owns their identity (`An` = `author.publicKey`, immutable per
[names-and-addresses.md](names-and-addresses.md)); the delegate only ever holds a **rotatable, profile-scoped**
minter key. The author revokes a delegate by coming online and re-pointing `An` to a new `Mn'`. This
is what makes "run the profile as a full community" safe: the online, key-holding party can mint and
moderate the profile record, but can never impersonate the author elsewhere, and can be rotated away.

### Division of responsibility (what is / is not in pkc-js)

Mirroring [delegated-ipns.md](delegated-ipns.md), **delegate-side publishing is intentionally not part
of pkc-js**. pkc-js does resolution, verification, and the owner's own-key actions; the minter service
does everything under `Mn`.

**In pkc-js (owner's client, own keys only):**

- **Resolve + verify** an author-community by resolving `author.publicKey` (the anchor), walking the
  single `An → Mn` hop, and verifying the minter-signed content against the chain's terminal, using the
  delegated-loading path that already exists (issue #93).
- **Anchor publish.** Sign the anchor record `An → Mn` with `As` (in-browser) and publish it: once at
  delegation setup, and re-signed before the anchor EOL lapses. Only the author holds `As`, so this
  step is inherently client-side and cannot be delegated.
- **Native content signing.** Sign the owner's own `CommentIpfs` with the author's identity key and
  publish it to the profile like any publication (see [Owner actions](#owner-actions-existing-publication-types)).
- **Cross-post sync.** Push the owner's cross-network comment list to the minter via the sync RPC pair
  (see [Syncing cross-posts](#syncing-cross-posts-listauthorcomments--syncauthorcomments)).

**Out of pkc-js (the delegate / profile-node service):**

- Hold `Ms`, mint `Mn → <envelope cid>` frequently, run the challenge/publication topic, fold in
  foreign replies, sign the profile record and native mod-state, pin/serve/provide the DAG, and keep
  the record alive after the author goes offline. This is ordinary delegated-community publishing, which
  pkc-js deliberately does not implement.

> **Delegation setup handshake.** To point `An → Mn` the author needs the delegate's minter name `Mn`.
> The delegate generates `Mn`/`Ms` and returns `Mn`; the author then signs `An → Mn` client-side. The
> handshake response should also return the profile's `pubsubTopic` and `encryption` key, since before
> the first mint there is no record for the client to resolve them from (bootstrap). The handshake
> surface (how the browser asks bitsocial forge to become its minter) lives in the forge, not pkc-js.
> See [open questions](#open-questions).

**No delegate configured → no profile.** Publishing a profile requires a reachable minter. A pure
in-browser helia node can sign the anchor but has no online party to mint and keep the record alive.
**v1 consequence:** pure-P2P (libp2p-js-only, e.g. 5chan) authors cannot publish profiles until they
point their anchor at some minter service. This is the same offline-owner constraint that delegated
communities already carry, not a bespoke author-community limitation.

### Owner actions (existing publication types)

Because the minter is a real community node, the existing publication vocabulary already covers every
owner action on **native** content and on the profile itself — no new publication types. The one
twist is how owner-only top level is enforced on the write side: **default challenge config, not a
code-level exemption**. `AuthorLocalCommunity` seeds `settings.challenges` at creation with the
built-in `fail` challenge (which only passes when excluded) carrying two excludes: one matching every
non-post publication type (replies, votes, edits, and moderation pass on to whatever other challenges
are configured), and one matching the owner's address. The owner-address exclude is signature-backed:
a publication's author address is verified against its signature before challenges run, so nobody but
the anchor key holder can pass it. The owner may edit this config like any community owner edits
challenges; the invariant itself is enforced read-side (see
[Read-side verification](#read-side-verification-three-feed-states)), so the default config is the
honest node's implementation of it, not the guarantee.

| Owner action | Publication type |
|---|---|
| Native post/reply to own profile | `Comment` (passes the default `fail` challenge via the owner-address exclude) |
| Delete a native post | `CommentEdit` with `deleted` (standard author delete; host = this community) |
| Moderate a foreign reply under a native post | `CommentModeration` (the owner is the mod) |
| Profile metadata (displayName, avatar, bio) | `CommunityEdit` (owner editing their own record) |
| Add/remove/refresh cross-post entries | **not a publication** — the sync RPC pair (below) |

A native `Comment` is signed by the owner's identity key client-side, with `communityPublicKey` = the
profile's own anchor public key; the minter folds it into the feed and signs the resulting mod-state
(`CommentUpdate`) with the minter key, exactly as any community node signs mod-state (with the anchor
key itself in the non-delegated own-node case). Foreign authors replying to a native post go through
the normal challenge/publication topic; the minter challenge-gates, accepts, and hosts them like any
community (the profile is their **sole host**).

### Syncing cross-posts: `listAuthorComments` / `syncAuthorComments`

Publishing to a foreign community never involves the minter — a libp2p-js client runs that challenge
exchange with the foreign community directly. So the minter cannot observe the owner's cross-network
activity, and **discovery of new entries is client-push only**: the client is the sole party that
knows "I just posted in community X," and it delivers that knowledge through a pair of RPC methods on
the minter (method names TBD):

```ts
listAuthorComments({ authorPublicKey, authorName? })            // → stored raw CommentIpfs[]
syncAuthorComments({ authorPublicKey, authorName?, comments })  // comments: raw CommentIpfsType[]
```

- **Multi-tenant addressing.** The RPC server hosts many author-communities alongside full
  communities, so both methods are keyed by the target profile. Wire params identify the profile by
  **`authorPublicKey` plus optional domain `authorName`**, never by address — address is runtime-only
  (see [wire-vs-runtime.md](wire-vs-runtime.md)).
- **Declarative snapshot semantics.** `syncAuthorComments` is the owner's full cross-post list. The
  minter diffs against its DB: CIDs not yet stored are added, stored CIDs omitted from the list are
  dropped from the feed. Removal is omission — no tombstones, no retraction publication. Idempotent.
- **Raw comments only, no `CommentUpdate`.** The client ships the raw author-signed `CommentIpfs`
  bytes (a loaded comment already exposes this as `comment.raw.comment`). Shipping the bytes (not bare
  CIDs) means sync never depends on the foreign community being reachable, and the minter never
  fetches anything during the call. The minter derives each CID from the bytes and reads
  `communityPublicKey` off the comment to learn its canonical community. Mod-state is never pushed —
  freshness is the minter's job (below).
- **List-then-merge-then-sync.** `listAuthorComments` exists so a client on a fresh device can read
  the server's stored set, union it with its local comments by CID, and sync the merged list — a bare
  sync from a partial view would silently drop the server-only entries.
- **Decoupled and best-effort.** The entry push is an independent client action that can happen any
  time after the foreign publish, from any of the author's devices. The profile lags reality until the
  client next syncs — the accepted consequence of client-owned timing. (When a client happens to have
  its minter reachable at publish time, pushing right away is a convenience, not a protocol
  requirement.)
- **Validation gates.** The minter accepts a synced comment only if it is validly signed by the
  addressed profile's `authorPublicKey` (`An`), rejects runtime-only fields (raw wire shape enforced),
  and bounds input size. A sync can therefore never inject content the owner didn't author.

**Sync authorization.** Signature validation stops forgery but not shrinkage: the owner's comments are
public, so an unauthorized caller could sync a valid *subset* and silently remove entries (omission =
removal). The access model is therefore transport-level, in two tiers:

- **Private RPC (local): trusted.** The private pkc-js RPC is considered **local-only and trusts its
  clients**, exactly like the rest of its methods (`createCommunity`, `deleteCommunity`, ...). No
  per-call ownership proof in v1.
- **bitsocial forge (multi-tenant): authenticated.** Forge will have auth and access granularity — a
  caller **cannot invoke `syncAuthorComments` for a profile unless it owns that author key**. That
  enforcement lives in the forge layer, not in the pkc-js method schema.

### Minter-side freshness of cross-posted entries

The embedded `CommentUpdate` snapshots drift (votes, mod-state). Keeping them fresh is the
**minter's job** — it is delegated with handling the profile, and the work is bounded to CIDs already
in its own DB, so the anti-amplification argument against node-side fetching does not apply here:

- The minter periodically re-loads each cross-posted entry's `CommentUpdate` from its canonical
  community (read from `communityPublicKey`), **verifies the community signature**, and replaces the
  snapshot on its next mint. An invalid fetch is discarded; an unreachable canonical community leaves
  the last known snapshot in place (the entry is never dropped for unreachability).
- The client never pushes mod-state, and never needs to be online for freshness.
- The boundary stays sharp: refresh known CIDs, yes; **crawl for discovery, never** (new entries only
  arrive via `syncAuthorComments`).

### Minter rotation and data migration

Rotating the anchor (`An → Mn'`) cleanly revokes the old delegate's *publishing* rights, but the old
minter's DB holds the only copy of **native** content — including foreign authors' replies, whose sole
host is this profile. Migration reuses the existing export machinery:

- **Export = `exportCommunity` (already exists, already sqlite).** An author-community runs the same
  per-community sqlite DB, so `LocalCommunity.exportCommunity()` and the `exportCommunity` RPC work on
  it kind-blind, producing a sqlite backup under `${dataPath}/exports/`. The owner can always trigger
  it: the local private RPC trusts its clients, and forge authorizes the caller as the author-key
  owner (same access model as `syncAuthorComments`).
- **The DB is portable across minters by construction.** The community address in the DB is the
  anchor `An` (the immutable identity); the minter key is node-local config and never part of the
  export. Restore = place the sqlite at the new node's community DB path and start.
- **No `importCommunity` method is needed.** Mod-state does not require a re-signing import step:
  `CommentUpdate`s are regenerated and signed by the running node's key as part of the normal update
  loop, so under the new minter they come out `Mn'`-signed on regeneration. The restore itself is a
  file-level operation by the node operator (consistent with the private RPC being local-only); at
  most a CLI convenience for copying the file into place.
- **Loss only without a backup.** Cross-posts are recoverable regardless (the client re-syncs;
  canonical copies live in foreign communities), and the owner's own native posts can be re-published
  by the client that authored them. Foreign replies live only in the DB, so losing them requires the
  minter dying with no export ever taken — ordinary backup hygiene, not a protocol property. Export
  regularly if native content matters.

### Liveness: anchor EOL + minter freshness

Two records, two cadences, exactly as in delegated IPNS:

- **Minter record (`Mn → cid`)** — re-signed **frequently** by the online delegate. This is what keeps
  the profile fresh and is re-provided to HTTP routers (whose announcements expire ~24 h). No author
  involvement.
- **Anchor record (`An → Mn`)** — signed by the offline author with a **long EOL**, and re-signed by
  the author before that EOL lapses. If the anchor expires while the author is away, loading fails
  everywhere until the author returns and re-publishes (the delegated-IPNS "liveness cliff"). **Reuse
  the delegated-IPNS anchor EOL constant**; do not invent a new value.

**TTL vs EOL.** TTL is a short caching hint (fast update propagation). EOL is hard validity: a peer
cannot usefully rebroadcast an expired record, and the `ipns` validator rejects expired records on
every path. The anchor EOL must therefore be comfortably longer than a typical away-gap. The minter
record's short cadence handles freshness; the anchor's long EOL handles absence.

**This is delegated publishing, not self-replication.** The author always owns and signs the anchor;
the delegate keeps the *minter* record alive and never touches `As`.

## Read-only mode (disabled challenge exchange)

> Tracked in issue [#229](https://github.com/pkcprotocol/pkc-js/issues/229). This is a kind-blind
> `LocalCommunity` feature, not author-community-specific; it is specced here because feed-only
> profiles are its main use case.

An owner may not want anybody to reply to their profile (or to post to a broadcast-style normal
community), in which case running the challenge topic is wasted traffic, per profile, on every
hosting minter. The private boolean **`community.settings.disablePubsubChallengeExchange`** turns the
community read-only over the network:

- **Node side.** When `true`, the node does not subscribe to the challenge/publication topic and the
  published record omits `pubsubTopic` (`cleanUpBeforePublishing` already purges undefined values).
  When unset or `false`, behavior is unchanged: `pubsubTopic` is backfilled to the signer address at
  init. A boolean was chosen over encoding the state in `settings.pubsubTopic` itself (e.g. `null`):
  it is self-describing, it preserves a custom topic string across disable/enable cycles, and it
  avoids a permanent tri-state falsy hazard at the backfill seam. Toggling takes effect on the next
  sync-loop iteration; no restart.
- **Wire rule (new, kind-blind): absence of `pubsubTopic` means the challenge exchange is
  disabled.** The historical reader fallback "absent topic, use the address" is removed on every
  path. Publishers fail fast with a dedicated error (`ERR_COMMUNITY_CHALLENGE_EXCHANGE_DISABLED`,
  name TBD) so clients can disable the reply UI up front instead of timing out.
- **No flag day.** Every record pkc-js has ever published carries an explicit `pubsubTopic` (the
  init backfill guarantees it), so no live record relies on the old fallback. Old clients parse a
  read-only record fine (the field is already optional) and degrade by timing out, the same as for
  an unreachable community.
- **Schema.** `AuthorCommunityIpfs` enforces all-or-none from day one: `pubsubTopic` absent implies
  `challenges` and `encryption` absent (refine). `CommunityIpfs` still requires
  `challenges`/`encryption`, so a read-only normal community publishes them as unused fields until
  the envelope flag-day relaxes them to optional.
- **The owner keeps publishing.** The local publish shortcut (`_publishWithLocalCommunity`) runs the
  challenge exchange in-process, without pubsub, whenever the target community is started in the
  same process, and that includes RPC clients, since the RPC server executes `publish()` in the
  process where the community runs. A self-hosted or RPC-connected owner therefore posts normally
  with the exchange disabled. The shortcut still evaluates challenges: read-only mode removes the
  network path, not the challenge pipeline.
- **Delegated consequence: feed-only profile.** For a forge-hosted author, disabling the exchange
  also disables the owner's own remote pubsub publications (native posts, `CommentEdit`,
  `CommentModeration`, `CommunityEdit`). The profile is then feed-only: cross-posts still flow
  through `syncAuthorComments`, metadata edits go through the minter's authenticated surface, and
  the owner can toggle the exchange back on at any time (the trio reappears on the next mint).
- **Replication unaffected.** The IPNS-over-pubsub record topic is a separate derivation
  (`ipnsPubsubTopic`) and stays on; record distribution, seeders, and reader updates are untouched.

## Replication (who keeps it alive)

The **delegate is the replicator**, by construction: it is the online, key-holding node that pins the
content DAG, mints and re-provides the record, and runs the topics. There is no separate replicator
protocol and no client-shipped CAR; a delegated community's own publishing keeps it alive.

- **Delegate (liveness guarantee).** bitsocial forge, or a self-run profile node (Seedit desktop's
  local node is its own delegate), mints and provides continuously, so ≥ 1 provider exists the instant
  the author goes offline.
- **Seeder network (ongoing redundancy).** **bitsocial-seeder** and voluntary nodes pick the record up
  from the record topic and re-provide it, so liveness does not hinge on a single delegate. The
  `hasAuthorCommunity` hint (below) still drives *discovery* with no registration step.
- **Providing policy** is the community machinery's existing policy: provide the record root; readers
  bitswap page chunks by CID from the connected provider once resolved. Do **not** loop-provide every
  page chunk (announcing N chunks × M profiles is what starved kubo's serial provider and broke
  community `updateCids`). Per-chunk providing stays a tuning lever for a minority deep-page path, added
  only if production shows reachability failing.

## The `hasAuthorCommunity` hint

A signed field on the wire `author` object (`AuthorPubsubSchema`) indicating "this author publishes a
profile, so `author.publicKey` is worth resolving." Consumers treat presence as "try, tolerate
failure," absence as "don't bother." It is per-comment (fixed at publish time), attested by the author
(a third party cannot forge it), and needs a place in the author signed-property list. (Name TBD:
`hasAuthorCommunity` / `publishesProfile`.)

## Read-side verification: three feed states

**Owner-only top level is a verification-time invariant, not just node policy.** Every top-level
entry in the `new` feed (inline page and every loaded `pageCids` chunk) must have `author.publicKey`
equal to the profile's anchor `An`. The check lives in the record/page verification step rather than a
bare schema refine, because the anchor is resolution context (the IPNS name the reader resolved), not
a field of the record. A record or page chunk violating it is rejected as invalid, so a misbehaving or
misconfigured minter cannot publish an open profile feed regardless of what its node accepted.
Replies are unconstrained (anyone, challenge-gated). Write-side acceptance policy on the minter is
therefore just the honest default; this check is the invariant.

Display source of truth is the author's minter-signed feed; the community's copy is the canonical
moderated one; **both remain accessible**. Per entry, verifying the embedded `CommentIpfs` +
`CommentUpdate` and (optionally) re-fetching the live `CommentUpdate` yields three renderable states:

1. **Live** — `CommentIpfs` signature valid + `CommentUpdate` loads clean → show normally.
2. **Removed** — `CommentUpdate` loads with `removed`/`deleted` set → show as moderated.
3. **Unknown** — `CommentUpdate` won't load at all → possibly purged, **or** the community is just
   offline/unseeded right now. Do **not** collapse this to "purged"; render as *unverified*. (Applies
   to **cross-posted** entries only; a **native** entry's sole host is the author-community itself, so
   it is live iff present in the feed, and "removed" just means the owner or a moderator deleted it.)

**Karma** is computed from state 1 (and maybe 2) only, never from raw self-attested entries, so a
profile cannot inflate its own karma, while a transient community outage does not silently delete
history. (The profile record is minter-signed, but the minter signing the *envelope* does not attest
the *foreign* mod-state inside it; karma still derives only from independently verified cross-posted
`CommentUpdate`s.)

## Runtime API surface: `kind` is derived, never wire

There is **no `createAuthor` method, no `getAuthor` method, and no `kind` wire field**. The envelope
key *is* the kind: a
loader reads which field is present (`community` vs `authorCommunity`) and surfaces it as a
**runtime-only** instance field — `community.kind` (values mirroring the envelope keys; exact spelling
TBD). It never enters the signed record: a wire discriminator would duplicate what key presence
already states (the same argument that settled the envelope over a `type` field). Like every
runtime-only field, it must be accounted for in the corresponding reserved-field list.

Consequences for the method surface:

- **Reading:** `getCommunity` / `communityUpdateSubscribe` and friends stay kind-blind; the returned
  instance carries `kind` for the client to branch on. There is no `getAuthor`: since `kind` is a
  runtime discriminant on the returned union, `community.kind === "authorCommunity"` narrows the type
  natively, and a dedicated method would just duplicate the resolution path.
- **Lifecycle:** `startCommunity` / `stopCommunity` / `deleteCommunity` / `list` are kind-blind
  (address-keyed); list output includes the derived `kind`.
- **Creation** is the one moment with no record to derive from, so the shared `createCommunity` takes
  the discriminating bit as a **local, non-wire creation option** (persisted in the community's local
  settings, from which the node knows which envelope key and schema to emit). Exact option shape TBD.
- The only genuinely author-specific RPC surface is the sync pair
  (`listAuthorComments` / `syncAuthorComments`).

## Convergence: both feeds under one name

Because an author-community is already a delegated community, the remaining milestone is small: let a
single IPNS name carry **both** payloads at once (`{ authorCommunity, community }`), so one identity is
simultaneously a multi-author community (references *in*) **and** its owner's author feed (references
*out*). The envelope already reserves the both-present slot; lifting the v1 "exactly one field" refine
is the mechanical change. The enduring difference stays semantic (references out vs. in), not
architectural.

## Future improvement: delegating profile moderation

> **Not in v1, not settled.** Recorded here because the v1 design deliberately leaves the door open.

v1 collapses the role map to the single owner (self), but that is a **policy choice, not a missing
capability**: an author-community is a full `LocalCommunity`, so the role map, the
`CommentModeration` publication type, and the mod-authorization check are already inherited untouched.
Re-opening the roles map is close to the whole change, which means a profile owner could grant
moderation of their own feed to other authors, including a **third-party moderation service**.

Sketch of what it would take:

- **Schema.** Restore a `roles` map to `AuthorCommunityIpfs`, same shape as `CommunityIpfs`
  (address to role), defaulting to just the owner. The owner edits it with `CommunityEdit`, the
  publication that already edits profile metadata. No new publication type.
- **Enforcement is unchanged.** `CommentModeration` acceptance already validates the publisher against
  the community's roles map, so a moderator's publication passes write-side with no author-community
  special case. The read-side owner-only invariant constrains **who may author top-level feed entries**,
  not who may moderate them, so granting a mod role does not weaken it.
- **Scope of what a mod can touch: native content only.** Native posts and the foreign replies hosted
  under them have this profile as their sole host, and their `CommentUpdate` is minter-signed, so mod
  actions on them are meaningful. Cross-posted entries carry the foreign community's signed mod-state,
  which nobody on this side can override; the only lever over a cross-post is the owner's own
  `syncAuthorComments` list (removal by omission), which stays owner-only.
- **Third-party moderation service.** A role entry is just an author key, so "delegate moderation of my
  profile feed to service X" is granting a role to X's author key. X then runs an **ordinary client**:
  it reads the feed and publishes `CommentModeration` through the normal challenge/publication topic,
  exactly like a moderator in any community. It never needs `As`, never needs `Ms`, and is revoked by a
  `CommunityEdit` dropping it from the map.
- **Distinct from the minter delegation.** The minter holds `Ms` and mints records; a mod service holds
  only its own author key and publishes moderation publications. The two delegations are independent
  and either can be rotated without touching the other.
- **Interaction with read-only mode.** `disablePubsubChallengeExchange` removes the network path a
  remote mod would publish through, so a profile with a third-party mod service needs the challenge
  exchange on (or the mod running in-process / over RPC).

Open bits, if this is ever picked up: whether the profile role vocabulary reuses the community one as
is (owner/admin/moderator) or a reduced set; whether a mod grant should be scoped (for example, replies
only, no edits to owner content); and how clients should attribute a profile mod action in the UI.

## Settled

- **Author-community is a delegated full community** (was: a bespoke client-signed / node-replicated
  record). Same `LocalCommunity` machinery, both pubsub topics, challenge processing; the **only**
  difference is the schema. Publishing is delegated anchor → minter, so a browser author owns a live,
  reply-able profile without handing out their identity key. The old `publishIpnsRecord` / CAR / pin-set
  replicator design is superseded and removed.
- **Delegate boundary.** Mirrors [delegated-ipns.md](delegated-ipns.md): pkc-js does resolution,
  verification, and owner own-key actions (anchor publish, native-comment signing); the minter service
  (out of pkc-js) mints, runs the challenge topic, and keeps the record alive.
- **Record shape.** An **envelope** (`{ authorCommunity? | community? }`), exactly one field in v1,
  resolves read-side dispatch by key presence; no `type` discriminator, `bso-resolver` untouched.
- **EOL length.** Reuse the delegated-IPNS **anchor EOL** constant, not a new value.
- **Cross-post sync.** The RPC pair `listAuthorComments` / `syncAuthorComments`, keyed by
  `{ authorPublicKey, authorName? }` (never address), declarative snapshot of raw `CommentIpfs[]`
  (no `CommentUpdate`), removal by omission, list-then-merge-then-sync for multi-device.
- **Sync authorization.** Private RPC is local-only and trusts its clients; bitsocial forge enforces
  ownership of the author key (auth lives in the forge layer, not the method schema).
- **Owner actions reuse existing publication types.** `Comment`, `CommentEdit`, `CommentModeration`,
  `CommunityEdit`; no new publication kinds. Owner-only top level on the write side is **default
  challenge config**: the built-in `fail` challenge seeded at creation with owner-address and
  non-post publicationType excludes, not a code-level `An` exemption.
- **`AuthorLocalCommunity` is a thin subclass of `LocalCommunity`**, instantiated from the persisted
  local kind option. It overrides the schema-facing seams (base record shape, `new` preloaded sort,
  schema/envelope, single-feed page generation, cross-post handling in the update loop, default
  challenges) and inherits everything else.
- **Freshness is minter-side.** The minter refreshes known entries' `CommentUpdate`s from their
  canonical communities; discovery of new entries is client-push only; the client never ships
  mod-state.
- **`kind` is runtime-only, derived from the envelope key.** No `createAuthor`, no `getAuthor`, no
  wire discriminator; creation passes the bit as a local non-wire option to the shared create, and
  reading narrows on the `kind` discriminant returned by the kind-blind `getCommunity`.
- **Read-only mode.** `settings.disablePubsubChallengeExchange` (private boolean) omits
  `pubsubTopic` from the record and stops the challenge-topic subscription; absence of `pubsubTopic`
  now means "no challenge exchange", with no fallback to the address anywhere. No flag day: all
  published records carry the topic explicitly, and old clients degrade by timeout. The local
  publish shortcut keeps same-process and RPC owners publishing. Tracked in
  [#229](https://github.com/pkcprotocol/pkc-js/issues/229).
- **Owner-only top level is enforced read-side.** Verifiers reject an `AuthorCommunityIpfs` record or
  page chunk containing a top-level entry whose `author.publicKey` differs from the resolved anchor
  `An` (checked at verification time, since the anchor is resolution context and not a record field).
  Node-side write acceptance is only the honest default, not the invariant.
- **Rotation migration reuses `exportCommunity`** (sqlite, kind-blind). The DB is portable across
  minters by construction (address = anchor, minter key is node-local config), restore is file-level,
  and no `importCommunity` method is needed: the normal update loop re-signs mod-state under the new
  minter key on regeneration.

## Open questions

- **`hasAuthorCommunity` field name** and its exact place in the author signed-property list.
- **Method/option naming.** `listAuthorComments` / `syncAuthorComments`, the `community.kind` value
  spellings, and the local creation-option shape are all TBD.
- **Delegation setup handshake.** How a browser author asks bitsocial forge (or another service) to
  become its minter and obtains `Mn` (plus the bootstrap `pubsubTopic`/`encryption`), and how the
  author later rotates `An → Mn'` to revoke. Mostly a forge concern, but pkc-js needs the client-side
  anchor sign/publish + rotate primitives.
- **Minter refresh cadence.** How often the minter re-loads cross-posted `CommentUpdate`s and with
  what backoff — delegate-side policy, mostly out of pkc-js.
- **Self-liveness-check (pure-P2P escape hatch).** For a future where libp2p-js-only authors can run
  their own minter, the client would verify "is anyone providing my record?" (query routers / the
  record topic) before going dark, and keep republishing if not. Out of scope for v1.
- **Anti-rollback on `An → Mn`.** Inherited from delegated IPNS: no sequence anti-rollback on the
  binding yet (tracked in #118); relevant here since a rotated-away minter could be pinned by a
  malicious gateway.

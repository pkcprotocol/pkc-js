# Author Communities (profiles as delegated communities)

> **Status: design (issue [#31](https://github.com/pkcprotocol/pkc-js/issues/31)).** Not yet
> implemented. This doc records the agreed design and the open questions.

## Summary

An **author-community** lets an author publish their own profile: display metadata plus a feed of
everything they've posted across the network, resolvable as an IPNS record at `author.publicKey`.
`getCommunity({ name?, publicKey?, address? })` resolves it the same way it resolves a normal
community, returning a community instance populated from the `AuthorCommunityIpfs` record; the
instance's runtime `type` field tells the client which one it got.

An author-community **is a full community**. It runs the same `LocalCommunity` machinery, both pubsub
topics (the IPNS-over-pubsub record topic **and** the challenge/publication topic), challenge
processing, and reply threads. Others can reply to the owner's posts, challenge-gated, exactly as in
any community. The difference is **the schema and what the schema implies**: an author-community carries a profile schema
(`AuthorCommunityIpfs`) with a single `new`-sorted feed whose top-level entries are the owner's own
comments (references *out* to other communities), where a normal community carries `CommunityIpfs`
with a role map and a multi-author, multi-sort feed of native submissions (references *in*).

It is published as a **delegated community** (anchor → minter, see
[delegated-ipns.md](delegated-ipns.md)): the author's identity key stays offline, and an online
delegate keeps the record fresh and runs the challenge topic on the author's behalf. This is the
mechanism that lets a browser author (who goes offline) own a live, reply-able community without ever
handing out their identity key, and without pkc-js needing a bespoke replicator.

Every comment is already a resolvable pointer to its author's profile, so no new index is needed.
Note that this works through **derived** identity, not a wire field: `author.publicKey` and
`author.address` are runtime-only (they are in `AuthorReservedFields` and must never appear on the
wire, see [wire-vs-runtime.md](wire-vs-runtime.md)). The resolvable anchor is computed from
`comment.signature.publicKey` via `getPKCAddressFromPublicKeySync()`, with `author.name` carrying the
optional domain. That derived value *is* an IPNS name, which is what makes the author's identity key
usable as the anchor `An`.

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
| Roles/moderation | full role map, moderators | **same role map**, seeded with the owner alone in v1 (see [Future improvement](#future-improvement-delegating-profile-moderation)) |
| `postUpdates` | yes (MFS bucket tree) | **no**, updates come from the feed pages (see [Why no `postUpdates`](#why-no-postupdates)) |
| Publishing | delegated community (anchor → minter) | **same:** delegated community (anchor → minter) |

**Build implication:** an author-community is a **schema/policy variant of the community machinery**,
not a separate class tree, and it is a **delegated community**, not a special replication path. The
two enduring differences are semantic, not architectural: an author-community's top-level content is
the owner's own cross-network comments (references out), and only the owner may post at top level. The
future "converged" milestone (a single name that is *both* a multi-author community and its owner's
author feed) is then nearly free (see [Convergence](#convergence-both-feeds-under-one-name)).

### Prerequisite: a delegated `LocalCommunity` (anchor identity, minter signer)

Everything below assumes a `LocalCommunity` whose **identity is not its signing key**: the record is
published under the minter name `Mn` (the node's signer) while the community's user-facing identity is
the anchor `An`. **That split shipped in [#237](https://github.com/pkcprotocol/pkc-js/pull/237)**
(issues #233 and #234), so it is no longer work to do here.
[delegated-ipns.md](delegated-ipns.md) now documents both the loading side and "Publishing a delegated
community". The read side derives `community.publicKey` from `ipnsHops[0]`, the anchor, and never from
`signature.publicKey`; the write side persists the anchor and replays it into `ipnsHops`, so the same
inherited code reports the anchor on a publisher. What it gives this design:

- **The anchor is persisted local config, not derived.** A delegated `LocalCommunity` cannot compute
  its own `publicKey` from its signer (that would yield `Mn`). The anchor `An` is supplied at creation
  and stored in the community's local settings, alongside the local `type` bit.
- **Publication acceptance compares against the anchor.** Incoming publications carry
  `communityPublicKey` = the address the client resolved, which is `An`. The node's check is
  `publication.communityPublicKey === community.publicKey` (the anchor) rather than
  `=== community.signer.address` (the minter), which would reject **every** remote publication to a
  delegated community: foreign replies, owner native posts, votes, edits, moderation.
- **Stored publications keep the anchor.** The publication store backfills `communityPublicKey` from
  `community.publicKey`, not from `community.signer.address`, so native content does not attribute
  itself to the minter, which would break on the next rotation.
- **Minter-derived things stay minter-derived.** `pubsubTopic`, the `encryption` keypair, and the
  record signature all belong to `Mn`. Only identity moves to the anchor.
- **Non-delegated is the degenerate case.** When a profile runs on the author's own node, signer and
  anchor are the same key and every rule above collapses to current behavior, so the change is a
  generalization rather than a fork.

This is a type-blind `LocalCommunity` change: any delegated community benefits, not just profiles.
pkc-js can create, publish, serve, and **load back** a delegated community end to end, even though the
production minter (forge) is what actually runs it.

### Implementation shape: `AuthorLocalCommunity`

The machinery is shared via a **thin subclass**: `AuthorLocalCommunity extends LocalCommunity`,
instantiated by the shared create/load path from the persisted local `type` option (Remote/RPC
variants mirror the type the same way later). A subclass is the same class tree; it overrides a small
set of seams, most of them data-like (a per-type descriptor the shared record-build functions
consult), with real method overrides only where behavior changes:

1. **Base record shape** (`_toJSONIpfsBaseNoPosts`): emits profile metadata (displayName, avatar,
   wallets, bio) and no roles map.
2. **Preloaded sort**: `new` (the community record build hardcodes `hot`).
3. **Schema and envelope**: validates and signs against `AuthorCommunityIpfsSchema` and publishes
   under the `authorCommunity` envelope key.
4. **Page generation**: a single-`new` sort table mixing posts and replies in one feed, embedding
   cross-posted entries' foreign-signed `CommentIpfs` + `CommentUpdate` verbatim.
5. **Page verification**: a dedicated verifier for author-community pages (see
   [Verifying author-community pages](#verifying-author-community-pages)). The shared page verifier
   rejects exactly what this feed is made of, so this is a real seam, not a data-like one.
6. **Storage**: cross-posts live in their own table, never in `comments` (see
   [Storage](#storage-cross-posts-live-in-their-own-table)).
7. **Update loop**: only ever generates `CommentUpdate`s for native rows; cross-posts are not in
   `comments` at all, so there is nothing to skip. Cross-post mod-state is refreshed by the minter's
   refresh job (see [Minter-side freshness](#minter-side-freshness-of-cross-posted-entries)).
8. **Default challenges**: creation seeds `settings.challenges` so only the owner can post at top
   level (see [Owner actions](#owner-actions-existing-publication-types)).
9. **Roles seeding**: creation seeds `roles` with the owner (see [Roles](#roles-kept-seeded-with-the-owner)).

Everything else (pubsub topics, challenge pipeline, lifecycle, export, IPNS publishing) is inherited
untouched, on top of the [delegated `LocalCommunity`](#prerequisite-a-delegated-localcommunity-anchor-identity-minter-signer)
prerequisite above.

## The record: `AuthorCommunityIpfs`

A sibling of `CommunityIpfs`. It **keeps** the fields that make it a working, reply-able community and
differs only where the profile semantics require it:

- **Kept, because it runs the challenge topic:** `challenges` (the public challenge requirements a
  replying author reads), `encryption` (the key a replying author encrypts their publication with; here
  it is the **delegate/minter's** key, since the minter runs the challenge/publication topic), and
  `pubsubTopic`. Others reply to the owner's posts through exactly this machinery, so omitting these
  would break replies. In [read-only mode](#read-only-mode-disabled-challenge-exchange) all three are
  omitted together, which is precisely the signal that replies are disabled.
- **Kept, narrowed by policy:** `roles`, seeded with a single owner entry (see below).
- **Kept, unchanged:** `features`, `modQueue`, `title`, `description`, `rules`, `suggested`, `flairs`,
  `lastPostCid`, `lastCommentCid` (see [What the profile keeps from `CommunityIpfs`](#what-the-profile-keeps-from-communityipfs)).
- **Dropped:** `postUpdates` (see [Why no `postUpdates`](#why-no-postupdates)).
- **Added:** profile metadata: `displayName`, `avatar`, `wallets`, bio/links, ...
- `posts: { pages: { new: <preloaded page> }, pageCids: { new: <cid> } }`, reusing the community
  `posts` structure verbatim, but a single `new` sort rather than the multi-sort community feed.
- `statsCid`, `createdAt`, `updatedAt`, `signature`, `protocolVersion`, as in `CommunityIpfs`.

### Roles: kept, seeded with the owner

The role map is **not** dropped. Inherited authorization reads it directly:
`isPublicationAuthorPartOfRoles()` returns `false` when `community.roles` is undefined, and it is what
gates `CommentModeration` acceptance and `CommunityEdit` (which requires `owner`/`admin`, and `owner`
for role or address edits). There is no implicit "the signer is the owner" fallback anywhere. Omitting
the map would therefore leave the owner unable to moderate replies on their own profile or to edit
their own profile metadata, which are two of the four owner actions below.

So `AuthorCommunityIpfs` carries the same `roles` shape as `CommunityIpfs`, and creation seeds it with
exactly one entry: the owner (the anchor's address) as `owner`. v1 policy is that the map stays a
single entry; the capability to open it up is inherited, which is what makes
[delegated profile moderation](#future-improvement-delegating-profile-moderation) close to free later.

### What the profile keeps from `CommunityIpfs`

The default is **keep**, not drop. An author-community hosts native content and challenge-gates
replies, so the fields that serve hosting serve it too, and dropping one would only create a branch in
inherited code for no gain. Concretely:

- **`features`** is required, not optional: `prepareCommentWithAnonymity()` reads
  `community.features?.pseudonymityMode`, so a profile could not offer pseudonymous replies without
  it. The whole `CommunityFeaturesSchema` carries over (see [Pseudonymity mode](#pseudonymity-mode)).
- **`modQueue`** carries over with the pending-approval flow intact: a profile that challenge-gates
  replies has exactly the same reason to hold a reply for approval as any community, and
  `settings.maxPendingApprovalCount` and the disapproved-purge setting apply unchanged. The one
  author-community-specific rule is that **the mod queue only ever holds native content**: cross-posts
  are not publications to this community, are not in `comments`, and cannot be approved or disapproved
  here. Removing one from the profile is omission from the next sync.
- **`title`, `description`, `rules`, `suggested`, `flairs`** are ordinary presentation and policy
  fields that a profile can use as-is (`rules` for replies to the profile, `flairs` for repliers).
  They are edited with `CommunityEdit`, like the profile metadata fields.
- **`lastPostCid` / `lastCommentCid`** carry over but are **native-only**, since they are derived from
  the `comments` table. They describe the profile as a host, not the author's activity across the
  network; the feed is what describes that.

### Why no `postUpdates`

A full community publishes a `postUpdates` MFS bucket tree so that a client holding **one comment CID**
can fetch that comment's `CommentUpdate` directly, by timestamp bucket, without traversing pages. That
matters when a community has millions of comments: page traversal to find a single update would be
absurd, so the bucket tree is the index that makes point lookup cheap.

An author-community does not have that problem. A profile's feed is the author's own output, which is
orders of magnitude smaller, and every entry's `CommentUpdate` is **already embedded in the feed
pages**. Native content's updates therefore arrive with the page that carries the comment, and
cross-posted content's canonical update lives in its own community (which has its own `postUpdates`).
Carrying a second index for a feed that already ships its updates inline would be pure overhead on
every mint.

If a profile ever does grow large enough that point lookup by CID matters, adding `postUpdates` is
additive and backward compatible, so it is listed under
[future good to haves](#future-good-to-haves) rather than designed out.

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
mod-state of *native* content it hosts, below). A cross-post's `CommentUpdate` reaches the minter
either from its own refresh job or seeded by the owner's client through
[`syncAuthorComments`](#syncing-cross-posts-listauthorcomments--syncauthorcomments); both paths verify
the same community signature, so the source does not affect what a reader can trust.

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

### Verifying author-community pages

The shared page verifier cannot be reused as is: it rejects precisely what this feed is made of. Given
a page and the community it belongs to, it currently enforces that

1. every entry's `communityPublicKey` equals the page's community (`ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_COMMUNITY`) — every cross-post fails this;
2. an entry with `depth > 0` has parent context, and its `depth` / `parentCid` / `postCid` line up with that parent — a cross-posted reply carried as a top-level feed entry has no local parent, so it fails this;
3. an entry with `depth === 0` has no `postCid`, which holds fine;
4. each entry's `CommentUpdate` verifies against **this** community's identity — a cross-post's update is signed by its foreign host, so it fails this too.

**The mod-queue page is the precedent to copy.** `ModQueuePageIpfs` already models the awkward part:
a page whose entries have **mixed depths, unrelated `parentCid`s, and no shared `postCid`**, and the
shared verifier already carries an explicit branch for it. So the author feed is not a novel page
shape, it is the second instance of one that exists. Concretely, `verifyAuthorCommunityPage` is the
mod-queue branch plus two substitutions:

- **Per-entry community, not per-page community.** Each entry is verified against the community named
  by its own `comment.communityPublicKey`: the `CommentIpfs` against its author signature, the
  `CommentUpdate` against that foreign community. The page's own community is only used for native
  entries. Cross-community mismatch stops being an error and becomes the routing key.
- **The owner-only invariant replaces the parent-relationship checks.** Feed entries are related to the
  profile by authorship, not by thread position, so the check that every top-level entry's author key
  equals the resolved anchor `An` (see [Read-side verification](#read-side-verification-three-feed-states))
  is what constrains the page. Depth is informational for rendering; parent linkage is only enforced
  inside a `CommentUpdate`'s own preloaded replies pages, where the shared verifier already applies.

**`communityName` is the strict half of the pair.** The existing rule stands and is applied per entry:
a `communityPublicKey` mismatch is deliberately **not** fatal, because a community may rotate its key,
but a `communityName` mismatch **is** fatal, because a domain is the stable identity. Matching uses
`areEquivalentCommunityAddresses()` in both cases. Per entry that means:

- **Native entry:** if the profile has a domain, `comment.communityName` must equal `community.name`,
  and an entry naming a different domain invalidates the page. If the profile has no domain, the
  entry's `communityPublicKey` is matched against the anchor instead.
- **Cross-posted entry:** the entry names a foreign community, so the pair is checked for internal
  consistency rather than against the profile. If `communityName` is present it must resolve to the
  entry's `communityPublicKey`, which is the same name-to-key check a reader does when loading that
  community directly; a name that resolves to a different key invalidates the entry, and a name that
  cannot be resolved right now leaves the entry verifiable by key with `nameResolved: false`, exactly
  as elsewhere. Never silently ignore a present `communityName`: an unchecked name is a free way to
  make a comment look like it came from a community it never touched.

### Storage: cross-posts live in their own table

Cross-posted entries are **not** rows in the `comments` table. That table is built for content this
community hosts and enforces it structurally:

- `postCid TEXT NOT NULL REFERENCES comments(cid)` and `parentCid TEXT NULLABLE REFERENCES comments(cid)`. A cross-posted reply's parent and post rows live in a foreign community and do not exist locally, so the insert violates the foreign key.
- `commentUpdates` is keyed `cid TEXT PRIMARY KEY REFERENCES comments(cid)` and holds updates this node generates and signs. A cross-post's update is foreign-signed and must never be regenerated.
- Per-community derived state would be silently corrupted: author post/reply counts and scores, `firstCommentTimestamp`, the `number` / `postNumber` counters, `lastPostCid` / `lastCommentCid`, and `statsCid` all count rows in `comments`. Cross-posts would inflate every one of them, including the challenge excludes that read author scores.

So an author-community keeps the standard schema for **native** content (which is ordinary community
content in every respect) and adds a dedicated table for cross-posts.

#### The cross-post table is not a mirror of `comments`

This is the heart of it: we cannot fill in a `comments` row for a cross-post, and we do not need to.
`comments` and `commentUpdates` are **decomposed** tables. They explode a publication into ~30 typed
columns (`link`, `linkWidth`, `thumbnailUrl`, `previousCid`, `number`, `postNumber`, `pendingApproval`,
`challengeCommentUpdate`, `extraProps`, ...) because the node **owns** that content: it computes
aggregates over the columns, regenerates and re-signs `CommentUpdate`s from them, and rebuilds the
wire record on the way out via `deriveCommentIpfsFromCommentTableRow()`. Every one of those columns
exists to serve something the node does *to* the content.

For a cross-post the node does none of that. It never scores it, never generates its mod-state, never
edits it. It does exactly two things: order it in the feed, and embed it verbatim. So the table stores
the **raw wire records as JSON**, plus only the columns needed to order, route, and refresh:

**The rule is: store the records verbatim plus node-local bookkeeping, and derive everything else.**
Anything already stated by the JSON gets no column of its own, because a copy is a second source of
truth that can drift. The two values that need an index are **generated columns** over the JSON, so
they are queryable and indexable without being stored twice:

```sql
CREATE TABLE IF NOT EXISTS crossPostedComments (
    -- the records, verbatim
    cid TEXT NOT NULL PRIMARY KEY UNIQUE,       -- derived from the raw comment bytes, never client-supplied
    comment TEXT NOT NULL,                      -- JSON: the author-signed CommentIpfs, verbatim
    commentUpdate TEXT NULLABLE,                -- JSON: the community-signed CommentUpdate, verbatim
    ancestors TEXT NULLABLE,                    -- JSON array: embedded parent chain of a cross-posted reply

    -- node-local bookkeeping, stated nowhere in the records
    ancestorsRefreshedAt INTEGER NULLABLE,
    lastRefreshAttemptAt INTEGER NULLABLE,
    lastRefreshSuccessAt INTEGER NULLABLE,
    refreshFailureCount INTEGER NOT NULL DEFAULT 0,
    insertedAt INTEGER NOT NULL,

    -- derived from the records, not duplicated
    timestamp INTEGER GENERATED ALWAYS AS (json_extract(comment, '$.timestamp')) VIRTUAL,
    communityPublicKey TEXT GENERATED ALWAYS AS (json_extract(comment, '$.communityPublicKey')) VIRTUAL
);
CREATE INDEX IF NOT EXISTS crossPostedComments_timestamp ON crossPostedComments(timestamp DESC);
CREATE INDEX IF NOT EXISTS crossPostedComments_communityPublicKey ON crossPostedComments(communityPublicKey);
```

`timestamp` earns a generated column because it is the feed's `ORDER BY` on the page-generation hot
path; `communityPublicKey` because the refresh job batches by it. Both are `VIRTUAL`, so nothing is
written twice while the index still stores the value. `cid` is the one derived value SQLite cannot
compute (it is a hash of the bytes, not a field of them), which is why it is a real column.

Deliberately **not** columns, since nothing queries them:

- **`communityName`** is read only during verification, which is parsing the record anyway. It never
  appears in a `WHERE` or `ORDER BY`.
- **`depth`** is rendering information. The ancestor job's "does this need a parent chain" filter runs
  periodically over a small table and can read it from the JSON like anything else.
- **`commentUpdateUpdatedAt`** answers a strictly per-row question: the monotonicity check happens
  while holding the row, whose `commentUpdate` JSON is right there. No bulk query compares
  `updatedAt` across rows, and if one ever does, it is another generated column at that point.

**No foreign keys.** Every reference a cross-post makes (`parentCid`, `postCid`, its community) points
outside this database by definition, which is exactly why these rows cannot live in `comments`.
`parentCid` and `postCid` are not columns either: they live in the raw JSON, used for rendering and
for walking ancestors, never for local linkage.

**Why raw JSON rather than exploded columns**, beyond "we have no use for them":

- **Byte fidelity.** The entry is embedded into the feed verbatim and its signature covers exactly
  those bytes. Decomposing into columns and reassembling on the way out is precisely the fragile step
  `deriveCommentIpfsFromCommentTableRow()` represents (see
  [db-community-address-migration.md](db-community-address-migration.md)); it is worth the fragility for
  content we sign ourselves, and not worth it for content we merely carry.
- **Forward compatibility.** A foreign community may run a newer protocol version with fields this
  node has never heard of. Stored raw, such a comment round-trips byte-exact and keeps verifying;
  exploded, its unknown fields land in `extraProps` and survive only as well as the reassembly logic
  does.
- **One source of truth.** With the records stored whole and the query surface generated from them,
  there is no copy to fall out of sync with the bytes that were actually signed. `json_extract()` is
  already used throughout `db-handler.ts`, so this is the existing idiom rather than a new one.

The row gets a zod schema alongside the other table-row schemas, with `comment`, `commentUpdate`, and
`ancestors` as parsed JSON columns, which means a case in the DB parsing test per the repo rules.

The table is exactly the declarative snapshot `syncAuthorComments` maintains: add on presence, drop on
omission, replace mod-state monotonically.

**Extend `db-handler.ts` and the shared schema.** The cross-post table is a normal addition to the
existing schema: declared in `createOrMigrateTablesIfNeeded()` alongside every other table, with its
queries added to `db-handler.ts` itself. There is no separate author-only handler, no subclassed
handler, and no second database.

It is created **unconditionally**, in every community DB, and stays empty for normal communities. The
alternative (create it only when the community is an author-community) would make the schema depend on
a *local setting*, so one `DB_VERSION` could describe two different databases and every later
migration would have to branch on it. An empty table costs nothing and keeps migrations linear.

Native content is ordinary community content in every respect, so the standard tables serve an
author-community unchanged; only the cross-post surface is new. `exportCommunity`, the restore path,
and rotation migration therefore stay file-level and type-blind, which is what makes moving a profile
between minters a copy rather than a protocol. Adding the table is a `DB_VERSION` bump and needs the
usual migration test, including migrating an existing normal community DB.

### Size cap

The **root object** (profile metadata + inline `new` page + `pageCids` list) is capped at **1 MiB**,
exactly like `LocalCommunity`'s root. The feed is unbounded overall (overflow spills into `pageCids`
chunks), but every fetched object is bounded, so loads stay fast. There is **no** 40 KiB cap here:
that limit is on a *comment's publication bytes*, not on an IPNS-pointed record (the IPNS record
itself only carries the signed name→CID pointer, ~10 KiB spec cap; the `AuthorCommunityIpfs` content
is a normal IPFS DAG with no hard protocol cap).

An embedded `CommentUpdate` is carried **whole**, including any preloaded `replies` page it came with:
stripping fields would break the community signature that makes the entry verifiable in the first
place. Entries are therefore not comment-sized, and the inline first page may hold relatively few of
them before the root cap forces a spill. That is the intended trade: bounded fetches, with depth
reached through `pageCids`.

## Publishing: delegated (anchor → minter)

An author-community is published **exactly like a delegated community**
([delegated-ipns.md](delegated-ipns.md)), with two keypairs:

- **`An` / `As`** — the **anchor**. `An` is the author's identity IPNS name (the runtime
  `author.publicKey`, derived from `signature.publicKey`, immutable per
  [names-and-addresses.md](names-and-addresses.md)); `As` is the author's identity signing key, held
  **offline by the author**, in the browser, and here it only ever signs the anchor record.
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

**pkc-js ships the machinery; the forge runs it.** The minter is an ordinary pkc-js community node
driving `AuthorLocalCommunity`, so the community-side code (schema, page generation and verification,
the sync RPC pair, the refresh job, `exportCommunity`) all lives in this repo. The **delegation setup
handshake** also belongs in pkc-js rather than in a hosting service, but it is type-blind and outside
this design; it shipped separately in
[#237](https://github.com/pkcprotocol/pkc-js/pull/237). What is *not* in pkc-js is the **service
layer** the forge wraps around it: multi-tenant authentication and authorization, `Ms` custody
policy, quotas, and hosting operations. This is a narrower boundary than
[delegated-ipns.md](delegated-ipns.md)'s, which is scoped to client-side *loading*; the two are
consistent because that doc's "publishing is not part of pkc-js" refers to operating a delegate, not
to the community implementation the delegate runs.

pkc-js must therefore be able to create, publish, and load back a delegated community entirely on its
own, under test, with no forge involved. The list below splits by **which key acts**, which is the
distinction that actually matters:

**Acts with `As` (owner's client, pkc-js):**

- **Resolve + verify** an author-community by resolving the anchor (the runtime `author.publicKey`),
  walking the single `An → Mn` hop, and verifying the minter-signed content against the chain's
  terminal, using the delegated-loading path that already exists (issue #93).
- **Anchor publish and rotate.** Sign the anchor record `An → Mn` with `As` (in-browser) and publish
  it at delegation setup; re-sign it only to point at a different minter. Only the author holds `As`,
  so this step is inherently client-side and cannot be delegated. With an
  [effectively infinite EOL](#liveness-anchor-eol--minter-freshness) there is no renewal obligation.
- **Native content signing.** Sign the owner's own `CommentIpfs` with the author's identity key and
  publish it to the profile like any publication (see [Owner actions](#owner-actions-existing-publication-types)).
- **Cross-post sync.** Push the owner's cross-network comment list to the minter via the sync RPC pair
  (see [Syncing cross-posts](#syncing-cross-posts-listauthorcomments--syncauthorcomments)).

**Acts with `Ms` (the minter node, also pkc-js):**

- Mint `Mn → <envelope cid>` frequently, run the challenge/publication topic, fold in foreign replies,
  sign the profile record and native mod-state, serve the sync RPC pair, run the refresh job, and
  pin/serve/provide the DAG so the record stays alive after the author goes offline. This is
  `AuthorLocalCommunity` on top of the [delegated `LocalCommunity`](#prerequisite-a-delegated-localcommunity-anchor-identity-minter-signer)
  prerequisite, all of it in this repo.

**Not in pkc-js (the forge's service layer around the minter node):**

- Multi-tenant authentication and per-profile authorization, `Ms` custody policy, quota and hosting
  policy, and operating the infrastructure. A self-hosted owner running their own node needs none of
  it, which is why pkc-js can exercise the whole shape in tests.

> **Delegation setup handshake (shipped in
> [#237](https://github.com/pkcprotocol/pkc-js/pull/237)).** To point `An → Mn` the author needs the
> delegate's minter name `Mn`, so `createCommunity` takes an anchor `publicKey`, generates `Mn`/`Ms`
> node-side and returns `Mn` along with the bootstrap `pubsubTopic` and `encryption` key (before the
> first mint there is no record to resolve those from). The author then signs `An → Mn` client-side and
> hands the bytes to `publishAnchorRecord`. That handshake is **type-blind** and serves delegated
> multi-author communities as much as profiles, which is why it lives in the community surface rather
> than here. It is in the pkc-js RPC and not in a hosting service: "run this community for me, I keep
> the anchor key" is a protocol operation, and putting it in the forge would leave a self-hosted owner
> unable to delegate to their own daemon. See "Setting delegation up" in
> [delegated-ipns.md](delegated-ipns.md).

**No delegate configured → no profile.** Publishing a profile requires a reachable minter. A pure
in-browser helia node can sign the anchor but has no online party to mint and keep the record alive.
**v1 consequence:** pure-P2P (libp2p-js-only, e.g. 5chan) authors cannot publish profiles until they
point their anchor at some minter service. This is the same offline-owner constraint that delegated
communities already carry, not a bespoke author-community limitation.

**On Node this is already solved: run a daemon.** A Node author does not need a third-party forge and
does not need a self-liveness escape hatch. `bitsocial daemon` is a pkc-js RPC server, so the author
runs it, connects to it as an RPC client, and has it host the author-community: the daemon is the
online, key-holding, always-providing party by construction. The unsolved case is only the browser
with no daemon anywhere, and there no client-side check helps: a tab can ask "is anyone providing my
record?" but has no remedy, since republishing from a page that is about to close creates no
provider. Browser-only authors therefore need someone else's minter, full stop.

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
| Moderate a foreign reply under a native post | `CommentModeration` (authorized by the owner's seeded `roles` entry, see [Roles](#roles-kept-seeded-with-the-owner)) |
| Profile metadata (displayName, avatar, bio) | `CommunityEdit` (owner editing their own record) |
| Add/remove/refresh cross-post entries | **not a publication** — the sync RPC pair (below) |

A native `Comment` is signed by the owner's identity key client-side, with `communityPublicKey` = the
profile's own anchor public key; the minter folds it into the feed and signs the resulting mod-state
(`CommentUpdate`) with the minter key, exactly as any community node signs mod-state (with the anchor
key itself in the non-delegated own-node case). Foreign authors replying to a native post go through
the normal challenge/publication topic; the minter challenge-gates, accepts, and hosts them like any
community (the profile is their **sole host**).

### Pseudonymity mode

`features.pseudonymityMode` is inherited and works exactly as it does in any community. The profile
owner may enable it so that **repliers** get an alias address (`per-post`, `per-reply`, or
`per-author`), and the whole alias pipeline (alias signer, `originalCommentSignatureEncoded`, edit
authorization against the original author key) is untouched. The one interaction with this design is
the owner-only top level: only the anchor may author a **post**, while **anyone may reply**, so
pseudonymity applies to the replies, which is the content it exists for.

The owner's own content is never aliased, and this falls out of the existing rule rather than needing
a special case: `prepareCommentWithAnonymity()` skips authors holding `owner`/`admin`/`moderator`, and
the profile seeds the owner into [`roles`](#roles-kept-seeded-with-the-owner). A profile whose owner
were missing from the map would not just lose moderation, it would also start aliasing its own
owner's posts, which the read-side owner-only invariant would then reject. The roles entry is what
keeps the two consistent.

For **cross-posts** the direction is reversed and worth stating plainly: when the owner publishes into
a foreign community that has pseudonymity enabled, the canonical comment there is **alias-signed**, so
it does not verify against `An`. Such a comment is rejected by the sync gate, and that is the correct
outcome twice over: the minter genuinely cannot attribute it to the anchor, and embedding it would
undo the anonymity the foreign community granted. The client must not offer pseudonymous comments for
sync, and the RPC must reject them if it does.

### Syncing cross-posts: `listAuthorComments` / `syncAuthorComments`

Publishing to a foreign community never involves the minter — a libp2p-js client runs that challenge
exchange with the foreign community directly. So the minter cannot observe the owner's cross-network
activity, and **discovery of new entries is client-push only**: the client is the sole party that
knows "I just posted in community X," and it delivers that knowledge through a pair of RPC methods on
the minter:

Both methods carry the comment list as **page entries**: the exact shape a `PageIpfs` already uses for
its comments (`{ comment: CommentIpfsType, commentUpdate: CommentUpdateType }`, see
[pages.md](pages.md) and `PageIpfsSchema`), with `commentUpdate` relaxed to **optional**. No new type:
what the client syncs is literally what the minter embeds in the `new` feed.

```ts
// PageIpfs["comments"][number], with commentUpdate optional
listAuthorComments({ authorPublicKey, authorName? })            // → stored entries
syncAuthorComments({ authorPublicKey, authorName?, comments })  // comments: entries
```

- **Multi-tenant addressing.** The RPC server hosts many author-communities alongside full
  communities, so both methods are keyed by the target profile. Wire params identify the profile by
  **`authorPublicKey` plus optional domain `authorName`**, never by address — address is runtime-only
  (see [wire-vs-runtime.md](wire-vs-runtime.md)).
- **Declarative snapshot semantics.** `syncAuthorComments` is the owner's full cross-post list. The
  minter diffs against its DB: CIDs not yet stored are added, stored CIDs omitted from the list are
  dropped from the feed. Removal is omission — no tombstones, no retraction publication. Idempotent.
- **Raw bytes, comment and mod-state both.** The client ships the raw author-signed `CommentIpfs`
  bytes (a loaded comment already exposes this as `comment.raw.comment`) and, when it has one, the
  community-signed `CommentUpdate` alongside it. Shipping the bytes (not bare CIDs) means sync never
  depends on the foreign community being reachable, and the minter never fetches anything during the
  call. The minter derives each CID from the comment bytes and reads `communityPublicKey` off the
  comment to learn its canonical community.
- **List-then-merge-then-sync.** `listAuthorComments` exists so a client on a fresh device can read
  the server's stored set, union it with its local comments by CID, and sync the merged list — a bare
  sync from a partial view would silently drop the server-only entries. It returns the **same entry
  shape** it accepts, so a merge round-trip never strips an entry's `commentUpdate`. Merge collisions
  on the same CID resolve by the same monotonicity rule the minter applies (below): keep the higher
  `updatedAt`.
- **`previousCommentCid` is the recovery path of last resort.** Every comment carries
  `author.previousCommentCid`, which chains an author's comments **across communities**, so the
  author's own history is walkable from any one of their comments without the minter or a local list.
  It is not part of the sync flow, but it is what a client falls back on when both sides have lost
  state (fresh device, minter DB gone, or an export nobody took), and it is the only independent way
  to notice that a minter quietly dropped entries from a feed. A client rebuilding this way walks the
  chain, loads each comment, and syncs the result like any other list; the same validation gates
  apply, so nothing about trust changes. Worth building only if profile-loss reports show up in
  practice, but worth knowing the option exists before designing a heavier backup.
- **Decoupled and best-effort.** The entry push is an independent client action that can happen any
  time after the foreign publish, from any of the author's devices. The profile lags reality until the
  client next syncs — the accepted consequence of client-owned timing. (When a client happens to have
  its minter reachable at publish time, pushing right away is a convenience, not a protocol
  requirement.)
- **Validation gates.** The minter accepts a synced entry only if all of the following hold: its
  comment is validly signed by the addressed profile's `authorPublicKey` (`An`); its `commentUpdate`,
  when defined, is validly signed by the comment's `communityPublicKey`; and the CID the server
  derives from the raw comment bytes equals `commentUpdate.cid`. It rejects runtime-only fields (raw
  wire shape enforced) and bounds input size. A sync can therefore never inject content the owner
  didn't author, mod-state the hosting community didn't sign, or mod-state the community signed for a
  *different* comment.

#### Why `commentUpdate` rides along

The argument for shipping comment bytes rather than CIDs applies verbatim to mod-state, and the
client is the only party positioned to supply it: publishing to a foreign community never involves the
minter, so the client held a valid community-signed `CommentUpdate` at publish time that the minter may
never be able to fetch. Without this, a cross-post to a community that is **down, dead, or unseeded**
can never get a `CommentUpdate` into the feed at all, and is pinned forever in read-side state 3
(unknown), even though a perfectly verifiable snapshot existed client-side.

Trust is unaffected: a `CommentUpdate` is signed by the community that hosts the comment, so the client
is a transport for an object it cannot forge, and minter-side verification is identical whether the
bytes arrived over RPC or over bitswap.

Five rules make it safe and useful:

1. **Optional is load-bearing.** A just-published comment has no `CommentUpdate` yet (the host
   community has not generated one), so the field must tolerate absence and be fillable by a later
   sync. This is the single deviation from the `PageIpfs` entry shape, which requires it.
2. **Verified against `comment.communityPublicKey`.** A pushed `CommentUpdate` whose community
   signature does not verify is rejected by the same strict gate as a badly signed comment.
3. **CID pairing is checked, not trusted.** For every entry where `commentUpdate` is defined, the RPC
   server derives the CID from the raw `comment` bytes it was given and requires it to equal
   `commentUpdate.cid`; a mismatch rejects the entry. This is not redundant with rule 2: a valid
   community signature attests the mod-state, not the pairing the *client* chose. Since `cid` is
   itself a signed field of `CommentUpdate` (precisely to prevent this attack), signature-plus-match
   is what proves the hosting community signed *this* mod-state for *this* comment. Without the check
   a client could staple a genuine, genuinely-signed `CommentUpdate` from a high-scoring comment onto
   a different one and inflate its profile's karma without forging anything.
4. **Monotonic by `updatedAt`.** The minter stores `max(stored, pushed)` and never downgrades. This is
   the one attack the change would otherwise open: an author whose post was moderated could push a
   pre-removal snapshot to whitewash a `removed`/`deleted` flag.
5. **Push seeds, minter refresh still wins.** A pushed snapshot bootstraps the entry and is the
   permanent fallback for an unreachable community; it does not retire the minter's refresh job
   ([below](#minter-side-freshness-of-cross-posted-entries)).

Because a `CommentUpdate` can embed a preloaded replies page, per-entry payload is no longer roughly
comment-sized: the input bound must be a **byte cap**, not just an entry count.

#### Feed membership vs. mod-state

These are separate axes, and conflating them is the failure mode carrying mod-state invites. **Membership
in the feed is controlled solely by presence in the sync list; mod-state is content of an entry.**
Removing a post from the profile is omission from the next sync, and since the minter fetches nothing
during the call, it works with the foreign community fully dead. Nothing should ever be hidden by
pushing a `deleted` `CommentUpdate`.

| Owner action | Mechanism | Needs the foreign community reachable? |
|---|---|---|
| Drop a cross-post from my profile feed | omission from `syncAuthorComments` | **no** |
| Delete the comment itself, everywhere | `CommentEdit` with `deleted`, to the host community | yes |

**Sync authorization.** Signature validation stops forgery but not shrinkage: the owner's comments are
public, so an unauthorized caller could sync a valid *subset* and silently remove entries (omission =
removal). The access model is therefore transport-level, in two tiers:

- **Private RPC (local): trusted.** The private pkc-js RPC is considered **local-only and trusts its
  clients**, exactly like the rest of its methods (`createCommunity`, `deleteCommunity`, ...). No
  per-call ownership proof in v1.
- **bitsocial forge (multi-tenant): authenticated.** Forge will have auth and access granularity — a
  caller **cannot invoke `syncAuthorComments` for a profile unless it owns that author key**. That
  enforcement lives in the forge layer, not in the pkc-js method schema.

### Parent context for cross-posted replies

A reply entry on its own renders as a body with nothing around it: no parent comment, no post title,
no indication of what was being answered. Reddit-style profile pages show the thread context, and a
profile that cannot is much less useful.

**The minter embeds the ancestors.** When it generates the feed pages it walks each cross-posted
reply's `parentCid` chain up to its post and embeds those comments alongside the entry, so a reader
renders the thread context from the same fetch that gave them the reply. This keeps the "one fetch to
render a profile" property that motivated embedding entries in the first place, and it keeps working
when the foreign community is unreachable at render time, which lazy client-side fetching does not.

Embedded ancestors are ordinary foreign-signed comments and carry no new trust: each verifies exactly
like the entry itself, against its own author signature and its own community. A reader that cannot
verify an ancestor renders the entry without context rather than rejecting it, since context is
presentation, not the entry's validity.

**Ancestors are refreshed on a fixed interval** (on the order of one to two hours), the same way and on
the same job as cross-posted `CommentUpdate`s. Context drifts slowly (a post title rarely changes,
a deletion upstream does), so a fixed period is enough and bounds the extra fetching the minter does
per mint. The exact constant is delegate-side policy, tuned alongside the refresh cadence below.

### Minter-side freshness of cross-posted entries

The embedded `CommentUpdate` snapshots drift (votes, mod-state). Keeping them fresh is the
**minter's job** — it is delegated with handling the profile, and the work is bounded to CIDs already
in its own DB, so the anti-amplification argument against node-side fetching does not apply here:

- The minter periodically re-loads each cross-posted entry's `CommentUpdate` from its canonical
  community (read from `communityPublicKey`), **verifies the community signature**, and replaces the
  snapshot on its next mint. An invalid fetch is discarded; an unreachable canonical community leaves
  the last known snapshot in place (the entry is never dropped for unreachability).
- The client may **seed** mod-state via `syncAuthorComments`, but never owns freshness: a pushed
  snapshot only ever bootstraps an entry (or persists as its last known state when the canonical
  community is unreachable), and the minter overwrites it with anything newer it fetches. The client
  never needs to be online for an entry to stay fresh.
- **Monotonicity is enforced on both paths.** Stored state advances by `updatedAt` and never regresses,
  whether the candidate arrived from a fetch or from a sync push.
- The boundary stays sharp: refresh known CIDs, yes; **crawl for discovery, never** (new entries only
  arrive via `syncAuthorComments`).

### Minter rotation and data migration

Rotating the anchor (`An → Mn'`) cleanly revokes the old delegate's *publishing* rights, but the old
minter's DB holds the only copy of **native** content — including foreign authors' replies, whose sole
host is this profile. Migration reuses the existing export machinery:

- **Export = `exportCommunity` (already exists, already sqlite).** An author-community runs the same
  per-community sqlite DB, so `LocalCommunity.exportCommunity()` and the `exportCommunity` RPC work on
  it type-blind, producing a sqlite backup under `${dataPath}/exports/`. The owner can always trigger
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
- **Anchor record (`An → Mn`)** — signed by the offline author with an **effectively infinite EOL**
  (the maximum representable validity, see [delegated-ipns.md](delegated-ipns.md#anchor-record-eol)).
  The author does not have to come back to keep the binding alive; they only come back to **change**
  it. Use that same constant here; do not invent a new value.

**TTL vs EOL.** TTL is a short caching hint (fast update propagation). EOL is hard validity: a peer
cannot usefully rebroadcast an expired record, and the `ipns` validator rejects expired records on
every path. Setting the anchor EOL to effectively infinite removes the liveness cliff entirely, at the
cost of making the binding permanent until explicitly rotated, which is the right trade for an author
who may be away for months. The minter record's short cadence handles freshness; the anchor never
expires.

**What "infinite" does not solve.** An anchor record that never expires still has to be *retrievable*:
it must be re-provided to routers like any other record. A never-expiring old binding is also exactly
what a malicious server would want to keep serving after a rotation.

**Settled: no anchor-specific anti-rollback.** The exposure is bounded by **how many sources a reader
consults**, and that is enough. On the P2P paths the anchor record arrives from peers over the IPNS
record topic and from routers, not from one authority. On the gateway path pkc-js fans out to
multiple gateways in parallel and, for community records, `selectWinningGatewayCommunity` picks the
highest `updatedAt` among the responses and never accepts one older than the record the client
already holds. A pinned stale binding therefore surfaces as a stale record that loses to any honest
response, and a rotation propagates as soon as one honest source is reachable. Persisting a last-seen
anchor sequence would additionally close the case of a first-ever load where *every* source is
malicious; that stays general delegated-IPNS hardening in
[#118](https://github.com/pkcprotocol/pkc-js/issues/118), not something this design waits on.

**This is delegated publishing, not self-replication.** The author always owns and signs the anchor;
the delegate keeps the *minter* record alive and never touches `As`.

## Read-only mode (disabled challenge exchange)

> Shipped in [#236](https://github.com/pkcprotocol/pkc-js/pull/236) (issue #229). This is a type-blind
> `LocalCommunity` feature, not author-community-specific; it is specced here because feed-only
> profiles are its main use case. What remains for this design is the `AuthorCommunityIpfs` all-or-none
> refine below.

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
- **Wire rule (new, type-blind): absence of `pubsubTopic` means the challenge exchange is
  disabled.** The historical reader fallback "absent topic, use the address" is removed on every
  path. Publishers fail fast with a dedicated error (`ERR_COMMUNITY_CHALLENGE_EXCHANGE_DISABLED`)
  so clients can disable the reply UI up front instead of timing out.
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
  local node, or a `bitsocial daemon` the author connects to over RPC, which may hold `As` directly
  rather than a minter key, see [#234](https://github.com/pkcprotocol/pkc-js/issues/234)), mints and
  provides continuously, so ≥ 1 provider exists the instant the author goes offline.
- **Seeder network (ongoing redundancy).** **bitsocial-seeder** and voluntary nodes pick the record up
  from the record topic and re-provide it, so liveness does not hinge on a single delegate. The
  `author.isAuthorCommunity` hint (below) still drives *discovery* with no registration step.
- **Providing policy** is the community machinery's existing policy: provide the record root; readers
  bitswap page chunks by CID from the connected provider once resolved. Do **not** loop-provide every
  page chunk (announcing N chunks × M profiles is what starved kubo's serial provider and broke
  community `updateCids`). Per-chunk providing stays a tuning lever for a minority deep-page path, added
  only if production shows reachability failing.

## The `author.isAuthorCommunity` hint

`author.isAuthorCommunity` is a signed boolean on the wire `author` object (`AuthorPubsubSchema`)
meaning "this author publishes an author-community, so their identity key is worth resolving."
Consumers treat presence as "try, tolerate failure," absence as "don't bother." It is per-comment
(fixed at publish time) and attested by the author (a third party cannot forge it).

**Placement (settled):** it is a new optional key on `AuthorPubsubSchema` itself
(`isAuthorCommunity: z.boolean().optional()`). Nothing else has to move, because both lists that
matter are derived from that shape rather than hand-maintained:

- **Signing.** `author` is a single top-level signed property of the publication, and signed-property
  lists are computed from top-level schema shape keys. A new key inside the author object is
  therefore covered by the existing publication signature with no change to any
  `signedPropertyNames` list.
- **Reserved fields.** `AuthorReservedFields` is `difference(<author-with-CommentUpdate keys + runtime
  keys>, keys(AuthorPubsubSchema.shape))`, so adding the key to `AuthorPubsubSchema` removes it from
  the reserved set automatically. That is what makes the node's reserved-field rejection start
  accepting it, and it is why the name must live in the pubsub schema rather than beside it.

Key order within the zod object is cosmetic; grouping it with the other author-attested flags is the
only consideration.

It is a pure optimization: the identity key is derivable from any comment's signature regardless, so
the hint only saves readers from speculatively resolving an IPNS name for every author they render.
Adding it is backward compatible in both directions: comments are parsed through the flexible-author
variant (`AuthorPubsubSchema.loose()`), so an old node accepts it as an extra author prop and the
publication signature carries it unchanged; and a new client reads an old comment that lacks it as
"don't bother". The name must not collide with `AuthorReservedFields`, which is the runtime-only set.

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
3. **Unknown** — there is no verifiable `CommentUpdate` at all: none embedded (its community signature
   failed, or the entry never carried one) *and* none loadable live → possibly purged, **or** the
   community is just offline/unseeded right now. Do **not** collapse this to "purged"; render as
   *unverified*. (Applies to **cross-posted** entries only; a **native** entry's sole host is the
   author-community itself, so it is live iff present in the feed, and "removed" just means the owner
   or a moderator deleted it.)

An entry whose embedded `CommentUpdate` verifies against its `communityPublicKey` is renderable as
state 1 or 2 **even if that community is permanently gone**: the signature is what makes it
verifiable, not the community's reachability. Such a snapshot is not known-current, so a client that
distinguishes should mark it as last-known rather than live. This is the state that only exists
because the client can push mod-state through
[`syncAuthorComments`](#syncing-cross-posts-listauthorcomments--syncauthorcomments); with
minter-fetch-only mod-state, a dead community's cross-posts could never leave state 3.

**Karma** is computed from state 1 (and maybe 2) only, never from raw self-attested entries, so a
profile cannot inflate its own karma, while a transient community outage does not silently delete
history. *Independently verified* here means the `CommentUpdate`'s community signature checks out, not
that it was fetched live: a client-seeded snapshot counts on exactly the same footing as a
minter-fetched one, because neither party could have forged it. What a snapshot cannot promise is
recency, which is true of every embedded snapshot regardless of how it arrived. (The profile record is minter-signed, but the minter signing the *envelope* does not attest
the *foreign* mod-state inside it; karma still derives only from independently verified cross-posted
`CommentUpdate`s.)

**Aggregation is per-entry, so a total means walking the feed.** Each entry's score is trustworthy on
its own (the hosting community signed it), but there is no signed profile-wide total a reader could
verify. A minter-computed one would be an attestation by the profile owner's own delegate about its
owner's karma, which is exactly the self-attestation this section rules out, so the record does not
carry one.

> **Note for clients (Seedit, 5chan, anything rendering a karma number).** A profile's karma is
> **computed client-side by iterating the feed**: sum the verified `CommentUpdate`s of the inline
> first page, then of each `pageCids` chunk as it is loaded. A number shown after loading only the
> first page is a partial sum over the most recent entries, not the profile's total, and it grows as
> further chunks load. Clients should either paginate to the end before presenting a total, or label
> what is shown as partial. There is no shortcut field to read, by design.

## Runtime API surface: `type` is derived, never wire

There is **no `createAuthor` method, no `getAuthor` method, and no `type` wire field**. The envelope
key *is* the type: a
loader reads which field is present (`community` vs `authorCommunity`) and surfaces it as a
**runtime-only** instance field — `community.type` (`"community"` or `"authorCommunity"`, mirroring the envelope keys). It never enters the signed record: a wire discriminator would duplicate what key presence
already states (the same argument that settled the envelope over a `type` field). Like every
runtime-only field, it must be accounted for in the corresponding reserved-field list.

Consequences for the method surface:

- **Reading:** `getCommunity` / `communityUpdateSubscribe` and friends stay type-blind; the returned
  instance carries `type` for the client to branch on. There is no `getAuthor`: since `type` is a
  runtime discriminant on the returned union, `community.type === "authorCommunity"` narrows the type
  natively, and a dedicated method would just duplicate the resolution path.
- **Lifecycle:** `startCommunity` / `stopCommunity` / `deleteCommunity` / `list` are type-blind
  (address-keyed); list output includes the derived `type`.
- **Creation** is the one moment with no record to derive from, so the shared `createCommunity` takes
  the discriminating bit as a **local, non-wire creation option** (persisted in the community's local
  settings, from which the node knows which envelope key and schema to emit). The option is
  `createCommunity({ type: "authorCommunity" })`, reusing the same value space as the derived
  runtime-only `community.type` so creation and read use one vocabulary; omitting it defaults to
  `"community"`, keeping every existing call site unchanged.
- **Delegation setup** is its own RPC surface and is type-blind, serving delegated `community` and
  `authorCommunity` alike; shipped in [#237](https://github.com/pkcprotocol/pkc-js/pull/237), not
  here.
- The only genuinely author-specific RPC surface is the sync pair
  (`listAuthorComments` / `syncAuthorComments`).

## Convergence: both feeds under one name

Because an author-community is already a delegated community, the remaining milestone is small: let a
single IPNS name carry **both** payloads at once (`{ authorCommunity, community }`), so one identity is
simultaneously a multi-author community (references *in*) **and** its owner's author feed (references
*out*). The envelope already reserves the both-present slot; lifting the v1 "exactly one field" refine
is the mechanical change. The enduring difference stays semantic (references out vs. in), not
architectural.

## Future good to haves

Additive, backward compatible, and deliberately out of v1:

- **`postUpdates` for large profiles.** A profile whose feed grows large enough that a client holding
  a single native comment CID should not traverse pages to find its `CommentUpdate` can publish the
  same MFS bucket tree a full community publishes (see [Why no `postUpdates`](#why-no-postupdates)).
  The machinery is inherited; v1 simply does not emit the field.
- **Delegating profile moderation** (below).
- **Convergence**: one name carrying both payloads (see [Convergence](#convergence-both-feeds-under-one-name)).

## Future improvement: delegating profile moderation

> **Not in v1, not settled.** Recorded here because the v1 design deliberately leaves the door open.

v1 seeds the role map with the owner alone, but that is a **policy choice, not a missing capability**:
the map itself is carried in the record, and the `CommentModeration` publication type and the
mod-authorization check are inherited untouched. Letting the owner add entries is close to the whole
change, which means a profile owner could grant moderation of their own feed to other authors,
including a **third-party moderation service**.

Sketch of what it would take:

- **Schema: nothing to add.** `AuthorCommunityIpfs` already carries the `roles` map in the same shape
  as `CommunityIpfs` (address to role); v1 just seeds it with one entry. The owner edits it with
  `CommunityEdit`, the publication that already edits profile metadata. No new publication type, no
  schema change.
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
  record). Same `LocalCommunity` machinery, both pubsub topics, challenge processing; what differs is
  the schema and the policy it implies. Publishing is delegated anchor → minter, so a browser author owns a live,
  reply-able profile without handing out their identity key. The old `publishIpnsRecord` / CAR / pin-set
  replicator design is superseded and removed.
- **Delegate boundary.** Mirrors [delegated-ipns.md](delegated-ipns.md): pkc-js does resolution,
  verification, and owner own-key actions (anchor publish, native-comment signing); the minter service
  (out of pkc-js) mints, runs the challenge topic, and keeps the record alive.
- **Record shape.** An **envelope** (`{ authorCommunity? | community? }`), exactly one field in v1,
  resolves read-side dispatch by key presence; no `type` discriminator, `bso-resolver` untouched.
- **EOL length.** Reuse the delegated-IPNS **anchor EOL** constant (effectively infinite), not a new
  value.
- **Cross-post sync.** The RPC pair `listAuthorComments` / `syncAuthorComments`, keyed by
  `{ authorPublicKey, authorName? }` (never address), declarative snapshot, removal by omission,
  list-then-merge-then-sync for multi-device. Entries reuse the `PageIpfs` comment shape
  (`{ comment, commentUpdate }`) with `commentUpdate` **optional**, so the client can seed
  community-signed mod-state the minter may never be able to fetch. No new type.
- **Client-seeded mod-state is safe and monotonic.** A pushed `CommentUpdate` is community-signed, so
  the client cannot forge it; the minter verifies it against the comment's `communityPublicKey`,
  **requires the CID derived from the raw comment bytes to equal `commentUpdate.cid`** (signature
  alone attests the mod-state, not the client's chosen pairing), and stores `max(stored, pushed)` by
  `updatedAt`, which blocks whitewashing a `removed`/`deleted` flag with an older snapshot. Push
  seeds, minter refresh still wins.
- **Feed membership and mod-state are separate axes.** Membership is presence in the sync list alone,
  so dropping a cross-post from the profile works with the foreign community fully dead; deleting the
  comment itself is a `CommentEdit` to that community and does need it reachable. Never hide an entry
  by pushing a `deleted` `CommentUpdate`.
- **Sync authorization.** Private RPC is local-only and trusts its clients; bitsocial forge enforces
  ownership of the author key (auth lives in the forge layer, not the method schema).
- **Owner actions reuse existing publication types.** `Comment`, `CommentEdit`, `CommentModeration`,
  `CommunityEdit`; no new publication kinds. Owner-only top level on the write side is **default
  challenge config**: the built-in `fail` challenge seeded at creation with owner-address and
  non-post publicationType excludes, not a code-level `An` exemption.
- **`AuthorLocalCommunity` is a thin subclass of `LocalCommunity`**, instantiated from the persisted
  local type option. It overrides the schema-facing seams (base record shape, `new` preloaded sort,
  schema/envelope, single-feed page generation, page verification, cross-post storage, default
  challenges, roles seeding) and inherits everything else.
- **A delegated `LocalCommunity` is a prerequisite, not a seam.** Identity (`community.publicKey`)
  must come from the anchor persisted in local settings rather than from the signer; publication
  acceptance must compare `publication.communityPublicKey === community.publicKey`, not
  `=== community.signer.address`; and the publication store must backfill `communityPublicKey` from
  the anchor. Without it every remote publication to a delegated community is rejected. The change is
  type-blind and collapses to current behavior when signer and anchor are the same key.
- **`roles` is kept**, seeded with the owner alone. Inherited authorization returns `false` when
  `community.roles` is undefined, and it gates both `CommentModeration` and `CommunityEdit`, so
  dropping the map would remove two of the four owner actions.
- **The profile keeps the rest of `CommunityIpfs`.** `features` (required, pseudonymity reads it),
  `modQueue` with the pending-approval flow (native content only), `title`, `description`, `rules`,
  `suggested`, `flairs`, and native-only `lastPostCid` / `lastCommentCid`. Default is keep: dropping a
  field only creates a branch in inherited code.
- **The minter embeds cross-posted replies' ancestors** when generating pages, refreshed on a fixed
  interval (host policy, hourly by default in bitsocial-cli) by the same job that refreshes
  cross-posted `CommentUpdate`s. Ancestors are foreign-signed comments carrying no new trust; an
  unverifiable ancestor drops the context, not the entry.
- **`author.isAuthorCommunity`** is the wire hint's name, a signed boolean added as an optional key on
  `AuthorPubsubSchema` itself, backward compatible in both directions through the flexible-author
  parse. Placement needs no hand-edited list: signed-property lists derive from top-level shape keys
  (`author` is one property), and `AuthorReservedFields` is a `difference` against
  `AuthorPubsubSchema.shape`, so the key leaves the reserved set by construction.
- **Naming is settled** across the surface: `listAuthorComments` / `syncAuthorComments`,
  `community.type` with values `"community"` / `"authorCommunity"`, the creation option
  `createCommunity({ type: "authorCommunity" })`, and the read-only-mode publisher error
  `ERR_COMMUNITY_CHALLENGE_EXCHANGE_DISABLED`.
- **The runtime discriminant is `community.type`**, derived from the envelope key, never on the wire.
- **`previousCommentCid` is the last-resort recovery path** for a cross-post list lost on both sides,
  and the only independent check that a minter has not silently dropped feed entries. Not part of the
  sync flow; recorded as the option that exists before designing anything heavier.
- **No `postUpdates`.** The MFS bucket tree exists so a client holding one comment CID can find its
  update without traversing pages, which matters at millions of comments; a profile embeds every
  entry's `CommentUpdate` in its feed pages and is orders of magnitude smaller. Listed under
  [future good to haves](#future-good-to-haves), not designed out.
- **Cross-posts get their own table**, never rows in `comments`: that table's `postCid` / `parentCid`
  foreign keys cannot be satisfied by foreign content, its `commentUpdates` are node-signed, and every
  per-community aggregate counts its rows. One DB handler, additive tables, `DB_VERSION` bump with a
  migration test.
- **Author-community pages need their own verifier**, modeled on the existing mod-queue branch (mixed
  depths, unrelated parents, no shared `postCid`), with per-entry community routing and the owner-only
  invariant in place of the parent-relationship checks.
- **Pseudonymity mode is inherited unchanged** for replies to the profile; cross-posts published
  pseudonymously into a foreign community are alias-signed, so they fail the sync gate by design and
  must not be offered for sync.
- **Anchor EOL is effectively infinite.** The offline owner returns to *change* the binding, never to
  preserve it. This removes the liveness cliff.
- **No anti-rollback on `An → Mn`.** Records are always fetched in parallel from several
  gateways/peers, and the community loader keeps the highest `updatedAt` while refusing anything
  older than what the client already holds, so a rotated-away minter pinned by one malicious gateway
  loses to any honest source. Sequence anti-rollback ([#118](https://github.com/pkcprotocol/pkc-js/issues/118))
  stays general delegated-IPNS hardening, not a prerequisite here.
- **Delegation setup is type-blind and outside this design.** "Run this community for me, I keep the
  anchor key" is a protocol operation belonging in the pkc-js RPC rather than a hosting service, and
  it serves delegated multi-author communities as much as profiles. Shipped separately in
  [#237](https://github.com/pkcprotocol/pkc-js/pull/237); this design assumes only that the author
  obtains `Mn` and signs `An → Mn` with `As`. The forge keeps auth, quotas, and `Ms` custody policy.
- **Minter refresh cadence is host policy, not protocol.** How often a minter re-loads cross-posted
  `CommentUpdate`s (and the ancestor snapshots) is chosen by whoever runs the node: bitsocial-cli and
  other RPC hosts decide it, with hourly as bitsocial-cli's default. pkc-js mandates no interval and
  no reader depends on one.
- **Freshness is minter-side.** The minter refreshes known entries' `CommentUpdate`s from their
  canonical communities and always wins over a pushed snapshot once it fetches something newer;
  discovery of new entries stays client-push only. The client *may* seed mod-state (previous bullet),
  but it never owns freshness.
- **`type` is runtime-only, derived from the envelope key**, with values `"community"` and
  `"authorCommunity"` mirroring those keys. No `createAuthor`, no `getAuthor`, no wire discriminator;
  creation passes the bit as a local non-wire option to the shared create
  (`createCommunity({ type: "authorCommunity" })`, defaulting to `"community"`), and reading narrows
  on the `type` discriminant returned by the type-blind `getCommunity`.
- **Read-only mode.** `settings.disablePubsubChallengeExchange` (private boolean) omits
  `pubsubTopic` from the record and stops the challenge-topic subscription; absence of `pubsubTopic`
  now means "no challenge exchange", with no fallback to the address anywhere. No flag day: all
  published records carry the topic explicitly, and old clients degrade by timeout. The local
  publish shortcut keeps same-process and RPC owners publishing. Shipped in
  [#236](https://github.com/pkcprotocol/pkc-js/pull/236) (issue #229).
- **Owner-only top level is enforced read-side.** Verifiers reject an `AuthorCommunityIpfs` record or
  page chunk containing a top-level entry whose `author.publicKey` differs from the resolved anchor
  `An` (checked at verification time, since the anchor is resolution context and not a record field).
  Node-side write acceptance is only the honest default, not the invariant.
- **Rotation migration reuses `exportCommunity`** (sqlite, type-blind). The DB is portable across
  minters by construction (address = anchor, minter key is node-local config), restore is file-level,
  and no `importCommunity` method is needed: the normal update loop re-signs mod-state under the new
  minter key on regeneration.

## Open questions

- ~~**Delegation setup handshake.**~~ Answered: an author asks a delegate (their own
  `bitsocial daemon`, or bitsocial forge) to become its minter via `createCommunity` with an anchor
  `publicKey`, receives `Mn` plus the bootstrap `pubsubTopic`/`encryption`, gets the client-signed
  `An → Mn` onto the network with `publishAnchorRecord`, and rotates by repeating that against a new
  node. Type-blind, in the pkc-js RPC rather than a hosting service, shipped in
  [#237](https://github.com/pkcprotocol/pkc-js/pull/237). See "Setting delegation up" in
  [delegated-ipns.md](delegated-ipns.md).

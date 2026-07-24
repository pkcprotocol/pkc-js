# Author Communities (profiles as IPNS records)

> **Status: design (issue [#31](https://github.com/pkcprotocol/pkc-js/issues/31)).** Not yet
> implemented. This doc records the agreed design and the open questions.

## Summary

An **author-community** lets an author publish their own profile — display metadata plus a feed
of everything they've posted across the network — as an IPNS record at `author.publicKey`.
`getAuthor(address)` resolves that IPNS name to an `AuthorCommunityIpfs` record the same way
`getCommunity` resolves a community. It is the **degenerate case of a community**: single-author,
no challenge pubsub topic, a single `new`-sorted feed. A full community is an author-community that
also accepts foreign submissions.

Because every comment already carries `author.publicKey` (an IPNS name) and `author.address`, every
existing comment is already a resolvable pointer to its author's profile — no new index is needed.

## Two community types

| | Full community | Author-community |
|---|---|---|
| Class | `LocalCommunity` (+ Remote/RPC variants) | **same machinery, author schema/policy** |
| Pubsub | ipns-over-pubsub record topic **+** challenge/publication topic | ipns-over-pubsub record topic **only** |
| Challenges | yes | no (v1) — others cannot reply |
| Top-level content | native submissions from many authors (`communityPublicKey` = this community) | the owner's own comments made **to other communities** (each entry's `communityPublicKey` = someone else's) |
| Who posts at top level | anyone (challenge-gated) | only the owner |
| Sort types | hot/top/controversial/new, reply trees | single `new` feed |
| Roles/moderation | full role map, moderators | single owner (self) |

**Build implication:** author-community is a **policy/config variant of the community machinery**,
not a separate class tree. This makes the future "profile nodes" milestone (below) nearly free —
it just turns on the challenge topic + challenge processing `LocalCommunity` already has.

> **Precise wording on pubsub.** An author-community *does* have exactly one pubsub topic — the
> IPNS-over-pubsub **record** topic (`/record/<hash>`), which is how the record stays fresh without
> the DHT and what replicating peers subscribe to. What it lacks is the *challenge/publication*
> topic.

## The record: `AuthorCommunityIpfs`

A sibling of `CommunityIpfs`, minus `challenges`, `encryption`, and the multi-`roles` map (owner is
always self), plus profile metadata and a `new`-sorted feed:

- profile metadata: `displayName`, `avatar`, `wallets`, bio/links, ...
- `posts: { pages: { new: <preloaded page> }, pageCids: { new: <cid> } }` — reuses the community
  `posts` structure verbatim.
- `stats`, `updatedAt`, `signature`, `protocolVersion`.

### The envelope

Both record kinds are wrapped in a single top-level envelope (`{ authorCommunity? | community? }`)
so one IPNS name can, in the future, carry either payload (or both):

```ts
type IpnsRecordEnvelope = {
  authorCommunity?: AuthorCommunityIpfs;
  community?: CommunityIpfs;
};
```

**v1 rule: exactly one field is present** (`z.refine` — neither and both are rejected). The
"both present" case is reserved for a future where a single IPNS name is simultaneously a full
multi-author community (references *in*) **and** its owner's author feed (references *out*) — the
two-independent-signed-feeds convergence. We reserve the slot now and disallow it until then.

Why an envelope rather than a `type: "community" | "author"` discriminator on a bare record: the
domain/text-record layer is already unambiguous (one name → one key → one entity; an author and a
community cannot share a domain), so the only thing a domain-first load needs is to know which
*schema* it fetched. The envelope answers that by key presence, reserves the both-at-once future a
flat discriminator can't express, and keeps the write path type-blind (see `publishIpnsRecord`
below). Each payload carries its own `signature`; the reader verifies whichever field is present.

> **Wire-format break (communities).** Wrapping `CommunityIpfs` in `{ community: ... }` moves the
> community's signed fields off the root, so a pre-envelope loader fetching an enveloped record
> fails to parse it. This is a **coordinated flag-day** for live communities, gated on a
> `protocolVersion` bump: loaders and publishers must ship together, and old clients cannot read new
> records until updated. Author-communities are new, so nothing old loads them — they emit envelopes
> from day one. **Do not deploy enveloped community publishers before the envelope-aware loader has
> been released**, or un-updated clients are stranded.

### Feed = preloaded page, embedded, `new` sort

The feed **embeds full comments** (not thin `{cid, communityPublicKey}` pointers), exactly like a
community's inline first page, so a profile renders in **one fetch** instead of N round-trips to N
communities. Each entry embeds the signed `CommentIpfs` **and** the signed `CommentUpdate`. The
author cannot forge either — a reader verifies both signatures — so embedding does not weaken the
trust model; the embedded mod-state is simply a snapshot the reader can refresh.

Posts and replies are mixed in the single `new` feed (like a Reddit user page).

### Two kinds of feed content

1. **Cross-posted** — the author's comments made to *other* communities (`communityPublicKey` =
   someone else's). The canonical copy lives in that community; the embedded `CommentUpdate` is
   **community-signed** and verified against that community.
2. **Native** — posts/replies authored *directly to the author-community itself*
   (`communityPublicKey` = the author-community's own IPNS public key). **The author-community is the
   sole host** — this content lives nowhere else. In v1 only the owner can add native content (no
   challenge); "replies" means the owner replying to their own posts (self-threads).

Both kinds share the single `new` feed and the same `author.publish({comments})` republish path.

### Size cap

The **root object** (profile metadata + inline `new` page + `pageCids` list) is capped at **1 MiB**,
exactly like `LocalCommunity`'s root. The feed is unbounded overall — overflow spills into `pageCids`
chunks — but every fetched object is bounded, so loads stay fast. There is **no** 40 KiB cap here:
that limit is on a *comment's publication bytes*, not on an IPNS-pointed record (the IPNS record
itself only carries the signed name→CID pointer, ~10 KiB spec cap; the `AuthorCommunityIpfs` content
is a normal IPFS DAG with no hard protocol cap).

## Publishing: `author.publish()`

The Author instance's job is **build → sign → publish** only. The **client** (e.g. Seedit) owns
comment-tracking and republish timing; there is no cross-community gather, timer, or submission DB
inside pkc-js.

```ts
author.publish({
  comments: { comment: CommentIpfsType, commentUpdate?: CommentUpdateType }[],  // raw wire fields
  ...extraProps  // profile metadata
})
```

- Clients MUST pass **raw wire fields** (`comment.raw.comment`, `comment.raw.commentUpdate`), **not**
  deconstructed `Comment` instances. A `Comment` instance carries runtime-only fields (`address`,
  `shortAddress`, `state`, clients, ...) that must never enter a signed record — embedding them would
  bloat the record and corrupt read-side signature verification. (A loaded page already exposes this
  shape: `page.comments.map((c) => c.raw)`.)
- `publish()` assembles the `new` page(s) + `pageCids` (reusing the page-generator, ≤ 1 MiB root),
  wraps it in the envelope (`{ authorCommunity }`), signs the payload with the author key, packs the
  blocks into a CAR, and hands the signed record + CAR to a node for replication (below).

### Transport: `publishIpnsRecord` (client-signed, node-replicated)

The author always signs in-browser; a node only **replicates** the already-signed record. This is a
**new RPC model**, distinct from `createCommunity`/`editCommunity` (which are server-owns-key). The
node's job — add the DAG blocks, publish the IPNS name **without re-signing**, park in the
ipns-over-pubsub record topic, and provide to HTTP routers — is **identical regardless of payload**,
so the primitive is deliberately **type-blind**:

```ts
publishIpnsRecord({
  ipnsRecord,  // signed name→CID POINTER only (EOL/seq) — contains no content
  car,         // CAR bytes: every block to seed; the CAR `roots` header = the CIDs to pin
})
```

**Both args are required.** The IPNS record is only a signed `name → CID` pointer; it carries none
of the bytes at that CID. Ship the record alone and the node can announce the pointer but has nothing
in its blockstore to serve when a peer resolves the name — a dead pointer. The **CAR** (Content
Addressable aRchive — a single blob bundling `(CID, bytes)` blocks) carries the content the node
pins, serves, and provides, so the record actually resolves to something.

**Why a CAR, and why the client ships it (never the node fetching).** The client packages every block
it wants seeded — root envelope + every `pageCids` chunk + the target of any referencing field like
`newPropContentCid` — into one CAR, and the node imports it (`dag.import`). The publish path
therefore **never fetches content from the network**, so there is no amplification/DoS surface from
an untrusted caller supplying CIDs, and publish is deterministic (doesn't depend on referenced
content being fetchable at that moment). `fetchCid` stays a **read-side** method only.

**The CAR `roots` header is the pin set.** Because record CIDs are plain JSON strings, not IPLD
`{"/": …}` links, recursively pinning just the envelope root would *not* retain the page chunks or
`newPropContentCid`'s target. So the client lists every CID it wants pinned as a CAR root — envelope
root **+** each page chunk **+** any side CID — and the node pins exactly that set. A new referencing
field needs zero replication-code changes: include its blocks and list it as a root.

**Node validation gates (safe against an untrusted caller):**

1. **Size/count cap** — bounded read of the CAR bytes and a max root count, so a caller cannot exhaust
   memory/storage (the CAR analogue of the 10 KiB IPNS-record cap).
2. **`dag.import` verifies every block** — content-addressing rejects any block whose bytes don't hash
   to its CID, so the CAR cannot smuggle mismatched content (integrity is free).
3. **Root-in-CAR check** — the CID the `ipnsRecord` points to MUST be present in the CAR (else the
   node would publish a dead pointer), and every declared root MUST be present (can't pin blocks that
   weren't shipped).
4. **Author-signed gate** — the node seeds only if the envelope root is validly signed by the key the
   `ipnsRecord` publishes under. A replicator could technically seed anything; this check stops it
   being turned into free storage for arbitrary content under someone else's name.

The node then pins the CAR roots, publishes the IPNS record **without re-signing**, parks in the
record topic, and provides the root (see providing policy below).

The same method serves both consumers unchanged: **Seedit desktop** (electron → private pkc-js RPC)
and **browser → bitsocial forge** (a layer over the private RPC, so it inherits the method for free).
Because the record is self-describing via the envelope, the node never needs to know it is
replicating an author-community versus a community.

> **Replication is a durable server-side job, NOT subscription-scoped.** Unlike
> `communityUpdateSubscribe`/`publishComment` (whose server work dies with the subscription),
> `publishIpnsRecord` must keep rebroadcasting until EOL **even after the client disconnects** — that
> is the whole point (the browser publishes to forge, then closes). The replication commitment is
> persisted and keyed by the record's IPNS name; a subscription-scoped job would tear down the moment
> the tab closes and drop the record straight back into the dark-record hole (see Replication below).

**What the node provides: the root CID only, by default.** A reader resolves the name → root → finds
the root's provider → connects → then **bitswaps any block that provider holds, page chunks included,
by requesting them by CID**. Bitswap fetches by CID from *connected peers* regardless of DAG linkage,
so once the reader has connected via the root's provider record the (pinned) page chunks come with no
provider records of their own — even though they are plain-string CIDs, not IPLD-linked children. Do
**not** loop-provide every page chunk:
announcing N chunks × M profiles is exactly what starved kubo's serial provider and broke community
`updateCids` (browsers got `NoValidAddressesError`). Per-chunk (or side-CID) providing is a **tuning
lever** for a minority path — a reader fetching a *deep* page chunk, or a non-linked side-CID like
`newPropContentCid`, directly (e.g. over a gateway) without first connecting to the root's provider.
A plain-string side-CID isn't reachable by DAG-walk from the root, so if it must be *independently*
fetchable it has to be either linked under the root or given its own provider record. Add per-CID
providing only if production shows reachability actually failing, weighed against the starvation risk.
(The first page is inline in the root, so most reads never fetch a separate chunk.)

**No durable replicator → throw.** If `author.publish()` is called with **both**
`kuboRpcClientsOptions` and pkc-rpc options undefined, it throws
(`ERR_NO_NODE_TO_REPLICATE_AUTHOR_COMMUNITY`). The reason is *no durable replication target*, not
"no transport" — a pure in-browser helia node *could* sign + add + publish, but has no one to keep
the record alive once the tab closes. **v1 consequence:** pure-P2P (libp2p-js-only, e.g. 5chan)
authors cannot publish profiles yet — an intentional scope cut ("you can't publish a profile you
can't keep alive"), with the self-liveness-check safety net (below) as the eventual escape hatch.

### Garbage collection: unpin superseded roots on republish

Every `publishIpnsRecord` for an IPNS name supersedes the previous record. Without cleanup the node
would pin every historical version of every profile forever — unbounded growth. So the node keeps, as
part of its durable per-IPNS-name replication state, the **current pinned root set** for each name,
and on a successful republish it unpins the roots the new record no longer uses.

Ordering and gating matter:

1. **Only on a strictly-newer record.** Run GC only *after* the new record passes every validation
   gate **and** is confirmed newer than the one currently held (IPNS seq / `updatedAt`). A stale or
   rolled-back publish must never cause the node to unpin live content.
2. **Pin-new-before-unpin-old.** Recursive-pin the new CAR roots and publish the new record first,
   *then* unpin `oldRoots ∖ newRoots`. A shared block (e.g. an unchanged avatar or page chunk carried
   across versions) stays continuously pinned — never transiently dropped into a GC window.
3. **Diff, don't unpin-all.** Unpin only the roots absent from the new set; leave `oldRoots ∩ newRoots`
   pinned as-is.
4. **Cross-name safety.** Unpin a root only if **no other tracked IPNS name still lists it** in its
   current set (a cheap membership check against the index). Two profiles referencing the same CID
   (kubo pins are by CID, not refcounted per owner) must not have one's republish yank a block the
   other still needs.

**Unpin ≠ reclaim.** Unpinning only removes the pin; kubo frees the bytes on its own `repo gc`
schedule. Do **not** force `repo gc` per publish — it is expensive and races MFS
(kubo#10842). Space reclamation is the node operator's GC policy; the replicator's job ends at
maintaining correct pins.

### Native content: `author.createComment()`

Because an author-community *is* community machinery and the author's signing key **is** the
community key (`author.publicKey` == the author-community IPNS key), a native comment is just
"publishing to a community you own" with the challenge gate off — a **direct local accept**, no
pubsub round-trip. The author signs both the `CommentIpfs` and the `CommentUpdate` (same key).

```ts
// create + sign a NATIVE comment (post or reply) in the author's own profile
const entry = await author.createComment({ content, title?, parentCid?, signer })
// → returns raw { comment: CommentIpfsType, commentUpdate: CommentUpdateType }
//   communityPublicKey = the author-community's own IPNS public key; both signed by the author key
```

Creation is kept **separate from snapshot-publish** (consistent with client-owned republish
timing): `createComment()` returns the raw entry, the client tracks it alongside cross-posts, and
the next `author.publish({comments})` snapshots the whole `new` feed. This reuses the
owned-community publish path — **not** a parallel signing/storage flow. (Method name TBD:
`createComment` / `publishComment` / `post`.)

Native content is the **seed of the future full-community milestone**: v1 = only the owner adds
native submissions; turning on the challenge topic later lets others reply → a full community.

### Republish triggers (client-driven) and liveness

- **Client open + active** (upvote / post / edit, or EOL approaching) → `author.publish()` → new
  signed record with a **fresh EOL**.
- **Client closed** → a replicating node **rebroadcasts** the last signed record (no key, no
  re-sign) until its EOL, and re-provides it to HTTP routers.
- **Client reopens before EOL** → next `publish()` extends the EOL. If the client stays closed past
  EOL, the profile goes dark until it returns — the accepted tradeoff.

**TTL vs EOL — two different fields.** TTL is a short caching hint (fast update propagation). EOL is
the hard validity: a peer cannot usefully rebroadcast an expired record. EOL must therefore be
**comfortably longer than a typical away-gap** so absences survive; an active client republishes
constantly anyway. **Reuse the delegated-IPNS anchor EOL constant** rather than inventing a new
value: an author-community is non-delegated (the browser is both signer and the thing that goes
offline), which maps exactly onto delegated IPNS's *anchor* record — long EOL, self-re-published
before it lapses, a "liveness cliff" if it expires while away (see
[delegated-ipns.md](delegated-ipns.md)). There is no separate frequently-re-signed *minter* record
because there is no online delegate in v1; when the profile-nodes milestone adds one, the
author-community literally *becomes* a delegated community and the two EOLs unify by construction.
**This is NOT delegated publishing** — the author always signs their own record in-browser;
replicators only keep the *already-signed* record alive.

## Replication (who keeps it alive)

Since browser authors go offline, a node must pin the content DAG, park in the author's
ipns-over-pubsub topic to rebroadcast, and re-provide to HTTP routers (whose announcements expire
~24 h).

**Replication must be pushed at publish time, not scraped later.** A passive "seeder discovers the
author from a comment and fetches their record" model has a fatal bootstrap race: the comment only
gives the seeder the *key to look up*, not the *record*. If the browser already published, closed,
and no one was subscribed to the record topic or providing to a router at that instant, then when the
seeder comes online later and resolves `author.publicKey`, **there is nothing to fetch — the record
went dark before anyone captured it.** So `author.publish()` hands the signed record to a
known-online node (`publishIpnsRecord`) and confirms replication **before** the client considers
itself safe to close. Concretely:

- **Push (bootstrap guarantee).** The configured node — Seedit desktop's local pkc-js node, or
  **bitsocial forge** for browser authors — pins the DAG, publishes the IPNS name, parks in the
  record topic, and provides to routers, as a durable job that outlives the client connection. This
  guarantees ≥ 1 provider exists the instant the author goes offline.
- **Seeder network (ongoing redundancy).** **bitsocial-seeder** and voluntary nodes pick the record
  up from the record topic and re-provide it, so liveness doesn't hinge on a single node until EOL.
  The `hasAuthorCommunity` hint on comments the seeder already sees still drives *discovery* with no
  registration step — it just can no longer be the *only* replication path.
- **Self-run desktop nodes** (Seedit desktop) are their own push target — the local node replicates
  its own profile, so a public RPC push is optional there.

**Milestone note.** Push-at-publish quietly puts an online node in the author's v1 publish path — a
soft early step toward the profile-nodes milestone, for replication only (never re-signing).

## The `hasAuthorCommunity` hint

A signed field on the wire `author` object (`AuthorPubsubSchema`) indicating "this author publishes a
profile, so `author.publicKey` is worth resolving." Consumers treat presence as "try, tolerate
failure," absence as "don't bother." It is per-comment (fixed at publish time), attested by the
author (a third party cannot forge it), and needs a place in the author signed-property list. (Name
TBD — `hasAuthorCommunity` / `publishesProfile`.)

## Read-side verification: three feed states

Display source of truth is the author's self-signed feed; the community's copy is the canonical
moderated one; **both remain accessible**. Per entry, verifying the embedded `CommentIpfs` +
`CommentUpdate` and (optionally) re-fetching the live `CommentUpdate` yields three renderable states:

1. **Live** — `CommentIpfs` signature valid + `CommentUpdate` loads clean → show normally.
2. **Removed** — `CommentUpdate` loads with `removed`/`deleted` set → show as moderated.
3. **Unknown** — `CommentUpdate` won't load at all → possibly purged, **or** the community is just
   offline/unseeded right now. Do **not** collapse this to "purged"; render as *unverified*.
   (Applies to **cross-posted** entries only — a **native** entry's sole host is the author-community
   itself, so it is live iff present in the feed; "removed" just means the owner deleted it.)

**Karma** is computed from state 1 (and maybe 2) only — never from raw self-attested entries — so a
profile cannot inflate its own karma, while a transient community outage doesn't silently delete
history.

## Future milestone: profile nodes (delegated author-communities)

Later, an author will be able to delegate publishing to a service that runs a challenge topic, so
others can reply under the author's posts. At that point an author-community becomes, mechanically, a
**delegated community with a different schema** (see [delegated-ipns.md](delegated-ipns.md), anchor →
minter). The enduring difference is semantic, not architectural: its top-level content is the owner's
own cross-network comments (references out), while it may also host native replies (references in).
This convergence is exactly why author-community is built as a community variant from day one.

## Settled

- **Record shape (was Q6).** An **envelope** (`{ authorCommunity? | community? }`), exactly one field
  in v1, resolves read-side dispatch by key presence — no `type` discriminator needed. The
  domain/text-record layer is already unambiguous (one name → one key → one entity), so `bso-resolver`
  is untouched. See [The envelope](#the-envelope--authorcommunity--community).
- **EOL length.** Reuse the delegated-IPNS **anchor EOL** constant (see the TTL-vs-EOL note), not a
  new value.
- **Publish transport.** `publishIpnsRecord` (type-blind, client-signed / node-replicated), pushed
  at publish time; throw when no durable replicator is configured.

## Open questions

- **`hasAuthorCommunity` field name** and its exact place in the author signed-property list.
- **Self-liveness-check (pure-P2P escape hatch).** For a future where libp2p-js-only authors can
  publish, the client would verify "is anyone providing my record?" (query routers / the record
  topic) before going dark, and keep republishing if not — the safety net that lets us relax the
  no-durable-replicator throw. Out of scope for v1.

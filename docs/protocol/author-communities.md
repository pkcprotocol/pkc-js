# Author Communities (profiles as delegated communities)

> **Status: design (issue [#31](https://github.com/pkcprotocol/pkc-js/issues/31)).** Not yet
> implemented. This doc records the agreed design and the open questions.

## Summary

An **author-community** lets an author publish their own profile: display metadata plus a feed of
everything they've posted across the network, resolvable as an IPNS record at `author.publicKey`.
`getAuthor(address)` resolves that name to an `AuthorCommunityIpfs` record the same way `getCommunity`
resolves a community.

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
| Class | `LocalCommunity` (+ Remote/RPC variants) | same machinery, author schema/policy |
| Record schema | `CommunityIpfs` | `AuthorCommunityIpfs` (profile metadata + `new` feed) |
| Pubsub | record topic **+** challenge/publication topic | **same:** record topic **+** challenge/publication topic |
| Challenges | yes | yes (others can reply to the owner's posts) |
| Top-level content | native submissions from many authors (`communityPublicKey` = this community) | the owner's own comments made **to other communities** (references out) + native posts to the profile |
| Who posts at top level | anyone (challenge-gated) | **only the owner** (a profile feed is the owner's, not open submission) |
| Replies | anyone (challenge-gated) | anyone (challenge-gated) |
| Sort types | hot/top/controversial/new, reply trees | single `new` feed, reply trees |
| Roles/moderation | full role map, moderators | single owner (self) |
| Publishing | delegated community (anchor → minter) | **same:** delegated community (anchor → minter) |

**Build implication:** an author-community is a **schema/policy variant of the community machinery**,
not a separate class tree, and it is a **delegated community**, not a special replication path. The
two enduring differences are semantic, not architectural: an author-community's top-level content is
the owner's own cross-network comments (references out), and only the owner may post at top level. The
future "converged" milestone (a single name that is *both* a multi-author community and its owner's
author feed) is then nearly free (see [Convergence](#convergence-both-feeds-under-one-name)).

## The record: `AuthorCommunityIpfs`

A sibling of `CommunityIpfs`. It **keeps** the fields that make it a working, reply-able community and
differs only where the profile semantics require it:

- **Kept, because it runs the challenge topic:** `challenges` (the public challenge requirements a
  replying author reads), `encryption` (the key a replying author encrypts their publication with; here
  it is the **delegate/minter's** key, since the minter runs the challenge/publication topic), and
  `pubsubTopic`. Others reply to the owner's posts through exactly this machinery, so omitting these
  would break replies.
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
  hand it to the delegate (see [Native content](#native-content-authorcreatecomment)).

**Out of pkc-js (the delegate / profile-node service):**

- Hold `Ms`, mint `Mn → <envelope cid>` frequently, run the challenge/publication topic, fold in
  foreign replies, sign the profile record and native mod-state, pin/serve/provide the DAG, and keep
  the record alive after the author goes offline. This is ordinary delegated-community publishing, which
  pkc-js deliberately does not implement.

> **Delegation setup handshake.** To point `An → Mn` the author needs the delegate's minter name `Mn`.
> The delegate generates `Mn`/`Ms` and returns `Mn`; the author then signs `An → Mn` client-side. The
> handshake surface (how the browser asks bitsocial forge to become its minter) lives in the forge, not
> pkc-js. See [open questions](#open-questions).

**No delegate configured → no profile.** Publishing a profile requires a reachable minter. A pure
in-browser helia node can sign the anchor but has no online party to mint and keep the record alive.
**v1 consequence:** pure-P2P (libp2p-js-only, e.g. 5chan) authors cannot publish profiles until they
point their anchor at some minter service. This is the same offline-owner constraint that delegated
communities already carry, not a bespoke author-community limitation.

### Native content: `author.createComment()`

Posting to your own profile is "publishing to a community you own," with the owner exempt from the
challenge gate. The owner signs the `CommentIpfs` with their identity key (client-side), and the
delegate folds it into the record and signs the resulting mod-state (`CommentUpdate`) with the minter
key, exactly as a community node signs mod-state for any submission.

```ts
// create + sign a NATIVE comment (post or reply) in the author's own profile
const entry = await author.createComment({ content, title?, parentCid?, signer })
// → author-signed CommentIpfs; communityPublicKey = the author-community's own anchor public key.
//   The delegate mints it into the feed and signs the CommentUpdate with Mn.
```

Creation is kept **separate from the minter's snapshot** (consistent with client-owned timing):
`createComment()` produces the signed entry and hands it to the delegate, which snapshots it into the
`new` feed on its next mint. Foreign authors **replying** to a native post go through the normal
challenge/publication topic the delegate runs; the delegate challenge-gates, accepts, and folds them
in like any community. (Method name TBD: `createComment` / `publishComment` / `post`.)

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

## Convergence: both feeds under one name

Because an author-community is already a delegated community, the remaining milestone is small: let a
single IPNS name carry **both** payloads at once (`{ authorCommunity, community }`), so one identity is
simultaneously a multi-author community (references *in*) **and** its owner's author feed (references
*out*). The envelope already reserves the both-present slot; lifting the v1 "exactly one field" refine
is the mechanical change. The enduring difference stays semantic (references out vs. in), not
architectural.

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

## Open questions

- **`hasAuthorCommunity` field name** and its exact place in the author signed-property list.
- **Delegation setup handshake.** How a browser author asks bitsocial forge (or another service) to
  become its minter and obtains `Mn`, and how the author later rotates `An → Mn'` to revoke. Mostly a
  forge concern, but pkc-js needs the client-side anchor sign/publish + rotate primitives.
- **Self-liveness-check (pure-P2P escape hatch).** For a future where libp2p-js-only authors can run
  their own minter, the client would verify "is anyone providing my record?" (query routers / the
  record topic) before going dark, and keep republishing if not. Out of scope for v1.
- **Anti-rollback on `An → Mn`.** Inherited from delegated IPNS: no sequence anti-rollback on the
  binding yet (tracked in #118); relevant here since a rotated-away minter could be pinned by a
  malicious gateway.

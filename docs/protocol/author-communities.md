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
- `type` discriminator (`"community" | "author"`) — **open question**, see below.
- `stats`, `updatedAt`, `signature`, `protocolVersion`.

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
  signs `AuthorCommunityIpfs` with the author key, and publishes the IPNS record at
  `author.publicKey` with a fresh EOL.

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
**comfortably longer than a typical away-gap** (e.g. ~30 days) so absences survive; an active client
republishes constantly anyway. **This is NOT delegated publishing** — the author always signs their
own record in-browser; replicators only keep the *already-signed* record alive.

## Replication (who keeps it alive)

Since browser authors go offline, a node must pin the content DAG, park in the author's
ipns-over-pubsub topic to rebroadcast, and re-provide to HTTP routers (whose announcements expire
~24 h). For now:

- **bitsocial-seeder** (and potentially `bitsocialforge.com`) auto-replicate. The seeder already
  sees every comment in the communities it seeds, and each comment carries `author.publicKey` + the
  `hasAuthorCommunity` hint — so it can replicate flagged authors with **no registration step**.
- **Self-run desktop nodes** (5chan, Seedit desktop) republish their own IPNS records.

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

## Open questions

- **EOL length** — exact value (leaning ~30 days).
- **`type` discriminator + domain typing (Q6)** — a domain-first load (no `hasAuthorCommunity` hint)
  needs to know whether it fetched a community or an author record; whether a single `type` field
  also settles the author/community domain-collision rule is undecided. Via `bso-resolver` a name can
  currently be either a full community or an author-community.
- **`hasAuthorCommunity` field name** and its exact place in the author signed-property list.

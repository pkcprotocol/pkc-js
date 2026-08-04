# Crossposts

How a comment reposts another comment. Issue [#32](https://github.com/pkcprotocol/pkc-js/issues/32).

## Shape

```ts
// on CreateCommentOptionsSchema, and therefore on CommentPubsubMessage and CommentIpfs
crosspost?: {
    cid: string; // CID of the embedded record
    comment: CommentIpfs; // the full record, verbatim
}
```

`crosspost` is author-signed. It is derived into `CommentSignedPropertyNames` from
`CreateCommentOptionsSchema.shape` automatically, and the reserved-field lists are `difference`
computations against the same shape, so there is no hand-maintained list to update.

A crossposting comment may be a **post or a reply**. This differs from `quotedCids`, which is
replies-only.

## Why the full record and not a link

A link (`comment.link = "pkc://community/<cid>"`) would force mods to fetch the CID before they
could moderate it. Embedding makes the crossposted text permanent and independently moderatable by
the crossposting community: if the original author edits or deletes it, or the original community
disappears, the crossposted copy still carries the text, author-signed, in this community's records.

## Why no embedded CommentUpdate

`crosspost` lives inside a `CommentIpfs`, which is immutable and content-addressed, so anything
embedded there is frozen forever. `CommentUpdate` is mutable state (score, mod flags, edits), so
embedding it would bake a snapshot into a record that can never be refreshed. Clients load it on
demand instead.

## Two tiers of trust

The embedded record is only *partly* author-signed. `CommentSignedPropertyNames` covers the
`CreateCommentOptionsSchema` subset; `CommentIpfsSchema` extends it with fields the hosting community
added and the author never signed: `depth`, `thumbnailUrl`, `thumbnailUrlWidth`,
`thumbnailUrlHeight`, `previousCid`, `pseudonymityMode`. Checking `cid` against the bytes does not
help on its own, since whoever builds the crosspost picks both and can make them agree.

### Tier 1 — local, no network

Implemented in `_verifyCrosspost` in `src/signer/signatures.ts`, called from
`verifyCommentPubsubMessage`. That single call site covers both the community's acceptance path and
every client fetch path, since `verifyCommentIpfs` delegates to it.

1. `CID(deterministicStringify(crosspost.comment)) === crosspost.cid`
2. the embedded record's author signature verifies
3. the embedded record contains no reserved/runtime fields
4. a nested `crosspost` the embedded record did not sign is verified from the raw record, so a chain
   cannot opt out of its own checks. See below.

This proves who wrote the content, and that they *claim* it was posted to the community named in the
embedded record. It proves nothing about the unsigned extras, or about that community having
accepted it.

The embedded record is deliberately **not** run through `verifyCommentIpfs`: that compares the
record's community against the instance's, and the embedded record belongs to a different community
by construction.

#### Why check 4 exists: a chain must not choose whether it is verified

Checks 1 to 3 only exist for a given record if the recursion reached it, and until check 4 the
recursion was implicit: `_verifyCrosspost` delegates to `verifyCommentPubsubMessage`, which descends
on `comment.crosspost`, and it was handed a record already narrowed by
`pick(comment, ["signature", ...signedPropertyNames])`.

`signedPropertyNames` lives inside `signature`, which is not part of the signed bytes, so a record
chooses it freely. Nothing exotic is needed: `_signJson` derives the list from the fields actually
present, so a post signed with no crosspost simply has no `crosspost` entry, and attaching one
afterwards leaves the signature valid. The pick then hid that nested record from the recursion, and
an arbitrary subtree rode along with none of the three checks applied — a nested `cid` that lies
about its own bytes (so a tier-2 fetch attests to content that community never saw) and reserved
runtime fields the checks exist to reject.

Check 4 reads `crosspost.comment.crosspost` off the raw record instead, so every level is checked
regardless of what the level above signed. It is guarded on the signed case having already
descended, otherwise a chain would be walked twice per level.

Note this means verified does not imply signed for a nested crosspost. That is deliberate and safe:
shrinking `signedPropertyNames` invalidates the signature of any record the attacker did not sign
themselves, so a record reaching check 4 was always fabricated by the attacker anyway.

The cause is not crosspost-specific. Every path that picks by `signedPropertyNames` verifies a
subset of what it renders, and it does not bite elsewhere only because community acceptance runs
`_allFieldsOfRecordInSignedPropertyNames` on the un-picked record. A client verifying a cid it did
not get from a community-signed page or `CommentUpdate` has no such backstop. Tracked in #249.

### Tier 2 — one fetch

Load the `CommentUpdate` for `crosspost.cid` from the community named in the embedded record and
verify its signature. `cid` is inside `CommentUpdateSignedPropertyNames`, so the update cannot be
re-pointed at other bytes. Because the CID hashes the entire record, a valid update is that
community attesting to **exactly these bytes**, unsigned extras included.

There is no tier-2 helper in pkc-js and none is needed — build an instance from the embedded record
and update it:

```ts
const original = await pkc.createComment({
    cid: comment.crosspost.cid,
    raw: { comment: comment.crosspost.comment }
});
await original.update();
```

### Client rules that follow

- Do not render `thumbnailUrl*` from an embedded crosspost at tier 1. It is attacker-chosen until
  tier 2.
- Do not present "crossposted from C" as fact at tier 1. It is an author claim until tier 2.
- Do not present the embedded record's **author** as fact either. See below.
- Karma and deletion/removal state require tier 2 by definition.

#### TODO: the embedded record's author never gets `nameResolved`

`crosspost` is inert data on the instance: `comment.ts` assigns it through and nothing else reads
it. `_resolveAuthorNamesInBackground` collects the comment's own author and its reply-page authors,
never `crosspost.comment.author`, so `crosspost.comment.author.nameResolved` is always `undefined`.

Tier 1 does not cover the gap. `address` is derived as `name || publicKey`, so an author name is
only a claim until it resolves: anyone can generate a keypair, set `author.name` to someone else's
domain, and sign a record that verifies cleanly. What normally catches that is domain resolution
setting `nameResolved: false`, and it does not run here.

So a client rendering "originally by `<name>`" from an embedded record has **no signal at all**,
even after tier 1 passes.

Planned, not implemented. When it lands, `nameResolved` stays a **runtime** field exactly as it is
today: derived locally, never on the wire, and in the reserved-field lists so an incoming record
carrying it is rejected. See `docs/protocol/wire-vs-runtime.md`.

## Host community acceptance

The community running the challenge exchange enforces **tier 1 only**. It does not fetch the
referenced community at acceptance time, so publication acceptance never depends on a third party's
uptime.

`features.noCrossposts` rejects the publication outright with
`ERR_NOT_ALLOWED_TO_PUBLISH_CROSSPOSTS`. It is an **inbound** rule: it governs what this community
accepts, not what other communities may do with this community's comments.

Crossposting a comment that belongs to the host community itself **is allowed**. It is not treated
as a community mismatch.

## Chains

Crossposting a crosspost nests records, and verification recurses through every level. There is
deliberately **no depth cap**: the 40kb publication limit bounds what can be published, and each
level of nesting eats the budget for the next, so long chains simply cannot be published.

## The embedded record must never be normalized

`crosspost.cid` hashes the entire embedded record, so any normalization of it breaks the crosspost.
Zod's strip behavior is per-schema, which is why `crosspost.comment` is declared `.loose()` in
`src/publications/comment/schema.ts`. Leaving it at zod's default would let the
`CommentIpfsSchema.strip().parse()` in `storePublication` silently delete author-signed extra props
from the embedded record, changing the CID that `deriveCommentIpfsFromCommentTableRow` reconstructs,
breaking page generation, and getting the comment purged by the post-migration signature sweep.

The community stores the field in a single `crosspost` JSON column on the comments table so the
embedded record round-trips verbatim.

## The recursive schema

`crosspost.comment` is a `CommentIpfs`, and `CommentIpfs` is derived from
`CreateCommentOptionsSchema`, so the schema is self-recursive. TypeScript cannot infer this: a plain
`z.lazy` getter collapses `CommentSignedPropertyNames`, the pick key record, and `CommentIpfsSchema`
itself to `any`. This is why it differs from the `z.lazy`-only idiom used by `CommentUpdate.replies`,
whose cycle runs through the pages schema rather than through the shape the pubsub schema is
`pick()`ed from.

The cycle is severed by annotating `CrosspostSchema` with an explicit `z.ZodType`, backed by a
hand-written `Crosspost` interface that refers to `Omit<CommentIpfsType, "crosspost">`. A structural
assertion at the bottom of the schema file fails at compile time if the interface and the schema
ever drift.

Both generic parameters of `z.ZodType` must be pinned (`z.ZodType<Crosspost, Crosspost>`): zod 4
defaults the `Input` parameter to `unknown` where zod 3 defaulted it to `Output`, and leaving it
inferred makes `z.input` of any schema containing a crosspost degrade to `unknown`, which breaks the
`z.input`/`z.infer` equivalence the RPC parse helpers rely on.

## Relationship to `quotedCids`

Both are author-signed references and they are not interchangeable.

| | `quotedCids` | `crosspost` |
|---|---|---|
| Meaning | "my text refers to these comments" | "this post **is** a repost of that comment" |
| Count | zero or many | exactly one |
| Storage | reference only | full record embedded |
| Placement | replies only | posts and replies |
| Identity | does not change what the post is | it is the post's identity |

## Back-references are not tracked

The pointer goes one way only. A crossposting comment embeds the original, so from a crosspost you
can always reach the comment it reposts. Nothing points the other way: the original comment has no
record of having been crossposted. It was published before the crosspost existed, and it is an
immutable `CommentIpfs`, so it can never gain one.

This means the reverse view some UIs show, "crossposted to a, b, c" rendered on the *original*
post, cannot be answered. Producing that list means finding every crosspost whose `crosspost.cid`
is the original, and there is no global index of communities to search. Enumerating every community
that exists is not possible.

Two workarounds exist, and neither is implemented:

- **Restrict to subscribed communities.** Scan the feeds the client already loads for crossposts
  referencing the comment. Cheap, but the answer is really "crossposted to communities *you*
  follow", so two users see different lists for the same post and crossposts into communities you
  do not follow are invisible.
- **Publish a reply to the original.** When crossposting, also publish a reply under the original
  pointing at the new crosspost, so the back-reference lives in a reply tree clients already load.
  This depends on the original community accepting that reply: you have to pass its challenge, you
  may be banned there, its mods can remove the reply, and the community may be offline or gone. It
  also adds a machine-generated reply to every popular thread.

Knowing who crossposted a comment and where is not important for now, so neither is planned. This
costs nothing at the record level: a crosspost carries the same data either way, and a back-
reference scheme could be added later without changing the wire format, since a reply carrying a
CID is expressible today with `quotedCids`.

What clients *can* render today is the forward direction, on the crosspost itself: "this is a
repost of X", with the embedded record available offline and verifiable at tier 1.

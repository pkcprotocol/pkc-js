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
2. the embedded record contains no reserved/runtime fields
3. every signable field the embedded record carries is in its `signature.signedPropertyNames`, so a
   chain cannot opt out of its own checks. See below.
4. the embedded record's author signature verifies, recursing into a nested crosspost

This proves who wrote the content, and that they *claim* it was posted to the community named in the
embedded record. It proves nothing about the unsigned extras, or about that community having
accepted it.

The embedded record is deliberately **not** run through `verifyCommentIpfs`: that compares the
record's community against the instance's, and the embedded record belongs to a different community
by construction.

#### Why check 3 exists: a record must not choose which of its fields are verified

`signedPropertyNames` lives inside `signature`, which is not part of the signed bytes, so a record
chooses it freely. Nothing exotic is needed: `_signJson` derives the list from the fields actually
present, so a post signed with no crosspost simply has no `crosspost` entry, and attaching one
afterwards leaves the signature valid. Check 4 then narrows the record to
`pick(comment, ["signature", ...signedPropertyNames])` before descending, which would hide the
attached subtree from the recursion entirely: an arbitrary nested record would ride along with none
of the checks applied — a nested `cid` free to lie about its own bytes (so a tier-2 fetch attests to
content that community never saw) and reserved runtime fields the checks exist to reject — while
remaining in what gets stored and rendered.

Check 3 rejects such a record outright, and for every signable field, not just `crosspost`: a field
in `CommentSignedPropertyNames` present on the raw record but absent from `signedPropertyNames`
fails verification (`_isThereUnsignedSignableFieldInRecord` in `src/signer/signatures.ts`).
Verified therefore implies signed at every chain level. The guard is deliberately restricted to the
signable set: community-generated fields (`depth`, `thumbnailUrl*`, `previousCid`,
`pseudonymityMode`) are legitimately unsigned, and unknown author-signed extra props from future
protocol versions must keep surviving loads.

The cause was never crosspost-specific. Every path that picks by `signedPropertyNames` verifies a
subset of what it renders. Community acceptance was always covered, since it runs
`_allFieldsOfRecordInSignedPropertyNames` on the un-picked pubsub record; the signable-field guard
now also runs in `verifyCommentIpfs` on the raw record before its pick, covering a client that
verifies a cid it did not get from a community-signed page or `CommentUpdate`. This closed #249,
and is also why, for example, a `communityName` attached to an already-signed record no longer
verifies: re-labeling a comment as belonging to a different community requires re-signing it.

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

#### The embedded record's author: `crosspost.comment.author.nameResolved`

Tier 1 proves who **signed** the embedded record, not who they are. `address` is derived as
`name || publicKey`, so an author name is only a claim: anyone can generate a keypair, set
`author.name` to somebody else's domain, and sign a record that passes all three checks. What
catches that is domain resolution, which sets `nameResolved`.

```ts
comment.crosspost.comment.author.nameResolved;
```

| value | meaning |
|---|---|
| `true` | the name's TXT record points at the key that signed the embedded record |
| `false` | it points at somebody else. Do not render the name as an identity |
| `undefined` | not resolved yet, no resolver in this instance for that TLD, or the author has no name. **Not** a verdict |

`nameResolved` says nothing about whether the referenced community ever accepted the comment. That
is still tier 2.

**`comment.crosspost` is a copy, `comment.raw.comment.crosspost` is the wire record.** `crosspost.cid`
hashes the embedded record whole, so writing a runtime field into the wire object would stop it
reproducing its own cid, break page generation and get the comment purged by the signature sweep.
The copy is one shallow copy per chain level plus a copy of each level's author; everything below an
author is shared by reference. `nameResolved` is the only field written into it.

Passing the copy back to `createComment` is the normal way to re-crosspost something you just read,
and it round trips: the publish path strips `nameResolved` at every level before signing, and a
record that arrives on the wire still carrying it is rejected by check 2 (reserved fields).

**Only the first chain level triggers a resolution.** A chain is attacker-controlled in both depth
and content, so walking all of it would turn one fetched comment into an unbounded number of name
resolutions. Deeper levels, and crossposting comments inside a page, still pick up a verdict already
in `nameResolvedCache`, they just do not get one triggered on their behalf.

RPC clients receive the verdict through the `runtimeFields` transport rather than resolving locally,
since they usually have no `nameResolvers` configured and would wrongly conclude `false`.

See `docs/protocol/wire-vs-runtime.md` and issue #251.

#### A crosspost is payload on its own (bare crossposts)

A comment whose only payload is the crosspost is valid, as a post or a reply. This is the
twitter-style "retweet": repost with nothing added. Issue #254.

The `link || content || title` refinement accepts `crosspost` as a fourth payload kind, in all four
places it appears: `CreateCommentOptionsWithRefinementSchema` (user input),
`CommentPubsubMessageWithFlexibleAuthorRefinementSchema` (the community's parse of
`request.comment`, so acceptance too), `CommentPubsubMessageWithRefinementSchema` and
`CommentIpfsWithRefinmentSchema`. A comment with none of the four is still refused with
`ERR_COMMENT_HAS_NO_CONTENT_LINK_TITLE`.

Clients rendering a bare crosspost have only the embedded record to show, so the tier rules above
apply with no dilution: at tier 1 the embedded title/content are author-signed and safe to render,
the unsigned extras and the claimed origin community are not.

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

# Author communities

An **author community** is an ordinary community addressed by an author's identity key, configured so
that only its owner can post, and fed by the owner crossposting their own comments into it. Informally,
a profile. Issue [#31](https://github.com/pkcprotocol/pkc-js/issues/31).

There is no `AuthorCommunityIpfs`, no envelope, no `community.type`, no `AuthorLocalCommunity`, no
dedicated page verifier and no author-specific RPC. **An author community is a configuration, not a
type**, so `getCommunity`, the schema, page verification, moderation, pseudonymity, export and the
whole lifecycle apply unchanged. This document covers only what is different.

## What is different

Three things, none of which is a new mechanism:

1. **The address is the author's identity key.** The community is published delegated, anchor to
   minter, where the anchor `An` is the same key the author signs comments with. See
   [delegated-ipns.md](delegated-ipns.md) for the chain, the setup calls and rotation.
2. **Only the owner may post.** Enforced by disabling the pubsub challenge exchange, backed by
   challenge configuration, not by a feature flag. See below.
3. **The feed is the owner's crossposts.** Ordinary comments carrying `comment.crosspost`, published
   by the owner's own client. See [crossposts.md](crossposts.md).

## Only the owner may post

The default profile is **feed-only**: `settings.disablePubsubChallengeExchange` is set, so the pubsub
challenge exchange is off and the remote publishing path does not exist. The record omits
`pubsubTopic`, the node never subscribes to the exchange topic, and a remote publisher fails fast with
`ERR_COMMUNITY_CHALLENGE_EXCHANGE_DISABLED` before anything reaches the community. The owner publishes
over RPC to the node running the community, the one path that remains, see "How the owner publishes".

A `fail` challenge excluding the owner alone backs the setting up, because the remaining path is a
real one: the local shortcut only suppresses the pubsub echo and the challenge pipeline still runs. On
a multi-tenant minter the challenge is what rejects the other tenants, and if the exchange is ever
re-enabled the configuration fails closed rather than open.

The whole profile is one `createCommunity` call:

```js
const profile = await pkc.createCommunity({
    anchor: { publicKey: An },           // the author's identity key, see delegated-ipns.md
    roles: {
        [An]: { role: "owner" }          // createCommunity never adds this itself, see "The roles key" below
    },
    suggested: { uiType: "author" },     // declares the profile to UIs, see "Declaring the profile to UIs"
    settings: {
        disablePubsubChallengeExchange: true, // feed-only: nobody can publish over pubsub
        challenges: [
            {
                name: "fail",
                options: { error: "Only the owner can post to this profile." },
                publicOptions: ["error"], // publish the rejection text, see "What a reader can actually tell"
                exclude: [{ roles: ["owner"] }]
            }
        ],
        pages: {
            posts: [{ name: "new", preloaded: true }], // the only sort a profile feed needs, see "Page sorts"
            replies: []                                 // feed-only: no reply pages
        }
    }
})
```

Then publish the anchor record and start the community, as in [delegated-ipns.md](delegated-ipns.md).

**What `disablePubsubChallengeExchange: true` costs.** Nobody but the owner can publish anything to
the profile: no replies, no votes. That includes replies to the crossposts the feed is made of, so a
reader who wants to discuss a crossposted comment has to do it at the origin community, where it was
first published. That discussion is unaffected, but it is not mirrored into the profile, see
"The profile as a backup". A profile that should take replies is the reply-able flavor below.

**Converting an existing community.** The same configuration can be applied with `edit()` to a
community that was created with `anchor`; an ordinary community cannot be re-keyed onto the author's
identity afterwards. `settings` and `suggested` are replaced wholesale on edit, so spread what is
already there, or the edit silently drops everything it does not repeat, `settings.pages` included.
`roles` is a patch, so it needs no spread:

```js
await community.edit({
    roles: { [An]: { role: "owner" } },
    suggested: { ...community.suggested, uiType: "author" },
    settings: {
        ...community.settings,
        disablePubsubChallengeExchange: true,
        challenges: [/* the fail challenge above */],
        pages: { posts: [{ name: "new", preloaded: true }], replies: [] }
    }
})
```

### The reply-able flavor

To let strangers reply, leave the exchange enabled, add a reply sort, and make the challenge
configuration carry the whole restriction. Replies take both settings, and either one alone is not
enough: with the exchange enabled and `replies: []`, a stranger's reply is accepted and counted but
listed in no page, and with a reply sort but the exchange disabled, nobody but the owner can reply.

The built-in `fail` challenge exists to be paired with `exclude`: it always fails, so the only way
past it is to be excluded. Two challenges express "the owner posts, anyone may reply". In the
`createCommunity` call above, drop `disablePubsubChallengeExchange` (unset means enabled) and
replace `challenges` and `pages`:

```js
const profile = await pkc.createCommunity({
    anchor: { publicKey: An },
    roles: {
        [An]: { role: "owner" }
    },
    suggested: { uiType: "author" },
    settings: {
        pages: {
            posts: [{ name: "new", preloaded: true }],
            replies: [{ name: "new", preloaded: true }] // one reply sort, see "Page sorts"
        },
        challenges: [
            {
                name: "fail",
                options: { error: "Only the owner can post to this profile." },
                publicOptions: ["error"],
                exclude: [
                    { roles: ["owner"] },
                    // no `vote`: votes stay rejected in this flavor too, see below
                    { publicationType: { reply: true, commentEdit: true, commentModeration: true, communityEdit: true } }
                ]
            },
            {
                name: "question",
                options: { question: "...", answer: "..." },
                exclude: [{ roles: ["owner"] }]
            }
        ]
    }
})
```

How it resolves, given that an `exclude` array matches if **any** item matches, and an item matches
only if **all** of its conditions hold:

| publisher and type | challenge 0 (`fail`) | challenge 1 (`question`) | result |
|---|---|---|---|
| owner, post | excluded by `role` | excluded by `role` | accepted, unchallenged |
| owner, reply | excluded by either rule | excluded by `role` | accepted, unchallenged |
| stranger, post | matches neither rule, so it runs and fails | dropped | **rejected** |
| stranger, reply | excluded by `publicationType` | runs | challenged normally |
| stranger, vote | matches neither rule, so it runs and fails | dropped | **rejected** |

A failing challenge drops any challenge still pending, so the rejected stranger is never asked the
question: they get one immediate failed verification rather than a challenge round trip.

**Votes stay rejected.** In the feed-only default nobody can send one in the first place; in this
flavor `vote` is deliberately absent from the `publicationType` exclude, so a stranger's vote hits the
`fail` challenge exactly like a stranger's post, while the owner's own votes stay excluded by `role`.
The reason is the karma model in [crossposts.md](crossposts.md): karma over a profile is read at
tier 2 from each entry's origin community, so a vote published to the profile lands on the crosspost
copy, is tallied by the owner's own delegate, and counts toward nothing a client should trust. It
would only accumulate a misleading second score on the copy, and it does not drive ranking either,
since `new` is the only sort a profile feed has a reason to serve. A profile that wants vote-driven
reply sorting can opt back in by adding `vote: true` to the exclude.

Set the `error` option, in either flavor. It is what the rejected publisher actually sees: a `fail`
challenge reports through `challengeErrors`, not through the verification `reason`, and its default
text is the generic `"You're not allowed to publish."`. Naming it in `publicOptions` publishes that
sentence in the record too, which is worth doing here: a reader then sees the intent without
publishing anything. It is still a hint rather than an attestation, for the reason below.

### What a reader can actually tell

The feed-only default is legible through an absence: a record with no `pubsubTopic` tells a reader
the challenge exchange is off, so no publisher can even open one, and honest clients fail fast rather
than try. That is the strongest owner-only signal a profile can carry, because there is no challenge
whose passability is left to guess at. The rest of this section is about the reply-able flavor, where
the restriction lives in the challenge configuration and legibility gets subtler.

`exclude` is copied verbatim from the private `settings.challenges` into the public signed `challenges`
array, while `path` and `name` are stripped. `options` are private by default and leave only by name:
the owner lists individual option names in `settings.challenges[i].publicOptions`, and those, and only
those, are published as `challenges[i].publicOptions` (see
[challenge-settings.md](challenge-settings.md)). Be precise about what that does and does not give a
client, because it is easy to overclaim:

**Legible**: which publishers are exempt from which challenge, and the `roles` map the exemption is
matched against. A reader can see that the owner and every non-post publication skip challenge 0, and
that nobody else does.

**Not legible**: whether challenge 0 can be passed at all. `name` and `options` are exactly what
distinguish `fail` from, say, `question`, and neither is published, so a community that gates non-owner
posts behind an answerable challenge publishes the same exemption structure as one that forbids them
outright. `type` does not separate them either: both are `text/plain`. `description` differs by default
but is operator-settable free text, so it is a hint, not a discriminator.

`publicOptions` is the same kind of hint. A profile that opts its `error` in publishes the rejection
sentence, and that is a better hint than `description` because a passable challenge has no reason to
carry one. It is still not a discriminator: the value is free text chosen by the same node that decides
whether to honor it, and a custom challenge file may declare an `error` option of its own and publish an
identical string while remaining passable. What a client learns from `publicOptions` is what the owner
says the rule is, which is exactly what it learns from the rest of the record.

So "only the owner posts here" is a **reasonable inference from the record, not a fact the record
attests**. A client should render it as a strong hint, and find out for certain the same way it would
for any community, by publishing and reading the verification.

That is also the honest reason there is no `features.onlyOwnerCanPost`. Such a flag would be a clearer
declaration, but it would be a claim by the same node that writes the challenge config, so it would not
be any more verifiable. It would save the inference, not add a guarantee.

Nothing enforces any of this read-side in the first place. A dishonest minter can accept a post from
anyone, and the entry will verify like any other comment in the community it was published to.
Owner-only posting is a property of an honest node's configuration.

### `roles` and `settings.challenges` are set in two different places

`roles` is a top-level field on the **public signed record**, so it travels to readers and is what
`exclude.roles` matches against. `settings` is **private and local-only**. Both are passed through
`createCommunity` or `community.edit`, but only one of them is published. Setting the challenges
without the roles is the most likely way to get this wrong, and it fails in a confusing direction:

- **`community.edit()` needs no role.** It is a direct method call, not a `CommentEdit` or
  `CommunityEdit` publication, so configuring the profile always works.
- **Publishing does need the role, on every path including RPC.** Publishing over RPC to a node that
  runs the community takes the local shortcut, which only suppresses the pubsub echo; the challenge
  pipeline and `exclude` evaluation still run. So does `checkPublicationValidity`, which gates
  `CommentModeration` on the roles map separately.

`createCommunity` never seeds `roles`, for delegated communities or any other kind. A profile whose
excludes are configured but whose roles map is empty looks correct until the owner's first post is
rejected by their own `fail` challenge.

### The roles key

`exclude.roles` does not look the publisher up by `author.address`. It walks the roles map and binds
each key to the **signer** of the publication, the same way `isPublicationAuthorPartOfRoles` does for
moderation authority (see the identity table in `challenge-flow.md`). Either form of the owner's
identity is a valid key, and each one matches by its own rule:

- **The peer-ID key** (`author.publicKey`) matches when it equals the address derived from
  `signature.publicKey`. That holds whatever `author.name` the owner sends, and it costs nothing: keys
  are compared before any name is resolved, so an owner listed this way never waits on a resolver.
- **The domain key** (`author.name`) matches only when the owner publishes with that exact name and
  the name resolves, fresh, to the signer. Resolution runs regardless of `resolveAuthorNames` and
  bypasses the cache, because a role grants authority and must reflect current state. An owner who
  holds the domain but publishes without `author.name` does not match a domain-only map.

A PKC address, an IPNS name and a community `publicKey` are all the **same base58btc peer ID**
(`12D3Koo...`), so the peer-ID key is literally the string passed as `anchor.publicKey`. It is not
`signer.publicKey`, which is base64 raw key material. Wire fields and roles keys always carry the
base58btc form. The base36 and base32 encodings of the same key (`k51...`, `bafz...`) only appear in
gateway paths, and the address schema is a plain string, so a roles key copied from a gateway URL is
accepted and never matches.

Both keys can sit in the map side by side. The peer-ID key is the one every profile needs, and
`createCommunity` does not add it: pass it in `roles` yourself before the owner's first publication,
as the call above does. The domain key is what an owner adds once they publish under a domain and want
the record to show it:

```js
roles: {
    "12D3KooW...": { role: "owner" },
    "owner.bso": { role: "owner" }
}
```

A domain key the node cannot verify is still a non-match, so the owner's post falls through to the
`fail` challenge. But when that unverified name is the only thing standing between the owner and the
exclude, the rejection names the cause instead of the challenge's owner-only text:

- `ERR_AUTHOR_NAME_HAS_NO_RECORD`: the resolvers answered and the name has no record.
- `ERR_COMMUNITY_FAILED_TO_RESOLVE_AUTHOR_NAME`: every resolver failed or timed out. This is the
  community node's problem, not the owner's.
- `ERR_COMMUNITY_HAS_NO_RESOLVER_FOR_AUTHOR_NAME_TLD`: the node has no resolver for the name's TLD, so
  it can never verify it. Fix the node's `nameResolvers`.
- `ERR_AUTHOR_NAME_RECORD_IS_NOT_A_VALID_KEY`: the record exists but is not a valid public key.

A name that resolves to a different key gets no such reason: that author is not the owner, and the
challenge's own text is the right answer. The peer-ID key avoids all of this, since it never touches a
resolver.

## Declaring the profile to UIs

`suggested.uiType: "author"` is how a profile tells clients what it is. It lives in `suggested`
alongside `primaryColor` and `avatarUrl` because it is the same kind of thing: a rendering hint the
owner sets, which a client may ignore without breaking interoperability. It is not a record type and
does not weaken "a configuration, not a type": nothing in pkc-js branches on it, it plays no role in
validation or loading, and a record that lies about it verifies fine, exactly like a record with a
misleading `title`.

It is part of the `createCommunity` call above. On an existing community, spread the rest of
`suggested`, since `edit()` replaces it whole:

```js
await community.edit({ suggested: { ...community.suggested, uiType: "author" } })
```

`"author"` is the only defined value. Absence means an ordinary community. Clients must ignore values
they do not recognize, so the vocabulary can grow without breaking old clients.

This is the only recommended way for a client to decide how to render the record. The tempting
inference `roles[community.address].role === "owner"` is not reliable in either direction: any
ordinary community can hold the owner role over its own address and nothing forbids or even
discourages it, while `createCommunity` never seeds `roles`, so a half-configured profile lacks the
entry. Both signals are claims by the same node that writes the record, so the inference buys no
extra trust over the declaration, it only buys false positives.

## Page sorts

An unconfigured community generates nine post sorts and five reply sorts on every update cycle,
chunked, added to IPFS and rotated. A profile feed is one author's posts in the order they made them,
so almost all of that is for nobody, and profiles are potentially one per author, so they outnumber
boards by a wide margin. `settings.pages` (see [page-sorts.md](page-sorts.md)) cuts a profile to what
it serves:

| flavor | `settings.pages` |
|---|---|
| feed-only (default) | `{ posts: [{ name: "new", preloaded: true }], replies: [] }` |
| reply-able | `{ posts: [{ name: "new", preloaded: true }], replies: [{ name: "new", preloaded: true }] }` |

**Posts: `new` only, preloaded.** While the feed fits in one page, the single-chunk shortcut applies:
the record embeds `posts.pages.new` and carries no `pageCids` at all, so a small profile adds no page
CIDs beyond its own record. A client that wants another order rebuilds it locally from the embedded
page. Past one page, `new` chunks into `pageCids` like any other sort. `pinnedFirst` keeps its default
`"true"`, so a post the owner pins stays on top.

**Replies: none in the feed-only default.** `replies: []` generates no reply pages. Watch for one
consequence: the owner can still reply over RPC, since the `fail` challenge excludes their role. That
reply is accepted and counted in the parent's `replyCount` and `lastReplyTimestamp`, but no page lists
it, so readers see a count with nothing to open. An owner who wants to reply uses the reply-able
flavor.

**Replies: `new`, preloaded, in the reply-able flavor.** Votes are rejected there (see "Votes stay
rejected"), so every score ties and `best` or `top` would order nothing. An owner who re-enables
votes may switch the reply sort to `best`.

Like every other setting, `pages` is replaced with `settings` on `edit()`, so spread the existing
settings when changing anything else. Any change to `settings.pages` regenerates every CommentUpdate
once, on the next pass.

## The feed

The owner's client publishes a crosspost into the profile alongside the real comment, so the profile
shows the author's activity. Backfilling history by walking `author.previousCommentCid` works the same
way. Both are client behavior: pkc-js ships the crosspost primitive and the community, and does not
mirror anything on an author's behalf.

Entries sort by when they were crossposted, not by when the original was published. A crosspost is a
native comment of the profile with its own `timestamp`, and `new` orders by it. Live crossposts land
within moments of their originals, but history backfilled through `previousCommentCid` all lands at
the time of the backfill. A client that wants true chronology re-sorts on `crosspost.comment.timestamp`.

Only the author can sign as the author, so a feed entry is either author-signed or it is a foreign
record embedded by the minter. There is no third option, and the second was rejected because it made
the profile's contents unattributable. Publishing a crosspost is what makes an entry the owner's.

Adding to the feed is publishing. Removing from it is a `CommentEdit` with `deleted`, or a
`CommentModeration` with `removed`, exactly as in any community. Nothing is retracted by omission.

Reading a feed entry means reading a crosspost, so the tier-1 and tier-2 rules and the three render
states in [crossposts.md](crossposts.md) apply unchanged. In particular, karma over a profile is the
sum over independently verified entries and there is no signed profile-wide total, by design: a
minter-computed number would be the owner's own delegate attesting to the owner's reputation.

Duplicate crossposts of the same `cid` are not rejected. Two people crossposting the same comment to
one community is legitimate, so idempotency belongs to whatever does the mirroring.

## The profile as a backup

A crosspost embeds the whole author-signed record, so a profile is also the author's own copy of
their posts. A client that crossposts each of the author's posts into their profile as it publishes
them (a bare crosspost, with nothing added, see [crossposts.md](crossposts.md)) keeps a copy the
origin community cannot take back. If the origin purges the post, or the board disappears, the
profile still holds the text, and tier 1 still proves the author wrote it.

What a reader sees then follows from the three render states in crossposts.md:

- **Purged at the origin, or the origin is gone:** the entry is **unknown**. The origin no longer
  serves a `CommentUpdate` for it, so tier 2 never completes. The text still renders, and the entry
  stops counting toward karma, unless a client had already verified the origin's update and kept it.
- **Removed or deleted at the origin:** the entry is **removed**, because the origin still serves an
  update that says so.
- **Replies do not follow.** The profile copy is its own comment, with its own reply thread or none.
  The origin's discussion is not mirrored, and when the origin purges a post its replies go with it.

Clients SHOULD treat a **self-signed** entry in a profile differently from an ordinary crosspost.
Self-signed means the embedded record was signed by the profile's own key: the address derived from
`crosspost.comment.signature.publicKey` equals the profile's `publicKey`. Tier 1 makes that check with
no network. For such an entry:

- **When it is unknown**, render it as the author's own copy instead of with the generic unverified
  marker, and word it so it does not assert the origin, for example "kept by the author; its original
  community did not confirm it". Show the origin community only as the author's claim, which is all it
  is at tier 1: an unknown entry may have been purged, or may never have been accepted at all.
- **When it is removed or deleted at the origin**, keep showing its text, labeled "removed at C" or
  "deleted at C". Hiding a removed crosspost is reasonable in a board, but in a profile it defeats the
  backup. This includes the author deleting the original themselves: a deletion at the origin does not
  reach the profile copy.
- **It leaves the profile only through the profile's own moderation**: the owner's `CommentEdit` with
  `deleted`, or a `CommentModeration` with `removed` or `purged`, on the profile copy.

Foreign records embedded in a profile, signed by anyone else, get the ordinary crosspost treatment.

## Two flavors

**Feed-only**, the default. `settings.disablePubsubChallengeExchange` is set, the record omits
`pubsubTopic`, and nobody can publish over pubsub, replies and votes included. The owner publishes
over RPC, because that is the only remaining path, and the `fail` challenge is belt and braces rather
than the mechanism. A profile is a broadcast of one author's activity, so this is the shape most
profiles want, and it is also the cheapest: the node runs no exchange topic at all, and with
`replies: []` it builds no reply pages either.

**Reply-able**, the opt-in. Leave the exchange enabled, so the record carries a `pubsubTopic` and
strangers can reply over pubsub, and add a reply sort so those replies appear in pages. The
restriction then lives entirely in the challenge configuration above, which needs the second challenge
or replies are unguarded. Strangers still cannot vote, see "Votes stay rejected" above. An owner who
can only publish over pubsub themselves, such as a browser-only author with no RPC access to their
minter, must also leave the exchange enabled; if they still want no replies, they drop the
`publicationType` exclude and the second challenge, so the `fail` challenge rejects everything the
owner does not sign, and keep `replies: []`.

## How the owner publishes

Either flavor works over RPC to a node running the community, whether that is `bitsocial-cli`'s
embedded RPC or a hosted service. The client's signature survives end to end: the RPC server parses
into a schema that requires `signature` and accepts no `signer`, so it never re-signs, and the
ephemeral key it generates covers only the outer challenge-request envelope. The author of a comment
published through a hosted service is the author, not the service.

A browser-only author with no RPC access to their minter can only publish over pubsub, which is why
the feed-only default assumes a self-hosted or RPC-reachable profile. Multi-tenant authentication for
a hosted minter is a service-layer concern and lives outside this repo.

## Key lifetime

The anchor key signs both the author's comments and the `An -> Mn` record, because the profile is
addressed by the author's identity. There is no rotation story: changing that key changes the author's
identity and orphans the profile, and compromise of it takes both. Minter rotation is different and is
fully supported, see [delegated-ipns.md](delegated-ipns.md); it re-points `An` at a new `Mn'` and the
address does not move.

Migration between minters reuses `exportCommunity`, which is type-blind and already sqlite-based. The
community address in the database is the anchor, and the minter key is node-local configuration that
is never part of an export, so the database is portable by construction.

## Finding a profile

There is no field on `author` saying an author has a profile. A profile lives at the author's
identity key, which is always derivable from `comment.signature.publicKey`, so finding one means
loading the community at that key. A signed `author.hasProfile` hint was considered and rejected
([#269](https://github.com/pkcprotocol/pkc-js/issues/269)). It would be permanent wire surface, it
would be self-attested, and since comments are immutable it could never appear on anything the author
published before creating the profile.

The cost to manage is the negative case. A missing IPNS record is never proven missing, only timed
out, so clients should:

- **Not resolve authors speculatively** while rendering a feed. Checking every author on a page means
  a full timeout for each one who has no profile.
- **Resolve on demand**, for example when the author's page is opened, and render the result as a
  profile only if it carries `suggested.uiType: "author"`.
- **Cache the verdict per author key.** Keep a positive result, and keep "no profile" for about a day,
  so a repeat visit does not wait on the same timeout while a newly created profile still shows up
  within a day.

## Open questions

- **Delegating profile moderation** to a third party. The schema already supports it; the recommended
  config gives the roles map the owner alone.
- **Convergence**, one name carrying both a community feed and its owner's author feed.

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

```js
await community.edit({
    roles: {
        [An]: { role: "owner" }          // An is the anchor publicKey, see "The roles key" below
    },
    settings: {
        disablePubsubChallengeExchange: true, // feed-only: nobody can publish over pubsub
        challenges: [
            {
                name: "fail",
                options: { error: "Only the owner can post to this profile." },
                publicOptions: ["error"], // publish the rejection text, see "What a reader can actually tell"
                exclude: [{ role: ["owner"] }]
            }
        ]
    }
})
```

### The reply-able flavor

To let strangers reply, leave the exchange enabled and make the challenge configuration carry the
whole restriction. The built-in `fail` challenge exists to be paired with `exclude`: it always fails,
so the only way past it is to be excluded. Two challenges express "the owner posts, anyone may reply":

```js
await community.edit({
    roles: {
        [An]: { role: "owner" }
    },
    settings: {
        challenges: [
            {
                name: "fail",
                options: { error: "Only the owner can post to this profile." },
                publicOptions: ["error"],
                exclude: [
                    { role: ["owner"] },
                    // no `vote`: votes stay rejected in this flavor too, see below
                    { publicationType: { reply: true, commentEdit: true, commentModeration: true, communityEdit: true } }
                ]
            },
            {
                name: "question",
                options: { question: "...", answer: "..." },
                exclude: [{ role: ["owner"] }]
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
`exclude.role` matches against. `settings` is **private and local-only**. Both are passed through
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

`exclude.role` matches `community.roles[author.address]`, and `author.address` is `name || publicKey`.
So the key must be whatever form the owner actually publishes under.

- A PKC address, an IPNS name and a community `publicKey` are all the **same base58btc peer ID**
  (`12D3Koo...`). The key is therefore literally the string passed as `anchor.publicKey`. It is not
  `signer.publicKey`, which is base64 raw key material.
- If the owner publishes with `author.name` set to a domain, `author.address` is that **domain**, and
  a peer-ID key silently fails to match. `exclude` matching is a bare map lookup with no name
  resolution, unlike `isPublicationAuthorPartOfRoles`.

**Put both forms in the roles map** so the owner matches either way:

```js
roles: {
    "12D3KooW...": { role: "owner" },
    "owner.bso": { role: "owner" }
}
```

The domain key inherits the weakness in [#267](https://github.com/pkcprotocol/pkc-js/issues/267):
`exclude` compares a string the publisher partly controls, so a domain-keyed rule is only sound while
`resolveAuthorNames` is on, which is the default. The peer-ID key has no such dependency, because
`isStringDomain` forbids a raw address as an `author.name`.

One further trap: the anchor schema accepts base36 and base32 CIDv1 peer-ID forms (`k51...`, `bafz...`)
that are valid IPNS names but are not what the address derivation emits. A roles key written that way
never matches.

## Declaring the profile to UIs

`suggested.uiType: "author"` is how a profile tells clients what it is. It lives in `suggested`
alongside `primaryColor` and `avatarUrl` because it is the same kind of thing: a rendering hint the
owner sets, which a client may ignore without breaking interoperability. It is not a record type and
does not weaken "a configuration, not a type": nothing in pkc-js branches on it, it plays no role in
validation or loading, and a record that lies about it verifies fine, exactly like a record with a
misleading `title`.

```js
await community.edit({ suggested: { uiType: "author" } })
```

`"author"` is the only defined value. Absence means an ordinary community. Clients must ignore values
they do not recognize, so the vocabulary can grow without breaking old clients.

This is the only recommended way for a client to decide how to render the record. The tempting
inference `roles[community.address].role === "owner"` is not reliable in either direction: any
ordinary community can hold the owner role over its own address and nothing forbids or even
discourages it, while `createCommunity` never seeds `roles`, so a half-configured profile lacks the
entry. Both signals are claims by the same node that writes the record, so the inference buys no
extra trust over the declaration, it only buys false positives.

## The feed

The owner's client publishes a crosspost into the profile alongside the real comment, so the profile
shows the author's activity. Backfilling history by walking `author.previousCommentCid` works the same
way. Both are client behavior: pkc-js ships the crosspost primitive and the community, and does not
mirror anything on an author's behalf.

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

## Two flavors

**Feed-only**, the default. `settings.disablePubsubChallengeExchange` is set, the record omits
`pubsubTopic`, and nobody can publish over pubsub, replies and votes included. The owner publishes
over RPC, because that is the only remaining path, and the `fail` challenge is belt and braces rather
than the mechanism. A profile is a broadcast of one author's activity, so this is the shape most
profiles want, and it is also the cheapest: the node runs no exchange topic at all.

**Reply-able**, the opt-in. Leave the exchange enabled, so the record carries a `pubsubTopic` and
strangers can reply over pubsub. The restriction then lives entirely in the challenge configuration
above, which needs the second challenge or replies are unguarded. Strangers still cannot vote, see
"Votes stay rejected" above. An owner who can only publish over pubsub themselves, such as a
browser-only author with no RPC access to their minter, must also leave the exchange enabled; if they
still want no replies, they drop the `publicationType` exclude and the second challenge, so the `fail`
challenge rejects everything the owner does not sign.

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

## Open questions

- **A discovery hint on the author object.** A client seeing one of millions of authors has no cheap
  way to know whether that author's identity key resolves to a profile worth fetching. The key is
  always derivable from `comment.signature.publicKey`, so a hint would only save a failed lookup, but
  at scale that may be worth a signed optional boolean on `AuthorPubsubSchema`. Deferred rather than
  rejected: it is permanent wire surface once published.
- **Delegating profile moderation** to a third party. The schema already supports it; v1 seeds the
  roles map with the owner alone.
- **Convergence**, one name carrying both a community feed and its owner's author feed.

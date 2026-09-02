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
2. **Only the owner may post.** Enforced by challenge configuration, not by a feature flag. See below.
3. **The feed is the owner's crossposts.** Ordinary comments carrying `comment.crosspost`, published
   by the owner's own client. See [crossposts.md](crossposts.md).

## Only the owner may post

The built-in `fail` challenge exists to be paired with `exclude`: it always fails, so the only way past
it is to be excluded. Two challenges express "the owner posts, anyone may reply":

```js
await community.edit({
    roles: {
        [An]: { role: "owner" }          // An is the anchor publicKey, see "The roles key" below
    },
    settings: {
        challenges: [
            {
                name: "fail",
                options: { error: "Only the owner can post to this profile." },
                publicOptions: ["error"], // publish the rejection text, see "What a reader can actually tell"
                exclude: [
                    { role: ["owner"] },
                    { publicationType: { reply: true, vote: true, commentEdit: true, commentModeration: true, communityEdit: true } }
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

A failing challenge drops any challenge still pending, so the rejected stranger is never asked the
question: they get one immediate failed verification rather than a challenge round trip.

Set the `error` option. It is what the rejected publisher actually sees: a `fail` challenge reports
through `challengeErrors`, not through the verification `reason`, and its default text is the generic
`"You're not allowed to publish."`. Naming it in `publicOptions` publishes that sentence in the record
too, which is worth doing here: a reader then sees the intent without publishing anything. It is still
a hint rather than an attestation, for the reason below.

### What a reader can actually tell

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

**Reply-able**, the default. The challenge exchange runs, the record carries a `pubsubTopic`, and
strangers can reply over pubsub. This needs the second challenge in the config above, or replies are
unguarded.

**Feed-only.** Set `settings.disablePubsubChallengeExchange`. The record omits `pubsubTopic`, the node
unsubscribes, and remote publishers fail fast with `ERR_COMMUNITY_CHALLENGE_EXCHANGE_DISABLED`. Nobody
can reply, and the owner must publish over RPC, because that is the only remaining path. The `fail`
challenge is then belt and braces rather than the mechanism.

## How the owner publishes

Either flavor works over RPC to a node running the community, whether that is `bitsocial-cli`'s
embedded RPC or a hosted service. The client's signature survives end to end: the RPC server parses
into a schema that requires `signature` and accepts no `signer`, so it never re-signs, and the
ephemeral key it generates covers only the outer challenge-request envelope. The author of a comment
published through a hosted service is the author, not the service.

A browser-only author with no RPC access to their minter can only publish over pubsub, which is why
the feed-only flavor is for self-hosted or RPC-reachable profiles. Multi-tenant authentication for a
hosted minter is a service-layer concern and lives outside this repo.

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
- **A field saying this is a profile.** Nothing in the record declares itself a profile rather than an
  ordinary community, and the pieces that imply one are spread across the anchor, the roles map and the
  challenge excludes. Right now a client can do `const isAuthor = roles[community.address].role ===
  "owner"` and it is accurate, because an ordinary community has no reason to hold the owner role over
  its own address. Whether that is enough, or whether it deserves an explicit field, is open. Like the
  hint above, a field is permanent wire surface once published.
- **Delegating profile moderation** to a third party. The schema already supports it; v1 seeds the
  roles map with the owner alone.
- **Convergence**, one name carrying both a community feed and its owner's author feed.

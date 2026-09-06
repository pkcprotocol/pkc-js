# Community lists (`CommunityList`, formerly "multisub")

> **Status: design settled, not yet implemented.** Tracked in issue #21, where the design
> decisions below were recorded. This doc is the spec the implementation must follow.

A `CommunityList` is a signed, IPNS-published curation record: a list of communities with
owner-set metadata. It is what clients load to render a default feed (`all`, `crypto`) or to
power client-side community search (a large semi-curated list searched by its metadata alone,
without loading each community).

The name replaces "multisub", a fossil of the "subplebbit" vocabulary this repo renamed to
"community". There is no `Multisub`, `MultisubCommunity`, or `MultisubEdit` in the protocol.

## Wire format

```js
CommunityList /* (IPNS-published IPFS file) */ {
  title?: string
  description?: string
  author?: Author // the list owner's self-set profile, same schema as publication.author
  communities: CommunityListEntry[]
  createdAt: number // seconds
  updatedAt: number // seconds, bumped on every edit
  protocolVersion: string
  signature: Signature
}
CommunityListEntry { // metadata set by the list owner, NOT the community owner
  publicKey: string // required, IPNS public key of the community
  name?: string // optional crypto domain (e.g. 'memes.bso')
  title?: string
  description?: string
  languages?: string[] // client can detect language and hide/show the community
  locations?: string[] // client can detect location and hide/show the community
  features?: string[] // client can match against user settings (e.g. SFW) to hide/show
  tags?: string[] // arbitrary keywords used for search
}
```

- `CommunityListSignedPropertyNames = ["title", "description", "author", "communities",
  "createdAt", "updatedAt", "protocolVersion"]`: every wire field except the signature itself, per the
  conventions in [signing.md](signing.md). Future fields must go through the reserved-field
  check like every other record.
- All array-valued fields are plural (`communities`, `languages`, `locations`, `features`,
  `tags`).
- **Load schemas are loose.** When loading a record, `CommunityListSchema` and
  `CommunityListEntrySchema` must accept and preserve unknown extra props (zod `.loose()`),
  exactly like `CommentIpfsSchema` and `CommunityIpfsSchema`. This is load-bearing, not
  stylistic: a newer publisher may add fields and sign them, and verification walks the
  record's own `signature.signedPropertyNames`, so a strict schema would both reject records
  from newer publishers and break signature verification by dropping signed props. Extra
  props ride along into the runtime instance and JSON round-trips untouched.
- The runtime-only conveniences (`address`, `shortAddress`) go on reserved-field lists
  (`CommunityListReservedFields` and the entry equivalent), so looseness never lets a wire
  record smuggle in runtime-only names; same rule as every other record type. The author
  object reuses the publication author reserved list (`address`, `publicKey`, `shortAddress`,
  `community`, `nameResolved`, see below).

## Identity and addressing

- Entry identity follows the publication convention (issue #70): the wire carries `publicKey`
  (required) plus `name` (optional domain). Runtime instances add `address` and `shortAddress`
  as conveniences, exactly like publications do. See
  [names-and-addresses.md](names-and-addresses.md).
- **No eager name resolution.** Entries have no `nameResolved`. A list can hold thousands of
  entries; resolving every name at parse time is a network storm, and the community load path
  already verifies name-to-key when a client actually opens a community. The list is a pointer
  directory, not an authority: entry metadata is the list owner's claim.
- The list itself is referenced by `{publicKey, name?}`, same as communities. The record has
  no `names[]` field and there are no magnet URIs.

## Author

The optional `author` field is the list owner's self-set profile, shown by clients next to
the list the way a publication's author is shown next to a comment. It reuses the publication
author schema verbatim, wire and runtime:

- **Wire**: same shape as `publication.author` (`AuthorPubsubSchema`): `name?`,
  `displayName?`, `previousCommentCid?`, `wallets?`, `avatar?`, `flairs?`. Strict on create,
  loose on load, like the rest of the record. There is no identity field on the wire author;
  identity always comes from the signature, per the publication convention.
- **Runtime**: instances derive `author.publicKey`, `author.address`, and
  `author.shortAddress` from `signature.publicKey` with the same helpers publications use
  (`buildRuntimeAuthor` in `src/publications/publication-author.ts`), and a domain in
  `author.name` reports resolution through `author.nameResolved`, never by overriding
  `author.address`. Those names are the publication author reserved list, so a wire record
  cannot smuggle them in.
- A consequence of reusing the machinery unchanged: the record is signed by the list's IPNS
  key, so the derived `author.publicKey`/`author.address` are the list's own identity, not a
  separate personal author key. Everything in `author` (display name, wallets, avatar NFT) is
  the owner's claim, verified no further than a publication author's claims are.
- **No community-assigned author state.** A `CommunityList` is never published to a
  community: there is no challenge flow and no `CommentUpdate` analog, so `author.community`
  (community-assigned flair, ban state, karma) does not exist on a list author, on the wire
  or at runtime.
- `edit(props)` can change `author` like any other owner-set field (bumps `updatedAt`,
  re-signs, republishes).

## Ownership and custody

Only the holder of the list's IPNS key can publish. There is no third-party edit publication
(no `MultisubEdit` analog, no challenge flow) and none is planned.

- `pkc.createCommunityList()` takes a caller-supplied `signer`. The signer is a field on the
  instance and **the caller persists it**, the same custody model as comments and votes.
  pkc-js stores nothing (this differs from `LocalCommunity`, which persists its key under
  `dataPath`).
- Losing the signer means losing the list's address forever.

## Owner API

- `publish()`: explicit one-shot. Sign the JSON, add the file to IPFS, publish the IPNS
  record. Throws on any validation failure (see below).
- `edit(props)`: bumps `updatedAt`, re-signs, republishes.
- **No background republish loop.** Record liveliness is infrastructure's job: the owner's
  node republishing while online today, delegated publishing RPCs once they are online (their
  code exists and this design targets that path). Browser nodes can publish IPNS records
  themselves and will use delegated publishing RPCs to keep records alive.
- Publishing is isomorphic (Node and browser). Unlike `LocalCommunity` there is no Node-only
  dependency: no sqlite, no MFS, no pubsub.

## Consumer API

- One-shot `pkc.getCommunityList({publicKey, name?})`, plus an `update()`/`stop()` event loop
  reusing the existing IPNS resolve machinery (mirrors `RemoteCommunity`; tests should prefer
  create + `update()` over the one-shot for the same CI-reliability reasons as communities).
- Load-side rejection (a cap only enforced by honest publishers is not a cap):
  - records over **2 MB**, rejected before parsing (DoS guard),
  - duplicate `publicKey` entries,
  - schema violations,
  - records whose `updatedAt` is older than the one already held (the staleness rule that
    makes `update()` events trustworthy).

## Validation on publish

`publish()` (and `edit()`) throw on:

- any schema violation,
- a duplicate `publicKey` in `communities` (a duplicate is always a curation bug),
- serialized size over **2 MB**.

No pagination or chunking in v1. Rough math: ~200 bytes per entry means even a
thousands-of-entries search list fits in well under the cap. Revisit chunking only if a real
list outgrows single-file fetching.

## RPC

Full RPC support, with the signer never leaving the client. Same trust model as the delegated
anchor flow from issue #234 (see [delegated-ipns.md](delegated-ipns.md)):

1. The client builds and signs the `CommunityList` JSON locally and hands it to the server.
   The server adds it to IPFS and returns the CID plus IPNS prep params (sequence number
   etc.).
2. The client signs the IPNS record over that CID locally and sends the bytes. The server
   verifies them, `routing.put`s them **byte-identical**, and keeps re-providing. The server
   can re-provide the same signed bytes but can never extend an EOL, since it lacks the key;
   EOL conventions follow [delegated-ipns.md](delegated-ipns.md).

This is a **list-specific method pair** mirroring `prepareAnchorPublish` /
`publishAnchorRecord` and sharing their plumbing. The anchor methods themselves stay
community-bound (they are entangled with `LocalCommunity` lifecycle that lists do not have).

The server **persists hosted list records in the RPC state DB** and restores re-providing on
boot. (Follow-up: retrofit the same restart persistence onto anchor records, which currently
lack it.)

## Class shape

Two classes, not the community four-class tower:

- `RemoteCommunityList`: fetch, `update()`, `stop()`.
- `CommunityList extends RemoteCommunityList`: adds `signer`, `publish()`, `edit()`.

Direct-vs-RPC transport lives in the client manager rather than the class hierarchy. The
community tower's extra layers (`RpcRemoteCommunity`, `RpcLocalCommunity`) encode a
server-side key custody split; for lists, signing never moves server-side, so that split does
not exist.

## Non-goals

- `MultisubEdit` / third-party edit publications: contradicts the ownership model (only the
  keyholder publishes).
- `PKCDefaults` (`multisubAddresses` dictionary): client-side app configuration, not pkc-js
  protocol.
- `names[]` on the record or magnet URIs: not implemented for communities either; entries'
  `publicKey` + `name` suffice.
- Pagination of large lists: deferred until a real list needs it.

# Community lists (`CommunityList`, formerly "multisub")

> **Status: implemented** (`src/community-list/`). Tracked in issue #21 (original design) and
> issue #342 (`author` field). The original design published lists over IPNS; that was
> reversed on 2026-09-06 in favor of immutable records (see [Why immutable](#why-immutable)).
> This doc is the spec the implementation follows.

A `CommunityList` is a signed, **immutable** IPFS file, addressed by CID like a comment: a
list of communities with curator-set metadata. It is what clients load to render a default
feed (`all`, `crypto`) or to power client-side community search (a large semi-curated list
searched by its metadata alone, without loading each community).

The name replaces "multisub", a fossil of the "subplebbit" vocabulary this repo renamed to
"community". There is no `Multisub`, `MultisubCommunity`, or `MultisubEdit` in the protocol.

## Wire format

```js
CommunityList /* immutable IPFS file, addressed by CID */ {
  title?: string
  description?: string
  author?: Author // the curator's profile, same schema as publication.author (see below)
  communities: CommunityListEntry[]
  timestamp: number // seconds, when this version was signed
  protocolVersion: string
  signature: Signature
}
CommunityListEntry { // metadata set by the list curator, NOT the community owner
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
  "timestamp", "protocolVersion"]`: every wire field except the signature itself, per the
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
- The runtime-only conveniences (`cid`, `shortCid` on the record; `address`, `shortAddress`
  on entries) go on reserved-field lists (`CommunityListReservedFields` and the entry
  equivalent), so looseness never lets a wire record smuggle in runtime-only names; same
  rule as every other record type. The author object reuses the publication author reserved
  list (`address`, `publicKey`, `shortAddress`, `community`, `nameResolved`).

## Why immutable

The original design published lists as mutable IPNS records. That was rejected for a
security reason: apps ship list addresses as defaults, and a mutable list is a permanent,
unreviewable trust delegation to one keyholder. A single IPNS update could redirect every
installed client to arbitrary new communities, including illegal content, with nobody in
the loop. A list update also amplifies: it swaps the whole set of places a client will go.

With immutable CIDs, the trust decision is made once, over concrete bytes, by whoever
adopts the CID. Each revision is a new CID that gets re-reviewed at adoption time. Clients
MUST NOT auto-follow any pointer from an old list version to a newer one.

Publishing a revision = building a new record and publishing a new CID (see
[Versioning and discovery](#versioning-and-discovery)). Immutability also collapses the
implementation: no IPNS liveliness or republish loops, no delegated publishing, no
staleness rules, no sequence numbers.

## Identity and addressing

- **The list's identity is its CID.** There is no IPNS name, no `names[]` field, and no
  magnet URIs.
- Entry identity follows the publication convention (issue #70): the wire carries
  `publicKey` (required) plus `name` (optional domain). Runtime instances add `address` and
  `shortAddress` as conveniences, exactly like publications do. See
  [names-and-addresses.md](names-and-addresses.md).
- **No eager name resolution for entries.** Entries have no `nameResolved`. A list can hold
  thousands of entries; resolving every name at parse time is a network storm, and the
  community load path already verifies name-to-key when a client actually opens a
  community. The list is a pointer directory, not an authority: entry metadata is the
  curator's claim.

## Author

The optional `author` field is the curator's profile, shown by clients next to the list the
way a publication's author is shown next to a comment. It reuses the publication author
schema verbatim, wire and runtime:

- **Wire**: same shape as `publication.author` (`AuthorPubsubSchema`): `name?`,
  `displayName?`, `previousCommentCid?`, `wallets?`, `avatar?`, `flairs?`. Strict on
  create, loose on load, like the rest of the record. There is no identity field on the
  wire author; identity always comes from the signature, per the publication convention.
- **Runtime**: instances derive `author.publicKey`, `author.address`, and
  `author.shortAddress` from `signature.publicKey` with the same helpers publications use
  (`buildRuntimeAuthor` in `src/publications/publication-author.ts`), and a domain in
  `author.name` reports resolution through `author.nameResolved` (same lazy background
  resolution as publications, gated on the `resolveAuthorNames` option), never by
  overriding `author.address`.
- **Any key can sign a list**, including the curator's personal author key (the one they
  sign comments with). Signing a list consumes no IPNS slot, so one key can sign any number
  of lists, and a list signed with the curator's personal key carries their real,
  verifiable author identity.
- **No community-assigned author state.** A `CommunityList` is never published to a
  community: there is no challenge flow and no `CommentUpdate` analog, so
  `author.community` (community-assigned flair, ban state, karma) does not exist on a list
  author, on the wire or at runtime.

## Ownership and custody

- `pkc.createCommunityList({signer, ...props})` takes a caller-supplied `signer`. The
  signer is a field on the instance and **the caller persists it**, the same custody model
  as comments and votes. pkc-js stores nothing.
- Because the record is immutable and CID-addressed, losing the signer does not lose the
  list: published CIDs stay valid forever. It only loses the ability to sign future
  revisions under the same author identity.
- There is no third-party edit publication (no `MultisubEdit` analog, no challenge flow)
  and none is planned.

## Owner API

- `pkc.createCommunityList({signer, title?, description?, author?, communities,
  timestamp?})`: builds the instance. `timestamp` defaults to now, like publications.
- `publish()`: explicit one-shot. Signs the JSON and adds the file to IPFS (locally, or via
  the RPC server). Sets `cid` on the instance and returns. Throws on any validation
  failure (see below).
- `stop()`: aborts an in-flight `publish()`.
- There is no `edit()`. Publishing a revision means calling `createCommunityList()` again
  with the previous record's props (obtained from a loaded instance) and publishing a new
  CID.
- Publishing is isomorphic (Node and browser). There is no Node-only dependency: no
  sqlite, no MFS, no pubsub. It does require a node that can `ipfs add`: a kubo RPC client
  or a PKC RPC server. Gateway-only and libp2p-js-only instances can load lists but not
  publish them (helia exposes no add in pkc-js today, and a browser cannot reliably provide
  blocks anyway).

## Consumer API

- `pkc.createCommunityList({cid})` + `update()`/`stop()` is the evented path (tests should
  prefer it over the one-shot for the same CI-reliability reasons as communities):
  - `update()` fetches and verifies the record (retrying on transient failures) and emits
    `update`.
  - The record is immutable, so there is no subscription afterwards. The only thing left to
    settle is `author.nameResolved`: if `author.name` is a domain and
    `pkc.resolveAuthorNames` is on, `update()` keeps driving the background resolution
    until the verdict is **definitive**, emits `update` again with `author.nameResolved`
    set, then stops itself. Definitive means: resolved to `signature.publicKey` (true),
    resolved to a different key (false), or no resolver in this PKC instance handles the TLD
    (false). A resolution that returns nothing is indistinguishable from a resolver outage
    today, so it retries rather than failing shut, the same policy as publication authors.
    Transient resolver failures keep retrying until the caller's `stop()`.
  - When there is nothing to settle (no `author`, `author.name` absent or not a domain, or
    `resolveAuthorNames: false`), the instance stops itself right after the first `update`.
- One-shot `pkc.getCommunityList({cid})`: resolves after fetch + verify, without waiting
  for the `nameResolved` verdict (same as `getComment`); the verdict lands in the pkc-wide
  cache, so evented instances pick it up.
- Load-side rejection (a cap only enforced by honest publishers is not a cap):
  - records over **2 MB**, rejected before parsing (DoS guard),
  - invalid signatures,
  - duplicate `publicKey` entries,
  - schema violations.

## Validation on publish

`publish()` throws on:

- any schema violation,
- a duplicate `publicKey` in `communities` (a duplicate is always a curation bug),
- serialized size over **2 MB**.

No pagination or chunking in v1. Rough math: ~200 bytes per entry means even a
thousands-of-entries search list fits in well under the cap. Revisit chunking only if a
real list outgrows single-file fetching.

## Versioning and discovery

- A revision is a brand-new record with a new CID. The record carries no revision-chain
  field in v1 (one can be added later as a signed optional field; load schemas are loose).
- Discovery of newer revisions is out of protocol: future IPNS-published author profiles
  and communities (both mutable, the latter moderated) are the channels through which a
  curator announces a new list CID. Client-side default lists are app configuration
  (`PKCDefaults` stays a non-goal).
- Clients MUST NOT auto-follow from one list version to another (see
  [Why immutable](#why-immutable)).

## RPC

Full RPC support, with the signer never leaving the client:

- **Publish**: the client builds and signs the `CommunityList` JSON locally and hands it to
  the server. The server validates it, adds it to IPFS, and returns the CID.
- **Fetch**: the client asks the server for a CID; the server fetches the file and returns
  it; the client parses and verifies it locally like any other record.

No delegated IPNS machinery is involved (there is no IPNS record). This is deliberately the
same shape as comment publish/fetch over RPC.

## Class shape

One class, `CommunityList`, not the community four-class tower and not a
`RemoteCommunityList` split (those existed for the IPNS update loop, which is gone):

- constructed with a `signer` (owner path): `publish()`/`stop()`.
- constructed with a `cid` (consumer path): `update()`/`stop()`.

Direct-vs-RPC transport lives in the client manager rather than the class hierarchy;
signing never moves server-side.

## Non-goals

- Mutability / IPNS publishing: rejected, see [Why immutable](#why-immutable).
- `MultisubEdit` / third-party edit publications: contradicts the custody model (only the
  keyholder signs).
- `PKCDefaults` (`multisubAddresses` dictionary): client-side app configuration, not pkc-js
  protocol.
- `names[]`, magnet URIs, or any name for the list itself: the list is its CID; entries'
  `publicKey` + `name` suffice.
- A revision-chain field (`previousCommunityListCid`): deferred; additive later without
  breaking.
- Pagination of large lists: deferred until a real list needs it.

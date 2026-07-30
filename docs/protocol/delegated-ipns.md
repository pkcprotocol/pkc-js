# Delegated IPNS (anchor → minter chains)

This documents pkc-js's **client-side loading** of communities published via a delegated
IPNS chain (see issue #93), and the **minter-side identity split** that lets pkc-js run a delegated
community itself (issue #233, "Publishing a delegated community" below).

> **For now, only a single `anchor → minter` hop is allowed** (`MAX_IPNS_HOPS = 1`). Chains
> longer than one hop are rejected with `ERR_IPNS_MAX_HOPS_EXCEEDED` on every resolution path
> (the P2P paths and the gateway chain walk). (The resolver is written to support N hops, so this
> cap can be raised later.)

## Motivation

A community owner may want their private key to stay offline while an online delegate
(e.g. a public RPC operator) keeps the community's IPNS record fresh — without the delegate
being able to permanently take the community over. This is achieved with two keypairs:

- **`An` / `As`** — the **anchor** keypair. `An` is the public IPNS name (the user-facing
  community identity); `As` is held offline by the owner.
- **`Mn` / `Ms`** — the **minter** keypair. `Mn` is the public IPNS name; `Ms` is held by
  the online delegate.

The records form a chain:

```text
/ipns/An  ──(signed by As, long EOL)──>  /ipns/Mn
/ipns/Mn  ──(re-signed frequently by Ms)────────────────>  /ipfs/<CommunityIpfs cid>
/ipfs/<cid> ── CommunityIpfs JSON, signed by Ms (the minter key)
```

The owner revokes by coming online and re-pointing `An` to a new `Mn'`.

> **Anchor EOL is a liveness cliff, not "infinite".** Every IPNS record carries a validity (EOL),
> and the `ipns` validator **rejects expired records** (`RecordExpiredError`) on every path. The
> anchor record is therefore not infinitely valid: it must be published with a long EOL and
> **re-published by the offline owner before that EOL lapses**. If the anchor record expires while
> `As` is offline, loading fails everywhere — over a gateway it surfaces as the non-retriable
> `ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID` with `reason: "IPNS record has expired …"` (distinct from
> the forged/tampered reason). Choose the anchor EOL with this re-publish obligation in mind.

## What this means for identity & verification

- **Identity stays the anchor.** `community.address` and `community.publicKey` are the
  anchor `An` (or its domain). Per [names-and-addresses.md](names-and-addresses.md) the
  address is immutable, so this is **new-community-only** — existing communities cannot
  migrate.
- **Content is signed by the terminal (minter) key.** `CommunityIpfs.signature.publicKey`
  derives to `Mn`, **not** `An`. The `An → Mn` binding is established by the
  cryptographically-verified IPNS record chain, not by the content signature.
- A **non-delegated** community is just the degenerate single-hop case: the chain is
  `[An]`, the terminal equals the anchor, and the content is signed by `An`. All the logic
  below collapses to the original behaviour, so nothing changes for normal communities.

## How loading works

`BaseClientsManager.resolveIpnsToCidP2P` resolves **one hop at a time** with
`recursive: false` and returns `{ cid, ipnsHops }`, where `ipnsHops` is the ordered chain
of IPNS names traversed (`ipnsHops[0]` = anchor, `ipnsHops.at(-1)` = terminal). We resolve
hop-by-hop rather than letting the resolver recurse because kubo's recursive resolve only
yields the final `/ipfs/` CID and hides the intermediate names — we need the terminal name
to verify the content signature, and resolving each hop keeps per-record signature
verification. A normal community resolves in a single hop, so this costs exactly one lookup
in the common case. A hop cap (`MAX_IPNS_HOPS = 1`) bounds the chain: **for now only a single
`anchor → minter` delegation is followed**, so a normal community resolves in zero hops and a
delegated community in exactly one. A longer chain is rejected with `ERR_IPNS_MAX_HOPS_EXCEEDED`
on every path — the gateway path walks and validates the chain itself (see "Per resolution path"
below), so the cap is enforced there too.

The resolved chain is stored on the instance as `RemoteCommunity.ipnsHops` (a runtime-only
field; it is never part of the signed wire record). `community.publicKey`/`ipnsName` are
derived from `ipnsHops[0]` (the anchor), and the content signature is verified against
`ipnsHops.at(-1)` (the terminal) — `verifyCommunity` receives the terminal name so its
`signature.publicKey` check passes.

### Per resolution path

- **Kubo RPC (node):** `name.resolve(name, { recursive: false })` returns the immediate
  value of each record; we walk the chain. Requires the kubo node to have
  `Ipns.UsePubsub=true` and be subscribed to both topics.
- **Helia (browser/libp2p):** the wrapper resolves a **single** record per call via the
  resolver's routers (not `@helia/ipns`'s recursive `resolve`, which would try to fetch a
  deeper hop's record before its pubsub topic has subscribers and throw `NotFoundError`).
  Each hop warms its own pubsub topic before its record is fetched.
- **IPFS gateways (untrusted, two-tier):** a gateway is not trusted to recurse the chain for us, so
  loading is optimistic and only escalates when delegation is detected.
  - **Tier 1 — always:** a single plain `GET ${gateway}/ipns/<anchor>` fetches the content body. If
    the content is signed by the anchor key itself, the community is **non-delegated** and the
    content signature alone secures the response — done in one request, no chain walk (this is every
    normal community).
  - **Tier 2 — only when the content is signed by a different key** (the hallmark of delegation):
    pkc-js independently follows & **validates** each record of the chain via
    `${gateway}/ipns/<name>?format=ipns-record` (`fetchAndValidateIpnsRecordFromGateway`, using the
    `ipns` package's signature validator), confirms the terminal record's CID matches the served
    body, and confirms the body's signer equals the terminal name. A gateway cannot forge any hop's
    signature, so it cannot substitute a different community. The same `MAX_IPNS_HOPS` cap as the
    P2P paths applies — a chain longer than a single `anchor → minter` hop is rejected with
    `ERR_IPNS_MAX_HOPS_EXCEEDED`. Tier 2 assumes the configured gateways can serve
    `?format=ipns-record` (the raw-record format); delegated loading relies on it. Each raw-record
    response is also size-capped at the IPNS spec's 10 KiB maximum (`MAX_IPNS_RECORD_SIZE`) and read
    with a hard byte ceiling, so an untrusted gateway cannot exhaust memory by streaming an oversized
    body before validation runs.

  Per-hop validation cost is therefore paid **only** for delegated communities; non-delegated
  communities are a single plain GET, untouched. (Per-request, only the requested name's own record
  is returned — no response header carries the traversed chain, so the walk fetches each hop's
  record individually; see [ipfs/kubo#11351](https://github.com/ipfs/kubo/issues/11351).)

## Publishing a delegated community

A `LocalCommunity` can be the minter of a delegated community: it signs with `Ms` while its identity
is `An`. Because a node never resolves itself, it cannot derive that identity — the anchor is supplied
at creation and kept as local state.

```js
// The node generates Mn/Ms itself; As never leaves the owner.
const community = await pkc.createCommunity({ anchor: { publicKey: An } })
community.publicKey // An, what every reader resolves
community.signer.address // Mn, what this node signs and publishes with
```

`anchor.publicKey` is the B58 IPNS name, the same representation `community.publicKey` uses, not the
base64 raw key that `signer.publicKey` and `encryption.publicKey` carry. Passing both `signer` and
`anchor` is an error (`ERR_CAN_NOT_CREATE_A_COMMUNITY_WITH_BOTH_SIGNER_AND_ANCHOR`): which key the
caller supplies is the discriminator between the two regimes.

The anchor is persisted in the community's internal record and replayed into `ipnsHops` as
`[An, Mn]` on every load, so the identity code above (`publicKey` from `ipnsHops[0]`) applies to a
publisher exactly as it does to a reader.

**What moves to the anchor:** `community.publicKey` and `community.address`, the community's data
directory and MFS namespace, publication acceptance (a publisher addresses the community by the
name it resolved, which is `An`), and the `communityPublicKey` stored on content. Content labelling
in particular must be anchor-based, or a minter rotation would leave stored publications naming a key
that no longer publishes the community.

**What stays with the minter:** the record signature, `encryption`, `signer.ipnsKeyName`, the
`pubsubTopic` backfill, and this node's own `ipnsName` / `ipnsPubsubTopic` / routing CID. A publisher
mints under its own key, so unlike a reader it never derives those from `ipnsHops[0]`
(`LocalCommunity` overrides `_updateIpnsPubsubPropsIfNeeded` to enforce this).

A non-delegated community is the degenerate case: no anchor, no `ipnsHops`, and every rule above
collapses to `signer.address`.

> **Rotation changes the pubsub topic.** The challenge-exchange `pubsubTopic` is backfilled from the
> minter address, so it moves when the owner re-points `An` at a new `Mn'`. The address does not.
> Client authors must re-resolve the community before publishing rather than trusting a cached topic.

Getting the `An → Mn` record onto the network and keeping it there is the setup half, issue #234.

## Performance

A delegated community's extra `anchor → minter` hop costs on **every** resolution path. On the P2P
paths it adds one sequential IPNS resolution (the resolver walks the chain one hop per network
round-trip). Over a gateway it adds the per-hop `?format=ipns-record` validation fetches (Tier 2
above) on top of the plain GET. Non-delegated communities pay nothing extra on any path — a single
lookup / single plain GET.

Benchmark (`scripts/bench-delegated-ipns.js` — run with the node test server up and after
`npm run build`: `node scripts/bench-delegated-ipns.js`, iterations via `BENCH_IPNS_ITERATIONS`).
It loads the same community record two ways, direct (load the minter name, single hop) vs delegated
(load the anchor name, one extra hop), so the delta isolates the extra hop. Run on the local test
setup with **no DHT** (helia resolves via the local HTTP router, kubo from its own datastore) and
the **same peer serving both keypairs**. Median of 7 runs:

| mechanism             | direct (1-hop) | delegated (2-hop) | delta   | ratio  |
| --------------------- | -------------- | ----------------- | ------- | ------ |
| `remote-kubo-rpc`     | ~3.7 ms        | ~4.4 ms           | ~0.7 ms | ~1.2x  |
| `remote-libp2pjs`     | ~5.3 ms        | ~8.1 ms           | ~2.8 ms | ~1.5x  |
| `remote-ipfs-gateway` | ~3.4 ms        | ~5.7 ms           | ~2.3 ms | ~1.7x  |

In absolute terms the extra hop is cheap here because there is no DHT walk (resolution is served
from a local datastore or HTTP router). The gateway row now reflects the per-hop
`?format=ipns-record` validation fetches a delegated load makes (it used to be ~0 ms when the
gateway's recursion was trusted). If a DHT walk were involved, the per-hop delta would dominate.

> **Optimization (deferred — measure in production first):** the extra hop is cheap in these
> numbers only because the benchmark has no DHT (resolution is served from a local datastore / HTTP
> router), so there is nothing actionable to tune against yet — any optimization now would be
> guessing at a delta we cannot measure. The real cost shows up on the production path, where DHT /
> router / gateway round-trip latency dominates the per-hop delta. The plan is therefore to measure
> delegated vs non-delegated loads in production first, and only then decide whether the candidate
> optimizations are worth implementing:
>
> - **Gateway Tier-2 concurrent validation:** the content signature already reveals the terminal
>   minter name, and the chain is capped at a single hop, so the anchor and minter
>   `?format=ipns-record` fetches can run concurrently (`Promise.all`) instead of strictly
>   hop-by-hop — independent per-record verification is unaffected.
> - **Helia/libp2p concurrent fetch:** warm both topics / fetch both records concurrently rather
>   than strictly hop-by-hop, where the hop cap and per-record verification still allow it.
> - **Anchor → minter binding cache:** the anchor record is stable and long-lived; caching it
>   (honouring its own TTL) lets repeat loads skip the anchor hop on every path.
>
> Tracked alongside issue #93.

## Trust model (summary)

- The delegate fully controls what `/ipns/An` resolves to until the owner rotates —
  unavoidable for any offline-owner design short of threshold signing.
- If `Ms` leaks, an attacker can publish under `Mn` (including a sequence-exhaustion lock)
  until the owner rotates `An` to a new `Mn'`. `As` never touches the network after the
  initial publish.
- pkc-js **never accepts content whose signer is not the terminal of the validated chain**, on
  every resolution path — kubo RPC, helia, and gateways alike. Over a gateway the `An → Mn` binding
  is verified by independently fetching and signature-checking each IPNS record
  (`?format=ipns-record`), so a malicious gateway cannot serve content under a key it controls and
  pass it off as `An`'s resolution. (Content freshness is handled separately by `updatedAt`: a
  record older than the one already held in memory is ignored, so a gateway cannot roll the
  *content* back within a session.)
- **Known limitation — no sequence anti-rollback on the `An → Mn` binding.** The chain walk validates
  each record's signature and EOL but does **not** compare IPNS-record sequence numbers, and nothing
  is persisted across loads. So a malicious gateway can keep serving the *old, validly-signed* anchor
  record (`An → Mn`, long EOL) after the owner has rotated to `An → Mn'`, pinning a victim to the
  revoked minter. The `updatedAt` freshness check does **not** save you here: whoever leaked `Ms`
  keeps minting fresh-`updatedAt` content under `Mn`, so the content always looks current — freshness
  protects content recency, not the binding. Rotation is therefore only reliably enforced against an
  honest gateway/router. The proper fix (persist the last-seen anchor sequence and refuse downgrades)
  is tracked as a follow-up in #118.

## Relevant errors

Chain-walk errors carry `hopRole` (`"anchor"` or `"minter"`) and `hopIndex` in their `details` so a
failure names **which** record was at fault, not just that the chain failed. Both resolution paths —
the P2P resolver (`resolveIpnsToCidP2P`) and the gateway chain walker (`_resolveIpnsChainViaGateway`)
— label failures identically.

- `ERR_IPNS_MAX_HOPS_EXCEEDED` — chain longer than the hop cap (`MAX_IPNS_HOPS`), on the P2P paths
  and the gateway chain walk. `hopRole`/`hopIndex` identify the record that delegated one hop too far.
- `ERR_RESOLVED_IPNS_TO_UNSUPPORTED_VALUE` — a record value that is neither `/ipfs/` nor `/ipns/`.
- `ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED` — a P2P record resolved to no value (e.g. not found).
- `ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID` — the gateway-served `?format=ipns-record` chain failed to
  validate. The `reason` in `details` distinguishes the cause: bad signature ("forged or tampered
  record"), expired record ("IPNS record has expired …"), oversized record ("exceeds the maximum
  allowed size"), missing record, terminal CID mismatch, or signer ≠ terminal. (All three of the
  codes above are non-retriable.)
- `ERR_THE_COMMUNITY_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED` — the content's signer
  matches none of the accepted identities (loaded address, community publicKey/anchor, or the chain's
  terminal/minter). `matchChecks` and `isDelegatedChain` in `details` say which checks failed.

**Forgery-error asymmetry between paths:** only the gateway path emits an explicit forgery error.
Over a gateway pkc-js fetches and signature-checks each record itself, so a forged/tampered record
fails with `ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID` ("forged or tampered record"). Over P2P (kubo RPC
/ helia) the resolver performs per-record signature validation internally, so a forged/tampered/
unverifiable record surfaces as an opaque resolution failure (`ERR_FAILED_TO_RESOLVE_IPNS_VIA_IPFS_P2P`
or a not-found), **not** an explicit forgery error. Those P2P failures carry a `note` in `details`
explaining the asymmetry.

# Delegated IPNS (anchor → minter chains)

This documents pkc-js's **client-side loading** of communities published via a delegated
IPNS chain (see issue #93). Delegate-side *publishing* is intentionally **not** part of
pkc-js — only resolution and verification are.

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
/ipns/An  ──(signed once by As, ~infinite validity)──>  /ipns/Mn
/ipns/Mn  ──(re-signed frequently by Ms)────────────────>  /ipfs/<CommunityIpfs cid>
/ipfs/<cid> ── CommunityIpfs JSON, signed by Ms (the minter key)
```

The owner revokes by coming online and re-pointing `An` to a new `Mn'`.

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
    `ERR_IPNS_MAX_HOPS_EXCEEDED`. This requires the gateway to serve `?format=ipns-record`; many
    public gateways won't, so delegated loading over gateways is best-effort and depends on gateway
    capability (a gateway that can't serve the records fails, and the loader moves on to others).

  Per-hop validation cost is therefore paid **only** for delegated communities; non-delegated
  communities are a single plain GET, untouched. (Per-request, only the requested name's own record
  is returned — no response header carries the traversed chain, so the walk fetches each hop's
  record individually; see [ipfs/kubo#11351](https://github.com/ipfs/kubo/issues/11351).)

## Performance

A delegated community's extra `anchor → minter` hop costs on **every** resolution path. On the P2P
paths it adds one sequential IPNS resolution (the resolver walks the chain one hop per network
round-trip). Over a gateway it adds the per-hop `?format=ipns-record` validation fetches (Tier 2
above) on top of the plain GET. Non-delegated communities pay nothing extra on any path — a single
lookup / single plain GET.

Benchmark (see the env-gated `BENCH_IPNS` timing benchmark in
`test/node-and-browser/community/delegated-ipns.test.ts`). It loads the same community record two
ways, direct (load the minter name, single hop) vs delegated (load the anchor name, one extra hop),
so the delta isolates the extra hop. Run on the local test setup with **no DHT** (helia resolves via
the local HTTP router, kubo from its own datastore) and the **same peer serving both keypairs**.
Median of 7 runs:

| mechanism             | direct (1-hop) | delegated (2-hop) | delta   | ratio  |
| --------------------- | -------------- | ----------------- | ------- | ------ |
| `remote-kubo-rpc`     | ~3.7 ms        | ~4.4 ms           | ~0.7 ms | ~1.2x  |
| `remote-libp2pjs`     | ~5.3 ms        | ~8.1 ms           | ~2.8 ms | ~1.5x  |
| `remote-ipfs-gateway` | ~3.4 ms        | ~5.7 ms           | ~2.3 ms | ~1.7x  |

In absolute terms the extra hop is cheap here because there is no DHT walk (resolution is served
from a local datastore or HTTP router). The gateway row now reflects the per-hop
`?format=ipns-record` validation fetches a delegated load makes (it used to be ~0 ms when the
gateway's recursion was trusted). If a DHT walk were involved, the per-hop delta would dominate.

> **TODO (future optimization):** the helia path's ~1.5x ratio is a bit too high for one extra hop.
> We may come back to this later to optimize delegated resolution over libp2p (e.g. warming both
> topics / fetching both records concurrently instead of strictly hop-by-hop, where the hop cap and
> per-record verification still allow it). Tracked alongside issue #93.

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
  pass it off as `An`'s resolution. (Freshness is handled separately by `updatedAt`: a record older
  than the one already held is ignored, so a gateway cannot roll a community back.)

## Relevant errors

- `ERR_IPNS_MAX_HOPS_EXCEEDED` — chain longer than the hop cap (`MAX_IPNS_HOPS`), on the P2P paths
  and the gateway chain walk.
- `ERR_RESOLVED_IPNS_TO_UNSUPPORTED_VALUE` — a record value that is neither `/ipfs/` nor `/ipns/`.
- `ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID` — the gateway-served `?format=ipns-record` chain failed to
  validate (bad signature, missing record, terminal CID mismatch, or signer ≠ terminal). (All three
  are non-retriable.)

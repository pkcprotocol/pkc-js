# Delegated IPNS (anchor → minter chains)

This documents pkc-js's **client-side loading** of communities published via a delegated
IPNS chain (see issue #93). Delegate-side *publishing* is intentionally **not** part of
pkc-js — only resolution and verification are.

> **For now, only a single `anchor → minter` hop is allowed** (`MAX_IPNS_HOPS = 1`). Chains
> longer than one hop are rejected over the P2P paths with `ERR_IPNS_MAX_HOPS_EXCEEDED`. (The
> resolver is written to support N hops, so this cap can be raised later.)

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
`anchor → minter` delegation is followed over the P2P paths**, so a normal community resolves in
zero hops and a delegated community in exactly one. A longer chain is rejected with
`ERR_IPNS_MAX_HOPS_EXCEEDED`. (Gateways recurse the chain internally and expose only the final
content, so this cap is unenforceable on the gateway path — see "Per resolution path" below.)

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
- **IPFS gateways (best-effort, gateway-trusted for delegation):** a plain
  `GET ${gateway}/ipns/<anchor>` makes the gateway recurse the chain internally and serve only
  the **final content** — the intermediate signed IPNS records are discarded and exposed in no
  response header (`X-Ipfs-Path`/`X-Ipfs-Roots` carry only the final CID; verified empirically on
  2-hop and 3-hop chains). So over a gateway pkc-js does **one** request: it verifies the content's
  own signature and that the body matches the served CID, derives the terminal (minter) from the
  content signer, and reports `ipnsHops` as `[anchor, terminal]` (intermediate hops are not
  observable). **It does not independently validate the `An → Mn` binding** — that part is trusted
  to the gateway's recursion.

  **Why we accept this (speed):** loading an IPNS over a gateway should be a single call. The only
  way to verify the chain ourselves would be one extra `?format=ipns-record` fetch **per hop**,
  added sequentially, because no response header or single response can carry the traversed records
  (see [ipfs/kubo#11351](https://github.com/ipfs/kubo/issues/11351)). Rather than pay `N+1`
  round-trips on the gateway path, we keep it to one call and trust the gateway's recursion there.
  This downgrade applies **only** to delegated communities on the gateway path: a normal community
  is still self-securing because its content is signed by the anchor itself (a gateway cannot forge
  that signature), and the P2P paths (kubo RPC / helia) keep full per-hop verification.

## Trust model (summary)

- The delegate fully controls what `/ipns/An` resolves to until the owner rotates —
  unavoidable for any offline-owner design short of threshold signing.
- If `Ms` leaks, an attacker can publish under `Mn` (including a sequence-exhaustion lock)
  until the owner rotates `An` to a new `Mn'`. `As` never touches the network after the
  initial publish.
- **On the P2P paths** pkc-js never accepts content whose signer is not the terminal of the
  validated chain. **On the gateway path** the `An → Mn` binding is trusted to the gateway's
  recursion (a single plain GET; see "Per resolution path" above for the speed rationale), so a
  malicious gateway could serve content under a key it controls and present it as `An`'s
  resolution — a gateway-only client cannot detect this for a delegated community. Normal
  (non-delegated) communities are unaffected, since their content is signed by the anchor itself.

## Relevant errors

- `ERR_IPNS_MAX_HOPS_EXCEEDED` — chain longer than the hop cap (`MAX_IPNS_HOPS`, P2P paths).
- `ERR_RESOLVED_IPNS_TO_UNSUPPORTED_VALUE` — a record value that is neither `/ipfs/` nor
  `/ipns/`. (Both are non-retriable.)

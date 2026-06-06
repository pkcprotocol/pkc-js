# Delegated IPNS (anchor → minter chains)

This documents pkc-js's **client-side loading** of communities published via a delegated
IPNS chain (see issue #93). Delegate-side *publishing* is intentionally **not** part of
pkc-js — only resolution and verification are.

## Motivation

A community owner may want their private key to stay offline while an online delegate
(e.g. a public RPC operator) keeps the community's IPNS record fresh — without the delegate
being able to permanently take the community over. This is achieved with two keypairs:

- **`An` / `As`** — the **anchor** keypair. `An` is the public IPNS name (the user-facing
  community identity); `As` is held offline by the owner.
- **`Mn` / `Ms`** — the **minter** keypair. `Mn` is the public IPNS name; `Ms` is held by
  the online delegate.

The records form a chain:

```
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
in the common case. A depth cap (`MAX_IPNS_RECURSION_DEPTH = 32`, mirroring Boxo's
`DefaultDepthLimit`) bounds the chain.

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
- **IPFS gateways (untrusted):** the gateway does its own recursion, so its resolved body
  cannot be trusted to bind `An → Mn`. When the served record is signed by a key other than
  the anchor, pkc-js independently fetches and **validates** each record in the chain via
  `${gateway}/ipns/<name>?format=ipns-record` (`fetchAndValidateIpnsRecordFromGateway`,
  using the `ipns` package's signature validator), confirms the terminal record's CID
  matches the served body, and confirms the body's signer equals the terminal name. This
  requires the gateway to serve `?format=ipns-record` and to support IPNS-over-pubsub for
  the inner topic; many public gateways won't, so delegated loading over gateways is
  best-effort and depends on gateway capability.

## Trust model (summary)

- The delegate fully controls what `/ipns/An` resolves to until the owner rotates —
  unavoidable for any offline-owner design short of threshold signing.
- If `Ms` leaks, an attacker can publish under `Mn` (including a sequence-exhaustion lock)
  until the owner rotates `An` to a new `Mn'`. `As` never touches the network after the
  initial publish.
- pkc-js never accepts content whose signer is not the terminal of the validated chain.

## Relevant errors

- `ERR_IPNS_RECURSION_DEPTH_EXCEEDED` — chain longer than the depth cap.
- `ERR_RESOLVED_IPNS_TO_UNSUPPORTED_VALUE` — a record value that is neither `/ipfs/` nor
  `/ipns/`.
- `ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID` — the gateway-served `?format=ipns-record` chain
  failed to validate or did not bind anchor → terminal. (All three are non-retriable.)

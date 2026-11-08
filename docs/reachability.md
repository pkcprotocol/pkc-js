# Reachability: why a community loads on one client and not on another

A community is served by whatever nodes announce themselves as providers of its IPNS record: the node that runs it, and any node that seeds it. A client can only load the community if it can open a direct connection to at least one of those providers. Whether it can depends on two things the client checks locally, before any network round trip:

1. **What addresses the providers announce.** A node behind NAT (a home router, carrier-grade NAT, a mobile hotspot, no port forwarding or UPnP) cannot be reached from the outside. Kubo detects this (AutoNAT reports `Private`) and announces only `/p2p-circuit` addresses, meaning "reach me through this relay".
2. **What transports the client has.** A browser can only open WebSocket (`/wss`), WebTransport and WebRTC connections, and pkc-js denies WebRTC by default. A Node.js libp2p-js client can also open TCP. Kubo can open everything, including relayed connections that it then upgrades to direct ones by hole punching.

When the client finds providers but every one of them fails those local checks, pkc-js reports `ERR_COMMUNITY_UNREACHABLE_FROM_THIS_CLIENT` instead of the generic "does this IPNS name exist?" error. The community exists and its providers were found. This client simply cannot connect to any of them.

## The error

```
ERR_COMMUNITY_UNREACHABLE_FROM_THIS_CLIENT
```

`error.details` carries:

| Field             | Meaning                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| `reason`          | `"relay-only-providers"` or `"no-dialable-provider-addrs"`, see below         |
| `providerPeerIds` | The peer ids of the providers that were found                                 |
| `providersFound`  | How many providers were found                                                 |
| `providers`       | Per-provider verdict and the addresses it announced                           |
| `docsUrl`         | This page                                                                     |
| `retriableError`  | `true` when emitted by a community's update loop (see "What the client does") |

### `reason: "relay-only-providers"`

Every provider announced only `/p2p-circuit` addresses. The host is behind NAT and no publicly reachable node is seeding the community. pkc-js never dials a relay-only provider from a libp2p-js client: the relayed connection is limited and cannot carry the record fetch, page fetches or publishing (see issue #215).

### `reason: "no-dialable-provider-addrs"`

Providers announced addresses, but none of them uses a transport this client has, or none passed the client's connection gater. The usual case is a browser client and providers that announce only TCP or QUIC addresses. Relay-only providers mixed with such providers also produce this reason.

## What the client does

-   **Community update loop** (`community.update()`): the error is emitted on the community's `error` event on every failed cycle, with `details.retriableError: true`, and the loop keeps retrying. A seeder or a direct address can show up later, and the loop picks it up without a restart.
-   **`pkc.getCommunity()`** and **`publish()`** on a community the client has never loaded: they reject with this error right after the first failed cycle instead of waiting the full `community-ipns` timeout (5 minutes by default). Nothing within that window changes which addresses the providers announce.
-   **Kubo RPC clients** (`kuboRpcClientsOptions`) and **IPFS gateways** never produce this error. Kubo does its own routing and hole punching and hides the provider list, and a gateway cannot see providers at all.

## How to fix it

Pick whichever side you control.

**You run the community.**

-   Give the node a public address: forward the libp2p port on your router, enable UPnP, or host it on a VPS. Once Kubo's AutoNAT reports `Public`, it announces direct addresses and browsers can connect.
-   Browsers need a WebSocket Secure (`/wss`) or WebTransport (`/webtransport` with certhashes) address as well. Kubo announces WebTransport by default on UDP 4001; some networks filter that port, so also listen on UDP 443 (`bitsocial reachability setup` adds both, and serves `/wss` through an IP certificate). Kubo's AutoTLS provides `/wss` automatically on a publicly reachable node.
-   Or have a publicly reachable node seed the community with [bitsocial-seeder](https://github.com/bitsocialnet/bitsocial-seeder). Seeders announce themselves as providers, so clients load the community from them even while the owner's node stays behind NAT.

**You are trying to load or post to the community.**

-   Use a client that runs a local Kubo node, such as the Bitsocial desktop app or `bitsocial-cli`. Kubo reaches NAT-hosted peers through relays and hole punching.
-   Or ask the community's owner to do one of the above.

## Where the check lives

The verdicts are computed in `directFetchIpnsRecordFromProviders` (`src/helia/util.ts`) from each provider record's addresses, `libp2p.isDialable()` (transport match plus connection gater) and whether a dial ever reached a real address. `summarizeProviderReachability` turns them into the `reason`. The error is thrown by the libp2p-js IPNS resolver in `src/helia/helia-for-pkc.ts` only when every provider failed a local check and no subscriber was reached. A provider whose dial merely failed on the wire keeps the generic `ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED`, which now also carries `providersFound`.

Hole punching from a Node.js libp2p-js client is tracked in issue #391. Until that lands, "cannot connect from this client" is true for Node.js libp2p-js clients as well as browsers.

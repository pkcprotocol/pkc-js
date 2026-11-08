# Reachability: why a community loads on one client and not on another

A community is served by whatever nodes announce themselves as providers of its IPNS record: the node that runs it, and any node that seeds it. A client can only load the community if it can open a direct connection to at least one of those providers. Whether it can depends on two things the client checks locally, before any network round trip:

1. **What addresses the providers announce.** A node behind NAT (a home router, carrier-grade NAT, a mobile hotspot, no port forwarding or UPnP) cannot be reached from the outside. Kubo detects this (AutoNAT reports `Private`) and announces only `/p2p-circuit` addresses, meaning "reach me through this relay".
2. **What transports the client has.** A browser can only open WebSocket Secure (`/tls/ws`), WebTransport and WebRTC connections, and pkc-js browsers dial WebSocket Secure only by default (see [What a seeder must announce](#what-a-seeder-must-announce-to-be-browser-dialable)). A Node.js libp2p-js client can also open TCP. Kubo can open everything, including relayed connections that it then upgrades to direct ones by hole punching.

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
-   Browsers need a WebSocket Secure (`/tls/ws`) address behind a certificate they trust, and a WebTransport address on UDP 443 as well as 4001. The section [What a seeder must announce](#what-a-seeder-must-announce-to-be-browser-dialable) lists exactly what, and how to verify it. `bitsocial reachability setup` (bitsocial-cli) configures all of it on a kubo node.
-   Or have a publicly reachable node seed the community with [bitsocial-seeder](https://github.com/bitsocialnet/bitsocial-seeder). Seeders announce themselves as providers, so clients load the community from them even while the owner's node stays behind NAT.

**You are trying to load or post to the community.**

-   Use a client that runs a local Kubo node, such as the Bitsocial desktop app or `bitsocial-cli`. Kubo reaches NAT-hosted peers through relays and hole punching.
-   Or ask the community's owner to do one of the above.

## What a seeder must announce to be browser-dialable

This is the contract between pkc-js browsers and the nodes that serve communities (the community's own node and every [bitsocial-seeder](https://github.com/bitsocialnet/bitsocial-seeder)). `bitsocial reachability` in bitsocial-cli implements it; the probe below checks it. A provider record that satisfies it lets a browser connect in one dial; a provider that announces only `/tcp/4001` and `/udp/4001/quic-v1` is invisible to every browser, however healthy the node is.

A browser can open exactly three kinds of libp2p connection: WebSocket Secure, WebTransport and WebRTC. pkc-js dials WebSocket Secure by default and denies WebRTC and WebTransport in its connection gater (`src/helia/dial-transport-filter.ts`, decided in #166; WebTransport is being re-enabled under #475). So the record must carry, in this order of importance:

1. **A WebSocket Secure address on TCP 443 behind a certificate browsers trust.** The multiaddr ends in `/tcp/443/tls/ws` (older records write `/wss`). Two valid forms:

    - `/ip4/<public ip>/tcp/443/tls/ws` and `/ip6/<public ip>/tcp/443/tls/ws`: a Let's Encrypt certificate for the bare IP address (`shortlived` profile, 6 days, renewed automatically), terminated by a TLS proxy on the node that forwards to a plain `/ws` swarm listener on loopback. No DNS is involved, so a DNS outage cannot take it down. This is what `bitsocial reachability setup` does.
    - `/dns4/<name>/tcp/443/tls/ws` and `/dns6/<name>/tcp/443/tls/ws`: a name the operator controls with its own certificate, or kubo AutoTLS's `<ip>.<peer id>.libp2p.direct` name. AutoTLS listens on 4001 by default; move it to 443, because corporate and mobile networks that allow outbound 443 only are common. AutoTLS depends on a single third-party zone that was unreachable for a week in November 2026, so a node that relies on it alone is one registrar change away from vanishing for browsers.

    A plain `/ws` address does not count: an https page cannot open an unencrypted WebSocket. The certificate must chain to a public CA; a self-signed certificate fails in the browser before libp2p ever runs.

2. **WebTransport addresses with certhashes, on UDP 443 as well as UDP 4001, over IPv4 and IPv6.** `/ip4/<ip>/udp/443/quic-v1/webtransport/certhash/<hash>/certhash/<hash>` plus the `/ip6/` twin, in addition to the default `/udp/4001` ones. Kubo adds the two certhashes itself (the current and the next certificate, rotated every 14 days) when the listener is in `Addresses.Swarm`; a WebTransport address without them is undialable. The second port exists because some consumer ISPs drop IPv4 UDP to port 4001 while UDP 443 (HTTP/3) passes, measured in #475; a global IPv6 address is a complete fix on its own where the host has one. In kubo config this is four lines:

    ```json
    "/ip4/0.0.0.0/udp/443/quic-v1", "/ip4/0.0.0.0/udp/443/quic-v1/webtransport",
    "/ip6/::/udp/443/quic-v1",      "/ip6/::/udp/443/quic-v1/webtransport"
    ```

3. **Direct addresses only.** A node whose record contains nothing but `/p2p-circuit` relay addresses is behind NAT and is not a provider for any browser or libp2p-js client (`reason: "relay-only-providers"` above). AutoNAT must report `Public`, or the port must be forwarded.

4. **Announced to the HTTP routers, and kept fresh.** pkc-js browsers do not run the DHT; they ask the delegated HTTP routers (`httpRoutersOptions`) for the providers of the community's IPNS-over-pubsub topic, and those routers serve only what nodes announce to them. A stock kubo reprovides to the DHT alone; it announces to an HTTP router only when that router is in its `Routing.Routers` with `provide` among the `Routing.Methods` (bitsocial-cli writes the pkc-js default routers there on init). Each router keeps an announcement for 24 hours, so a node that changes its public IP or restarts with new WebTransport certificates must reannounce within that window. When the TLS proxy terminates WebSocket Secure, the address is announced through `Addresses.AppendAnnounce` (kubo cannot discover it), and the `server` profile's `/ip4/127.0.0.0/ipcidr/8` entry in `Swarm.AddrFilters` must go, or kubo's gater refuses the proxied connections arriving from loopback.

What does not help a browser: `/tcp/4001`, `/udp/4001/quic-v1` without `/webtransport`, `/webrtc-direct` (denied by pkc-js, #166), relay addresses, and WebSocket Secure on a port other than 443 for clients on restrictive networks.

### Verifying it

Run the browser-transport-only probe from `test/manual-e2e/` against a community's public key or against a provider's multiaddrs. It dials every WebSocket Secure address with full certificate verification from a libp2p node gated like a browser, and sends a QUIC version-negotiation packet to every WebTransport endpoint:

```bash
E2E_TARGETS=<community publicKey> node test/run-test-config.js --pkc-config local-kubo-rpc test/manual-e2e/browser-reachability.e2e.test.ts
E2E_PEERS=/ip4/<ip>/tcp/443/tls/ws/p2p/<peer id>,/ip4/<ip>/udp/443/quic-v1/webtransport/certhash/<h>/certhash/<h>/p2p/<peer id> node test/run-test-config.js --pkc-config local-kubo-rpc test/manual-e2e/browser-reachability.e2e.test.ts
```

It prints one verdict per provider (dialable from pkc-js browsers today, dialable once WebTransport is allowed, IPv6, UDP 443) with the operator-facing problems found, and writes a JSON report under `.tmp/` for the external monitor (bitsocialnet/bitsocial-web#55).

What a pass means: with the default `E2E_REQUIRE=wss` the test passes as soon as `E2E_MIN_PROVIDERS` (default 1) providers have a WebSocket Secure address that dialed, which is what a pkc-js browser can use today. WebTransport, UDP 443 and IPv6 are reported and listed under each provider's problems but not asserted; `E2E_REQUIRE=webtransport` asserts the QUIC probe instead. Read the problems list to check the whole contract above.

What the UDP probe can and cannot tell: a reply that is a QUIC Version Negotiation packet proves a QUIC listener answers at that address from this network; it does not run the WebTransport handshake or validate the certhashes, so "dialable with WebTransport" in the report means "a browser would get as far as the handshake". A timeout means the UDP path or the node is unavailable from this network, not which one. Results depend on the network the probe runs from: a UDP 4001 endpoint that is dead from one ISP and alive from another is exactly the case the 443 listeners exist for.

## Where the check lives

The verdicts are computed in `directFetchIpnsRecordFromProviders` (`src/helia/util.ts`) from each provider record's addresses, `libp2p.isDialable()` (transport match plus connection gater) and whether a dial ever reached a real address. `summarizeProviderReachability` turns them into the `reason`. The error is thrown by the libp2p-js IPNS resolver in `src/helia/helia-for-pkc.ts` only when every provider failed a local check and no subscriber was reached. A provider whose dial merely failed on the wire keeps the generic `ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED`, which now also carries `providersFound`.

Hole punching from a Node.js libp2p-js client is tracked in issue #391. Until that lands, "cannot connect from this client" is true for Node.js libp2p-js clients as well as browsers.

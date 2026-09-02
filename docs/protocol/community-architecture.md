# Community Architecture

## Summary

A community has four class variants depending on who owns it and how it's accessed. `LocalCommunity` runs on Node.js and owns the IPNS key. `RemoteCommunity` subscribes to a community read-only. Two RPC variants let browser clients access communities through a WebSocket server.

## Class Hierarchy

| Class | File | Use Case |
|-------|------|----------|
| `RemoteCommunity` | `src/community/remote-community.ts` | Read-only subscriber: fetches CommunityIpfsType from IPNS |
| `RpcRemoteCommunity` | `src/community/rpc-remote-community.ts` | Browser reading a remote community via RPC server |
| `RpcLocalCommunity` | `src/community/rpc-local-community.ts` | Browser managing an owned community via RPC server |
| `LocalCommunity` | `src/runtime/node/community/local-community.ts` | **Node-only**: owns the IPNS key, manages DB, publishes updates |

### When Each Is Used

- **Node.js, own community**: `LocalCommunity`, can `start()`, publish IPNS, process challenges
- **Node.js, reading someone else's community**: `RemoteCommunity`, can `update()`, subscribe to changes
- **Browser via RPC, own community**: `RpcLocalCommunity`, delegates to RPC server's `LocalCommunity`
- **Browser via RPC, reading**: `RpcRemoteCommunity`, delegates to RPC server's `RemoteCommunity`

## CommunityIpfsType

The `CommunityIpfsType` record is what gets published to IPNS. It's the community's current state snapshot, signed by the community owner:

- `name`: optional domain name (wire field)
- `title`, `description`, `rules[]`: community metadata
- `roles`: `{ [authorAddress]: { role: "owner" | "admin" | "moderator" } }`
- `challenges[]`: configured challenge system
- `features`: feature flags (requirePostLink, noVideos, etc.)
- `suggested`: suggested client settings (primaryColor, language, etc.)
- `encryption`: public key for encrypted challenge exchanges
- `posts`: pre-loaded first pages + `pageCids` for pagination
- `stats`: hourly/daily/weekly/monthly/yearly/all-time post, reply, and active user counts
- `createdAt`, `updatedAt`, `protocolVersion`, `signature`

## State Machines

State types are defined in `src/community/types.ts`.

### CommunityState (main)
`"stopped"` | `"updating"` | `"started"`

### CommunityUpdatingState (during `update()`)
`"stopped"` → `"resolving-name"` → `"fetching-ipns"` → `"fetching-ipfs"` → `"succeeded"` / `"failed"` → `"waiting-retry"`

During `"fetching-ipns"` the IPNS name may resolve through a **delegated chain**
(`/ipns/anchor` → `/ipns/minter` → `/ipfs/cid`). The resolved chain is exposed as
`RemoteCommunity.ipnsHops`; identity stays the anchor (`ipnsHops[0]`) while the content is
verified against the terminal/minter name (`ipnsHops.at(-1)`). See
[delegated-ipns.md](delegated-ipns.md).

#### The update loop is push-driven on both P2P resolvers

`startUpdatingLoop` (`src/community/community-client-manager.ts`) does not poll every second.
When the default record resolver exposes `ipnsRecordArrivals` (the libp2p-js client since
issue #308, the kubo-RPC client since issue #322) the loop subscribes to the IPNS-over-pubsub
record topic of every hop in `ipnsHops`, parks until a pushed record arrives, and otherwise
runs one jittered safety-net cycle per `pkc.updateInterval` (0.75x to 1.25x, so a directory
of communities does not tick in lockstep). Gateways poll at `pkc.updateInterval`.

- **libp2p-js**: arrivals are observed at the pubsub router's `localStore.put`, so an
  arrival-woken cycle reads the routing-layer cache; a timer-fired cycle forces a network
  revalidation, floored at 30s.
- **kubo-RPC**: arrivals are one `pubsub.subscribe` RPC stream per record topic on the
  resolver daemon (`src/clients/kubo-ipns-record-arrivals.ts`); every resolve stays
  `nocache: true`, which on kubo is a local namesys-store read. **Ordering rule**: a topic is
  armed only after a resolve of this manager walked its name (from inside the same cycle,
  right after the resolve, so the community IPFS fetch that follows already has a listener),
  and a dead stream is dropped before the next resolve and re-armed after it. The first cycle
  never runs twice to compensate for starting unarmed: a second cycle would emit a second
  `fetching-ipns` per community start, which comments and publications mirror into their own
  state sequences. An RPC subscription that joins a record
  topic before kubo's namesys permanently blocks namesys from joining that name on that
  daemon (`name.resolve` fails until restart), so never subscribe to an IPNS record topic
  over the kubo RPC ahead of resolving the name. While any hop has no live stream (pubsub
  disabled on the daemon, daemon restarting) the loop falls back to the pre-#322 1s poll.

### CommunityStartedState (during `start()`, `LocalCommunity` only)
`"stopped"` → `"publishing-ipns"` → `"succeeded"` / `"failed"`

## LocalCommunity Internals

- **Database**: SQLite at `${dataPath}/communities/${address}`
- **Tables** (see `TABLES` in `src/runtime/node/community/db-handler.ts`): `comments`, `commentUpdates`, `votes`, `commentModerations`, `commentEdits`, `pseudonymityAliases`
- **IPNS Publishing**: Periodically publishes updated `CommunityIpfsType` to IPNS
- **Challenge Processing**: Receives encrypted challenge requests from pubsub, processes them
- **Page Generation**: Rebuilds sorted/paginated pages when comments change (`src/runtime/node/community/page-generator.ts`)

## Key Invariants

- `LocalCommunity` lives under `src/runtime/node/`, it **must not** be imported from browser code.
- Tests using `LocalCommunity` must be placed in `test/node/`, not `test/node-and-browser/`.
- `community.address` is immutable and runtime-only (see `wire-vs-runtime.md`).
- Internal state fields (prefixed with `_`) are never transmitted to RPC clients.

## Events

All community variants emit:
- `update`: new `CommunityIpfsType` received
- `statechange`, `updatingstatechange`: state transitions
- `error`: errors during update/start
- `challengerequest`, `challenge`, `challengeanswer`, `challengeverification`: challenge flow events (`LocalCommunity`/`RpcLocalCommunity`)
- `startedstatechange`: `LocalCommunity`/`RpcLocalCommunity` only

## Common Mistakes

- Importing `LocalCommunity` in browser-compatible code, it's Node-only.
- Using `getCommunity()` in tests instead of `createCommunity() + update()`, `getCommunity` does a one-shot fetch that fails randomly in CI.
- Confusing `CommunityIpfsType` (wire format, signed snapshot) with the `RemoteCommunity` class (runtime object with state tracking, events, clients).

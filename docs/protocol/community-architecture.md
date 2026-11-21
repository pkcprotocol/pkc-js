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
- `suggested`: suggested client settings (primaryColor, language, uiType, etc.)
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

### CommunityStartedState (during `start()`, `LocalCommunity` only)
`"stopped"` → `"publishing-ipns"` → `"succeeded"` / `"failed"`

## LocalCommunity Internals

- **Database**: SQLite at `${dataPath}/communities/${address}`
- **Tables** (see `TABLES` in `src/runtime/node/community/db-handler.ts`): `comments`, `commentUpdates`, `votes`, `commentModerations`, `commentEdits`, `pseudonymityAliases`
- **IPNS Publishing**: Periodically publishes updated `CommunityIpfsType` to IPNS
- **Challenge Processing**: Receives encrypted challenge requests from pubsub, processes them
- **Page Generation**: Rebuilds sorted/paginated pages when comments change (`src/runtime/node/community/page-generator.ts`)

## The communities registry

Which local communities a data path holds, and which PKC instance has started each, is kept in two tables of `${dataPath}/storage.db` (`src/runtime/node/community/communities-registry.ts`, issue #585). `pkc.communities`, the local-or-remote decision of `pkc.createCommunity`, `community.started` and the RPC server's lookups all read it. None of them lists `dataPath/communities`.

- **The DB files are the truth, the registry is their index.** A file with no row gets one, a row whose file is gone is removed. Creating a community writes the file first and the row second. A DB file deleted by hand under a running community gets no special handling: its row goes, and the community fails on its own.
- **One row per DB file**: its filename (the community's address), its identity key, and `startedBy`, the id of the PKC instance that started it. A DB whose identity can't be read yet (mid-creation, mid-migration, corrupt) may have a row with no key, and is left out of `pkc.communities` until it can.
- **`started`** means `startedBy` names an instance whose lock is held. Each PKC instance holds one kernel lock for its lifetime (`pkc-instance-lock.ts`), however many communities it runs. `start()` claims the row in one SQLite write transaction, which is atomic across processes, and takes it over from an instance that died. `stop()` gives it back. There is no lock file per community.
- **A started community checks at each publish cycle that it is still its instance's.** If another live instance has it claimed, it emits `ERR_COMMUNITY_START_TAKEN_BY_ANOTHER_PKC_INSTANCE` and stops itself, so two instances never keep publishing one community.
- **The directory is listed once per PKC**, when it is created, and again only for a filesystem event that does not name its file. Any other event concerns one file: ignored when the file has a row and is still there (so a write to a community's DB costs one lookup in memory), registered when it has none (so a DB moved or copied in by hand is picked up when its last write lands).
- **What another PKC instance on the data path does reaches `pkc.communities` within about two seconds** (`COMMUNITIES_REGISTRY_TICK_MS`). SQLite does not notify another process of a write, and a killed process writes nothing, so every instance reads the rows changed since its last read, and tries the lock of each other instance that has communities started, on a timer. What an instance does itself is in its own list at once. Only the list can be late: `start()`, `createCommunity()` and `community.started` read the tables.
- **A filesystem event the kernel drops** (Linux drops events past 16,384 queued, with no error) leaves `pkc.communities` without a DB that was copied in by hand, until that file's next event or the next PKC on the data path. `createCommunity({ address })` finds the file all the same.
- Every process on a data path must run the same pkc-js version, and the data path must be on a local filesystem.

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

## RPC Connection Loss

The RPC server ties every subscription to one websocket connection and drops them all when it closes. It keeps no events for a disconnected client. `PKCRpcClient` hides this from the instances (#425):

- It retries the connection forever, with a backoff that doubles from 1s up to 30s, so a client survives a server restart or a laptop suspend. This includes a clean close with code 1000, which is what a server shutting down sends and which `rpc-websockets` would not retry on its own (#479). Only `pkc.destroy()` or a 403 from the server ends the retries.
- `state` goes `connected`, `stopped`, `connecting`, and stays `connecting` until a reconnect succeeds. A lasting `stopped` means nothing is trying to connect, and `failed` means the client will not retry, which today is only that 403.
- Every failed reconnect attempt emits `ERR_RPC_RECONNECT_FAILED` on `pkc.on("error")`, with `rpcServerUrl`, `closeCode`, `closeReason`, `attempt`, `nextRetryMs` and the underlying `error` in `details`. A drop that recovers on the first try emits no error, because the re-issued subscriptions lose nothing.
- A call still waiting for its response when the socket closes rejects with `ERR_RPC_CONNECTION_LOST`. The server may already have run it, so check before repeating anything that is not safe to run twice. Every call made during an outage waits up to 20s for the connection, then throws `ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC`. After a 403 calls fail right away.
- After each reconnect it re-issues every live subscription (`update()`, `start()`, `community.exports`, the communities and settings lists). The server sends its current snapshot on subscribe, so each instance returns to the latest state. The events that happened during the gap are not replayed one by one.
- The communities and settings subscriptions run in the background with no caller to retry them, so one whose first attempt fails with the connection is issued again on the next open. This covers a server that was down when the client started. A subscription that the server rejects while the client is connected is not retried.
- `start()` is re-established with `startedCommunitySubscribe`, never `startCommunity`, so a reconnect never undoes a stop. If someone stopped the community on purpose, even while the client was away, the client gets `startedState: "stopped"` and does not try again. A community the server lost without a stop (a server restart) is started again.
- Instances keep the subscription id they got first. The client maps the server's new id back to it, so nothing outside `PKCRpcClient` sees the change.
- A publication in flight when the connection closes fails with `ERR_RPC_PUBLICATION_LOST_WITH_CONNECTION` and `publishingState: "failed"`. The server stopped it, and re-publishing automatically would start a challenge exchange the user never saw. To publish it again, create a new instance (`pkc.createComment(comment.raw.pubsubMessageToPublish)` for the same signed publication) and call `publish()` on that: a publication instance publishes once.
- `pkc.destroy()` closes the socket and cancels any pending reconnect attempt.

## Common Mistakes

- Importing `LocalCommunity` in browser-compatible code, it's Node-only.
- Using `getCommunity()` in tests instead of `createCommunity() + update()`, `getCommunity` does a one-shot fetch that fails randomly in CI.
- Confusing `CommunityIpfsType` (wire format, signed snapshot) with the `RemoteCommunity` class (runtime object with state tracking, events, clients).

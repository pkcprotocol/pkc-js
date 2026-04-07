# Subplebbit Architecture

<!-- Note: "subplebbit" is being renamed to "community" — see RENAMING_GUIDE.md -->

## Summary

A subplebbit (community) has four class variants depending on who owns it and how it's accessed. `LocalSubplebbit` runs on Node.js and owns the IPNS key. `RemoteSubplebbit` subscribes to a community read-only. Two RPC variants let browser clients access communities through a WebSocket server.

## Class Hierarchy

| Class | File | Use Case |
|-------|------|----------|
| `RemoteSubplebbit` | `src/subplebbit/remote-subplebbit.ts` | Read-only subscriber — fetches SubplebbitIpfs from IPNS |
| `RpcRemoteSubplebbit` | `src/subplebbit/rpc-remote-subplebbit.ts` | Browser reading a remote community via RPC server |
| `RpcLocalSubplebbit` | `src/subplebbit/rpc-local-subplebbit.ts` | Browser managing an owned community via RPC server |
| `LocalSubplebbit` | `src/runtime/node/subplebbit/local-subplebbit.ts` | **Node-only** — owns the IPNS key, manages DB, publishes updates |

### When Each Is Used

- **Node.js, own community**: `LocalSubplebbit` — can `start()`, publish IPNS, process challenges
- **Node.js, reading someone else's community**: `RemoteSubplebbit` — can `update()`, subscribe to changes
- **Browser via RPC, own community**: `RpcLocalSubplebbit` — delegates to RPC server's LocalSubplebbit
- **Browser via RPC, reading**: `RpcRemoteSubplebbit` — delegates to RPC server's RemoteSubplebbit

## SubplebbitIpfs

The `SubplebbitIpfs` record is what gets published to IPNS. It's the community's current state snapshot, signed by the community owner:

- `name` — optional domain name (wire field)
- `title`, `description`, `rules[]` — community metadata
- `roles` — `{ [authorAddress]: { role: "owner" | "admin" | "moderator" } }`
- `challenges[]` — configured challenge system
- `features` — feature flags (requirePostLink, noVideos, etc.)
- `suggested` — suggested client settings (primaryColor, language, etc.)
- `encryption` — public key for encrypted challenge exchanges
- `posts` — pre-loaded first pages + `pageCids` for pagination
- `stats` — hourly/daily/weekly/monthly/yearly/all-time post, reply, and active user counts
- `createdAt`, `updatedAt`, `protocolVersion`, `signature`

## State Machines

### SubplebbitState (main)
`"stopped"` | `"updating"` | `"started"`

### SubplebbitUpdatingState (during `update()`)
`"stopped"` → `"resolving-name"` → `"fetching-ipns"` → `"fetching-ipfs"` → `"succeeded"` / `"failed"` → `"waiting-retry"`

### SubplebbitStartedState (during `start()`, LocalSubplebbit only)
`"stopped"` → `"publishing-ipns"` → `"succeeded"` / `"failed"`

## LocalSubplebbit Internals

- **Database**: SQLite at `${dataPath}/communities/${address}`
- **Tables**: `comments`, `commentUpdates`, `commentEdits`, `posts`, `subplebbits` (internal state)
- **IPNS Publishing**: Periodically publishes updated `SubplebbitIpfs` to IPNS
- **Challenge Processing**: Receives encrypted challenge requests from pubsub, processes them
- **Page Generation**: Rebuilds sorted/paginated pages when comments change (`src/runtime/node/subplebbit/page-generator.ts`)

## Key Invariants

- `LocalSubplebbit` lives under `src/runtime/node/` — it **must not** be imported from browser code.
- Tests using `LocalSubplebbit` must be placed in `test/node/`, not `test/node-and-browser/`.
- `subplebbit.address` is immutable and runtime-only (see `wire-vs-runtime.md`).
- Internal state fields (prefixed with `_`) are never transmitted to RPC clients.

## Events

All subplebbit variants emit:
- `update` — new SubplebbitIpfs received
- `statechange`, `updatingstatechange` — state transitions
- `error` — errors during update/start
- `challengerequest`, `challenge`, `challengeanswer`, `challengeverification` — challenge flow events (LocalSubplebbit/RpcLocalSubplebbit)
- `startedstatechange` — LocalSubplebbit/RpcLocalSubplebbit only

## Common Mistakes

- Importing `LocalSubplebbit` in browser-compatible code — it's Node-only.
- Using `getSubplebbit()` in tests instead of `createSubplebbit() + update()` — `getSubplebbit` does a one-shot fetch that fails randomly in CI.
- Confusing `SubplebbitIpfs` (wire format, signed snapshot) with the `RemoteSubplebbit` class (runtime object with state tracking, events, clients).

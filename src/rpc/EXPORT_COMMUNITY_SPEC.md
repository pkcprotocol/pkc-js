# Community Export Specification

This document describes the design of the `community.export()` feature added in [issue #79](https://github.com/pkcprotocol/pkc-js/issues/79). It supersedes any earlier draft of this file.

## Public API

The export feature lives entirely on `Community` (every variant: `LocalCommunity`, `RemoteCommunity`, `RpcLocalCommunity`, `RpcRemoteCommunity`). PKC has no `exportCommunity`/`cancelExport` methods — exports are per-community.

```ts
community.export(options?: ExportCommunityUserOptions): Promise<{ exportId: string }>
community.exports: CommunityExportRecord[];
community.on("exportschange", (records: CommunityExportRecord[]) => void): this;
```

`community.export()` validates the request and returns a fresh `exportId` once the work is enqueued. The actual backup runs asynchronously; observers watch progress and completion through `community.exports` and the `exportschange` event. Cancellation is exclusively via `options.signal`.

### Types

```ts
export interface ExportCommunityUserOptions {
    includePrivateKey?: boolean;  // default false
    exportPath?: string;          // EMBEDDED MODE ONLY. Throws in RPC-client mode.
                                  // Default: <pkcDataPath>/exports/<exportId>.sqlite.
    signal?: AbortSignal;         // Optional. If already aborted at call time,
                                  // the promise rejects with signal.reason and no
                                  // record is created. This is the only way to
                                  // cancel an export.
}

export interface CommunityExportRecord {
    exportId: string;             // UUIDv4 generated when community.export() is called
    name?: string;                // community name, if it has one
    publicKey: string;            // community public key
    includePrivateKey: boolean;   // echoes the request option

    progress: number;             // 0..1; 1 means complete

    // present once progress === 1:
    size?: number;                // bytes
    sha256?: string;              // hex
    url?: string;                 // consumer-resolvable:
                                  //   - embedded: file:///<absolute-path>
                                  //   - RPC client view: http(s)://<server-origin>/exports/<exportId>

    // present if the export failed (also covers cancellation):
    error?: { code: string; message: string };
}
```

### Inferring state from the record

Per the design discussion on issue #79, the record intentionally does not carry an explicit state enum or progress-internal counters (`pagesCopied`, `totalPages`, `startedAt`, `completedAt`). Consumers infer state purely from `progress` and `error`:

| State        | How to detect                              |
|--------------|--------------------------------------------|
| in progress  | `progress < 1 && !error`                   |
| complete     | `progress === 1`                           |
| failed       | `error !== undefined`                      |
| cancelled    | `error?.code === "ERR_EXPORT_CANCELLED"`   |

If a future need arises for a finer-grained state (e.g. additional states beyond "in progress" / "failed" / "succeeded"), adding a `state` field is backwards-compatible.

### Validation: sync vs async

- **Synchronous (rejects the `community.export()` promise before any record is created):**
  - Community is not a `LocalCommunity` on this daemon (e.g. it's a read-only `RemoteCommunity`).
  - `includePrivateKey: true` but RPC server policy disallows it.
  - `exportPath` provided but caller is using an RPC client.
  - `options.signal` is already aborted (rejects with `signal.reason`).

- **Asynchronous (creates a record with `error` set and fires `exportschange`):**
  - Disk full while writing the sqlite backup.
  - Source DB read errors mid-backup.
  - Any other failure after the work was enqueued.

### Cancellation

Cancellation is exclusively via the `signal` option:

```ts
const ac = new AbortController();
const { exportId } = await community.export({ signal: ac.signal });
// ...later, anywhere we still hold `ac`...
ac.abort();
```

Behavior:
- Aborting while in progress stops the sqlite backup, unlinks the `.partial` file, sets `error.code = "ERR_EXPORT_CANCELLED"`, fires `exportschange`.
- Aborting after the export is already complete is a no-op (idempotent).

The AbortSignal lifetime intentionally outlives the `community.export()` promise: the promise resolves once the export is enqueued (returning `{ exportId }`), but the signal stays observed by the underlying backup task until terminal state. Same pattern as `node:fs.watch(path, { signal })` and `fetch(url, { signal })` for streaming responses.

There is no public `cancelExport(exportId)` method. Internally the RPC client uses a wire-level `cancelExport({ exportId })` to translate `signal.abort()` into a server-side cancel.

### Identifiers and URLs

- `exportId` (UUIDv4) is the canonical identifier returned to the caller and used in URLs, filenames, log lines, and `_activeExports` map keys.
- On-disk filename: `<exportId>.sqlite` under `<pkcDataPath>/exports/`. Caller-supplied `exportPath` (embedded only) overrides this.
- RPC download URL path: `/exports/<exportId>`. The wire-format `record.url` is a **relative URL** (`/exports/<exportId>`); the RPC client absolutizes via `new URL(wireUrl, rpcHttpOrigin).href` before exposing to the consumer, where `rpcHttpOrigin` is the WebSocket URL with `ws[s]://` swapped to `http[s]://` and any `authKey` path stripped.
- Embedded mode emits an absolute `file://` URL directly.
- Consumer code branches on `new URL(record.url).protocol === "file:"` and uses `fileURLToPath()` for `fs.*` calls; otherwise `fetch()`.

### Integration with `pkc.destroy()`

Each `LocalCommunity` keeps a private `_activeExports: Map<string, InternalExportHandle>` keyed by `exportId`. Each enqueued export adds an entry; terminal transitions remove it. `pkc.destroy()` walks every community's `_activeExports` and cancels everything in flight before the existing teardown.

On the RPC server side, `PKCWsServer.close()` likewise cancels per-connection subscriptions.

## RPC Wire Protocol

Three new RPC methods. `AbortSignal` is a client-side concept and never crosses the wire — when an RPC-side `community.export({ signal })` caller's signal aborts, the RPC client routes that to a `cancelExport` call.

### `exportCommunity({ name?, publicKey?, includePrivateKey? })` → `{ exportId: string }`

- At least one of `name` or `publicKey` must be provided.
- Server resolves the community address using the existing `_findCommunityAddress({ name, publicKey })`.
- Validates community is a `LocalCommunity` (error `ERR_COMMUNITY_NOT_LOCAL` otherwise).
- If `includePrivateKey === true`, checks policy; on denial returns `ERR_PRIVATE_KEY_EXPORT_NOT_ALLOWED`.
- On success: generates `exportId`, appends a `progress: 0` record to that community's `exports`, kicks off the backup task, returns `{ exportId }` synchronously.

### `exportsSubscribe({ name?, publicKey? })` → subscription

- Per-community subscription.
- Initial notification carries the **current** `community.exports` array.
- Subsequent notifications fire whenever any record on the community changes.
- Notification shape: `event: "exportschange"`, `result: CommunityExportRecord[]`.
- The wire-format `record.url` is a **relative URL** (`/exports/<exportId>`); the RPC client absolutizes.
- Tearing down the subscription does **not** cancel any in-flight exports.

### `cancelExport({ exportId })` → `void`

- Idempotent: unknown `exportId` returns success without action.
- Server stops the backup if running, unlinks the `.partial`, sets `error.code = ERR_EXPORT_CANCELLED`, fires `exportschange`.

### Disconnect behavior

On client disconnect, the server **does not** automatically cancel that client's exports. Records stay alive in `community.exports`; another client that subscribes will see them. The export feature exists partly to survive disconnects.

> **Future-work hook**: if `exportschange` notifications carrying full lists become bandwidth-heavy with many concurrent in-progress exports, we can split progress into a separate `exportProgressNotification` channel that carries `{ exportId, progress }` deltas without re-emitting the whole list. Backwards-compatible: the full-list `exportschange` would still fire on every terminal transition.

## Server-Side Backup (also used by embedded mode)

Helper in `src/runtime/node/util.ts`:

```ts
backupCommunityDb({ sourcePath, destPath, includePrivateKey, onProgress, signal }):
    Promise<{ size: number; sha256: string }>
```

`destPath` is whatever the caller decides:
- RPC server → always `<pkcDataPath>/exports/<filename>`.
- Embedded mode → caller-supplied `exportPath`, or `<pkcDataPath>/exports/<filename>` default.

Steps:
1. `mkdir -p path.dirname(destPath)`.
2. Open source DB with `better-sqlite3` (read-only; `.backup()` is safe under WAL — already used by the deletion path).
3. Call `sourceDb.backup(destPath + ".partial", { progress: onProgress })` in chunks; check `signal.aborted` between chunks and throw to cancel.
4. On completion, open the `.partial` copy, scrub private key if requested, close.
5. Compute sha256 of the finalized file.
6. `fs.rename(destPath + ".partial", destPath)` — atomic commit.
7. On any error, `unlink(destPath + ".partial")`.

### Private-key scrubbing (`includePrivateKey: false`)

The signer lives inside the `internalCommunity` KeyV record. With the backup DB open as a second `better-sqlite3` connection, read that record, set `signer.privateKey = undefined` (and `signer.ipfsKey` if present), write it back, close.

## Server-Side File Location & Naming

- Directory: `<pkcDataPath>/exports/` (sibling of `<pkcDataPath>/communities/`).
- On-disk filename: `<exportId>.sqlite`. Embedded callers can override the entire path with `exportPath`.
- Persistence: each community persists its `exports` array in its internal KeyV record so records survive process restart. On community load, the server prunes any records whose backing files no longer exist on disk.

### Retention

- **After successful HTTP download**: the RPC server deletes the export file once it finishes streaming the HTTP response, removes the record from `community.exports`, and fires `exportschange`.
- **Never-downloaded exports**: on RPC server startup, delete any files in `<pkcDataPath>/exports/` older than 24 hours and prune the matching records.
- **Embedded mode**: no auto-deletion. The record stays in `community.exports` indefinitely. User manages cleanup; deleting the file out-of-band will cause it to be pruned from `community.exports` on next community load.

## HTTP Download Endpoint

- Attached to the **same port as the WebSocket RPC**, via the `server` option already accepted by `RpcWebsocketsServer`. Construct a plain `http.Server`, register a `request` listener for `GET /exports/<exportId>`, then pass the server to `RpcWebsocketsServer` so the `upgrade` event routes WS traffic correctly.
- Returns `200` with `Content-Length` and `Content-Type: application/vnd.sqlite3`, streams file.
- After streaming completes successfully, server deletes the file, removes the record from `community.exports`, and fires `exportschange`.
- Unknown `exportId`: `404`.
- No range/resume in v1.

### Capability via `exportId`

The `exportId` is unguessable (UUIDv4 = 122 bits of entropy), so it doubles as the HTTP capability. No separate token map is needed; the URL path is just the `exportId` and the file on disk is `<exportId>.sqlite`. Records persist with the community's KeyV state, so capabilities survive RPC server restart automatically.

## Private Key Policy (RPC Server)

- Config flag on `pkcOptions.rpcServer`: `allowPrivateKeyExport` (default `true` — matches private-RPC scope).
- Public-RPC operators can set `allowPrivateKeyExport: false`; server rejects any `includePrivateKey: true` request with `ERR_PRIVATE_KEY_EXPORT_NOT_ALLOWED`.
- Embedded pkc-js (no RPC server) always honors `includePrivateKey`.

## Concurrency

- Per-community serialization. Server keeps a `Map<address, Promise<void>>` of in-flight backups. A second `community.export()` call for the same community immediately appends a record (`progress: 0`) and waits for the prior export to finish before stepping its own backup.
- Different communities export in parallel.

## File Format

Raw sqlite file (no wrapping).

- `better-sqlite3.backup()` already produces exactly a `.sqlite` file.
- Inspectable directly with the `sqlite3` CLI.
- Metadata (community address, signer if included) is already in the DB itself.
- Importing later = open the `.sqlite`, copy rows into `<newPkcDataPath>/communities/<address>`.

## Error Codes (in `src/errors.ts`)

Sync errors (thrown from `community.export()`):
- `ERR_COMMUNITY_NOT_LOCAL` — community doesn't correspond to a LocalCommunity on this daemon.
- `ERR_PRIVATE_KEY_EXPORT_NOT_ALLOWED` — server refused due to policy.
- `ERR_EXPORT_PATH_NOT_SUPPORTED_OVER_RPC` — caller used an RPC client and passed `exportPath`.

Async errors (recorded in `record.error.code`):
- `ERR_EXPORT_CANCELLED` — recorded when an `AbortSignal` aborts an in-progress record (or when `pkc.destroy()` cancels in-flight exports).
- `ERR_EXPORT_BACKUP_FAILED` — generic catch-all for `better-sqlite3.backup()` failures (disk full, source DB corruption, etc.); inspect `error.message` for specifics.

HTTP-only:
- `ERR_DOWNLOAD_EXPORT_ID_NOT_FOUND` — `GET /exports/<exportId>` hit but no record/file exists (404 to the caller; logged server-side with this code).

## Out of Scope (future work)

- `pkc.importCommunity()` — companion import.
- `pkc.deleteExport()` / `renameExport()` — explicit management APIs.
- Range/resume support on HTTP download.
- Splitting progress into a dedicated `exportProgressNotification` channel.
- `tar.gz` + manifest format version.
- Public/multi-tenant RPC host considerations (per-user quotas, auditing, per-user `community.exports` filtering).
- `bitsocial-cli` command (separate plan for the bitsocial-cli repo).

# Export Community Spec

## Public API
- `pkc.exportCommunity({ address: string, exportPath: string }): Promise<CommunityExport>`
- If the community is local to this instance (non-RPC client), it writes the backup to `exportPath` and returns
  `{ exportId, timestamp, size, url }` where `url` is `file:///...`.

## RPC Client Behavior
- `rpcClientPKC.exportCommunity({ address, exportPath })` does NOT send `exportPath` to the server.
- It calls RPC `/exportCommunity` with `{ address }`.
- Server runs local `pkc.exportCommunity` (using a server-chosen path), returns `{ exportId, timestamp, size }`.
- Client then calls `/exportCommunityDownloadSubscribe` with `{ address, exportId }` and streams bytes to the
  caller's `exportPath`.
- No progress events or progress fields anywhere.

## Data Model
- `CommunityExport` includes at least:
  - `exportId: string` (UUIDv4)
  - `timestamp: number` (seconds)
  - `size: number`
  - `url?: string`
- `community.exports` is stored in the internal community record in Keyv
  (`InternalCommunityRecordBeforeFirstUpdateType` and carried forward), not in the IPFS record.
- `community.exports` only contains completed exports (no progress).

## Limits
- Keep only the latest 5 exports per community (trim old entries when a new export completes).

## Out of Scope
- No extra endpoints or cleanup APIs beyond the above.

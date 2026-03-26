# DB Migration: subplebbitAddress → communityPublicKey/communityName

## Background

DB version 37 migrates the `subplebbitAddress` column in `comments`, `commentEdits`, and `commentModerations` tables to two new columns: `communityPublicKey` (IPNS key) and `communityName` (domain name).

## Migration Rules

- If `subplebbitAddress` was an IPNS key → `communityPublicKey = subplebbitAddress`
- If `subplebbitAddress` was a domain → `communityName = subplebbitAddress`, `communityPublicKey = NULL`
- At least one of `communityPublicKey` or `communityName` must be non-NULL (enforced by CHECK constraint)

## CID Reconstruction: Why subplebbitAddress is Preserved in extraProps

When a local subplebbit re-provides CommentIpfs to IPFS, it must reconstruct the **exact original JSON content** to match the original CID. If even one field differs, the CID changes and the content becomes unreachable under the old CID.

Old CommentIpfs records were stored with a `subplebbitAddress` field in their JSON. To reproduce the exact same CID:

1. During migration, the old `subplebbitAddress` value is copied into `extraProps.subplebbitAddress`
2. `deriveCommentIpfsFromCommentTableRow()` (in `src/runtime/node/util.ts`) spreads `extraProps` back into the CommentIpfs JSON, restoring the original `subplebbitAddress` field
3. This ensures the re-provided JSON matches the original, preserving the CID

### Old-format rows (migrated from v36)
- DB: `communityPublicKey` or `communityName` set, `extraProps.subplebbitAddress` preserved
- Derived CommentIpfs: includes `subplebbitAddress` from extraProps spread → CID matches original

### New-format rows (created on v37+)
- DB: `communityPublicKey`/`communityName` set, no `extraProps.subplebbitAddress`
- Derived CommentIpfs: includes `communityPublicKey`/`communityName` from schema fields → new CID format

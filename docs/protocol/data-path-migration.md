# Data Path Migration Guide

Guide for downstream applications (plebbit-cli, desktop apps) migrating from the old directory layout to the new one.

## What Changed

| Item | Old | New |
|------|-----|-----|
| Default data directory | `${cwd}/.plebbit` | `${cwd}/.pkc` |
| Community databases subdirectory | `subplebbits/` | `communities/` |
| Deleted communities backup | `subplebbits/deleted/` | `communities/deleted/` |
| Package name | `@plebbit/plebbit-js` | `@pkc/pkc-js` |

The new directory layout:

```
.pkc/
  storage.db              # global storage database
  communities/            # community databases (one SQLite file per community address)
    <communityAddress>
    deleted/              # backup of deleted community databases
  lru-storage/            # LRU cache storage
  rpc-server/             # RPC server state (if running as RPC server)
    rpc-state.db
  .address-rewriter/      # address rewriter cache
```

## What pkc-js Handles Automatically

- **DB schema migration (v36 → v37)**: When pkc-js opens an existing community database, it automatically migrates `subplebbitAddress` to `communityPublicKey`/`communityName` columns. See `docs/protocol/db-subplebbit-address-migration.md` for details.
- **Storage keys**: Internal storage keys (e.g., `PERSISTENT_DELETED_COMMUNITIES`) have been renamed. Old keys with old names become orphaned but harmless.

## What Downstream Apps Must Handle

pkc-js does **not** rename directories on disk. Applications that use pkc-js must perform directory migration themselves, **before** creating a PKC instance.

### Migration Algorithm

```
On app startup, before creating PKC instance:

1. Determine the data path:
   - If the user configured a custom dataPath, use that
   - Otherwise, use the default: ${cwd}/.pkc

2. Check for old default directory:
   - If ${cwd}/.plebbit exists AND ${cwd}/.pkc does NOT exist:
     - Rename .plebbit/ → .pkc/
   - If BOTH exist:
     - Warn the user; do not overwrite

3. Inside the data directory, check for old subdirectory:
   - If ${dataPath}/subplebbits/ exists AND ${dataPath}/communities/ does NOT exist:
     - Rename subplebbits/ → communities/
   - If BOTH exist:
     - Warn the user; do not overwrite

4. Proceed to create the PKC instance with the (now migrated) dataPath
```

### Important Notes

- Migration must happen **before** creating the PKC instance. The constructor may create directories at the new paths if they don't exist, which would block migration.
- Lock files (`*.start.lock`, `*.state.lock`) inside the communities directory keep the same format — only the parent directory name changes.
- If the user provides a custom `dataPath` (not the default), only step 3 (subdirectory rename) applies.
- The `storage.db` file inside the data directory does not need renaming — it stays as-is.

### Example (Node.js)

```ts
import fs from "fs";
import path from "path";

function migrateDataPath(dataPath: string) {
    const oldSubdir = path.join(dataPath, "subplebbits");
    const newSubdir = path.join(dataPath, "communities");

    if (fs.existsSync(oldSubdir) && !fs.existsSync(newSubdir)) {
        fs.renameSync(oldSubdir, newSubdir);
    } else if (fs.existsSync(oldSubdir) && fs.existsSync(newSubdir)) {
        console.warn(
            `Both ${oldSubdir} and ${newSubdir} exist. ` +
            `Please manually resolve this before starting.`
        );
    }
}

function migrateDefaultDataDir(cwd: string) {
    const oldDefault = path.join(cwd, ".plebbit");
    const newDefault = path.join(cwd, ".pkc");

    if (fs.existsSync(oldDefault) && !fs.existsSync(newDefault)) {
        fs.renameSync(oldDefault, newDefault);
    } else if (fs.existsSync(oldDefault) && fs.existsSync(newDefault)) {
        console.warn(
            `Both ${oldDefault} and ${newDefault} exist. ` +
            `Please manually resolve this before starting.`
        );
    }

    const dataPath = fs.existsSync(newDefault) ? newDefault : oldDefault;
    if (fs.existsSync(dataPath)) {
        migrateDataPath(dataPath);
    }
}
```

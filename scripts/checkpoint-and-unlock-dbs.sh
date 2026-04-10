#!/bin/bash
# Properly close all SQLite databases by checkpointing WAL files
# and removing stale lock files.
#
# Usage: ./checkpoint-and-unlock-dbs.sh [directory]
# Default directory: /root/.local/share/bitsocial/communities/

set -euo pipefail

DIR="${1:-/root/.local/share/bitsocial/communities/}"

if [ ! -d "$DIR" ]; then
    echo "Error: directory '$DIR' does not exist"
    exit 1
fi

echo "Processing databases in: $DIR"
echo ""

success=0
failed=0
locks_removed=0

# Find all SQLite database files (exclude -shm, -wal, and .start.lock)
for db in "$DIR"/*; do
    # Skip non-files
    [ -f "$db" ] || continue
    # Skip WAL and SHM files
    case "$db" in
        *-wal|*-shm) continue ;;
    esac

    # Verify it's actually a SQLite database
    if ! file "$db" 2>/dev/null | grep -q "SQLite"; then
        continue
    fi

    basename=$(basename "$db")
    echo "--- $basename ---"

    # Checkpoint WAL (flush to main db and truncate WAL file)
    if sqlite3 "$db" "PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode=WAL;" 2>&1; then
        # Verify write access
        if sqlite3 "$db" "CREATE TABLE IF NOT EXISTS _write_test(x); DROP TABLE IF EXISTS _write_test;" 2>&1; then
            echo "  OK (checkpointed + writable)"
            success=$((success + 1))
        else
            echo "  WARNING: checkpointed but NOT writable"
            failed=$((failed + 1))
        fi
    else
        echo "  FAILED to checkpoint"
        failed=$((failed + 1))
    fi
    echo ""
done

# Remove stale .start.lock directories
for lockdir in "$DIR"/*.start.lock; do
    [ -d "$lockdir" ] || continue
    basename=$(basename "$lockdir")
    if rm -rf "$lockdir"; then
        echo "Removed lock: $basename"
        locks_removed=$((locks_removed + 1))
    else
        echo "Failed to remove lock: $basename"
    fi
done

echo ""
echo "=== Summary ==="
echo "Databases checkpointed: $success"
echo "Failed: $failed"
echo "Lock dirs removed: $locks_removed"

import path from "path";
import fs from "fs";
import Database, { type Database as BetterSqlite3Database } from "better-sqlite3";

// Whether a local community is started: its start lock is held by some process on this dataPath. community.started
// and the `started` of its pkc.communities entry (issue #455) both come from here, so they always agree.
//
// The lock is held in the kernel, the way Kubo holds repo.lock (issue #561). It is the exclusive file lock SQLite takes
// on a small database beside the community's own (`<address>.start.lock.db`, the sidecar), which the process running
// the community attaches to its connection to the community DB. The kernel drops that lock the moment the process dies
// (SIGKILL, an OOM kill, power loss) and never before, so a held lock always means a live process is running the
// community. The lock this replaced was a file whose holder refreshed its mtime from a timer: it still read "held" for
// 10s after its holder was killed (issue #546), and read "free" under a holder whose event loop was blocked that long.
//
// What keeps it correct:
// - The lock lives exactly as long as the connection it is attached to. Closing that connection releases it, and
//   better-sqlite3 closes a connection that is garbage collected, so the lock is attached to the community's own
//   connection, which a started community holds on to anyway (DbHandler refuses to close it while the lock is held).
// - Nothing in the holder's process may open the sidecar other than through SQLite. POSIX drops every lock a process
//   holds on a file when it closes any descriptor of that file, and only SQLite's own bookkeeping guards against that.
//   The directory listing in util.ts reads file headers with plain fs calls, and skips the sidecar by its name.
// - The sidecar is never deleted while its community exists. Unlinking it on release would let a second process lock
//   the unlinked file while a third creates and locks a new one at the same path.
// - dataPath must be on a local filesystem. File locks are unreliable on network filesystems (NFS, SMB).

const START_LOCK_SCHEMA = "startlock";
export const START_LOCK_FILE_SUFFIX = ".start.lock.db";

const TAKE_START_LOCK_BUSY_TIMEOUT_MS = 100;

type StartLockArgs = { dataPath: string; communityAddress: string };

export function getStartLockPath({ dataPath, communityAddress }: StartLockArgs): string {
    return path.join(dataPath, "communities", `${communityAddress}${START_LOCK_FILE_SUFFIX}`);
}

const isSqliteBusyError = (error: unknown): boolean =>
    typeof (error as { code?: unknown })?.code === "string" && (error as { code: string }).code.startsWith("SQLITE_BUSY");

// A read of the sidecar needs a shared lock, which the holder's exclusive lock refuses. Read-only and with no busy
// timeout, so the check changes nothing on disk and never waits.
export function isCommunityStartLockedSync(args: StartLockArgs): boolean {
    const startLockPath = getStartLockPath(args);
    if (!fs.existsSync(startLockPath)) return false; // never started
    let db: BetterSqlite3Database;
    try {
        db = new Database(startLockPath, { readonly: true, fileMustExist: true, timeout: 0 });
    } catch (e) {
        if (!fs.existsSync(startLockPath)) return false; // its community was deleted meanwhile
        if (isSqliteBusyError(e)) return true;
        throw e;
    }
    try {
        db.prepare("SELECT 1 FROM sqlite_master").get();
        return false;
    } catch (e) {
        if (isSqliteBusyError(e)) return true;
        throw e;
    } finally {
        db.close();
    }
}

export async function isCommunityStartLocked(args: StartLockArgs): Promise<boolean> {
    return isCommunityStartLockedSync(args);
}

export function isStartLockAttached(db: BetterSqlite3Database): boolean {
    return (db.pragma("database_list") as { name: string }[]).some((attached) => attached.name === START_LOCK_SCHEMA);
}

// Takes the start lock on `db`, the caller's connection to the community DB, and holds it until releaseStartLock() or
// until that connection closes. Returns false when another connection holds it, in this process or any other.
export function takeStartLock({ db, dataPath, communityAddress }: StartLockArgs & { db: BetterSqlite3Database }): boolean {
    if (db.readonly) throw Error("The start lock of a community can't be taken on a read-only connection to its DB");
    if (db.inTransaction) throw Error("The start lock of a community can't be taken inside a transaction");
    const busyTimeout = db.pragma("busy_timeout", { simple: true }) as number;
    // The wait is synchronous, so the connection's own timeout would block the event loop for seconds under a held lock.
    // Not zero either: a check from another process holds a shared lock on the sidecar for the length of one read, and
    // a start that ran into it would be refused as if the community were started
    db.pragma(`busy_timeout = ${TAKE_START_LOCK_BUSY_TIMEOUT_MS}`);
    const startLockPath = getStartLockPath({ dataPath, communityAddress });
    // ATTACH opens the sidecar with the flags of `db`, which is opened with fileMustExist and so cannot create it.
    // Created through SQLite, not fs: see the top of this file
    if (!fs.existsSync(startLockPath)) new Database(startLockPath).close();
    let attached = false;
    try {
        db.prepare(`ATTACH DATABASE ? AS ${START_LOCK_SCHEMA}`).run(startLockPath);
        attached = true;
        // One 512 byte page and no page cache: a held lock costs a few KB of memory instead of about 90
        db.pragma(`${START_LOCK_SCHEMA}.page_size = 512`);
        db.pragma(`${START_LOCK_SCHEMA}.cache_size = 0`);
        // No journal file: a holder killed during the write below would leave one that a read-only check can't roll back
        db.pragma(`${START_LOCK_SCHEMA}.journal_mode = MEMORY`);
        // In this mode SQLite keeps a file lock once taken, instead of releasing it at the end of each transaction
        db.pragma(`${START_LOCK_SCHEMA}.locking_mode = EXCLUSIVE`);
        // Any write takes the exclusive lock. It also changes the sidecar on disk, which is how the communities
        // directory watcher of other processes learns that the community started
        db.pragma(`${START_LOCK_SCHEMA}.user_version = 1`);
        return true;
    } catch (e) {
        if (attached) db.exec(`DETACH DATABASE ${START_LOCK_SCHEMA}`);
        if (isSqliteBusyError(e)) return false;
        throw e;
    } finally {
        db.pragma(`busy_timeout = ${busyTimeout}`);
    }
}

// Releases a lock taken by takeStartLock() on `db`. The sidecar stays on disk (see the top of this file); its mtime is
// touched, by path, because releasing a file lock changes nothing on disk and the communities directory watcher of
// other processes needs an event to learn that the community stopped.
export function releaseStartLock({ db, dataPath, communityAddress }: StartLockArgs & { db: BetterSqlite3Database }): void {
    if (!db.open || !isStartLockAttached(db)) return;
    db.exec(`DETACH DATABASE ${START_LOCK_SCHEMA}`);
    const now = new Date();
    try {
        fs.utimesSync(getStartLockPath({ dataPath, communityAddress }), now, now);
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
}

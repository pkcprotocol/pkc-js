import path from "node:path";
import fs from "node:fs";
import Database, { type Database as BetterSqlite3Database } from "better-sqlite3";

// The lock a PKC instance holds for as long as it lives, on a file of its own. A local community is started when the
// communities registry says which instance started it and that instance's lock is held (see communities-registry.ts,
// issue #585). One lock per instance, however many communities it runs: the per-community lock this replaced (issue
// #561) cost a file, an attached database and several lock checks for every started community.
//
// The lock is held in the kernel, the way Kubo holds repo.lock. It is the exclusive file lock SQLite takes on a small
// database (`dataPath/pkc-instances/<instance id>.lock.db`), which the instance attaches to its registry connection.
// The kernel drops that lock the moment the process dies (SIGKILL, an OOM kill, power loss) and never before, so a held
// lock always means a live instance.
//
// What keeps it correct:
// - The lock lives exactly as long as the connection it is attached to. Closing that connection releases it, and
//   better-sqlite3 closes a connection that is garbage collected, so the registry keeps its connection until close().
// - On POSIX nothing in the holder's process may open the lock file other than through SQLite. POSIX drops every lock a
//   process holds on a file when it closes any descriptor of that file, and only SQLite's own bookkeeping guards against
//   that. Windows locks belong to the handle, which is why the check below may use plain fs calls there.
// - An instance id is never used twice, so a lock file is only ever locked by the instance that created it. A file
//   that is gone therefore means an instance that is gone.
// - dataPath must be on a local filesystem. File locks are unreliable on network filesystems (NFS, SMB).

const INSTANCE_LOCK_SCHEMA = "pkcinstancelock";
const INSTANCE_LOCK_FILE_SUFFIX = ".lock.db";

export function getInstanceLocksPath(dataPath: string): string {
    return path.join(dataPath, "pkc-instances");
}

export function getInstanceLockPath({ dataPath, instanceId }: { dataPath: string; instanceId: string }): string {
    return path.join(getInstanceLocksPath(dataPath), `${instanceId}${INSTANCE_LOCK_FILE_SUFFIX}`);
}

// The instance a file in dataPath/pkc-instances belongs to, or undefined for any other file
export function instanceIdOfLockFile(filename: string): string | undefined {
    return filename.endsWith(INSTANCE_LOCK_FILE_SUFFIX) ? filename.slice(0, -INSTANCE_LOCK_FILE_SUFFIX.length) : undefined;
}

const isSqliteBusyError = (error: unknown): boolean =>
    typeof (error as { code?: unknown })?.code === "string" && (error as { code: string }).code.startsWith("SQLITE_BUSY");

// The first of the bytes SQLite locks in a database file. They sit at a fixed offset far beyond the data and are part
// of its file format (PENDING_BYTE): https://www.sqlite.org/fileformat2.html#the_lock_byte_page
const SQLITE_PENDING_BYTE_OFFSET = 0x40000000;

// Windows only. SQLite gives up on a locked database there only after sleeping twice, which Windows rounds up to its
// timer tick: 31ms for each held lock, against microseconds elsewhere. Windows refuses a read of a byte another handle
// has locked exclusively, so reading the first lock byte tells whether the lock is held, in microseconds and without
// taking any lock.
function isInstanceLockHeldOnWindows(lockPath: string): boolean {
    let fd: number;
    try {
        fd = fs.openSync(lockPath, "r");
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; // the instance is gone
        throw e;
    }
    try {
        fs.readSync(fd, Buffer.alloc(1), 0, 1, SQLITE_PENDING_BYTE_OFFSET);
        return false; // reads nothing, the byte is beyond the end of the file
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EBUSY") return true;
        throw e;
    } finally {
        fs.closeSync(fd);
    }
}

// Whether the instance that owns this lock file is alive. A read of the file needs a shared lock, which the holder's
// exclusive lock refuses. Read-only and with no busy timeout, so the check changes nothing on disk and never waits.
// Never called by an instance on its own lock: it knows its own id.
export function isInstanceLockHeldSync(lockPath: string): boolean {
    if (process.platform === "win32") return isInstanceLockHeldOnWindows(lockPath);
    if (!fs.existsSync(lockPath)) return false;
    let db: BetterSqlite3Database;
    try {
        db = new Database(lockPath, { readonly: true, fileMustExist: true, timeout: 0 });
    } catch (e) {
        if (!fs.existsSync(lockPath)) return false; // removed meanwhile, with its instance
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

export function isInstanceLockAttached(db: BetterSqlite3Database): boolean {
    return (db.pragma("database_list") as { name: string }[]).some((attached) => attached.name === INSTANCE_LOCK_SCHEMA);
}

// Creates the lock file and takes its lock on `db`, which holds it until releaseInstanceLock() or until `db` closes.
// Nothing else ever takes this lock, so a failure here is an error and not a refusal.
export function takeInstanceLock({ db, lockPath }: { db: BetterSqlite3Database; lockPath: string }): void {
    if (db.inTransaction) throw Error("The lock of a PKC instance can't be taken inside a transaction");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    // Created through SQLite, not fs: see the top of this file
    new Database(lockPath).close();
    let attached = false;
    try {
        db.prepare(`ATTACH DATABASE ? AS ${INSTANCE_LOCK_SCHEMA}`).run(lockPath);
        attached = true;
        // One 512 byte page and no page cache: the held lock costs a few KB of memory instead of about 90
        db.pragma(`${INSTANCE_LOCK_SCHEMA}.page_size = 512`);
        db.pragma(`${INSTANCE_LOCK_SCHEMA}.cache_size = 0`);
        // No journal file: a holder killed during the write below would leave one that a read-only check can't roll back
        db.pragma(`${INSTANCE_LOCK_SCHEMA}.journal_mode = MEMORY`);
        // In this mode SQLite keeps a file lock once taken, instead of releasing it at the end of each transaction
        db.pragma(`${INSTANCE_LOCK_SCHEMA}.locking_mode = EXCLUSIVE`);
        // Any write takes the exclusive lock
        db.pragma(`${INSTANCE_LOCK_SCHEMA}.user_version = 1`);
    } catch (e) {
        if (attached) db.exec(`DETACH DATABASE ${INSTANCE_LOCK_SCHEMA}`);
        throw e;
    }
    // The sweep of another instance removes the lock files of dead instances, and only files older than this one can
    // be (see CommunitiesRegistry). Should the file be gone all the same, the lock just taken is on a file nobody can
    // find, and every other instance would take this one for dead
    if (!fs.existsSync(lockPath)) {
        db.exec(`DETACH DATABASE ${INSTANCE_LOCK_SCHEMA}`);
        throw Error(`The lock file of this PKC instance (${lockPath}) was removed while its lock was being taken`);
    }
}

// Releases a lock taken by takeInstanceLock() on `db` and removes the lock file: the instance is gone for good.
export function releaseInstanceLock({ db, lockPath }: { db: BetterSqlite3Database; lockPath: string }): void {
    if (db.open && isInstanceLockAttached(db)) db.exec(`DETACH DATABASE ${INSTANCE_LOCK_SCHEMA}`);
    fs.rmSync(lockPath, { force: true });
}

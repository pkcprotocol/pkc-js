import {
    closeSync,
    existsSync,
    mkdirSync,
    openSync,
    readdirSync,
    readSync,
    rmSync,
    statSync,
    watch as fsWatch,
    type FSWatcher
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database, { type Database as BetterSqlite3Database, type Statement } from "better-sqlite3";
import Logger from "../../../logger.js";
import { STORAGE_KEYS } from "../../../constants.js";
import { areEquivalentNames, isEthAliasDomain, isStringDomain } from "../../../domain-util.js";
import { doesCommunitiesEntryMatch, toCommunitiesEntry } from "../../../community/communities-entry-util.js";
import type { CommunitiesEntryIdentity, CommunitiesEntryLookup } from "../../../community/communities-entry-util.js";
import type { PKCCommunitiesEntry } from "../../../clients/rpc-client/types.js";
import {
    getInstanceLockPath,
    getInstanceLocksPath,
    instanceIdOfLockFile,
    isInstanceLockHeldSync,
    releaseInstanceLock,
    takeInstanceLock
} from "./pkc-instance-lock.js";

// The local communities of a data path, and which PKC instance has started each (issue #585).
//
// One row per community DB file in dataPath/communities, in two tables of dataPath/storage.db, which every PKC
// instance on the data path opens. pkc.communities, pkc.createCommunity, community.started and the RPC server all read
// it. Before, they were derived from the directory: every load, creation and start of one community listed the whole
// directory, which with 10,000 communities is 40,000 entries, and `started` was a lock file per community.
//
// - The DB files are the truth and the registry is their index. A file without a row gets one, a row without a file
//   is removed. Creating a community writes its file first and its row second, so a crash in between heals the same
//   way a file copied in by hand is picked up.
// - `startedBy` is the one thing only the registry knows: the id of the PKC instance that started the community. A
//   community is started when that instance's lock is held (see pkc-instance-lock.ts). start() claims the row in one
//   write transaction, which SQLite makes atomic across processes, and takes it over from an instance that died.
// - The directory is listed once, when monitoring starts, and again only for a filesystem event that does not say
//   which file it is about. Any other event is about one file: ignored when that file has a row and is still there,
//   registered when it has none.
// - SQLite does not notify another process of a write, and a killed process writes nothing. So what another instance
//   did (create, delete, rename, start, stop, die) reaches this one on a timer, every COMMUNITIES_REGISTRY_TICK_MS:
//   the rows changed since the last read, and a try of the lock of every other instance that has communities
//   started. What this instance does itself is applied at once. Only the list is late: start() and createCommunity()
//   read the tables.

export const COMMUNITIES_REGISTRY_TICK_MS = 2000;
// How many files of the directory are registered in one write transaction
export const COMMUNITIES_REGISTRY_RECONCILE_BATCH_SIZE = 100;

const COMMUNITIES_TABLE = "localCommunities";
const CHANGES_TABLE = "localCommunitiesChanges";
// How many changes are kept for instances that have not read them yet. An instance that falls further behind reads
// every row again
const CHANGES_KEPT = 65_536;
const CHANGES_PRUNE_EVERY = 4096;
// A lock file younger than this may belong to an instance that has created it and not locked it yet
const INSTANCE_LOCK_MIN_AGE_TO_SWEEP_MS = 60_000;

// Files in dataPath/communities that are never a community DB: SQLite's own companions, and the lock files of the
// designs before this one
const FILE_SUFFIXES_TO_IGNORE = [".lock", ".lock.db", "-journal", "-shm", "-wal"];
const LEGACY_START_LOCK_SUFFIXES = [".start.lock.db", ".start.lock"];
// What reading a DB's identity fails with when the file itself may be fine. SQLITE_CANTOPEN is also what SQLite makes of
// a process that is out of file descriptors
const ERROR_CODES_OF_A_READ_THAT_MAY_PASS = [
    "SQLITE_BUSY",
    "SQLITE_LOCKED",
    "SQLITE_CANTOPEN",
    "SQLITE_IOERR",
    "SQLITE_PROTOCOL",
    "EMFILE",
    "ENFILE"
];
// How many times the timer reads again the identity of a DB whose read failed for a reason that may pass
const IDENTITY_READ_RETRIES = 5;

type RegistryRow = {
    address: string; // the filename of the DB in dataPath/communities
    publicKey: string | null; // null while the DB's identity can't be read (mid-creation, mid-migration, corrupt)
    fileId: string | null; // which file the identity was read from, see getFileId
    startedBy: string | null; // the id of the PKC instance that started it
};

export type StartOwnership = "owned" | "taken";

const isIgnoredFilename = (filename: string) => FILE_SUFFIXES_TO_IGNORE.some((suffix) => filename.endsWith(suffix));

// A community DB this process is creating or moving into place right now, by absolute path. The filesystem events of
// its writes are not acted on: the creator registers the file itself once it is complete. Without this every write of
// a creation opened the half-written DB to look for its identity. Counted, since two calls may create the same DB
const filesBeingWrittenByThisProcess = new Map<string, number>();

// Marks a community DB as being created or moved into place by this process, until the returned function is called
export function markCommunityDbAsBeingWritten({ dataPath, communityAddress }: { dataPath: string; communityAddress: string }): () => void {
    const filePath = path.resolve(getDbFilePath(dataPath, communityAddress));
    filesBeingWrittenByThisProcess.set(filePath, (filesBeingWrittenByThisProcess.get(filePath) ?? 0) + 1);
    let done = false;
    return () => {
        if (done) return;
        done = true;
        const count = (filesBeingWrittenByThisProcess.get(filePath) ?? 1) - 1;
        if (count <= 0) filesBeingWrittenByThisProcess.delete(filePath);
        else filesBeingWrittenByThisProcess.set(filePath, count);
    };
}

function getDbFilePath(dataPath: string, communityAddress: string): string {
    return path.join(dataPath, "communities", communityAddress);
}

// Identifies the file itself, not its content: a DB that is deleted and created again under the same filename is
// another file, with another identity. The inode alone is reused by some filesystems right after a delete
function getFileId(filePath: string): string | undefined {
    try {
        const stat = statSync(filePath, { bigint: true });
        if (!stat.isFile()) return undefined;
        return `${stat.ino}:${stat.birthtimeNs}`;
    } catch {
        return undefined;
    }
}

// undefined if the header could not be read
function isSqliteFile(filePath: string): boolean | undefined {
    try {
        // Look for the SQLite file header "SQLite format 3\0"
        const fd = openSync(filePath, "r");
        const buffer = Buffer.alloc(16);
        try {
            readSync(fd, buffer, 0, 16, 0);
        } finally {
            closeSync(fd); // must run whatever readSync throws, or the fd leaks (#380)
        }
        return buffer.toString().startsWith("SQLite format 3");
    } catch (e) {
        // ENOENT is expected: the file can be removed between the event and the read (community delete)
        if (!(e instanceof Error && "code" in e && e.code === "ENOENT"))
            Logger("pkc-js:communities-registry").error(`Failed to check whether ${filePath} is a SQLite file, skipping it`, e);
        return undefined;
    }
}

// Reads the identity key from the DB's internal record. A delegated community is identified by its anchor, not by the
// minter it signs with. The name is not read from the DB but taken from the filename, which is the community's address,
// i.e. its name when it has one (issue #430): a rename moves the file before it writes the new name into the DB.
// No publicKey if the DB can't be read yet (mid-creation, mid-migration, corrupt). `failureMayPass` when the read failed
// for a reason that has nothing to do with what is in the file: it is locked, the process is out of file descriptors
function readCommunityPublicKeyFromDb(dbPath: string): { publicKey?: string; failureMayPass: boolean } {
    const log = Logger("pkc-js:communities-registry:readCommunityPublicKeyFromDb");
    let db: BetterSqlite3Database | undefined;
    try {
        db = new Database(dbPath, { readonly: true, fileMustExist: true });
        const row = db.prepare("SELECT value FROM keyv WHERE key = ?").get(`keyv:${STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY]}`) as
            | { value: string }
            | undefined;
        const internalState = row ? JSON.parse(row.value)?.value : undefined;
        const publicKey = internalState?.anchor?.publicKey ?? internalState?.signer?.address;
        if (typeof publicKey !== "string") {
            log(`Community DB (${dbPath}) has no internal state yet, leaving it out of pkc.communities for now`);
            return { failureMayPass: false };
        }
        return { publicKey, failureMayPass: false };
    } catch (e) {
        log.error(`Failed to read the identity of community DB (${dbPath}), leaving it out of pkc.communities for now`, e);
        const code = e instanceof Error && "code" in e && typeof e.code === "string" ? e.code : "";
        return { failureMayPass: ERROR_CODES_OF_A_READ_THAT_MAY_PASS.some((passing) => code.startsWith(passing)) };
    } finally {
        db?.close();
    }
}

const identityOfRow = (row: RegistryRow & { publicKey: string }): CommunitiesEntryIdentity =>
    isStringDomain(row.address) ? { name: row.address, publicKey: row.publicKey } : { publicKey: row.publicKey };

// The filenames a lookup identifier may be stored under: itself, and for an .eth/.bso name both spellings
function filenamesOfIdentifier(identifier: string): string[] {
    if (!isEthAliasDomain(identifier)) return [identifier];
    const withoutTld = identifier.toLowerCase().slice(0, -4);
    return [...new Set([identifier, `${withoutTld}.bso`, `${withoutTld}.eth`])];
}

export class CommunitiesRegistry {
    readonly instanceId = randomUUID();
    readonly dataPath: string;
    private _db: BetterSqlite3Database;
    private _closed = false;
    private _log = Logger("pkc-js:communities-registry");

    private _selectRow: Statement<[string], RegistryRow>;
    private _selectAllRows: Statement<[], RegistryRow>;
    private _upsertIdentity: Statement<[string, string | null, string | null]>;
    private _deleteRow: Statement<[string]>;
    private _setStartedBy: Statement<[string | null, string]>;
    private _releaseStartedBy: Statement<[string, string]>;
    private _clearInstance: Statement<[string]>;
    private _insertChange: Statement<[string]>;
    private _insertChangesOfInstance: Statement<[string]>;
    private _pruneChanges: Statement<[number]>;
    private _selectChangeBounds: Statement<[], { minSeq: number | null; maxSeq: number | null }>;
    private _selectChangedAddresses: Statement<[number], { address: string }>;
    private _lookupStatements = new Map<string, Statement<string[], RegistryRow>>();

    // What follows is only kept while monitoring, i.e. for the registry of a PKC instance: the copy of the table that
    // pkc.communities is built from
    private _onChange: ((communities: PKCCommunitiesEntry[]) => void) | undefined;
    private _rows = new Map<string, RegistryRow>();
    // The rows that have an identity, i.e. that are listed, sorted by address, and the entry of each at the same index
    private _sortedAddresses: string[] = [];
    private _entries: PKCCommunitiesEntry[] = [];
    private _listIsOutdated = false;
    private _lastSeq = 0;
    // Whether each other instance that has communities started is alive, as of the last time its lock was tried
    private _otherInstancesAlive = new Map<string, boolean>();
    private _startedCountByInstance = new Map<string, number>();
    // The DBs whose identity could not be read for a reason that may pass, and how many more times the timer tries
    private _identityReadsToRetry = new Map<string, number>();
    // The communities this instance has stopped whose release could not be written (see releaseStart)
    private _releasesToWriteAgain = new Set<string>();
    private _watcher: FSWatcher | undefined;
    private _timer: ReturnType<typeof setInterval> | undefined;

    constructor({ dataPath }: { dataPath: string }) {
        this.dataPath = dataPath;
        mkdirSync(dataPath, { recursive: true });
        this._db = new Database(path.join(dataPath, "storage.db"));
        // Readers and the one writer do not block each other in WAL mode, and several instances read and write here.
        // NORMAL: a commit is not synced to disk on its own. A power loss may then lose the last commits, which costs
        // nothing here: the rows are rebuilt from the DB files, and whoever had started a community is gone with the power
        this._db.pragma("journal_mode = WAL");
        this._db.pragma("synchronous = NORMAL");
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS ${COMMUNITIES_TABLE} (
                address TEXT PRIMARY KEY,
                publicKey TEXT,
                fileId TEXT,
                startedBy TEXT
            ) WITHOUT ROWID;
            CREATE INDEX IF NOT EXISTS ${COMMUNITIES_TABLE}_publicKey ON ${COMMUNITIES_TABLE} (publicKey);
            CREATE INDEX IF NOT EXISTS ${COMMUNITIES_TABLE}_startedBy ON ${COMMUNITIES_TABLE} (startedBy) WHERE startedBy IS NOT NULL;
            CREATE TABLE IF NOT EXISTS ${CHANGES_TABLE} (seq INTEGER PRIMARY KEY AUTOINCREMENT, address TEXT NOT NULL);
        `);
        this._selectRow = this._db.prepare(`SELECT address, publicKey, fileId, startedBy FROM ${COMMUNITIES_TABLE} WHERE address = ?`);
        this._selectAllRows = this._db.prepare(`SELECT address, publicKey, fileId, startedBy FROM ${COMMUNITIES_TABLE}`);
        this._upsertIdentity = this._db.prepare(
            `INSERT INTO ${COMMUNITIES_TABLE} (address, publicKey, fileId) VALUES (?, ?, ?)
             ON CONFLICT (address) DO UPDATE SET publicKey = excluded.publicKey, fileId = excluded.fileId`
        );
        this._deleteRow = this._db.prepare(`DELETE FROM ${COMMUNITIES_TABLE} WHERE address = ?`);
        this._setStartedBy = this._db.prepare(`UPDATE ${COMMUNITIES_TABLE} SET startedBy = ? WHERE address = ?`);
        this._releaseStartedBy = this._db.prepare(`UPDATE ${COMMUNITIES_TABLE} SET startedBy = NULL WHERE address = ? AND startedBy = ?`);
        this._clearInstance = this._db.prepare(`UPDATE ${COMMUNITIES_TABLE} SET startedBy = NULL WHERE startedBy = ?`);
        this._insertChange = this._db.prepare(`INSERT INTO ${CHANGES_TABLE} (address) VALUES (?)`);
        this._insertChangesOfInstance = this._db.prepare(
            `INSERT INTO ${CHANGES_TABLE} (address) SELECT address FROM ${COMMUNITIES_TABLE} WHERE startedBy = ?`
        );
        this._pruneChanges = this._db.prepare(`DELETE FROM ${CHANGES_TABLE} WHERE seq <= ?`);
        this._selectChangeBounds = this._db.prepare(`SELECT min(seq) AS minSeq, max(seq) AS maxSeq FROM ${CHANGES_TABLE}`);
        this._selectChangedAddresses = this._db.prepare(`SELECT DISTINCT address FROM ${CHANGES_TABLE} WHERE seq > ?`);

        takeInstanceLock({ db: this._db, lockPath: getInstanceLockPath({ dataPath, instanceId: this.instanceId }) });
    }

    get closed() {
        return this._closed;
    }

    // ---- the list of a PKC instance ----

    // Lists the directory once, starts the watcher and the timer, and calls onChange with the list, now and whenever it
    // changes afterwards
    startMonitoring({ onChange }: { onChange: (communities: PKCCommunitiesEntry[]) => void }) {
        if (this._closed) throw Error("The communities registry of this PKC instance is closed");
        if (this._onChange) throw Error("The communities registry of this PKC instance is monitoring already");
        const communitiesPath = path.join(this.dataPath, "communities");
        mkdirSync(communitiesPath, { recursive: true });
        this._onChange = onChange;
        // Watching before the directory is listed: a DB that is put in it while it is listed is in the listing or in an
        // event. An event is delivered after this function has returned, never in the middle of it
        this._watcher = fsWatch(communitiesPath, { persistent: false }, (eventType, filename) => {
            // Runs in the watcher callback, where a throw is uncaught
            try {
                if (typeof filename !== "string") this._reconcileWithDirectory();
                else this._onFileEvent(eventType, filename);
                this._emitListIfOutdated();
            } catch (error) {
                this._log.error("Failed to follow a change in", communitiesPath, eventType, filename, error);
            }
        });
        this._watcher.on("error", (error) => this._log.error("The watcher of", communitiesPath, "failed", error));
        this._timer = setInterval(() => {
            try {
                this.readChangesOfOtherInstances();
            } catch (error) {
                this._log.error("Failed to read what other PKC instances changed in the communities registry", error);
            }
        }, COMMUNITIES_REGISTRY_TICK_MS);
        this._timer.unref();

        this._sweepInstanceLocksOfDeadInstances();
        this._reloadAllRows();
        this._reconcileWithDirectory();
        this._clearDeadInstances();
        this._listIsOutdated = true; // a PKC waits for its first list, also when it is empty
        this._emitListIfOutdated();
    }

    // What the timer runs. Public so a caller that can't wait for the timer may run it now
    readChangesOfOtherInstances() {
        if (this._closed || !this._onChange) return;
        const { minSeq, maxSeq } = this._selectChangeBounds.get()!;
        if (maxSeq !== null && maxSeq > this._lastSeq) {
            // changes this instance has not read were pruned: read everything
            if (minSeq !== null && minSeq > this._lastSeq + 1) this._reloadAllRows();
            else {
                const changed = this._selectChangedAddresses.all(this._lastSeq);
                for (const { address } of changed) this._mirrorRow(address, this._selectRow.get(address));
                this._lastSeq = maxSeq;
            }
        }
        this._readAgainIdentitiesThatFailedToBeRead();
        for (const address of [...this._releasesToWriteAgain]) this.releaseStart(address);
        this._clearDeadInstances();
        this._emitListIfOutdated();
    }

    // ---- lookups ----

    // The filename (the address the DB is stored under) of the local community matching a lookup by address, name or
    // identity key, or undefined if there is none. A DB whose identity can't be read yet still matches by filename,
    // when every supplied identifier is that filename
    findAddress(lookup: CommunitiesEntryLookup): string | undefined {
        if (this._closed) return undefined;
        const identifiers = [lookup.address, lookup.name, lookup.publicKey].filter((id): id is string => typeof id === "string");
        if (identifiers.length === 0) return undefined;
        const filenames = [...new Set(identifiers.flatMap(filenamesOfIdentifier))];
        const matchesFilename = (filename: string) => identifiers.every((id) => areEquivalentNames(filename, id));
        const rowMatches = (row: RegistryRow) =>
            row.publicKey !== null
                ? doesCommunitiesEntryMatch(identityOfRow({ ...row, publicKey: row.publicKey }), lookup)
                : matchesFilename(row.address);

        for (const row of this._selectRowsByFilenameOrPublicKey({ filenames, publicKeys: identifiers })) {
            if (!rowMatches(row)) continue;
            if (existsSync(getDbFilePath(this.dataPath, row.address))) return row.address;
            // the file was removed without this instance being told, yet
            this._removeRowIfFileIsGone(row.address);
            this._emitListIfOutdated();
        }
        // A DB file that has no row yet: another process created it or somebody copied it in, and its filesystem event
        // has not arrived (on macOS it arrives late)
        for (const filename of filenames) {
            if (isIgnoredFilename(filename) || this._selectRow.get(filename)) continue;
            // Nothing is written for a community that is not local, which is what most lookups are about: a write
            // waits for whoever is writing to storage.db, and fails when that takes too long
            if (!existsSync(getDbFilePath(this.dataPath, filename))) continue;
            const registered = this._registerFile(filename);
            this._emitListIfOutdated();
            if (registered && rowMatches(registered)) return filename;
        }
        return undefined;
    }

    // Whether a community DB is stored under exactly this address
    hasCommunityDb(communityAddress: string): boolean {
        const dbFilePath = getDbFilePath(this.dataPath, communityAddress);
        if (!existsSync(dbFilePath)) return false;
        // Still answered after close(), from the file: something of a destroyed PKC may run a moment longer
        if (this._closed) return isSqliteFile(dbFilePath) === true;
        if (this._selectRow.get(communityAddress)) return true;
        if (isSqliteFile(dbFilePath) !== true) return false;
        // A DB without a row, e.g. of a creation whose registration failed: registered now. The DB is there whether
        // or not that works
        if (!filesBeingWrittenByThisProcess.has(path.resolve(dbFilePath))) {
            try {
                this._registerFile(communityAddress);
                this._emitListIfOutdated();
            } catch (error) {
                this._log.error("Failed to register the community DB found without a row", communityAddress, error);
            }
        }
        return true;
    }

    // ---- changes this instance makes ----

    // Reads the identity of the DB file stored under this address and writes its row. Called by whoever has just created
    // or moved the file, so the community is listed when their call returns
    registerCommunity(communityAddress: string) {
        if (this._closed) return;
        this._registerFile(communityAddress);
        this._emitListIfOutdated();
    }

    // Removes the row of a community whose DB file the caller has deleted or moved away
    unregisterCommunity(communityAddress: string) {
        if (this._closed) return;
        this._removeRow(communityAddress);
        this._emitListIfOutdated();
    }

    // A rename has moved the DB file from one address to another (issue #430): one change of the list, not two
    renameCommunity({ oldAddress, newAddress }: { oldAddress: string; newAddress: string }) {
        if (this._closed) return;
        this._write(() => {
            this._removeRow(oldAddress);
            this._registerFile(newAddress);
        });
        this._emitListIfOutdated();
    }

    // ---- started ----

    // Claims the community for this instance. Returns false when a live instance has it started, this one included.
    // A claim left by an instance that died is taken over.
    claimStart(communityAddress: string): boolean {
        if (this._closed) throw Error("The communities registry of this PKC instance is closed");
        const claimed = this._write(() => {
            let row = this._selectRow.get(communityAddress);
            if (!row) {
                this._registerFile(communityAddress, { evenIfNotACommunityDb: true });
                row = this._selectRow.get(communityAddress)!;
            }
            // its own claim, unless that is one it has given up and could not write the release of
            if (row.startedBy === this.instanceId && !this._releasesToWriteAgain.has(communityAddress)) return false;
            if (row.startedBy !== null && row.startedBy !== this.instanceId && this._isOtherInstanceAliveNow(row.startedBy)) return false;
            this._setStartedBy.run(this.instanceId, communityAddress);
            this._recordChange(communityAddress);
            return true;
        });
        if (claimed) this._releasesToWriteAgain.delete(communityAddress);
        this._emitListIfOutdated();
        return claimed;
    }

    // Does not throw when the release can't be written (storage.db locked by another process for longer than SQLite
    // waits): the community is stopped all the same. The claim would stay, in the name of a live instance, and nothing
    // could start the community until this process ended. So the release is written again on the timer, and until then
    // this instance does not count the claim as one
    releaseStart(communityAddress: string) {
        if (this._closed) return;
        try {
            this._write(() => {
                if (this._releaseStartedBy.run(communityAddress, this.instanceId).changes > 0) this._recordChange(communityAddress);
            });
            this._releasesToWriteAgain.delete(communityAddress);
        } catch (error) {
            this._releasesToWriteAgain.add(communityAddress);
            this._log.error("Failed to write that community", communityAddress, "is stopped, will try again", error);
        }
        this._emitListIfOutdated();
    }

    // Whether a live instance has the community started, this one included
    isStarted(communityAddress: string): boolean {
        if (this._closed) return false;
        const startedBy = this._selectRow.get(communityAddress)?.startedBy ?? null;
        if (startedBy === null) return false;
        if (startedBy === this.instanceId) return !this._releasesToWriteAgain.has(communityAddress);
        return this._isOtherInstanceAliveNow(startedBy);
    }

    // For a community this instance is running: whether it is still this instance's. "taken" means another live
    // instance has claimed it, which can only follow from this instance having lost its claim while running. A claim
    // that is merely gone (its row was removed and written again, e.g. around a file event of another process) is
    // written back.
    confirmStart(communityAddress: string): StartOwnership {
        if (this._closed) return "owned";
        const row = this._selectRow.get(communityAddress);
        if (row?.startedBy === this.instanceId) return "owned";
        if (row && row.startedBy !== null && this._isOtherInstanceAliveNow(row.startedBy)) return "taken";
        if (!row && !existsSync(getDbFilePath(this.dataPath, communityAddress))) return "owned"; // nothing to claim
        const stillOwned = this._write(() => {
            const current = this._selectRow.get(communityAddress);
            if (current?.startedBy === this.instanceId) return true;
            if (current && current.startedBy !== null && this._isOtherInstanceAliveNow(current.startedBy)) return false;
            if (!current) this._registerFile(communityAddress, { evenIfNotACommunityDb: true });
            this._setStartedBy.run(this.instanceId, communityAddress);
            this._recordChange(communityAddress);
            return true;
        });
        this._emitListIfOutdated();
        return stillOwned ? "owned" : "taken";
    }

    // ---- lifetime ----

    // Releases every community this instance still has claimed, and its lock. The instance is gone afterwards
    close() {
        if (this._closed) return;
        this._closed = true;
        if (this._timer) clearInterval(this._timer);
        this._watcher?.close();
        this._onChange = undefined;
        const lockPath = getInstanceLockPath({ dataPath: this.dataPath, instanceId: this.instanceId });
        try {
            if (this._db.open) {
                this._db.exec("BEGIN IMMEDIATE");
                this._insertChangesOfInstance.run(this.instanceId);
                this._clearInstance.run(this.instanceId);
                this._db.exec("COMMIT");
            }
        } catch (error) {
            if (this._db.inTransaction) this._db.exec("ROLLBACK");
            this._log.error("Failed to release the communities of a closing PKC instance", error);
        }
        try {
            releaseInstanceLock({ db: this._db, lockPath });
        } catch (error) {
            this._log.error("Failed to release the lock of a closing PKC instance", error);
        }
        if (this._db.open) this._db.close();
    }

    // ---- internals ----

    private _write<T>(write: () => T): T {
        if (this._db.inTransaction) return write();
        this._db.exec("BEGIN IMMEDIATE");
        try {
            const result = write();
            this._db.exec("COMMIT");
            return result;
        } catch (e) {
            if (this._db.inTransaction) this._db.exec("ROLLBACK");
            // The copy may hold what the rolled back transaction wrote
            if (this._onChange) this._reloadAllRows();
            throw e;
        }
    }

    // Tells the other instances that the row of this address changed, and applies the change to this instance's copy
    private _recordChange(communityAddress: string) {
        const seq = Number(this._insertChange.run(communityAddress).lastInsertRowid);
        if (seq % CHANGES_PRUNE_EVERY === 0) this._pruneChanges.run(seq - CHANGES_KEPT);
        if (this._onChange) this._mirrorRow(communityAddress, this._selectRow.get(communityAddress));
    }

    private _removeRow(communityAddress: string) {
        this._write(() => {
            if (this._deleteRow.run(communityAddress).changes > 0) this._recordChange(communityAddress);
            else if (this._onChange) this._mirrorRow(communityAddress, undefined);
        });
    }

    // Removes the row of a DB file that was seen to be gone. Looked at again inside the write transaction: what was seen
    // is old by then, and another instance may have created the file and registered it since. Its row was deleted
    // otherwise, and the community left every list while its creator ran it
    private _removeRowIfFileIsGone(communityAddress: string) {
        this._write(() => {
            if (getFileId(getDbFilePath(this.dataPath, communityAddress)) === undefined) this._removeRow(communityAddress);
            else this._registerFile(communityAddress);
        });
    }

    // Writes the row of the DB file stored under this address, from the file. Returns the row, or undefined when there
    // is no such file or it is not a SQLite database. `evenIfNotACommunityDb` writes a row all the same, without an
    // identity: start() claims a community by its row.
    // The file is read inside the write transaction, so two instances registering one file do so one after the other.
    // Read outside of it, an instance that had read a DB while it was still being created could write "no identity"
    // over the identity its creator had registered since, and the community was gone from every list
    private _registerFile(communityAddress: string, { evenIfNotACommunityDb = false } = {}): RegistryRow | undefined {
        const dbFilePath = getDbFilePath(this.dataPath, communityAddress);
        return this._write(() => {
            const fileId = getFileId(dbFilePath) ?? null;
            const isCommunityDb = fileId !== null && isSqliteFile(dbFilePath) === true;
            const existing = this._selectRow.get(communityAddress);
            if (!isCommunityDb && !evenIfNotACommunityDb) {
                this._identityReadsToRetry.delete(communityAddress);
                if (this._onChange) this._mirrorRow(communityAddress, existing);
                return undefined;
            }
            const identityRead = isCommunityDb ? readCommunityPublicKeyFromDb(dbFilePath) : { failureMayPass: false };
            let publicKey = identityRead.publicKey ?? null;
            // a read that failed says nothing about a file whose identity is known
            if (publicKey === null && existing && existing.fileId === fileId) publicKey = existing.publicKey;
            // Nothing else reads it again: a community that is not started is not written to, so no event follows
            if (publicKey !== null || !identityRead.failureMayPass) this._identityReadsToRetry.delete(communityAddress);
            else if (this._onChange && !this._identityReadsToRetry.has(communityAddress))
                this._identityReadsToRetry.set(communityAddress, IDENTITY_READ_RETRIES);
            if (!existing || existing.publicKey !== publicKey || existing.fileId !== fileId) {
                this._upsertIdentity.run(communityAddress, publicKey, fileId);
                this._recordChange(communityAddress);
            } else if (this._onChange) this._mirrorRow(communityAddress, existing); // written by another instance
            return this._selectRow.get(communityAddress);
        });
    }

    private _selectRowsByFilenameOrPublicKey({ filenames, publicKeys }: { filenames: string[]; publicKeys: string[] }): RegistryRow[] {
        const key = `${filenames.length}:${publicKeys.length}`;
        let statement = this._lookupStatements.get(key);
        if (!statement) {
            const placeholders = (count: number) => Array.from({ length: count }, () => "?").join(", ");
            statement = this._db.prepare(
                `SELECT address, publicKey, fileId, startedBy FROM ${COMMUNITIES_TABLE}
                 WHERE address IN (${placeholders(filenames.length)}) OR publicKey IN (${placeholders(publicKeys.length)})
                 ORDER BY address`
            );
            this._lookupStatements.set(key, statement);
        }
        return statement.all(...filenames, ...publicKeys);
    }

    private _isOtherInstanceAliveNow(instanceId: string): boolean {
        return isInstanceLockHeldSync(getInstanceLockPath({ dataPath: this.dataPath, instanceId }));
    }

    // One event of the watcher that names its file
    private _onFileEvent(eventType: string, filename: string) {
        if (isIgnoredFilename(filename)) return;
        const dbFilePath = getDbFilePath(this.dataPath, filename);
        if (filesBeingWrittenByThisProcess.has(path.resolve(dbFilePath))) return;
        const row = this._rows.get(filename);
        // A write to a DB that is listed changes nothing the registry holds, and every started community writes to its
        // DB at each checkpoint. A "rename" is the file appearing or disappearing
        if (row && row.publicKey !== null && eventType !== "rename") return;
        const fileId = getFileId(dbFilePath);
        if (fileId === undefined) {
            // gone, or not a file. Asked of the table, not the copy: another instance may have registered it
            if (row || this._selectRow.get(filename)) this._removeRowIfFileIsGone(filename);
            return;
        }
        if (row && row.publicKey !== null && row.fileId === fileId) return; // the file this instance knows
        this._registerFile(filename);
    }

    // The one place that lists the directory. Registers the files that have no row, removes the rows that have no file,
    // and reads again the identity of the DBs that had none
    private _reconcileWithDirectory() {
        const communitiesPath = path.join(this.dataPath, "communities");
        const filenames = new Set<string>();
        for (const dirent of readdirSync(communitiesPath, { withFileTypes: true })) {
            if (LEGACY_START_LOCK_SUFFIXES.some((suffix) => dirent.name.endsWith(suffix))) {
                // the lock of the design before this one: a file or a directory per community
                try {
                    rmSync(path.join(communitiesPath, dirent.name), { recursive: true, force: true });
                } catch (error) {
                    this._log.error("Failed to remove the start lock of an older version", dirent.name, error);
                }
                continue;
            }
            // Only regular files can be community DBs. Subdirectories live here too (`deleted/`, `.backup_before_migration/`)
            if (dirent.isFile() && !isIgnoredFilename(dirent.name)) filenames.add(dirent.name);
        }
        // In steps, each its own write transaction: registering a file opens it, and the first PKC on a data path of an
        // older version registers every file. As one transaction that kept every other process from writing to
        // storage.db for longer than SQLite waits (5 s), which fails a start() there. A file is still read inside the
        // transaction that writes its row (see _registerFile)
        const filenamesInOrder = [...filenames];
        for (let i = 0; i < filenamesInOrder.length; i += COMMUNITIES_REGISTRY_RECONCILE_BATCH_SIZE)
            this._write(() => {
                for (const filename of filenamesInOrder.slice(i, i + COMMUNITIES_REGISTRY_RECONCILE_BATCH_SIZE)) {
                    const dbFilePath = getDbFilePath(this.dataPath, filename);
                    if (filesBeingWrittenByThisProcess.has(path.resolve(dbFilePath))) continue;
                    const row = this._selectRow.get(filename);
                    if (!row || row.publicKey === null || row.fileId !== getFileId(dbFilePath)) this._registerFile(filename);
                    else if (this._onChange) this._mirrorRow(filename, row);
                }
            });
        this._write(() => {
            for (const { address } of this._selectAllRows.all()) if (!filenames.has(address)) this._removeRowIfFileIsGone(address);
        });
    }

    // What the timer does for the DBs whose identity could not be read for a reason that may pass
    private _readAgainIdentitiesThatFailedToBeRead() {
        for (const [address, retriesLeft] of [...this._identityReadsToRetry]) {
            try {
                this._registerFile(address);
            } catch (error) {
                this._log.error("Failed to read again the identity of community DB", address, error);
            }
            if (!this._identityReadsToRetry.has(address)) continue; // read, or not a community DB any more
            if (retriesLeft <= 1) this._identityReadsToRetry.delete(address);
            else this._identityReadsToRetry.set(address, retriesLeft - 1);
        }
    }

    // The lock files of instances that died without removing theirs
    private _sweepInstanceLocksOfDeadInstances() {
        const locksPath = getInstanceLocksPath(this.dataPath);
        let filenames: string[];
        try {
            filenames = readdirSync(locksPath);
        } catch {
            return;
        }
        for (const filename of filenames) {
            const instanceId = instanceIdOfLockFile(filename);
            if (instanceId === undefined || instanceId === this.instanceId) continue;
            const lockPath = path.join(locksPath, filename);
            try {
                if (Date.now() - statSync(lockPath).mtimeMs < INSTANCE_LOCK_MIN_AGE_TO_SWEEP_MS) continue;
                if (!isInstanceLockHeldSync(lockPath)) rmSync(lockPath, { force: true });
            } catch (error) {
                this._log.error("Failed to check the lock file of another PKC instance", lockPath, error);
            }
        }
    }

    // Tries the lock of every other instance that has communities started, and releases the communities of those that
    // are gone
    private _clearDeadInstances() {
        for (const instanceId of [...this._startedCountByInstance.keys()]) {
            if (instanceId === this.instanceId) continue;
            const alive = this._isOtherInstanceAliveNow(instanceId);
            this._otherInstancesAlive.set(instanceId, alive);
            if (alive) continue;
            this._write(() => {
                // tried again inside the write transaction, where no start() of that instance can be half done
                if (this._isOtherInstanceAliveNow(instanceId)) return;
                this._insertChangesOfInstance.run(instanceId);
                this._clearInstance.run(instanceId);
            });
            for (const row of [...this._rows.values()])
                if (row.startedBy === instanceId)
                    this._mirrorRow(row.address, this._selectRow.get(row.address), { startedMayHaveChanged: true });
            rmSync(getInstanceLockPath({ dataPath: this.dataPath, instanceId }), { force: true });
        }
        for (const instanceId of [...this._otherInstancesAlive.keys()])
            if (!this._startedCountByInstance.has(instanceId)) this._otherInstancesAlive.delete(instanceId);
    }

    private _reloadAllRows() {
        this._db.transaction(() => {
            this._lastSeq = this._selectChangeBounds.get()!.maxSeq ?? 0;
            const rows = this._selectAllRows.all();
            this._rows = new Map(rows.map((row) => [row.address, row]));
        })();
        this._startedCountByInstance.clear();
        for (const row of this._rows.values())
            if (row.startedBy !== null)
                this._startedCountByInstance.set(row.startedBy, (this._startedCountByInstance.get(row.startedBy) ?? 0) + 1);
        this._sortedAddresses = [...this._rows.values()]
            .filter((row) => row.publicKey !== null)
            .map((row) => row.address)
            .sort();
        this._entries = this._sortedAddresses.map((address) => this._entryOfRow(this._rows.get(address)!)!);
        this._listIsOutdated = true;
    }

    // The entry of pkc.communities for a row, or undefined for a row that is not listed
    private _entryOfRow(row: RegistryRow | undefined): PKCCommunitiesEntry | undefined {
        if (!row || row.publicKey === null) return undefined;
        return toCommunitiesEntry({ ...identityOfRow({ ...row, publicKey: row.publicKey }), started: this._isRowStarted(row) });
    }

    // Applies the current row of one address (undefined: it has none) to this instance's copy
    private _mirrorRow(communityAddress: string, row: RegistryRow | undefined, { startedMayHaveChanged = false } = {}) {
        const before = this._rows.get(communityAddress);
        if (
            !startedMayHaveChanged &&
            Boolean(before) === Boolean(row) &&
            before?.publicKey === row?.publicKey &&
            before?.startedBy === row?.startedBy &&
            before?.fileId === row?.fileId
        )
            return;
        if (before?.startedBy) {
            const count = (this._startedCountByInstance.get(before.startedBy) ?? 1) - 1;
            if (count <= 0) this._startedCountByInstance.delete(before.startedBy);
            else this._startedCountByInstance.set(before.startedBy, count);
        }
        if (row?.startedBy) this._startedCountByInstance.set(row.startedBy, (this._startedCountByInstance.get(row.startedBy) ?? 0) + 1);
        if (row) this._rows.set(communityAddress, row);
        else this._rows.delete(communityAddress);

        const wasListed = before !== undefined && before.publicKey !== null;
        const entry = this._entryOfRow(row);
        if (!wasListed && !entry) return;
        const index = this._indexOfSortedAddress(communityAddress);
        if (!wasListed && entry) {
            this._sortedAddresses.splice(index, 0, communityAddress);
            this._entries.splice(index, 0, entry);
        } else if (wasListed && !entry) {
            this._sortedAddresses.splice(index, 1);
            this._entries.splice(index, 1);
        } else if (entry) {
            const listed = this._entries[index];
            if (listed.publicKey === entry.publicKey && listed.started === entry.started) return;
            this._entries[index] = entry;
        }
        this._listIsOutdated = true;
    }

    // Where this address is in the sorted list, or where it belongs when it is not in it
    private _indexOfSortedAddress(communityAddress: string): number {
        let low = 0;
        let high = this._sortedAddresses.length;
        while (low < high) {
            const middle = (low + high) >>> 1;
            if (this._sortedAddresses[middle] < communityAddress) low = middle + 1;
            else high = middle;
        }
        return low;
    }

    private _isRowStarted(row: RegistryRow): boolean {
        if (row.startedBy === null) return false;
        if (row.startedBy === this.instanceId) return true;
        let alive = this._otherInstancesAlive.get(row.startedBy);
        if (alive === undefined) {
            alive = this._isOtherInstanceAliveNow(row.startedBy);
            this._otherInstancesAlive.set(row.startedBy, alive);
        }
        return alive;
    }

    private _emitListIfOutdated() {
        if (!this._listIsOutdated || !this._onChange || this._db.inTransaction) return;
        this._listIsOutdated = false;
        try {
            // A copy: this array keeps changing, and what a PKC was given as its list must not
            this._onChange(this._entries.slice());
        } catch (error) {
            // A `communitieschange` listener of the user threw. Whatever changed the list (a start, a stop, a creation)
            // has been written, and must not fail on it: a start that threw here kept a claim nothing released
            this._log.error("A listener of the list of local communities threw", error);
        }
    }
}

// Whether a live PKC instance has the community started, asked without being an instance: by a tool, a test, or a
// process that only wants to know. Reads the registry and tries the lock of the instance it names
export function isCommunityStartLockedSync({ dataPath, communityAddress }: { dataPath: string; communityAddress: string }): boolean {
    const storagePath = path.join(dataPath, "storage.db");
    if (!existsSync(storagePath)) return false;
    let startedBy: string | null | undefined;
    const db = new Database(storagePath, { readonly: true, fileMustExist: true });
    try {
        startedBy = (
            db.prepare(`SELECT startedBy FROM ${COMMUNITIES_TABLE} WHERE address = ?`).get(communityAddress) as
                | { startedBy: string | null }
                | undefined
        )?.startedBy;
    } catch (e) {
        // a data path no PKC instance has kept communities in yet
        if (e instanceof Error && e.message.includes("no such table")) return false;
        throw e;
    } finally {
        db.close();
    }
    if (typeof startedBy !== "string") return false;
    return isInstanceLockHeldSync(getInstanceLockPath({ dataPath, instanceId: startedBy }));
}

export async function isCommunityStartLocked(args: { dataPath: string; communityAddress: string }): Promise<boolean> {
    return isCommunityStartLockedSync(args);
}

// One registry per PKC instance, made when it is first asked for. Keyed by the object, so that a test may stand in for
// a PKC with any object that has a dataPath
const registries = new WeakMap<object, CommunitiesRegistry>();

export function getCommunitiesRegistry(pkc: { dataPath?: string }): CommunitiesRegistry {
    let registry = registries.get(pkc);
    if (!registry) {
        if (typeof pkc.dataPath !== "string") throw Error("pkc.dataPath needs to be defined to keep local communities");
        registry = new CommunitiesRegistry({ dataPath: pkc.dataPath });
        registries.set(pkc, registry);
    }
    return registry;
}

// Closes the registry of an object that stood in for a PKC and forgets it, so its connection to storage.db does not
// outlive it. A PKC closes its own when it is destroyed
export function closeCommunitiesRegistry(pkc: { dataPath?: string }) {
    registries.get(pkc)?.close();
    registries.delete(pkc);
}

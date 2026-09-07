import { PKCError } from "../../../../pkc-error.js";
import type { Database as BetterSqlite3Database, Statement } from "better-sqlite3";
import type { PageSortDb } from "../../../../pages/types.js";

// The read-only sqlite handle a page sort file receives (issue #73). One instance per DbHandler for its whole life,
// so a factory may keep it in its closure; the connection underneath is (re)opened on demand, since the handler
// closes and reopens its own connection across stop/start and not-started edits. Two shapes behind one interface:
//
// - File-backed communities get their own connection opened with `readonly: true`, so SQLite itself refuses any
//   write. WAL is on and page generation runs outside every write transaction, so it sees exactly what the
//   read-write handle has committed.
// - `noData` communities live in `:memory:`, which a second connection cannot open. They use the handler's current
//   read-write handle and rely on the per-statement check below. Test-only in practice.
//
// Both paths run the same check: sqlite3_stmt_readonly (better-sqlite3's Statement.readonly), which is still SQLite
// deciding rather than a JS allowlist, so a file sees the same ERR_PAGE_SORT_DB_WRITE_REJECTED on either.
export class PageSortDbFacade implements PageSortDb {
    private _openReadOnlyConnection?: () => BetterSqlite3Database; // file-backed: opens a fresh readonly connection
    private _sharedHandle?: () => BetterSqlite3Database; // in-memory: the handler's current handle
    private _ownedDb?: BetterSqlite3Database;
    private _exclusionClauses: PageSortDb["exclusionClauses"];

    constructor({
        openReadOnlyConnection,
        sharedHandle,
        exclusionClauses
    }: {
        openReadOnlyConnection?: () => BetterSqlite3Database;
        sharedHandle?: () => BetterSqlite3Database;
        exclusionClauses: PageSortDb["exclusionClauses"];
    }) {
        if (!openReadOnlyConnection && !sharedHandle) throw Error("PageSortDbFacade needs a connection source");
        this._openReadOnlyConnection = openReadOnlyConnection;
        this._sharedHandle = sharedHandle;
        this._exclusionClauses = exclusionClauses;
    }

    private _db(): BetterSqlite3Database {
        if (this._sharedHandle) return this._sharedHandle();
        if (!this._ownedDb?.open) this._ownedDb = this._openReadOnlyConnection!();
        return this._ownedDb;
    }

    prepare(sql: string): Statement {
        const statement = this._db().prepare(sql);
        if (!statement.readonly) throw new PKCError("ERR_PAGE_SORT_DB_WRITE_REJECTED", { sql });
        return statement;
    }

    exclusionClauses(...args: Parameters<PageSortDb["exclusionClauses"]>): ReturnType<PageSortDb["exclusionClauses"]> {
        return this._exclusionClauses(...args);
    }

    // Close the owned readonly connection (file-backed). The facade stays usable and reopens on the next prepare.
    close(): void {
        if (this._ownedDb?.open) this._ownedDb.close();
        this._ownedDb = undefined;
    }
}

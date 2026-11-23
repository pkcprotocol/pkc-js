// What a failed read of the community DB means for the publish loop, which reads it once after every cycle. Pure, so it
// is tested on its own.
//
// "busy": another connection holds the lock (SQLITE_BUSY, SQLITE_LOCKED). It passes by itself, so the loop reads again
//   after a pause, for as long as it takes.
// "maybe-transient": SQLITE_IOERR. It can pass (a network drive, a full descriptor table) or be a dying disk, so the loop
//   reads again a bounded number of times in a row, MAX_CONSECUTIVE_IO_ERRORS, and then treats it as final.
// "final": anything else (a closed handle, SQLITE_CORRUPT, SQLITE_FULL, SQLITE_READONLY, a bug). Reading again would
//   fail the same way.
export type DbFaultKind = "busy" | "maybe-transient" | "final";

export const MAX_CONSECUTIVE_IO_ERRORS = 5; // same bound the communities registry uses for re-reading an identity

export function classifyDbFault(error: unknown): DbFaultKind {
    const code = (error as { code?: unknown } | undefined)?.code;
    const message = (error as { message?: unknown } | undefined)?.message;
    // better-sqlite3 sets `code`; a plain Error whose message starts with the code is treated the same
    const name = typeof code === "string" ? code : typeof message === "string" ? (message.match(/^SQLITE_[A-Z_]+/)?.[0] ?? "") : "";
    if (name.startsWith("SQLITE_BUSY") || name.startsWith("SQLITE_LOCKED")) return "busy";
    if (name.startsWith("SQLITE_IOERR")) return "maybe-transient";
    return "final";
}

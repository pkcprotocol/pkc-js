import { describe, it, expect } from "vitest";
import { classifyDbFault, MAX_CONSECUTIVE_IO_ERRORS } from "../../../dist/node/runtime/node/community/local-community/db-fault.js";

describe("classifyDbFault", () => {
    it.each([
        [{ code: "SQLITE_BUSY" }, "busy"],
        [{ code: "SQLITE_BUSY_SNAPSHOT" }, "busy"],
        [{ code: "SQLITE_LOCKED" }, "busy"],
        [{ code: "SQLITE_IOERR" }, "maybe-transient"],
        [{ code: "SQLITE_IOERR_READ" }, "maybe-transient"],
        [{ code: "SQLITE_CORRUPT" }, "final"],
        [{ code: "SQLITE_FULL" }, "final"],
        [{ code: "SQLITE_READONLY" }, "final"],
        [{ code: "SQLITE_CANTOPEN" }, "final"],
        [new TypeError("The database connection is not open"), "final"],
        [new Error("SQLITE_IOERR: disk I/O error"), "maybe-transient"],
        [new Error("SQLITE_BUSY: database is locked"), "busy"],
        [new Error("anything else"), "final"],
        [undefined, "final"],
        [null, "final"],
        ["SQLITE_BUSY", "final"] // a bare string is not an error object
    ])("%j is %s", (error, expected) => {
        expect(classifyDbFault(error)).toBe(expected);
    });

    it("bounds the retries of a maybe-transient fault", () => {
        expect(MAX_CONSECUTIVE_IO_ERRORS).toBe(5);
    });
});

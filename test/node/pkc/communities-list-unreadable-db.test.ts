import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import Database from "better-sqlite3";
import { monitorCommunitiesDirectory, refreshCommunitiesList } from "../../../dist/node/runtime/node/util.js";
import { STORAGE_KEYS } from "../../../dist/node/constants.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PKCCommunitiesEntry } from "../../../dist/node/clients/rpc-client/types.js";

// Every file better-sqlite3 opens and every file fs.openSync opens (the SQLite header check), by basename, so the tests
// can count how often the communities list opens a file
const { openedDbFilenames, openedFilenames } = vi.hoisted(() => ({ openedDbFilenames: [] as string[], openedFilenames: [] as string[] }));

vi.mock("node:fs", async (importOriginal) => {
    const original = await importOriginal<typeof import("node:fs")>();
    const pathModule = await import("path");
    const openSync: typeof original.openSync = (...args) => {
        if (typeof args[0] === "string") openedFilenames.push(pathModule.basename(args[0]));
        return original.openSync(...args);
    };
    return { ...original, default: { ...original, openSync }, openSync };
});

vi.mock("better-sqlite3", async (importOriginal) => {
    const original = await importOriginal<{ default: typeof Database }>();
    const pathModule = await import("path");
    class CountingDatabase extends original.default {
        constructor(...args: ConstructorParameters<typeof Database>) {
            if (typeof args[0] === "string") openedDbFilenames.push(pathModule.basename(args[0]));
            super(...args);
        }
    }
    return { default: CountingDatabase };
});

// Node-only: real files and a real filesystem watcher. It needs no PKC instance, only what the communities list reads
// from one, so it runs under every config.
//
// pkc.communities lists dataPath/communities by reading each DB's identity. A DB whose identity is read is cached, so it
// is opened once. A DB that can't be read (no internal state: a community still being created, or one whose creation
// was abandoned; not a database: the partial copy of a failed rename) was not remembered at all, so every refresh
// opened it again (issue #540). Each open is synchronous SQLite work, and on Windows an open handle makes the file
// impossible to unlink for as long as it is held (issue #514), and three processes on one dataPath were seen opening
// the same unreadable file every 20 ms.
describe("pkc.communities and a community DB that can't be read", () => {
    const dataPath = path.join(process.cwd(), ".tmp", `communities-list-unreadable-db-${uuidv4()}`);
    const communitiesPath = path.join(dataPath, "communities");
    const statelessDb = "stateless-db.bso"; // has its tables, no internal state
    const notADatabase = "not-a-database.bso"; // starts like a SQLite file and is not one, as a partial copy does
    const notSqlite = "not-sqlite.txt"; // a stray file without the SQLite header
    const internalStateKey = `keyv:${STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY]}`;

    const createFakePkc = () => {
        const pkc = {
            dataPath,
            communities: [] as PKCCommunitiesEntry[],
            emit: (_eventName: string, { communities }: { communities: PKCCommunitiesEntry[] }) => {
                pkc.communities = communities;
                return true;
            }
        };
        return pkc as unknown as PKC;
    };

    const opensOf = (filename: string) => openedDbFilenames.filter((opened) => opened === filename).length;
    const headerChecksOf = (filename: string) => openedFilenames.filter((opened) => opened === filename).length;
    const resetCounts = () => {
        openedDbFilenames.length = 0;
        openedFilenames.length = 0;
    };

    const createStatelessDb = (filename: string) => {
        const db = new Database(path.join(communitiesPath, filename));
        db.pragma("journal_mode = WAL"); // as a community DB is
        db.exec("CREATE TABLE keyv(key VARCHAR(255) PRIMARY KEY, value TEXT)");
        db.close();
    };

    const writeInternalState = (filename: string, publicKey: string) => {
        const db = new Database(path.join(communitiesPath, filename));
        db.prepare("INSERT INTO keyv (key, value) VALUES (?, ?)").run(
            internalStateKey,
            JSON.stringify({ value: { signer: { address: publicKey } } })
        );
        db.close();
    };

    beforeAll(() => {
        fs.mkdirSync(communitiesPath, { recursive: true });
    });

    beforeEach(() => {
        for (const filename of fs.readdirSync(communitiesPath)) fs.rmSync(path.join(communitiesPath, filename), { force: true });
        createStatelessDb(statelessDb);
        fs.writeFileSync(
            path.join(communitiesPath, notADatabase),
            Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(4096, "x")])
        );
        fs.writeFileSync(path.join(communitiesPath, notSqlite), "not a community DB");
        resetCounts();
    });

    afterAll(() => {
        fs.rmSync(dataPath, { recursive: true, force: true });
    });

    it("opens it once, not on every refresh", () => {
        const pkc = createFakePkc();
        for (let i = 0; i < 5; i++) refreshCommunitiesList(pkc);

        expect(opensOf(statelessDb)).to.equal(1);
        expect(opensOf(notADatabase)).to.equal(1);
        expect(opensOf(notSqlite)).to.equal(0);
        for (const filename of [statelessDb, notADatabase, notSqlite]) expect(headerChecksOf(filename), filename).to.equal(1);
        expect(pkc.communities).to.deep.equal([]);
    });

    it("opens it again once the file changes, and lists the community when it has its internal state", () => {
        const pkc = createFakePkc();
        refreshCommunitiesList(pkc);
        expect(pkc.communities).to.deep.equal([]);

        writeInternalState(statelessDb, "12D3KooWStatelessDb");
        resetCounts();
        refreshCommunitiesList(pkc);

        expect(opensOf(statelessDb)).to.equal(1);
        expect(opensOf(notADatabase)).to.equal(0);
        expect(pkc.communities.map((entry) => entry.address)).to.deep.equal([statelessDb]);
    });

    it("opens a file that replaced it under the same filename", () => {
        const pkc = createFakePkc();
        refreshCommunitiesList(pkc);

        fs.rmSync(path.join(communitiesPath, notADatabase));
        createStatelessDb(notADatabase);
        writeInternalState(notADatabase, "12D3KooWReplacedFile");
        resetCounts();
        refreshCommunitiesList(pkc);

        expect(opensOf(notADatabase)).to.equal(1);
        expect(pkc.communities.map((entry) => entry.address)).to.deep.equal([notADatabase]);
    });

    it("forgets it when the file is removed, so a later file under that filename is read", () => {
        const pkc = createFakePkc();
        refreshCommunitiesList(pkc);

        fs.rmSync(path.join(communitiesPath, notADatabase));
        refreshCommunitiesList(pkc);
        createStatelessDb(notADatabase);
        resetCounts();
        refreshCommunitiesList(pkc);

        expect(opensOf(notADatabase)).to.equal(1);
    });

    // The watcher calls a refresh on every event in dataPath/communities, so before, every event on any file opened
    // every unreadable DB again. On the Windows CI runner that was one pass about every 16 ms for as long as such a DB
    // existed (issue #540). A read-only open of a DB in WAL mode produces watcher events of its own, on Windows and
    // Linux alike, but only for the DB's -wal and -shm files, which the watcher ignores.
    it("is not opened again by filesystem events on other files", async () => {
        const rawEvents: string[] = [];
        const rawWatcher = fs.watch(communitiesPath, (eventType, filename) => rawEvents.push(`${eventType}:${filename}`));
        const pkc = createFakePkc();
        const watchAbort = await monitorCommunitiesDirectory(pkc);
        try {
            // Let the events of the initial refresh's own opens arrive before counting
            await new Promise((resolve) => setTimeout(resolve, 500));
            rawEvents.length = 0;
            resetCounts();

            const otherFile = path.join(communitiesPath, "other-file.bso");
            for (let i = 0; i < 20; i++) {
                fs.writeFileSync(otherFile, Buffer.alloc(4096 + i, "y"));
                await new Promise((resolve) => setTimeout(resolve, 25));
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));

            expect(rawEvents.length).to.be.greaterThan(0); // the watcher did fire
            expect(headerChecksOf("other-file.bso")).to.be.greaterThan(0); // and its events did reach the refresh
            for (const filename of [statelessDb, notADatabase, notSqlite]) {
                expect(opensOf(filename), filename).to.equal(0);
                expect(headerChecksOf(filename), filename).to.equal(0);
            }
        } finally {
            watchAbort.abort();
            rawWatcher.close();
        }
    });
});

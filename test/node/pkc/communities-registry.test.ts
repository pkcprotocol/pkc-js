import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import Database from "better-sqlite3";

// Every listing of a `communities` directory and every open of a database is recorded
// `afterNextListing` runs once, between a listing of the directory and what its caller does with it. `onOpenOf` runs
// when the database of that filename is opened
const { directoryListings, openedDbFilenames, failNextOpenOf, hooks, onOpenOf, seenAsMissingOnce, statFailsOf, fileOpenFailsOnceOf } =
    vi.hoisted(() => ({
        directoryListings: [] as string[],
        openedDbFilenames: [] as string[],
        failNextOpenOf: new Set<string>(),
        hooks: { afterNextListing: undefined as (() => void) | undefined },
        onOpenOf: new Map<string, () => void>(),
        // by absolute path: seen as missing once, a stat that fails, an open (of the file, not of the database) that fails once
        seenAsMissingOnce: new Set<string>(),
        statFailsOf: new Set<string>(),
        fileOpenFailsOnceOf: new Set<string>()
    }));

vi.mock("node:fs", async (importOriginal) => {
    const original = await importOriginal<typeof import("node:fs")>();
    const pathModule = await import("path");
    const readdirSync = (...args: unknown[]) => {
        const isCommunitiesDirectory = pathModule.basename(String(args[0])) === "communities";
        if (isCommunitiesDirectory) directoryListings.push(String(args[0]));
        const listed = Reflect.apply(original.readdirSync, original, args);
        if (isCommunitiesDirectory && hooks.afterNextListing) {
            const afterListing = hooks.afterNextListing;
            hooks.afterNextListing = undefined;
            afterListing();
        }
        return listed;
    };
    const errorWithCode = (code: string) => Object.assign(new Error(`${code}: made up by the test`), { code });
    const existsSync = (...args: unknown[]) => {
        if (seenAsMissingOnce.delete(pathModule.resolve(String(args[0])))) return false;
        return Reflect.apply(original.existsSync, original, args);
    };
    const statSync = (...args: unknown[]) => {
        if (statFailsOf.has(pathModule.resolve(String(args[0])))) throw errorWithCode("EIO");
        return Reflect.apply(original.statSync, original, args);
    };
    const openSync = (...args: unknown[]) => {
        if (fileOpenFailsOnceOf.delete(pathModule.resolve(String(args[0])))) throw errorWithCode("EMFILE");
        return Reflect.apply(original.openSync, original, args);
    };
    const mocked = { readdirSync, existsSync, statSync, openSync };
    return { ...original, default: { ...original, ...mocked }, ...mocked };
});

vi.mock("better-sqlite3", async (importOriginal) => {
    const original = await importOriginal<{ default: typeof Database }>();
    const pathModule = await import("path");
    class CountingDatabase extends original.default {
        constructor(...args: ConstructorParameters<typeof Database>) {
            if (typeof args[0] === "string") {
                const filename = pathModule.basename(args[0]);
                openedDbFilenames.push(filename);
                onOpenOf.get(filename)?.();
                if (failNextOpenOf.delete(filename)) throw Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });
            }
            super(...args);
        }
    }
    return { default: CountingDatabase };
});

import { monitorCommunitiesDirectory } from "../../../dist/node/runtime/node/util.js";
import {
    COMMUNITIES_REGISTRY_RECONCILE_BATCH_SIZE,
    COMMUNITIES_REGISTRY_TICK_MS,
    getCommunitiesRegistry,
    isCommunityStartLockedSync,
    markCommunityDbAsBeingWritten
} from "../../../dist/node/runtime/node/community/communities-registry.js";
import { STORAGE_KEYS } from "../../../dist/node/constants.js";
import { holdStartLockInAnotherProcess } from "../../helpers/start-lock-holder.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PKCCommunitiesEntry } from "../../../dist/node/clients/rpc-client/types.js";
import Logger from "@pkcprotocol/pkc-logger";

const testLog = Logger({ namespace: "pkc-js:test:communities-registry" });

// Node-only: real community DB files, a real filesystem watcher and the real registry in dataPath/storage.db. It needs
// no PKC instance, only what the registry reads from one (its dataPath) and gives it (communitieschange), so it runs
// under every config.
//
// pkc.communities, the lookup behind pkc.createCommunity and `started` come from the communities registry (issue #585).
// The registry indexes the DB files in dataPath/communities, says which PKC instance has started each, and is shared by
// every instance on the dataPath. These tests pin what it does with the directory, with the files in it, and with
// other instances.
describe("communities registry", () => {
    let dataPath: string;
    let communitiesPath: string;
    const monitors: AbortController[] = [];
    const internalStateKey = `keyv:${STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY]}`;

    const createStatelessDb = (filePath: string) => {
        const db = new Database(filePath);
        db.pragma("journal_mode = WAL"); // as a community DB is
        db.exec("CREATE TABLE keyv(key VARCHAR(255) PRIMARY KEY, value TEXT)");
        db.close();
    };
    const writeInternalState = (filePath: string, publicKey: string) => {
        const db = new Database(filePath);
        db.prepare("INSERT INTO keyv (key, value) VALUES (?, ?)").run(
            internalStateKey,
            JSON.stringify({ value: { signer: { address: publicKey } } })
        );
        db.close();
    };
    const createCommunityDb = (address: string, publicKey = `12D3KooW${address}`, directory = communitiesPath) => {
        const filePath = path.join(directory, address);
        createStatelessDb(filePath);
        writeInternalState(filePath, publicKey);
        return filePath;
    };

    // What a PKC is to the registry: a dataPath, and somewhere to put the list
    const createInstance = async () => {
        const emitted: PKCCommunitiesEntry[][] = [];
        const pkc = {
            dataPath,
            _log: testLog,
            communities: undefined as PKCCommunitiesEntry[] | undefined,
            listenerThrows: false, // as a `communitieschange` listener of the user that throws
            emit: (_eventName: string, { communities }: { communities: PKCCommunitiesEntry[] }) => {
                pkc.communities = communities;
                emitted.push(communities);
                if (pkc.listenerThrows) throw new Error("thrown by a communitieschange listener");
                return true;
            }
        };
        monitors.push(await monitorCommunitiesDirectory(pkc as unknown as PKC));
        const addresses = () => pkc.communities!.map((entry) => entry.address);
        const started = () => pkc.communities!.filter((entry) => entry.started).map((entry) => entry.address);
        return { pkc, emitted, addresses, started, registry: getCommunitiesRegistry(pkc) };
    };

    const waitUntil = async (predicate: () => boolean, what: string, timeoutMs = 15_000) => {
        const deadline = Date.now() + timeoutMs;
        while (!predicate()) {
            if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}`);
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    };
    const settle = () => new Promise((resolve) => setTimeout(resolve, 500));
    const opensOf = (filename: string) => openedDbFilenames.filter((opened) => opened === filename).length;
    const resetCounts = () => {
        directoryListings.length = 0;
        openedDbFilenames.length = 0;
    };

    const registeredAddresses = () => {
        const db = new Database(path.join(dataPath, "storage.db"), { readonly: true });
        try {
            return (db.prepare("SELECT address FROM localCommunities ORDER BY address").all() as { address: string }[]).map(
                (row) => row.address
            );
        } finally {
            db.close();
        }
    };

    beforeEach(() => {
        failNextOpenOf.clear();
        onOpenOf.clear();
        seenAsMissingOnce.clear();
        statFailsOf.clear();
        fileOpenFailsOnceOf.clear();
        hooks.afterNextListing = undefined;
        dataPath = path.join(process.cwd(), ".tmp", `communities-registry-${uuidv4()}`);
        communitiesPath = path.join(dataPath, "communities");
        fs.mkdirSync(communitiesPath, { recursive: true });
        resetCounts();
    });

    afterEach(() => {
        for (const monitor of monitors.splice(0)) monitor.abort();
        fs.rmSync(dataPath, { recursive: true, force: true });
    });

    describe("the directory", () => {
        it("is listed once when a PKC is created, and each DB is opened once to read its identity", async () => {
            createCommunityDb("b.bso");
            createCommunityDb("a.bso");
            createCommunityDb("12D3KooWKeyNamed", "12D3KooWKeyNamed");
            createStatelessDb(path.join(communitiesPath, "stateless.bso")); // a community still being created
            fs.writeFileSync(
                path.join(communitiesPath, "not-a-database.bso"), // as the partial copy of a failed rename
                Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(4096, "x")])
            );
            fs.writeFileSync(path.join(communitiesPath, "not-sqlite.txt"), "not a community DB");
            fs.mkdirSync(path.join(communitiesPath, "deleted"));
            fs.mkdirSync(path.join(communitiesPath, ".backup_before_migration"));
            resetCounts();

            const first = await createInstance();
            expect(first.pkc.communities).to.deep.equal([
                { publicKey: "12D3KooWKeyNamed", address: "12D3KooWKeyNamed", started: false },
                { name: "a.bso", publicKey: "12D3KooWa.bso", address: "a.bso", started: false },
                { name: "b.bso", publicKey: "12D3KooWb.bso", address: "b.bso", started: false }
            ]);
            expect(directoryListings.length).to.equal(1);
            for (const filename of ["a.bso", "b.bso", "12D3KooWKeyNamed", "stateless.bso", "not-a-database.bso"])
                expect(opensOf(filename), filename).to.equal(1);
            for (const filename of ["not-sqlite.txt", "deleted", ".backup_before_migration"])
                expect(opensOf(filename), filename).to.equal(0);

            // The next PKC on the dataPath reads the identities from the registry, not from the DBs
            resetCounts();
            const second = await createInstance();
            expect(second.pkc.communities).to.deep.equal(first.pkc.communities);
            expect(directoryListings.length).to.equal(1);
            for (const filename of ["a.bso", "b.bso", "12D3KooWKeyNamed"]) expect(opensOf(filename), filename).to.equal(0);
        });

        it("is listed even when it is empty: a PKC waits for its first list", async () => {
            const { pkc, emitted } = await createInstance();
            expect(pkc.communities).to.deep.equal([]);
            expect(emitted.length).to.equal(1);
        });

        it("is not listed again by filesystem events, and a write to a listed DB opens nothing", async () => {
            const listed = createCommunityDb("listed.bso");
            const { addresses, emitted } = await createInstance();
            await settle(); // the events of the files created above
            resetCounts();
            emitted.length = 0;

            for (let i = 0; i < 20; i++) {
                const now = new Date();
                fs.utimesSync(listed, now, now); // a "change" event, as every checkpoint of a started community is
                fs.writeFileSync(path.join(communitiesPath, "listed.bso-wal"), `${i}`);
                fs.writeFileSync(path.join(communitiesPath, "stray-file.txt"), `${i}`);
                await new Promise((resolve) => setTimeout(resolve, 10));
            }
            await settle();

            expect(directoryListings).to.deep.equal([]);
            expect(opensOf("listed.bso")).to.equal(0);
            expect(addresses()).to.deep.equal(["listed.bso"]);
            expect(emitted).to.deep.equal([]);
        });

        // Issue #380: a directory under communities/ was opened to read a SQLite header, and its descriptor leaked
        it.runIf(process.platform === "linux")("an event on a subdirectory opens no file descriptor on it", async () => {
            const deletedDir = path.join(communitiesPath, "deleted");
            fs.mkdirSync(deletedDir);
            await createInstance();
            const descriptorsOn = (target: string) =>
                fs.readdirSync("/proc/self/fd").filter((fd) => {
                    try {
                        return fs.readlinkSync(path.join("/proc/self/fd", fd)) === fs.realpathSync(target);
                    } catch {
                        return false; // closed between readdir and readlink
                    }
                }).length;
            const before = descriptorsOn(deletedDir);
            for (let i = 0; i < 50; i++) {
                const now = new Date();
                fs.utimesSync(deletedDir, now, now);
            }
            await settle();
            expect(descriptorsOn(deletedDir) - before).to.equal(0);
        });

        it("has the start locks of older versions removed from it", async () => {
            createCommunityDb("upgraded.bso");
            const sidecar = path.join(communitiesPath, "upgraded.bso.start.lock.db");
            const lockDirectory = path.join(communitiesPath, "upgraded.bso.start.lock");
            new Database(sidecar).close();
            fs.mkdirSync(lockDirectory);

            const { addresses } = await createInstance();
            expect(addresses()).to.deep.equal(["upgraded.bso"]);
            expect(fs.existsSync(sidecar)).to.be.false;
            expect(fs.existsSync(lockDirectory)).to.be.false;
        });
    });

    describe("a DB file somebody else puts in the directory or takes out of it", () => {
        it("is listed when it appears and unlisted when it is removed", async () => {
            createCommunityDb("already-there.bso");
            const { addresses } = await createInstance();
            const elsewhere = path.join(dataPath, "elsewhere");
            fs.mkdirSync(elsewhere);
            fs.renameSync(createCommunityDb("moved-in.bso", undefined, elsewhere), path.join(communitiesPath, "moved-in.bso"));
            await waitUntil(() => addresses().includes("moved-in.bso"), "the DB that was moved in is listed");
            expect(addresses()).to.deep.equal(["already-there.bso", "moved-in.bso"]);

            fs.rmSync(path.join(communitiesPath, "moved-in.bso"));
            await waitUntil(() => !addresses().includes("moved-in.bso"), "the DB that was removed is unlisted");
            expect(directoryListings.length).to.equal(1); // the one of the PKC's creation
        });

        // A plain copy creates the file empty and writes into it: at its first event it is no community yet
        it("is listed once its last write has landed, when it is written in place", async () => {
            const { addresses } = await createInstance();
            const filePath = path.join(communitiesPath, "copied-in.bso");
            createStatelessDb(filePath);
            await settle();
            expect(addresses()).to.deep.equal([]);

            writeInternalState(filePath, "12D3KooWCopiedIn");
            await waitUntil(() => addresses().includes("copied-in.bso"), "the DB is listed once it has its internal state");
        });

        it("is read again when another file replaces it under the same filename", async () => {
            createCommunityDb("replaced.bso", "12D3KooWBefore");
            const { pkc } = await createInstance();
            expect(pkc.communities![0].publicKey).to.equal("12D3KooWBefore");

            const elsewhere = path.join(dataPath, "elsewhere");
            fs.mkdirSync(elsewhere);
            fs.renameSync(createCommunityDb("replaced.bso", "12D3KooWAfter", elsewhere), path.join(communitiesPath, "replaced.bso"));
            await waitUntil(() => pkc.communities![0]?.publicKey === "12D3KooWAfter", "the identity of the new file is listed");
        });

        it("is not acted on while this process says it is writing it, and is listed when the writer registers it", async () => {
            const { addresses, registry } = await createInstance();
            const doneWriting = markCommunityDbAsBeingWritten({ dataPath, communityAddress: "being-created.bso" });
            resetCounts();
            const filePath = createCommunityDb("being-created.bso");
            await settle();
            expect(opensOf("being-created.bso"), "opened by anyone but its creator").to.equal(2); // the two opens above
            expect(addresses()).to.deep.equal([]);

            doneWriting();
            registry.registerCommunity("being-created.bso");
            expect(addresses()).to.deep.equal(["being-created.bso"]);
            expect(fs.existsSync(filePath)).to.be.true;
        });
    });

    // Several instances register the same file, each when its own filesystem event arrives. One that could not read the
    // DB at that moment (it is locked, the process is out of file descriptors) must not write "no identity" over the
    // identity another has registered: the community would be gone from every list until its file next changed
    it("a DB whose identity is registered stays listed when a later read of it fails", async () => {
        createCommunityDb("read-fails.bso");
        const { addresses, registry } = await createInstance();
        expect(addresses()).to.deep.equal(["read-fails.bso"]);

        failNextOpenOf.add("read-fails.bso");
        registry.registerCommunity("read-fails.bso");
        expect(failNextOpenOf.size, "the read was not attempted").to.equal(0);
        expect(addresses()).to.deep.equal(["read-fails.bso"]);
        expect(registry.findAddress({ publicKey: "12D3KooWread-fails.bso" })).to.equal("read-fails.bso");
    });

    // Another instance wrote the row first: this one finds nothing to write, and must list the community all the same
    it("a DB that another instance registered first is listed by an instance that registers it too", async () => {
        const first = await createInstance();
        const second = await createInstance();
        const doneWriting = markCommunityDbAsBeingWritten({ dataPath, communityAddress: "registered-twice.bso" });
        createCommunityDb("registered-twice.bso");
        doneWriting();
        first.registry.registerCommunity("registered-twice.bso");
        expect(second.addresses(), "listed before it was registered or read").to.deep.equal([]);
        second.registry.registerCommunity("registered-twice.bso");
        expect(second.addresses()).to.deep.equal(["registered-twice.bso"]);
    });

    // The directory is listed before the registry is written, and another instance may create and register a community
    // in between. Its row is then one the listing does not have, and it was deleted as the row of a file that is gone:
    // the community left every list, and a third instance could have claimed it while its creator ran it
    it("a community that another instance creates right after this one listed the directory keeps its row", async () => {
        const first = await createInstance();
        hooks.afterNextListing = () => {
            const doneWriting = markCommunityDbAsBeingWritten({ dataPath, communityAddress: "created-meanwhile.bso" });
            createCommunityDb("created-meanwhile.bso");
            doneWriting();
            first.registry.registerCommunity("created-meanwhile.bso");
            first.registry.claimStart("created-meanwhile.bso");
        };
        const second = await createInstance(); // lists the directory, then reconciles the registry with what it listed
        expect(hooks.afterNextListing, "the directory was not listed").to.be.undefined;
        expect(registeredAddresses()).to.deep.equal(["created-meanwhile.bso"]);
        expect(second.addresses()).to.deep.equal(["created-meanwhile.bso"]);
        expect(second.started()).to.deep.equal(["created-meanwhile.bso"]);
        expect(first.registry.confirmStart("created-meanwhile.bso")).to.equal("owned");
    });

    // The first PKC on a data path of an older version registers every community, which opens every DB. Done as one
    // write transaction, no other process could write to storage.db until the last one was read: at 10,000 communities
    // that is longer than SQLite waits, and a start() in that process failed with SQLITE_BUSY
    it("the communities of a directory are registered in steps, each committed before the next", async () => {
        const count = COMMUNITIES_REGISTRY_RECONCILE_BATCH_SIZE * 2 + 5;
        const addresses = Array.from({ length: count }, (_, i) => `step-${String(i).padStart(4, "0")}.bso`);
        for (const address of addresses) createCommunityDb(address);
        const committedWhenOpened: number[] = [];
        let opened = 0;
        const countCommitted = () => {
            opened++;
            if (opened === COMMUNITIES_REGISTRY_RECONCILE_BATCH_SIZE + 1 || opened === count)
                committedWhenOpened.push(registeredAddresses().length);
        };
        for (const address of addresses) onOpenOf.set(address, countCommitted);

        const { addresses: listed } = await createInstance();
        expect(listed()).to.deep.equal(addresses);
        expect(committedWhenOpened, "rows another process could see while later DBs were still being read").to.deep.equal([
            COMMUNITIES_REGISTRY_RECONCILE_BATCH_SIZE,
            COMMUNITIES_REGISTRY_RECONCILE_BATCH_SIZE * 2
        ]);
    });

    // A read that fails for a reason that passes (the DB is locked, the process is out of file descriptors) leaves a
    // row without an identity. A stopped community is not written to, so no filesystem event followed and it stayed
    // out of pkc.communities until the next PKC on the data path
    it("a DB whose identity could not be read for a passing reason is read again on the timer", async () => {
        createCommunityDb("read-failed-once.bso");
        failNextOpenOf.add("read-failed-once.bso");
        const { addresses, registry } = await createInstance();
        expect(failNextOpenOf.size, "the read was not attempted").to.equal(0);
        expect(addresses()).to.deep.equal([]);
        registry.readChangesOfOtherInstances();
        expect(addresses()).to.deep.equal(["read-failed-once.bso"]);
    });

    it("a file that is not a database is not read again on the timer", async () => {
        fs.writeFileSync(
            path.join(communitiesPath, "not-a-database.bso"),
            Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(4096, "x")])
        );
        createStatelessDb(path.join(communitiesPath, "stateless.bso")); // a community still being created
        const { registry } = await createInstance();
        resetCounts();
        for (let i = 0; i < 3; i++) registry.readChangesOfOtherInstances();
        expect(openedDbFilenames.filter((opened) => opened.endsWith(".bso"))).to.deep.equal([]);
    });

    // `communitieschange` used to be emitted from the filesystem watcher only. It is now emitted by whatever changes
    // the list, so a listener that throws threw out of start(), stop() and createCommunity(): out of claimStart() after
    // the claim was committed, which left a claim nothing released
    it("a communitieschange listener that throws does not fail the call that changed the list", async () => {
        createCommunityDb("listener-throws.bso");
        const { pkc, registry, started } = await createInstance();
        pkc.listenerThrows = true;
        expect(registry.claimStart("listener-throws.bso")).to.be.true;
        expect(started()).to.deep.equal(["listener-throws.bso"]);
        registry.releaseStart("listener-throws.bso");
        expect(started()).to.deep.equal([]);
        expect(isCommunityStartLockedSync({ dataPath, communityAddress: "listener-throws.bso" })).to.be.false;
        registry.unregisterCommunity("listener-throws.bso");
        registry.registerCommunity("listener-throws.bso");
        expect(registry.findAddress({ address: "listener-throws.bso" })).to.equal("listener-throws.bso");
    });

    // The release of a stopped community that can't be written must not leave a claim in the name of a live instance:
    // nothing could start the community again until that process ended
    it("a release that could not be written is written again on the timer, and does not keep this instance from starting the community", async () => {
        createCommunityDb("release-fails.bso");
        const { registry, started } = await createInstance();
        (registry as unknown as { _db: Database.Database })._db.pragma("busy_timeout = 50");
        expect(registry.claimStart("release-fails.bso")).to.be.true;

        const writer = new Database(path.join(dataPath, "storage.db"), { timeout: 0 });
        writer.exec("BEGIN IMMEDIATE"); // another instance, writing for longer than SQLite waits
        try {
            registry.releaseStart("release-fails.bso");
        } finally {
            writer.exec("ROLLBACK");
            writer.close();
        }
        expect(isCommunityStartLockedSync({ dataPath, communityAddress: "release-fails.bso" }), "the release was written").to.be.true;
        expect(registry.isStarted("release-fails.bso")).to.be.false;
        expect(started(), "pkc.communities of the instance that stopped it").to.deep.equal([]);

        registry.readChangesOfOtherInstances();
        expect(isCommunityStartLockedSync({ dataPath, communityAddress: "release-fails.bso" })).to.be.false;

        // and without waiting for the timer: started again right away
        expect(registry.claimStart("release-fails.bso")).to.be.true;
        const blocker = new Database(path.join(dataPath, "storage.db"), { timeout: 0 });
        blocker.exec("BEGIN IMMEDIATE");
        try {
            registry.releaseStart("release-fails.bso");
        } finally {
            blocker.exec("ROLLBACK");
            blocker.close();
        }
        expect(started()).to.deep.equal([]);
        expect(registry.claimStart("release-fails.bso")).to.be.true;
        expect(registry.isStarted("release-fails.bso")).to.be.true;
        expect(started()).to.deep.equal(["release-fails.bso"]);
        registry.readChangesOfOtherInstances(); // nothing left to release
        expect(registry.isStarted("release-fails.bso")).to.be.true;
    });

    // An address comes from whoever calls createCommunity, an RPC client included, and is looked for as a file in
    // dataPath/communities. One that is not a plain filename reached other files: "../storage.db" was registered and
    // then opened as a community, "deleted/<address>" found a deleted one
    it("an address that is not a plain filename is not a local community, and nothing is registered for it", async () => {
        fs.mkdirSync(path.join(communitiesPath, "deleted"));
        createCommunityDb("gone.bso", undefined, path.join(communitiesPath, "deleted"));
        const { registry } = await createInstance();
        const notFilenames = [
            "../storage.db",
            "deleted/gone.bso",
            `deleted${path.sep}gone.bso`,
            path.join(dataPath, "storage.db"),
            "..",
            "."
        ];
        for (const address of notFilenames) {
            expect(registry.findAddress({ address }), address).to.be.undefined;
            expect(registry.findAddress({ name: address }), address).to.be.undefined;
            expect(registry.hasCommunityDb(address), address).to.be.false;
            expect(() => registry.registerCommunity(address), address).to.throw();
            expect(() => registry.claimStart(address), address).to.throw();
        }
        expect(registeredAddresses()).to.deep.equal([]);
    });

    // An .eth/.bso name is one name in any case and in either spelling (issue #424), and its DB is stored as it was
    // typed. Looked up by the exact filename only, a community named MyForum.bso was not local for myforum.bso
    it("a community with an .eth/.bso name is found in any case and either spelling, and any other name only as it is", async () => {
        createCommunityDb("MyForum.bso");
        createCommunityDb("12D3KooWMixedCase", "12D3KooWMixedCase");
        createCommunityDb("Other.xyz");
        const { registry } = await createInstance();
        for (const spelling of ["MyForum.bso", "myforum.bso", "MyForum.eth", "MYFORUM.ETH"]) {
            expect(registry.findAddress({ address: spelling }), spelling).to.equal("MyForum.bso");
            expect(registry.findAddress({ name: spelling, publicKey: "12D3KooWMyForum.bso" }), spelling).to.equal("MyForum.bso");
        }
        expect(registry.findAddress({ address: "12d3koowmixedcase" })).to.be.undefined;
        expect(registry.findAddress({ address: "other.xyz" })).to.be.undefined;
        expect(registry.findAddress({ address: "Other.xyz" })).to.equal("Other.xyz");
        expect(registeredAddresses()).to.deep.equal(["12D3KooWMixedCase", "MyForum.bso", "Other.xyz"]);
    });

    // The lookup saw the file missing, and it was there again when the registry looked inside its write transaction
    it("a lookup finds a community whose DB was seen missing and is there after all", async () => {
        const filePath = createCommunityDb("back-again.bso");
        const { registry, addresses } = await createInstance();
        seenAsMissingOnce.add(path.resolve(filePath));
        expect(registry.findAddress({ address: "back-again.bso" })).to.equal("back-again.bso");
        expect(seenAsMissingOnce.size, "the file was not looked for").to.equal(0);
        expect(addresses()).to.deep.equal(["back-again.bso"]);
    });

    // "Could not look at the file" is not "the file is gone": the row, and the start claim in it, stay
    it("a DB that can't be looked at keeps its row and its start claim", async () => {
        const filePath = createCommunityDb("stat-fails.bso");
        const { registry, started } = await createInstance();
        expect(registry.claimStart("stat-fails.bso")).to.be.true;
        statFailsOf.add(path.resolve(filePath));
        (registry as unknown as { _onFileEvent: (eventType: string, filename: string) => void })._onFileEvent("rename", "stat-fails.bso");
        registry.findAddress({ address: "stat-fails.bso" });
        statFailsOf.clear();
        expect(registeredAddresses()).to.deep.equal(["stat-fails.bso"]);
        expect(started()).to.deep.equal(["stat-fails.bso"]);
        expect(isCommunityStartLockedSync({ dataPath, communityAddress: "stat-fails.bso" })).to.be.true;
    });

    // Out of file descriptors at the first look into the file, before its database is opened
    it("a DB whose file could not be opened for a passing reason is read again on the timer", async () => {
        const filePath = createCommunityDb("open-failed-once.bso");
        fileOpenFailsOnceOf.add(path.resolve(filePath));
        const { addresses, registry } = await createInstance();
        expect(fileOpenFailsOnceOf.size, "the file was not opened").to.equal(0);
        expect(addresses()).to.deep.equal([]);
        registry.readChangesOfOtherInstances();
        expect(addresses()).to.deep.equal(["open-failed-once.bso"]);
    });

    // pkc.createCommunity({ address }) of a community that is not local is a lookup: it must not wait for, or fail on,
    // whoever is writing to storage.db
    it("a lookup of a community that is not local does not write to storage.db", async () => {
        const { registry } = await createInstance();
        const writer = new Database(path.join(dataPath, "storage.db"), { timeout: 0 });
        writer.exec("BEGIN IMMEDIATE"); // another instance, in the middle of a write
        try {
            const startedAt = Date.now();
            expect(registry.findAddress({ address: "remote.bso", publicKey: "12D3KooWRemote" })).to.be.undefined;
            expect(registry.hasCommunityDb("remote.bso")).to.be.false;
            expect(Date.now() - startedAt, "it waited for the writer").to.be.lessThan(1000);
        } finally {
            writer.exec("ROLLBACK");
            writer.close();
        }
    });

    // A creation whose registration failed (storage.db was locked for too long) left a complete DB with no row. Its
    // filesystem events were not acted on while it was written, so nothing listed it until the next PKC
    it("a DB found without a row when asked whether it is there is registered", async () => {
        const { registry, addresses } = await createInstance();
        const doneWriting = markCommunityDbAsBeingWritten({ dataPath, communityAddress: "never-registered.bso" });
        createCommunityDb("never-registered.bso");
        await settle(); // its filesystem events, not acted on
        doneWriting();
        expect(addresses()).to.deep.equal([]);
        expect(registry.hasCommunityDb("never-registered.bso")).to.be.true;
        expect(addresses()).to.deep.equal(["never-registered.bso"]);
    });

    it("an instance that is closed still says whether a community DB is there, and finds none by lookup", async () => {
        createCommunityDb("after-close.bso");
        const { registry } = await createInstance();
        registry.close();
        expect(registry.hasCommunityDb("after-close.bso")).to.be.true;
        expect(registry.hasCommunityDb("not-there.bso")).to.be.false;
        expect(registry.findAddress({ address: "after-close.bso" })).to.be.undefined;
        expect(registry.isStarted("after-close.bso")).to.be.false;
    });

    describe("lookups", () => {
        it("find a community by its address, its name in either spelling, or its key", async () => {
            createCommunityDb("named.bso", "12D3KooWNamedKey");
            createCommunityDb("12D3KooWOnlyKey", "12D3KooWOnlyKey");
            const { registry } = await createInstance();
            resetCounts();

            expect(registry.findAddress({ address: "named.bso" })).to.equal("named.bso");
            expect(registry.findAddress({ name: "named.eth" })).to.equal("named.bso");
            expect(registry.findAddress({ publicKey: "12D3KooWNamedKey" })).to.equal("named.bso");
            expect(registry.findAddress({ name: "named.bso", publicKey: "12D3KooWNamedKey" })).to.equal("named.bso");
            expect(registry.findAddress({ name: "named.bso", publicKey: "12D3KooWOnlyKey" })).to.be.undefined;
            expect(registry.findAddress({ address: "12D3KooWOnlyKey" })).to.equal("12D3KooWOnlyKey");
            expect(registry.findAddress({ address: "12D3KooWNobody" })).to.be.undefined;
            expect(registry.findAddress({})).to.be.undefined;
            expect(registry.hasCommunityDb("named.bso")).to.be.true;
            expect(registry.hasCommunityDb("named.eth")).to.be.false;

            expect(directoryListings).to.deep.equal([]);
            expect(openedDbFilenames.filter((filename) => filename !== "storage.db")).to.deep.equal([]);
        });

        // The watcher fires late on macOS, and not at all for an event the kernel dropped
        it("find a DB that was put in the directory before its filesystem event arrived", async () => {
            const { registry, addresses } = await createInstance();
            createCommunityDb("just-created.bso");
            expect(registry.findAddress({ address: "just-created.bso" })).to.equal("just-created.bso");
            expect(addresses()).to.deep.equal(["just-created.bso"]);
        });

        it("find a DB whose identity can't be read yet by its filename only", async () => {
            const { registry, addresses } = await createInstance();
            createStatelessDb(path.join(communitiesPath, "stateless.bso"));
            expect(registry.findAddress({ address: "stateless.bso" })).to.equal("stateless.bso");
            expect(registry.findAddress({ name: "stateless.bso", publicKey: "12D3KooWSomeKey" })).to.be.undefined;
            expect(addresses()).to.deep.equal([]);
        });

        it("no longer find a community whose DB was removed, before its filesystem event arrived", async () => {
            const filePath = createCommunityDb("removed.bso");
            const { registry, addresses } = await createInstance();
            fs.rmSync(filePath);
            expect(registry.findAddress({ address: "removed.bso" })).to.be.undefined;
            expect(addresses()).to.deep.equal([]);
        });
    });

    describe("started", () => {
        it("is set in the list of the instance that starts or stops a community at once, with one event each", async () => {
            createCommunityDb("a.bso");
            createCommunityDb("b.bso");
            const { registry, started, emitted } = await createInstance();
            emitted.length = 0;
            resetCounts();

            expect(registry.claimStart("b.bso")).to.be.true;
            expect(started()).to.deep.equal(["b.bso"]);
            expect(registry.isStarted("b.bso")).to.be.true;
            expect(registry.claimStart("b.bso"), "claimed twice").to.be.false;
            registry.releaseStart("b.bso");
            expect(started()).to.deep.equal([]);
            expect(emitted.length).to.equal(2);

            expect(directoryListings).to.deep.equal([]);
            // no lock file is tried for an instance's own communities, and no community DB is opened
            expect(openedDbFilenames).to.deep.equal([]);
        });

        it("what a PKC was given as its list is not changed by later changes", async () => {
            createCommunityDb("a.bso");
            const { registry, pkc } = await createInstance();
            const firstList = pkc.communities!;
            registry.claimStart("a.bso");
            createCommunityDb("b.bso");
            registry.registerCommunity("b.bso");
            expect(firstList).to.deep.equal([{ name: "a.bso", publicKey: "12D3KooWa.bso", address: "a.bso", started: false }]);
            expect(pkc.communities!.length).to.equal(2);
        });

        it("reaches another instance on the dataPath when it next reads the registry, which it does on a timer", async () => {
            createCommunityDb("shared.bso");
            const first = await createInstance();
            const second = await createInstance();

            expect(first.registry.claimStart("shared.bso")).to.be.true;
            expect(second.registry.isStarted("shared.bso"), "asked of the registry, the answer is never late").to.be.true;
            expect(second.registry.claimStart("shared.bso"), "started twice").to.be.false;
            await waitUntil(() => second.started().includes("shared.bso"), "the timer shows it started", COMMUNITIES_REGISTRY_TICK_MS * 4);

            first.registry.releaseStart("shared.bso");
            second.registry.readChangesOfOtherInstances();
            expect(second.started()).to.deep.equal([]);
            expect(second.registry.claimStart("shared.bso")).to.be.true;
        });

        it("ends for every community of an instance that is closed", async () => {
            createCommunityDb("a.bso");
            createCommunityDb("b.bso");
            const first = await createInstance();
            const second = await createInstance();
            first.registry.claimStart("a.bso");
            first.registry.claimStart("b.bso");
            second.registry.readChangesOfOtherInstances();
            expect(second.started()).to.deep.equal(["a.bso", "b.bso"]);

            first.registry.close();
            expect(isCommunityStartLockedSync({ dataPath, communityAddress: "a.bso" })).to.be.false;
            second.registry.readChangesOfOtherInstances();
            expect(second.started()).to.deep.equal([]);
            expect(fs.readdirSync(path.join(dataPath, "pkc-instances")).length, "lock files left").to.equal(1); // the second's
        });

        // A killed process writes nothing, so nothing tells the other instances. They find out by trying its lock
        it("ends for the communities of a process that is killed, when another instance next reads the registry", async () => {
            createCommunityDb("held.bso");
            const { registry, started } = await createInstance();
            const holder = await holdStartLockInAnotherProcess({ dataPath, communityAddress: "held.bso" });
            try {
                registry.readChangesOfOtherInstances();
                expect(started()).to.deep.equal(["held.bso"]);
                expect(registry.claimStart("held.bso")).to.be.false;
            } finally {
                await holder.kill();
            }

            expect(registry.isStarted("held.bso"), "asked of the registry, a dead instance holds nothing").to.be.false;
            registry.readChangesOfOtherInstances();
            expect(started()).to.deep.equal([]);
            expect(fs.readdirSync(path.join(dataPath, "pkc-instances")).length, "the dead instance's lock file is left").to.equal(1);
            expect(registry.claimStart("held.bso")).to.be.true;
        });
    });

    describe("a running community confirming that it is still this instance's", () => {
        const setStartedBy = (address: string, instanceId: string | null) => {
            const db = new Database(path.join(dataPath, "storage.db"));
            db.prepare("UPDATE localCommunities SET startedBy = ? WHERE address = ?").run(instanceId, address);
            db.close();
        };

        it("is told so, and nothing is written", async () => {
            createCommunityDb("mine.bso");
            const { registry, emitted } = await createInstance();
            registry.claimStart("mine.bso");
            emitted.length = 0;
            for (let i = 0; i < 10; i++) expect(registry.confirmStart("mine.bso")).to.equal("owned");
            expect(emitted).to.deep.equal([]);
        });

        it("is told that another live instance has taken it", async () => {
            createCommunityDb("taken.bso");
            const first = await createInstance();
            const second = await createInstance();
            first.registry.claimStart("taken.bso");
            setStartedBy("taken.bso", second.registry.instanceId);
            expect(first.registry.confirmStart("taken.bso")).to.equal("taken");
            expect(second.registry.confirmStart("taken.bso")).to.equal("owned");
        });

        it("claims it again when the claim is gone, or names an instance that is dead", async () => {
            createCommunityDb("reclaimed.bso");
            const { registry, started } = await createInstance();
            registry.claimStart("reclaimed.bso");

            setStartedBy("reclaimed.bso", null);
            expect(registry.confirmStart("reclaimed.bso")).to.equal("owned");
            expect(isCommunityStartLockedSync({ dataPath, communityAddress: "reclaimed.bso" })).to.be.true;

            setStartedBy("reclaimed.bso", uuidv4()); // no such instance
            expect(registry.confirmStart("reclaimed.bso")).to.equal("owned");
            expect(isCommunityStartLockedSync({ dataPath, communityAddress: "reclaimed.bso" })).to.be.true;

            // and when its row was removed and written again, as around a file event of another process
            registry.unregisterCommunity("reclaimed.bso");
            registry.registerCommunity("reclaimed.bso");
            expect(started()).to.deep.equal([]);
            expect(registry.confirmStart("reclaimed.bso")).to.equal("owned");
            expect(started()).to.deep.equal(["reclaimed.bso"]);
        });
    });
});

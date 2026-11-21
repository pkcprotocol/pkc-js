import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import Database from "better-sqlite3";

// Every listing of a `communities` directory and every open of a database is recorded
const { directoryListings, openedDbFilenames } = vi.hoisted(() => ({
    directoryListings: [] as string[],
    openedDbFilenames: [] as string[]
}));

vi.mock("node:fs", async (importOriginal) => {
    const original = await importOriginal<typeof import("node:fs")>();
    const pathModule = await import("path");
    const readdirSync = (...args: unknown[]) => {
        if (pathModule.basename(String(args[0])) === "communities") directoryListings.push(String(args[0]));
        return Reflect.apply(original.readdirSync, original, args);
    };
    return { ...original, default: { ...original, readdirSync }, readdirSync };
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

import { monitorCommunitiesDirectory } from "../../../dist/node/runtime/node/util.js";
import {
    COMMUNITIES_REGISTRY_TICK_MS,
    getCommunitiesRegistry,
    isCommunityStartLockedSync
} from "../../../dist/node/runtime/node/community/communities-registry.js";
import { STORAGE_KEYS } from "../../../dist/node/constants.js";
import { holdStartLockInAnotherProcess } from "../../helpers/start-lock-holder.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PKCCommunitiesEntry } from "../../../dist/node/clients/rpc-client/types.js";

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
            communities: undefined as PKCCommunitiesEntry[] | undefined,
            emit: (_eventName: string, { communities }: { communities: PKCCommunitiesEntry[] }) => {
                pkc.communities = communities;
                emitted.push(communities);
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

    beforeEach(() => {
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
            const doneWriting = registry.markFileAsBeingWritten("being-created.bso");
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

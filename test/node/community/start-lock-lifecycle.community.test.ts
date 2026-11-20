import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import env from "../../../dist/node/version.js";
import { mockPKC, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { getStartLockPath, isCommunityStartLockedSync } from "../../../dist/node/runtime/node/community/start-lock.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { holdStartLockInAnotherProcess, startCommunityInAnotherProcess } from "../../helpers/start-lock-holder.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

// A community's start lock lives on its connection to its DB (issue #561, see start-lock.ts), so every step of a
// community's life that touches that connection can drop the lock: the community would keep running while another
// process starts it too. After each step here a second OS process asks for the lock, and must be refused for exactly as
// long as the community is started. The DB handler also throws under vitest when the connection is closed while it
// holds the lock, so each step doubles as a check that nothing on its path does that.

// A second OS process asks for the start lock in the local dataPath; over RPC the community runs in the server's process
describeSkipIfRpc("the start lock through a community's life", () => {
    let pkc: PKCType;

    // "held": the other process is refused. "free": it takes the lock, and gives it back by dying
    const lockAsAnotherProcessSeesIt = async (communityAddress: string): Promise<"held" | "free" | string> => {
        try {
            const taker = await holdStartLockInAnotherProcess({ dataPath: pkc.dataPath!, communityAddress });
            await taker.kill();
            return "free";
        } catch (e) {
            return (e as Error).message === "failed ERR_COMMUNITY_ALREADY_STARTED" ? "held" : (e as Error).message;
        }
    };

    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it("is held from start() to stop(), through publish cycles and an edit, and free again after stop()", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        expect(await lockAsAnotherProcessSeesIt(community.address)).to.equal("free");

        await community.start();
        expect(await lockAsAnotherProcessSeesIt(community.address)).to.equal("held");

        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        expect(await lockAsAnotherProcessSeesIt(community.address)).to.equal("held");

        const title = `edited ${Date.now()}`;
        await community.edit({ title });
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.raw.communityIpfs?.title === title });
        expect(await lockAsAnotherProcessSeesIt(community.address)).to.equal("held");

        // other instances of it in this process read and reload it without touching the lock
        const sameCommunity = (await pkc.createCommunity({ address: community.address })) as LocalCommunity;
        expect(sameCommunity.started).to.be.true;
        expect(await lockAsAnotherProcessSeesIt(community.address)).to.equal("held");

        await community.stop();
        expect(isCommunityStartLockedSync({ dataPath: pkc.dataPath!, communityAddress: community.address })).to.be.false;
        expect(await lockAsAnotherProcessSeesIt(community.address)).to.equal("free");

        // and it can be started and stopped again
        await community.start();
        expect(await lockAsAnotherProcessSeesIt(community.address)).to.equal("held");
        await community.delete();
        expect(fs.existsSync(getStartLockPath({ dataPath: pkc.dataPath!, communityAddress: community.address }))).to.be.false;
    });

    // Issue #546 end to end: a server that was killed and restarted within 10s used to find the start locks of its
    // communities still held, fail every start with ERR_COMMUNITY_ALREADY_STARTED and never host them again.
    it("a process killed while it runs a community leaves it startable at once by the next process", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        const address = community.address;
        const otherProcess = await startCommunityInAnotherProcess({ dataPath: pkc.dataPath!, communityAddress: address });
        try {
            // While that process lives, this one sees the community started and is refused
            const whileRunning = (await pkc.createCommunity({ address })) as LocalCommunity;
            expect(whileRunning.started).to.be.true;
            const refused = await whileRunning.start().then(
                (): PKCError | undefined => undefined,
                (e: PKCError) => e
            );
            expect(refused?.code).to.equal("ERR_COMMUNITY_ALREADY_STARTED");
        } finally {
            await otherProcess.kill(); // SIGKILL
        }

        // No wait: the next process starts the community right after the kill
        expect(isCommunityStartLockedSync({ dataPath: pkc.dataPath!, communityAddress: address })).to.be.false;
        const restarted = (await pkc.createCommunity({ address })) as LocalCommunity;
        expect(restarted.started).to.be.false;
        const updatedAtByKilledProcess = restarted.updatedAt;
        expect(updatedAtByKilledProcess, "the killed process had published a record").to.be.a("number");
        await restarted.start();
        expect(restarted.state).to.equal("started");
        expect(await lockAsAnotherProcessSeesIt(address)).to.equal("held");
        // and it hosts the community again: it publishes a newer record
        await resolveWhenConditionIsTrue({
            toUpdate: restarted,
            predicate: async () => typeof restarted.updatedAt === "number" && restarted.updatedAt > updatedAtByKilledProcess!
        });
        await restarted.delete();
    });

    // edit() and exportCommunityModLogs() close the DB connection of a community they find stopped. A start() in flight
    // is still "stopped" until it has taken the lock, on that same connection: closing it then left the community
    // running with no lock, which a second process could take.
    it("an edit() called right after start() waits for it, and the lock stays held", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        const title = `edited while starting ${Date.now()}`;

        const starting = community.start();
        const editing = community.edit({ title });
        await Promise.all([starting, editing]);

        expect(community.state).to.equal("started");
        expect(community.title).to.equal(title);
        expect(await lockAsAnotherProcessSeesIt(community.address)).to.equal("held");
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => community.raw.communityIpfs?.title === title });
        await community.delete();
    });

    // delete() only stopped a community whose state was "started", and a start() is "stopped" until it holds the lock
    // and has set itself up. A delete() overlapping one went on to close the connection that held the lock (refused,
    // see DbHandler.destoryConnection) and moved the DB and its sidecar away under a community that stayed started.
    const expectDeletedAndNotRunning = (community: LocalCommunity, address: string) => {
        expect(community.state).to.equal("stopped");
        expect(community._dbHandler.holdsStartLock(), "the instance still holds the start lock").to.be.false;
        expect(fs.existsSync(path.join(pkc.dataPath!, "communities", address)), "the DB is still there").to.be.false;
        expect(fs.existsSync(getStartLockPath({ dataPath: pkc.dataPath!, communityAddress: address })), "the sidecar is still there").to.be
            .false;
        expect(pkc.communities.map((entry) => entry.address)).to.not.include(address);
    };

    it("a delete() called right after start() waits for it, and leaves no started community behind", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        const address = community.address;
        try {
            const starting = community.start();
            starting.catch(() => {});
            await community.delete();
            await starting; // the start was let through, and the delete stopped what it set up

            expectDeletedAndNotRunning(community, address);
        } finally {
            if (community.state !== "stopped") await community.stop().catch(() => {});
        }
    });

    it("a start() called during a delete() is refused, and the community is deleted", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        const address = community.address;
        try {
            const deleting = community.delete();
            deleting.catch(() => {});
            const startError = await community.start().then(
                (): PKCError | undefined => undefined,
                (e: PKCError) => e
            );
            await deleting;

            expect(startError?.code).to.equal("ERR_COMMUNITY_IS_BEING_DELETED");
            expectDeletedAndNotRunning(community, address);
        } finally {
            if (community.state !== "stopped") await community.stop().catch(() => {});
        }
    });

    // A rename of a stopped community closes its DB connection and moves the DB to its new filename. A start() called
    // while the rename waited on kubo took the start lock on that connection: the close was refused, the DB and its
    // sidecar moved all the same, and the community ran on the old file with a lock nobody else could see.
    it("a start() called during the rename of a stopped community waits for it, then starts under the new address", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        const oldAddress = community.address;
        const newAddress = `start-during-rename-${Date.now()}.bso`;
        const dbPath = (address: string) => path.join(pkc.dataPath!, "communities", address);

        // start() is called from inside the rename, at its kubo call
        const mfs = community._clientsManager.getDefaultKuboRpcClient()._client.files;
        const realMv = mfs.mv.bind(mfs);
        let starting: Promise<void> | undefined;
        vi.spyOn(mfs, "mv").mockImplementation(async (...args) => {
            if (!starting) {
                starting = community.start();
                starting.catch(() => {});
            }
            return realMv(...args);
        });

        try {
            await community.edit({ address: newAddress });
            expect(starting, "the rename never reached its kubo call").to.not.be.undefined;
            await starting;

            expect(community.address).to.equal(newAddress);
            expect(community.state).to.equal("started");
            expect(community._dbHandler.holdsStartLock()).to.be.true;
            expect(fs.existsSync(dbPath(newAddress)), "no DB under the new address").to.be.true;
            expect(fs.existsSync(dbPath(oldAddress)), "the DB is still under the old address").to.be.false;
            expect(await lockAsAnotherProcessSeesIt(newAddress)).to.equal("held");
        } finally {
            vi.restoreAllMocks();
            await community.delete().catch(() => community.stop().catch(() => {}));
        }
    });

    it("exportCommunityModLogs() during a start() does not close the connection that holds the lock", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;

        let startSettled = false;
        const starting = community.start().finally(() => (startSettled = true));
        starting.catch(() => {}); // a failed start is thrown by the await below, once the loop has ended
        let exportsDuringStart = 0;
        while (!startSettled) {
            await community.exportCommunityModLogs();
            exportsDuringStart++;
            await new Promise((resolve) => setImmediate(resolve));
        }
        await starting;

        expect(exportsDuringStart).to.be.greaterThan(1);
        expect(community.state).to.equal("started");
        expect(await lockAsAnotherProcessSeesIt(community.address)).to.equal("held");
        await community.delete();
    });

    it("is free again after a start() that fails once it holds the lock", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        const dbHandler = community._dbHandler;
        const createOrMigrateTablesIfNeeded = dbHandler.createOrMigrateTablesIfNeeded.bind(dbHandler);
        let lockWhileStartFails: string | undefined;
        // start() sets its tables up right after it takes the lock
        dbHandler.createOrMigrateTablesIfNeeded = async () => {
            lockWhileStartFails = await lockAsAnotherProcessSeesIt(community.address);
            throw new Error("failing the start after the lock");
        };

        await expect(community.start()).rejects.toThrow("failing the start after the lock");
        expect(lockWhileStartFails).to.equal("held");
        expect(community.state).to.equal("stopped");
        expect(await lockAsAnotherProcessSeesIt(community.address)).to.equal("free");

        dbHandler.createOrMigrateTablesIfNeeded = createOrMigrateTablesIfNeeded;
        await community.start();
        expect(await lockAsAnotherProcessSeesIt(community.address)).to.equal("held");
        await community.delete();
    });

    it("stays held while start() migrates the DB, which backs it up without closing the connection", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        await community.stop();
        const dbPath = path.join(pkc.dataPath!, "communities", community.address);
        const db = new Database(dbPath);
        try {
            db.pragma(`user_version = ${env.DB_VERSION - 1}`); // one version behind: the next start() migrates it
        } finally {
            db.close();
        }
        // A new instance, as after a restart of the process: the stopped one remembers that it already set its tables up
        const communityToMigrate = (await pkc.createCommunity({ address: community.address })) as LocalCommunity;

        // The backup is removed at the end of the migration, so the migration is under way when this runs
        const backupDir = path.join(pkc.dataPath!, "communities", ".backup_before_migration");
        const realRm = fs.promises.rm.bind(fs.promises);
        let lockDuringMigration: string | undefined;
        let backupExistedDuringMigration = false;
        vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
            if (typeof target === "string" && target.startsWith(path.join(backupDir, `${community.address}.`))) {
                backupExistedDuringMigration = fs.existsSync(target);
                lockDuringMigration = await lockAsAnotherProcessSeesIt(community.address);
            }
            return realRm(target, options);
        });

        await communityToMigrate.start();
        expect(backupExistedDuringMigration, "the migration did not back the DB up").to.be.true;
        expect(lockDuringMigration).to.equal("held");
        expect(await lockAsAnotherProcessSeesIt(community.address)).to.equal("held");
        await communityToMigrate.delete();
    });
});

import { it, expect, beforeAll, afterAll, afterEach, describe, vi } from "vitest";
import fs from "fs";
import Database from "better-sqlite3";
import path from "path";
import { mockPKC } from "../../../dist/node/test/test-util.js";
import { DbHandler } from "../../../dist/node/runtime/node/community/db-handler.js";
import { STORAGE_KEYS } from "../../../dist/node/constants.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
import type { CommunitySettings } from "../../../dist/node/community/types.js";

// A createCommunity() rejected for invalid settings must leave nothing on disk (issue #540). The settings used to be
// validated after the DB file was created, so every rejected create left a DB with its tables and no internal state
// under dataPath/communities. Nothing removed it, and every PKC instance on that dataPath opened it again each time
// it listed its communities.
//
// Each case passes its own signer, so the file to look for is known and suites running at the same time on the shared
// dataPath can't affect the assertion.
//
// Skipped under RPC: the assertion is on the community DB file, which is on the RPC server's dataPath. An RPC client
// has no dataPath.
describeSkipIfRpc("createCommunity rejected for invalid settings leaves no community DB on disk", () => {
    let pkc: PKCType;

    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    const rejectedSettings: { name: string; settings: CommunitySettings; code: string }[] = [
        {
            name: "settings.pages",
            settings: { pages: { replies: [{ name: "best" }, { name: "best" }] } },
            code: "ERR_PAGE_SORT_SETTINGS_VALIDATION_FAILED_FOR_PAGE_SORTS"
        },
        {
            name: "settings.challenges",
            settings: { challenges: [{ name: "question", options: { question: "q?", anwser: "a" } }] },
            code: "ERR_CHALLENGE_SETTINGS_VALIDATION_FAILED_FOR_CHALLENGES"
        }
    ];

    const openFileDescriptorsOn = (filePath: string) =>
        fs.readdirSync("/proc/self/fd").filter((fd) => {
            try {
                return fs.readlinkSync(`/proc/self/fd/${fd}`) === filePath;
            } catch {
                return false; // closed between the listing and the readlink
            }
        }).length;

    const filesOf = (address: string) =>
        fs
            .readdirSync(path.join(pkc.dataPath!, "communities"))
            .filter((filename) => filename.startsWith(address))
            .sort();

    // Removes what a case left on the shared dataPath. Retried: a DB that holds an internal state is a community to
    // every other PKC instance on the dataPath, each of which opens it once to read its identity, and on Windows a file
    // can't be unlinked while one of them has it open. `maxRetries` only applies with `recursive`
    const removeFilesOf = async (address: string) => {
        for (const filename of filesOf(address))
            await fs.promises.rm(path.join(pkc.dataPath!, "communities", filename), {
                force: true,
                recursive: true,
                maxRetries: 50,
                retryDelay: 100
            });
    };

    // Valid settings no longer leave a window, but a step after the file is created can still fail. A DB that has its
    // tables and no internal state is not a community and nothing would ever remove it, so the file this call created
    // goes with the failure, and its connection is closed.
    describe("when a step fails after the DB file was created", () => {
        afterEach(() => {
            vi.restoreAllMocks();
        });

        it("removes the DB file it created and closes its connection", async () => {
            const signer = await pkc.createSigner();
            const realKeyvSet = DbHandler.prototype.keyvSet;
            vi.spyOn(DbHandler.prototype, "keyvSet").mockImplementation(function (this: DbHandler, ...args) {
                if (args[0] === STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY]) throw new Error("the internal state could not be written");
                return realKeyvSet.apply(this, args);
            });

            let thrown: unknown;
            try {
                await pkc.createCommunity({ signer });
            } catch (e) {
                thrown = e;
            }
            expect((thrown as Error | undefined)?.message).to.equal("the internal state could not be written");
            expect(filesOf(signer.address)).to.deep.equal([]);

            // An open connection would have kept the -wal and -shm files, and on Windows the removal would have failed.
            // The same signer creating the community afterwards shows nothing of the failed attempt is in the way
            vi.restoreAllMocks();
            const community = await pkc.createCommunity({ signer });
            expect(community.address).to.equal(signer.address);
            await community.delete();
        });

        // Nothing serializes two creations of the same community. The one that finds the other's internal state fails,
        // and the DB it fails on is the other call's community, not a leftover of its own.
        it("does not remove the DB of a concurrent createCommunity with the same signer that succeeded", async () => {
            const signer = await pkc.createSigner();
            const filePath = path.join(pkc.dataPath!, "communities", signer.address);
            // Both calls are held just before they open the DB until both are there, so neither sees the other's file
            // when it gets that far. Left alone, the first call of one process is always a step ahead of the second
            const realInitDbIfNeeded = DbHandler.prototype.initDbIfNeeded;
            let callsWaiting = 0;
            let releaseBoth: () => void;
            const bothWaiting = new Promise<void>((resolve) => (releaseBoth = resolve));
            vi.spyOn(DbHandler.prototype, "initDbIfNeeded").mockImplementation(async function (this: DbHandler, ...args) {
                if (++callsWaiting === 2) releaseBoth();
                await bothWaiting;
                return realInitDbIfNeeded.apply(this, args);
            });
            const settled = Promise.allSettled([pkc.createCommunity({ signer }), pkc.createCommunity({ signer })]);
            // A call whose DB was removed under it waits for a community that never gets listed
            const results = await Promise.race([
                settled,
                new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 15_000))
            ]);
            expect(results, "both calls should settle").to.not.be.undefined;
            vi.restoreAllMocks();
            expect(results!.filter((result) => result.status === "fulfilled").length).to.be.greaterThan(0);
            expect(fs.existsSync(filePath)).to.be.true;

            const community = await pkc.createCommunity({ address: signer.address });
            expect(community.signer?.address).to.equal(signer.address);
            await community.delete();
        });

        // A failed table creation closes the connection before it throws, so whether the file holds an internal state
        // can't be asked of that connection any more. The file is read again for the answer: another creator may have
        // written its state into the file this call created.
        it("keeps a DB that holds another creator's internal state when creating the tables fails", async () => {
            const signer = await pkc.createSigner();
            const filePath = path.join(pkc.dataPath!, "communities", signer.address);
            const internalStateKey = `keyv:${STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY]}`;
            const realCreateTables = DbHandler.prototype.createOrMigrateTablesIfNeeded;
            vi.spyOn(DbHandler.prototype, "createOrMigrateTablesIfNeeded").mockImplementation(async function (this: DbHandler) {
                await realCreateTables.call(this);
                const otherCreator = new Database(filePath);
                otherCreator
                    .prepare("INSERT INTO keyv (key, value) VALUES (?, ?)")
                    .run(internalStateKey, JSON.stringify({ value: { signer: { address: signer.address } } }));
                otherCreator.close();
                this.destoryConnection(); // as the real failure path does before it throws
                throw new Error("creating the tables failed");
            });

            let thrown: unknown;
            try {
                await pkc.createCommunity({ signer });
            } catch (e) {
                thrown = e;
            }
            vi.restoreAllMocks();
            expect((thrown as Error | undefined)?.message).to.equal("creating the tables failed");
            expect(fs.existsSync(filePath)).to.be.true;
            const db = new Database(filePath, { readonly: true });
            try {
                expect(db.prepare("SELECT 1 FROM keyv WHERE key = ?").get(internalStateKey)).to.exist;
            } finally {
                db.close();
            }
            await removeFilesOf(signer.address);
        });

        // On Windows the removal is retried while the file is busy, for up to 10s. A file that is busy because another
        // creator has it open is the one that gains an internal state meanwhile, so each attempt looks again first.
        it("stops removing the DB when it gains an internal state while its removal is being retried", async () => {
            const signer = await pkc.createSigner();
            const filePath = path.join(pkc.dataPath!, "communities", signer.address);
            const internalStateKey = `keyv:${STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY]}`;
            const realKeyvSet = DbHandler.prototype.keyvSet;
            vi.spyOn(DbHandler.prototype, "keyvSet").mockImplementation(function (this: DbHandler, ...args) {
                if (args[0] === STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY]) throw new Error("the internal state could not be written");
                return realKeyvSet.apply(this, args);
            });
            // The first removal attempt finds the file busy, and by the next one another creator has written its state
            const realRm = fs.promises.rm.bind(fs.promises);
            let removalAttempts = 0;
            vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
                if (target !== filePath) return realRm(target, options);
                if (++removalAttempts > 1) return realRm(target, options);
                const otherCreator = new Database(filePath);
                otherCreator
                    .prepare("INSERT INTO keyv (key, value) VALUES (?, ?)")
                    .run(internalStateKey, JSON.stringify({ value: { signer: { address: signer.address } } }));
                otherCreator.close();
                throw Object.assign(new Error(`EBUSY: resource busy or locked, unlink '${filePath}'`), { code: "EBUSY" });
            });

            let thrown: unknown;
            try {
                await pkc.createCommunity({ signer });
            } catch (e) {
                thrown = e;
            }
            vi.restoreAllMocks();
            expect((thrown as Error | undefined)?.message).to.equal("the internal state could not be written");
            expect(removalAttempts, "the removal was attempted, and found the file busy").to.equal(1);
            expect(fs.existsSync(filePath)).to.be.true;
            await removeFilesOf(signer.address);
        });

        // The cleanup is for a DB that has no internal state. Once the state is written the community exists, and a
        // later step failing must not take it away.
        it("keeps the DB when a step fails after the internal state was written", async () => {
            const signer = await pkc.createSigner();
            const filePath = path.join(pkc.dataPath!, "communities", signer.address);
            const { LocalCommunity } = await import("../../../dist/node/runtime/node/community/local-community.js");
            vi.spyOn(LocalCommunity.prototype, "_updateStartedValue").mockRejectedValueOnce(new Error("the start lock could not be read"));

            let thrown: unknown;
            try {
                await pkc.createCommunity({ signer });
            } catch (e) {
                thrown = e;
            }
            expect((thrown as Error | undefined)?.message).to.equal("the start lock could not be read");
            expect(fs.existsSync(filePath)).to.be.true;
            if (process.platform === "linux") expect(openFileDescriptorsOn(filePath)).to.equal(0);

            vi.restoreAllMocks();
            const community = await pkc.createCommunity({ address: signer.address });
            expect(community.signer?.address).to.equal(signer.address);
            await community.delete();
        });

        // A file that is not a SQLite DB is not listed as a community, so createCommunity takes the creation path and
        // fails when it opens it. That file was there before the call and is not this call's to remove.
        it("leaves a file that was already at that address untouched", async () => {
            const signer = await pkc.createSigner();
            const filePath = path.join(pkc.dataPath!, "communities", signer.address);
            const content = Buffer.alloc(4096, "x");
            fs.writeFileSync(filePath, content);
            try {
                let thrown: unknown;
                try {
                    await pkc.createCommunity({ signer });
                } catch (e) {
                    thrown = e;
                }
                expect(thrown, "createCommunity() should have thrown").to.exist;
                expect(fs.existsSync(filePath)).to.be.true;
                expect(fs.readFileSync(filePath).equals(content)).to.be.true;
                // The connection that failed to open it is closed. Closing used to be skipped when the checkpoint
                // before it threw, which it does on a file that is not a database. On Windows the handle left open
                // makes the removal below fail with EBUSY, and on Linux it shows among the process's open files
                if (process.platform === "linux") expect(openFileDescriptorsOn(filePath)).to.equal(0);
                fs.rmSync(filePath);
            } finally {
                await removeFilesOf(signer.address);
            }
        });
    });

    for (const { name, settings, code } of rejectedSettings)
        it(`invalid ${name}`, async () => {
            const signer = await pkc.createSigner();
            const communitiesPath = path.join(pkc.dataPath!, "communities");

            let thrown: unknown;
            try {
                await pkc.createCommunity({ signer, settings });
            } catch (e) {
                thrown = e;
            }
            expect((thrown as PKCError | undefined)?.code).to.equal(code);

            // The DB file, and the -wal and -shm files of a connection that was left open
            const leftBehind = fs.readdirSync(communitiesPath).filter((filename) => filename.startsWith(signer.address));
            expect(leftBehind).to.deep.equal([]);
            expect(pkc.communities.some((entry) => entry.publicKey === signer.address)).to.be.false;

            // The same signer can still create the community once the settings are valid
            const community = await pkc.createCommunity({ signer });
            expect(community.address).to.equal(signer.address);
            expect(fs.existsSync(path.join(communitiesPath, signer.address))).to.be.true;
            await community.delete();
        });
});

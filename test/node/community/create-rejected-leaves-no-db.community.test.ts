import { it, expect, beforeAll, afterAll, afterEach, describe, vi } from "vitest";
import fs from "fs";
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

    const filesOf = (address: string) =>
        fs
            .readdirSync(path.join(pkc.dataPath!, "communities"))
            .filter((filename) => filename.startsWith(address))
            .sort();

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
            } finally {
                for (const filename of filesOf(signer.address))
                    fs.rmSync(path.join(pkc.dataPath!, "communities", filename), { force: true });
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

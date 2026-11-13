// A DB migration copies the DB to communities/.backup_before_migration first and removes that copy once the migration
// succeeded. On Windows the removal can fail with EBUSY or EPERM while another handle still has the file open. The
// removal used to be tried once with nothing catching its failure, so a busy backup made start() reject although the
// migration itself had succeeded and the DB version was already bumped. The backup then stayed for good, since the next
// start had nothing to migrate.
// A busy file is simulated by failing fs.promises.rm with the codes Windows returns, so the cases run on every OS.
import { describe, afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import env from "../../../dist/node/version.js";
import { mockPKC, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

const busyError = (code: string, filePath: string) =>
    Object.assign(new Error(`${code}: resource busy or locked, unlink '${filePath}'`), { code, syscall: "unlink" });

function readDbVersion(dbPath: string): number {
    const db = new Database(dbPath, { readonly: true });
    try {
        return db.pragma("user_version", { simple: true }) as number;
    } finally {
        db.close();
    }
}

// A stopped community whose DB says it is one version behind, so the next start() migrates it and backs it up first
async function createCommunityWithDbBehindLatest() {
    const pkc = await mockPKC({});
    const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
    await community.start();
    await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    await community.stop();
    const dbPath = path.join(pkc.dataPath!, "communities", community.address);
    const db = new Database(dbPath);
    try {
        db.pragma(`user_version = ${env.DB_VERSION - 1}`);
    } finally {
        db.close();
    }
    // A new instance, as after a restart of the process: the stopped one remembers that it already set its tables up
    const communityToMigrate = (await pkc.createCommunity({ address: community.address })) as LocalCommunity;
    const backupDir = path.join(pkc.dataPath!, "communities", ".backup_before_migration");
    const backupsOfThisCommunity = () =>
        fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((name) => name.startsWith(`${community.address}.`)) : [];
    return { pkc, community: communityToMigrate, dbPath, backupDir, backupsOfThisCommunity };
}

// Fails the removal of this community's migration backup, `timesBusy` times or always
function makeBackupBusy(backupDir: string, communityAddress: string, code: string, timesBusy: number) {
    const realRm = fs.promises.rm.bind(fs.promises);
    const attempts: string[] = [];
    vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
        const isBackup = typeof target === "string" && target.startsWith(path.join(backupDir, `${communityAddress}.`));
        if (!isBackup) return realRm(target, options);
        attempts.push(target);
        if (attempts.length <= timesBusy) throw busyError(code, target);
        return realRm(target, options);
    });
    return attempts;
}

// Rewrites the community's sqlite file directly and stubs the filesystem of the process that runs the community,
// neither of which is reachable over RPC.
describeSkipIfRpc("Removing the DB backup after a migration", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    for (const code of ["EBUSY", "EPERM"])
        it(`start() succeeds and the backup is removed when it is ${code} at first`, async () => {
            const { pkc, community, dbPath, backupDir, backupsOfThisCommunity } = await createCommunityWithDbBehindLatest();
            try {
                const attempts = makeBackupBusy(backupDir, community.address, code, 2);
                await community.start();
                expect(readDbVersion(dbPath)).to.equal(env.DB_VERSION);
                expect(attempts, "the removal is retried until the file is released").to.have.length(3);
                expect(backupsOfThisCommunity()).to.deep.equal([]);
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => community.startedState === "succeeded"
                });
            } finally {
                await community.delete().catch(() => {});
                await pkc.destroy();
            }
        });

    it("start() still succeeds when the backup stays busy, and the backup is left in place", async () => {
        const { pkc, community, dbPath, backupDir, backupsOfThisCommunity } = await createCommunityWithDbBehindLatest();
        try {
            const attempts = makeBackupBusy(backupDir, community.address, "EBUSY", Infinity);
            await community.start();
            expect(readDbVersion(dbPath), "the migration itself succeeded").to.equal(env.DB_VERSION);
            expect(attempts.length).to.be.greaterThan(1);
            expect(backupsOfThisCommunity(), "a backup that can't be removed is harmless and stays").to.have.length(1);
            expect(community.state).to.equal("started");
        } finally {
            vi.restoreAllMocks();
            await community.delete().catch(() => {});
            for (const backup of backupsOfThisCommunity()) await fs.promises.rm(path.join(backupDir, backup), { force: true });
            await pkc.destroy();
        }
    });
});

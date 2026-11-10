import { existsSync, promises as fsPromises } from "node:fs";
import Logger from "@pkcprotocol/pkc-logger";
import path from "node:path";
import { v4 as uuidV4 } from "uuid";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deleteOldCommunityInWindows } from "../../../dist/node/runtime/node/util.js";

// Free signer/verify helpers and raw clients take a required log (issue #493); tests use the process-default root
const testLog = Logger({ namespace: "pkc-js:test:delete-old-community-in-windows" });

type PkcWithStorage = Parameters<typeof deleteOldCommunityInWindows>[1];

const STORAGE_KEY = "PERSISTENT_DELETED_COMMUNITIES";

// deleteOldCommunityInWindows removes a community's old DB file after a delete() or a rename on Windows, where the
// file can still be held for a moment after its connection closed. It used to sleep a fixed 10s before every rm,
// so every rename and delete on Windows blocked 10s even when nothing held the file (PR #414's rename suites spent
// most of their windows-latest time there and timed the job out). These pin the contract: a free file goes at once,
// a busy one is retried until it is released, and one that stays busy is recorded for a later delete as before.
// The helper runs on every OS, so a busy file is simulated by failing fs.promises.rm with the codes Windows returns.
function createPkcWithStorage(): { pkc: PkcWithStorage; storage: Map<string, unknown> } {
    const storage = new Map<string, unknown>();
    const pkc = {
        _log: testLog,
        _storage: {
            getItem: async (key: string): Promise<unknown> => storage.get(key),
            setItem: async (key: string, value: unknown): Promise<void> => void storage.set(key, value)
        }
    } as unknown as PkcWithStorage;
    return { pkc, storage };
}

async function createOldDbFile(): Promise<string> {
    const dir = path.join(process.cwd(), ".tmp", "delete-old-community-in-windows");
    await fsPromises.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `old-community-${uuidV4()}.bso`);
    await fsPromises.writeFile(filePath, "old db");
    return filePath;
}

const busyError = (code: string) => Object.assign(new Error(`${code}: resource busy or locked`), { code });

describe("deleteOldCommunityInWindows", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("removes a file nothing holds at once, without a fixed wait", async () => {
        const { pkc, storage } = createPkcWithStorage();
        const filePath = await createOldDbFile();

        const startedAt = Date.now();
        await deleteOldCommunityInWindows(filePath, pkc);

        expect(Date.now() - startedAt).to.be.lessThan(2000);
        expect(existsSync(filePath)).to.be.false;
        expect(storage.get(STORAGE_KEY)).to.be.undefined;
    });

    for (const code of ["EBUSY", "EPERM"])
        it(`retries while rm fails with ${code} and removes the file once it is released`, async () => {
            const { pkc, storage } = createPkcWithStorage();
            const filePath = await createOldDbFile();
            const realRm = fsPromises.rm.bind(fsPromises);
            const rmSpy = vi
                .spyOn(fsPromises, "rm")
                .mockRejectedValueOnce(busyError(code))
                .mockRejectedValueOnce(busyError(code))
                .mockImplementation(realRm);

            await deleteOldCommunityInWindows(filePath, pkc);

            expect(rmSpy).toHaveBeenCalledTimes(3);
            expect(existsSync(filePath)).to.be.false;
            expect(storage.get(STORAGE_KEY)).to.be.undefined;
        });

    it("records the file for a later delete when it stays busy", async () => {
        const { pkc, storage } = createPkcWithStorage();
        const filePath = await createOldDbFile();
        vi.spyOn(fsPromises, "rm").mockRejectedValue(busyError("EBUSY"));

        await deleteOldCommunityInWindows(filePath, pkc, { timeoutMs: 500 });

        expect(existsSync(filePath)).to.be.true;
        expect(storage.get(STORAGE_KEY)).to.deep.equal([path.basename(filePath)]);
        await fsPromises.unlink(filePath);
    });
});

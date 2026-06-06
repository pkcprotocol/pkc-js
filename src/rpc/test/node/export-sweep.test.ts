// Coverage for the RPC server's orphan export-file sweep (`_sweepOldExportFiles`) and its
// configurability via the `exportFileMaxAgeMs` server option (sibling of `allowPrivateKeyExport`).
//
// The sweep deletes `*.sqlite` files under `<pkcDataPath>/exports/` whose mtime is older than the
// configured max age. We stage files directly on disk, back-date their mtimes with fs.utimes, run
// the sweep in-process, and assert exactly which files survive. Running the server in-process (not
// over a remote RPC socket) is what lets us call `_sweepOldExportFiles()` and read `server.pkc.dataPath`
// directly — so this is a SkipIfRpc suite.

import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { temporaryDirectory } from "tempy";
import net from "node:net";
import path from "node:path";
import { mkdir, writeFile, utimes, readdir } from "node:fs/promises";

import PKCWsServerModule from "../../../../dist/node/rpc/src/index.js";
import { mockPKC } from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../../test/helpers/conditional-tests.js";

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { CreatePKCWsServerOptions } from "../../../../dist/node/rpc/src/types.js";

const { PKCWsServer: createPKCWsServer } = PKCWsServerModule;

type PKCWsServerType = Awaited<ReturnType<typeof createPKCWsServer>>;

const HOUR_MS = 60 * 60 * 1000;

const getAvailablePort = async (): Promise<number> =>
    new Promise((resolve, reject) => {
        const server = net.createServer();
        server.unref();
        server.on("error", (e) => {
            server.close();
            reject(e);
        });
        server.listen(0, () => {
            const address = server.address();
            server.close(() => resolve(typeof address === "object" && address ? address.port : 0));
        });
    });

// Write a file into the server's exports dir, then back-date its mtime by `ageMs`.
const stageExportFile = async (exportsDir: string, name: string, ageMs: number): Promise<string> => {
    const filePath = path.join(exportsDir, name);
    await writeFile(filePath, "fake-sqlite-bytes");
    const when = new Date(Date.now() - ageMs);
    await utimes(filePath, when, when);
    return filePath;
};

const listExports = async (exportsDir: string): Promise<string[]> => (await readdir(exportsDir)).sort();

describeSkipIfRpc("RPC server export-file sweep (_sweepOldExportFiles + exportFileMaxAgeMs)", () => {
    let serverPkc: PKCType;
    // Default-age server (no exportFileMaxAgeMs -> 24h) and a custom-age server (2h) to prove the
    // option actually changes sweep behaviour.
    let defaultServer: PKCWsServerType;
    let customServer: PKCWsServerType;
    // exportFileMaxAgeMs: 0 -> sweep disabled, files kept forever.
    let neverSweepServer: PKCWsServerType;
    let defaultExportsDir: string;
    let customExportsDir: string;
    let neverSweepExportsDir: string;

    const makeServer = async (exportFileMaxAgeMs?: number): Promise<PKCWsServerType> => {
        const opts: CreatePKCWsServerOptions = {
            port: await getAvailablePort(),
            pkcOptions: {
                kuboRpcClientsOptions: serverPkc.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
                httpRoutersOptions: [],
                dataPath: temporaryDirectory()
            },
            ...(exportFileMaxAgeMs !== undefined ? { exportFileMaxAgeMs } : {})
        };
        return createPKCWsServer(opts);
    };

    beforeAll(async () => {
        serverPkc = await mockPKC();
        defaultServer = await makeServer();
        customServer = await makeServer(2 * HOUR_MS);
        neverSweepServer = await makeServer(0);

        defaultExportsDir = path.join(defaultServer.pkc.dataPath!, "exports");
        customExportsDir = path.join(customServer.pkc.dataPath!, "exports");
        neverSweepExportsDir = path.join(neverSweepServer.pkc.dataPath!, "exports");
        await mkdir(defaultExportsDir, { recursive: true });
        await mkdir(customExportsDir, { recursive: true });
        await mkdir(neverSweepExportsDir, { recursive: true });
    }, 120000);

    afterAll(async () => {
        try {
            await defaultServer?.destroy();
        } catch {}
        try {
            await customServer?.destroy();
        } catch {}
        try {
            await neverSweepServer?.destroy();
        } catch {}
        try {
            await serverPkc?.destroy();
        } catch {}
    });

    it("default 24h: sweeps files older than 24h, keeps fresh ones, ignores non-sqlite files", async () => {
        const oldFile = await stageExportFile(defaultExportsDir, "11111111-1111-1111-1111-111111111111.sqlite", 25 * HOUR_MS);
        const freshFile = await stageExportFile(defaultExportsDir, "22222222-2222-2222-2222-222222222222.sqlite", 23 * HOUR_MS);
        // A non-sqlite file older than the threshold must NOT be touched (extension filter).
        const strayFile = await stageExportFile(defaultExportsDir, "notes.txt", 48 * HOUR_MS);

        await defaultServer._sweepOldExportFiles();

        const remaining = await listExports(defaultExportsDir);
        expect(remaining).to.not.include(path.basename(oldFile));
        expect(remaining).to.include(path.basename(freshFile));
        expect(remaining).to.include(path.basename(strayFile));
    });

    it("exportFileMaxAgeMs honored: a 3h-old file is swept under a 2h max age (would survive under the 24h default)", async () => {
        // 3h old > configured 2h max age -> swept. Under the default 24h it would have survived, so
        // this asserts the configured value, not the default, drives the sweep.
        const overThreshold = await stageExportFile(customExportsDir, "33333333-3333-3333-3333-333333333333.sqlite", 3 * HOUR_MS);
        // 1h old < 2h max age -> retained.
        const underThreshold = await stageExportFile(customExportsDir, "44444444-4444-4444-4444-444444444444.sqlite", 1 * HOUR_MS);

        await customServer._sweepOldExportFiles();

        const remaining = await listExports(customExportsDir);
        expect(remaining).to.not.include(path.basename(overThreshold));
        expect(remaining).to.include(path.basename(underThreshold));
    });

    it("exportFileMaxAgeMs: 0 disables the sweep — even ancient files are kept forever", async () => {
        // A file far older than any real threshold must survive when the sweep is disabled.
        const ancient = await stageExportFile(neverSweepExportsDir, "55555555-5555-5555-5555-555555555555.sqlite", 1000 * HOUR_MS);

        await neverSweepServer._sweepOldExportFiles();

        const remaining = await listExports(neverSweepExportsDir);
        expect(remaining).to.include(path.basename(ancient));
    });
});

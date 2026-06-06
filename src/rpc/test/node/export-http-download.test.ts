// Coverage for the RPC server's HTTP export download endpoint (`GET /exports/<exportId>`), focused
// on two reported defects:
//
//   Bug 1 — on a caller-supplied http.Server, the export `request` listener answers a 404 for every
//           non-export path, clobbering routes the caller serves on the same shared server.
//   Bug 2 — a completed export's download URL 404s after a daemon restart, because the handler only
//           looks at in-memory loaded communities and never falls back to the persisted file on disk.
//
// Both assert the POST-FIX behaviour, so they run red against the current (buggy) src until the fix
// lands. Running the servers in-process (not over a remote RPC socket) is what lets us hand a custom
// http.Server to the constructor and read `server.pkc.dataPath` directly — so this is a SkipIfRpc suite.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { temporaryDirectory } from "tempy";
import net from "node:net";
import http from "node:http";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

import PKCWsServerModule from "../../../../dist/node/rpc/src/index.js";
import { mockPKC, createSubWithNoChallenge } from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../../test/helpers/conditional-tests.js";

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity as LocalCommunityType } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { CommunityExportRecord } from "../../../../dist/node/community/types.js";
import type { CreatePKCWsServerOptions } from "../../../../dist/node/rpc/src/types.js";

const { PKCWsServer: createPKCWsServer } = PKCWsServerModule;

type PKCWsServerType = Awaited<ReturnType<typeof createPKCWsServer>>;

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

// Wait until the export with `exportId` reaches a terminal state; resolve the completed record.
const waitForCompletedExport = (community: LocalCommunityType, exportId: string, timeoutMs = 60000): Promise<CommunityExportRecord> =>
    new Promise((resolve, reject) => {
        const settle = () => {
            const rec = community.exports.find((r) => r.exportId === exportId);
            if (rec?.progress === 1) {
                cleanup();
                resolve(rec);
            } else if (rec?.error) {
                cleanup();
                reject(new Error(`Export failed: ${rec.error.code} ${rec.error.message}`));
            }
        };
        const onChange = () => settle();
        const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`Export ${exportId} did not complete within ${timeoutMs}ms`));
        }, timeoutMs);
        const cleanup = () => {
            clearTimeout(timer);
            community.removeListener("exportschange", onChange);
        };
        community.on("exportschange", onChange);
        settle();
    });

describeSkipIfRpc("RPC server HTTP export download endpoint", () => {
    let serverPkc: PKCType;

    const basePkcOptions = (dataPath: string): CreatePKCWsServerOptions["pkcOptions"] => ({
        kuboRpcClientsOptions: serverPkc.kuboRpcClientsOptions as CreatePKCWsServerOptions["pkcOptions"]["kuboRpcClientsOptions"],
        httpRoutersOptions: [],
        dataPath
    });

    beforeAll(async () => {
        serverPkc = await mockPKC();
    }, 120000);

    afterAll(async () => {
        try {
            await serverPkc?.destroy();
        } catch {}
    });

    // Bug 1: the export route must not hijack/clobber unrelated routes on a caller-provided server.
    describe("caller-provided (shared) http.Server", () => {
        let httpServer: http.Server;
        let wsServer: PKCWsServerType;
        let port: number;

        beforeAll(async () => {
            port = await getAvailablePort();
            httpServer = http.createServer();
            await new Promise<void>((resolve) => httpServer.listen(port, () => resolve()));

            wsServer = await createPKCWsServer({ server: httpServer, pkcOptions: basePkcOptions(temporaryDirectory()) });

            // The caller registers its own route AFTER handing the server to PKCWsServer — the
            // realistic ordering, and the one where the export listener (registered first) gets to
            // run before the caller's handler for every request.
            httpServer.on("request", (req, res) => {
                if (res.writableEnded || res.headersSent) return; // export listener already responded
                if (req.url === "/custom") {
                    res.writeHead(200, { "content-type": "text/plain" });
                    res.end("custom-route-ok");
                }
            });
        }, 120000);

        afterAll(async () => {
            try {
                await wsServer?.destroy();
            } catch {}
            try {
                await new Promise<void>((resolve) => httpServer?.close(() => resolve()));
            } catch {}
        });

        it("does not 404 an unrelated route the caller serves on the same server", async () => {
            const res = await fetch(`http://localhost:${port}/custom`);
            const body = await res.text();
            expect(res.status).to.equal(200);
            expect(body).to.equal("custom-route-ok");
        });
    });

    // Bug 2: a completed export must stay downloadable after a daemon restart, when the owning
    // community has not been loaded back into memory yet.
    describe("download survives a daemon restart", () => {
        const dataPath = temporaryDirectory();
        let exportId: string;
        let expectedSha256: string;
        let restartedServer: PKCWsServerType;
        let restartedPort: number;

        beforeAll(async () => {
            // --- First boot: create + start a community, run a completed export, capture its id/hash.
            const firstServer = await createPKCWsServer({ port: await getAvailablePort(), pkcOptions: basePkcOptions(dataPath) });
            const community = (await createSubWithNoChallenge({}, firstServer.pkc)) as LocalCommunityType;
            await community.start();

            const started = await community.export();
            exportId = started.exportId;
            const rec = await waitForCompletedExport(community, exportId);
            expectedSha256 = rec.sha256!;

            // Sanity: the export file is on disk at the canonical path under this dataPath.
            const filePath = fileURLToPath(new URL(rec.url!));
            expect(existsSync(filePath)).to.equal(true);
            expect(filePath).to.equal(path.join(dataPath, "exports", `${exportId}.sqlite`));

            await firstServer.destroy(); // shut the daemon down; the export file persists on disk

            // --- Restart: fresh server on the same dataPath. Disable auto-start so the owning
            // community is NOT loaded back into memory — exactly the window where the bug bites.
            restartedPort = await getAvailablePort();
            restartedServer = await createPKCWsServer({
                port: restartedPort,
                startStartedCommunitiesOnStartup: false,
                exportFileMaxAgeMs: 0, // never sweep, so the file is guaranteed present for the assertion
                pkcOptions: basePkcOptions(dataPath)
            });
        }, 180000);

        afterAll(async () => {
            try {
                await restartedServer?.destroy();
            } catch {}
        });

        it("serves GET /exports/<id> for a completed export whose community is not loaded after restart", async () => {
            const res = await fetch(`http://localhost:${restartedPort}/exports/${exportId}`);
            expect(res.status).to.equal(200);
            const bytes = Buffer.from(await res.arrayBuffer());
            expect(createHash("sha256").update(bytes).digest("hex")).to.equal(expectedSha256);
        });
    });
});

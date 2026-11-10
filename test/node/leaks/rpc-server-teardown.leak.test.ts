// Leak suite (#496): what an RPC server keeps after clients disconnect, delete
// communities, or abort an export download. Runs an in-process server so its state is readable.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import PKC from "../../../dist/node/index.js";
import { createInProcessRpcServer, pollUntil, uniqueTmpDataPath, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import { countOpenFds } from "../../helpers/leak-detection.js";
import { mockRpcServerPKC, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

// it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
// starts failing once the leak is fixed: remove the .fails then.

interface ServerInternals {
    _startedCommunities: Record<string, "pending" | LocalCommunity>;
    _exportCommunityInstances: Map<string, LocalCommunity>;
}
const ATTEMPTS = 3;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("leak: RPC server state after disconnects, deletes and aborted downloads", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    let dataPath: string;
    const newClient = async () => {
        const client = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
        client.on("error", () => {});
        return client;
    };
    const server = () => rpcServer as unknown as ServerInternals;

    beforeAll(async () => {
        dataPath = uniqueTmpDataPath("pkc-leak-rpc-server");
        serverPKC = await mockRpcServerPKC({ dataPath });
        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: "leak-rpc-server" }));
    });

    afterAll(async () => {
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    // Finding 4: startCommunity parks in getStartedCommunity() while the community is "pending" (an auto-start
    // or a setSettings restart in progress). The client disconnects, its cleanup runs, then the handler resumes
    // and attaches its listeners to the started community for a connection that is gone.
    it.fails(
        `a start() subscription parked on a pending community, whose client disconnects, leaves no listeners (${ATTEMPTS} clients)`,
        async () => {
            const owner = await newClient();
            try {
                const community = (await owner.createCommunity({})) as RpcLocalCommunity;
                await community.edit({ settings: { challenges: [] } });
                await community.start();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
                const started = server()._startedCommunities[community.address] as LocalCommunity;
                const listenerCounts = () => ({
                    update: started.listenerCount("update"),
                    startedstatechange: started.listenerCount("startedstatechange"),
                    challengerequest: started.listenerCount("challengerequest"),
                    error: started.listenerCount("error")
                });
                const baseline = listenerCounts();

                for (let i = 0; i < ATTEMPTS; i++) {
                    const visitor = await newClient();
                    const sameCommunity = (await visitor.createCommunity({ address: community.address })) as RpcLocalCommunity;
                    server()._startedCommunities[community.address] = "pending";
                    sameCommunity.start().catch(() => {});
                    await sleep(300); // the server handler is now polling the pending entry
                    await Promise.race([visitor.destroy().catch(() => {}), sleep(5000)]);
                    await sleep(500); // the server has cleaned the closed connection up
                    server()._startedCommunities[community.address] = started;
                    await sleep(300); // the parked handler resumes
                }
                expect(listenerCounts()).toEqual(baseline);
                await community.stop();
            } finally {
                await owner.destroy();
            }
        }
    );

    // Finding 5
    it.fails(`create + load + delete a community ${ATTEMPTS} times leaves no instance in the export cache`, async () => {
        const client = await newClient();
        try {
            const before = server()._exportCommunityInstances.size;
            for (let i = 0; i < ATTEMPTS; i++) {
                const created = (await client.createCommunity({})) as RpcLocalCommunity;
                const loaded = (await client.createCommunity({ address: created.address })) as RpcLocalCommunity;
                await sleep(300); // the eager exports snapshot of both instances has landed
                await loaded.delete();
            }
            await sleep(500);
            expect({ exportInstancesAdded: server()._exportCommunityInstances.size - before }).toEqual({ exportInstancesAdded: 0 });
        } finally {
            await client.destroy();
        }
    });

    // Finding 6b
    // Linux only: the leak is read from /proc/self/fd
    it.runIf(process.platform === "linux").fails(
        `aborting GET /exports/<id> mid-stream ${ATTEMPTS} times leaves no file descriptor open`,
        async () => {
            const client = await newClient();
            try {
                const community = (await client.createCommunity({})) as RpcLocalCommunity;
                const { exportId } = await community.export();
                await pollUntil(() => community.exports.some((rec) => rec.exportId === exportId && rec.progress === 1), {
                    timeoutMs: 30_000
                });
                const record = community.exports.find((rec) => rec.exportId === exportId)!;
                expect(record.progress).toBe(1);
                // Larger than the loopback socket buffers, so the read stream is still open when the client aborts.
                // The server reads the size at request time.
                const filePath = path.join(dataPath, "exports", `${exportId}.sqlite`);
                expect(fs.existsSync(filePath)).toBe(true);
                fs.appendFileSync(filePath, Buffer.alloc(64 * 1024 * 1024));

                const abortedDownload = () =>
                    new Promise<void>((resolve, reject) => {
                        const request = http.get(record.url!, (response) => {
                            response.once("data", () => {
                                request.destroy();
                                resolve();
                            });
                        });
                        request.on("error", (error: NodeJS.ErrnoException) => (error.code === "ECONNRESET" ? resolve() : reject(error)));
                    });
                await abortedDownload(); // warm-up
                await sleep(500);
                const fdsBefore = countOpenFds()!;
                for (let i = 0; i < ATTEMPTS; i++) await abortedDownload();
                await sleep(1000);
                expect({ fdsLeftOpen: countOpenFds()! - fdsBefore }).toEqual({ fdsLeftOpen: 0 });
                await community.delete();
            } finally {
                await client.destroy();
            }
        }
    );
});

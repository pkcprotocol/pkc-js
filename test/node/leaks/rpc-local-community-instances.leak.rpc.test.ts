// Leak suite (#496): an RPC client must not retain RpcLocalCommunity instances the caller dropped.
//
// #490: every getCommunity() / createCommunity({ address }) of a community the RPC server hosts
// created an RpcLocalCommunity, fetched one update, stopped it, then attached an exportsSubscribe
// subscription that nothing ever removed. The RPC client kept it in _resubscribeCalls and
// _subscriptionEvents, whose exportschange listener closed over the instance, so each call pinned
// one community (its record, pages and page clients, ~2 MB on a 29k-comment board) for the life of
// the PKC. A publisher hit it once per publication through the background refresh in
// Publication._fetchCommunityForPublishing() and ran out of heap every 5-7 hours.
//
// The suite runs against an in-process RPC server, so it only needs the test server's kubo.
// itIfRpc: the scenario is an RPC client talking to an RPC server, which the in-process server
// provides; there is nothing to exercise under the non-RPC configs.
import { describe, beforeAll, afterAll, expect } from "vitest";
import PKC from "../../../dist/node/index.js";
import { createInProcessRpcServer, pollUntil, uniqueTmpDataPath, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import { createCollectionTracker } from "../../helpers/leak-detection.js";
import { mockRpcServerPKC } from "../../../dist/node/test/test-util.js";
import { itIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

const RPC_AUTH_KEY = "test-leak-rpc-local-community-instances";
const ITERATIONS = 20;

interface RpcClientRegistries {
    _resubscribeCalls: Map<number, { method: string; params: unknown[] }>;
    _subscriptionEvents: Record<string, unknown>;
}

function registrySizes(client: PKCType) {
    const rpcClient = (client as unknown as { _pkcRpcClient: RpcClientRegistries })._pkcRpcClient;
    return {
        resubscribeCalls: rpcClient._resubscribeCalls.size,
        subscriptionEvents: Object.keys(rpcClient._subscriptionEvents).length
    };
}

describe("leak: RPC client retains RpcLocalCommunity instances of a server-hosted community", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let rpcUrl: string;
    let communityAddress: string;

    beforeAll(async () => {
        serverPKC = await mockRpcServerPKC({ dataPath: uniqueTmpDataPath("pkc-leak-rpc-local-community") });
        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY }));
        const serverCommunity = (await serverPKC.createCommunity({})) as LocalCommunity;
        communityAddress = serverCommunity.address;
    });

    afterAll(async () => {
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
    });

    for (const method of ["getCommunity", "createCommunity"] as const) {
        itIfRpc(`${method}({ address }) + stop() ${ITERATIONS} times leaves no instance or subscription behind`, async () => {
            const client = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
            client.on("error", () => {});
            try {
                // Warm up once so subscriptions that legitimately live as long as the PKC
                // (communitiesSubscribe, settings) are part of the baseline
                const warmup = await client[method]({ address: communityAddress });
                if (method === "createCommunity") await warmup.update();
                await warmup.stop();
                const baseline = registrySizes(client);

                const tracker = createCollectionTracker();
                // In a function of its own: a suspended async frame keeps its last loop value in a
                // saved register, which would keep the final instance alive for as long as this test waits
                const runIterations = async () => {
                    for (let i = 0; i < ITERATIONS; i++) {
                        const community = await client[method]({ address: communityAddress });
                        if (method === "createCommunity") await community.update();
                        await community.stop();
                        tracker.track(community, `${method} #${i}`);
                    }
                };
                await runIterations();

                const alive = await tracker.aliveLabels();
                expect({ registries: registrySizes(client), instancesStillAlive: alive }).toEqual({
                    registries: baseline,
                    instancesStillAlive: []
                });
            } finally {
                await client.destroy();
            }
        });
    }

    itIfRpc("an exportschange listener holds the exports subscription of a stopped instance until it is removed", async () => {
        const client = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
        client.on("error", () => {});
        try {
            const warmup = await client.getCommunity({ address: communityAddress });
            await warmup.stop();
            const baseline = registrySizes(client);

            const community = await client.getCommunity({ address: communityAddress });
            const listener = () => {};
            community.on("exportschange", listener);
            await pollUntil(() => registrySizes(client).resubscribeCalls === baseline.resubscribeCalls + 1, { timeoutMs: 5_000 });
            const whileListening = registrySizes(client).resubscribeCalls;

            community.removeListener("exportschange", listener);
            await pollUntil(() => registrySizes(client).resubscribeCalls === baseline.resubscribeCalls, { timeoutMs: 5_000 });

            expect({ whileListening, afterRemoval: registrySizes(client) }).toEqual({
                whileListening: baseline.resubscribeCalls + 1,
                afterRemoval: baseline
            });
        } finally {
            await client.destroy();
        }
    });
});

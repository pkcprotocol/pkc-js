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
import { describe, beforeAll, afterAll, expect, vi } from "vitest";
import { getEventListeners } from "node:events";
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

    // The instance clears its exports subscription id before the unsubscribe call, so nothing can retry
    // a call that rejects (the connection dropping mid-call, for example). The RPC client must release
    // its own per-subscription state either way, or that state is kept for the life of the PKC.
    itIfRpc("an unsubscribe call that rejects still releases the subscription's client-side state", async () => {
        const client = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
        client.on("error", () => {});
        try {
            const warmup = await client.getCommunity({ address: communityAddress });
            await warmup.stop();
            const baseline = registrySizes(client);

            const community = await client.getCommunity({ address: communityAddress });
            const listener = () => {};
            community.on("exportschange", listener);
            await pollUntil(() => registrySizes(client).subscriptionEvents === baseline.subscriptionEvents + 1, { timeoutMs: 5_000 });

            const webSocketClient = (client as unknown as { _pkcRpcClient: { _webSocketClient: { call: WebSocketCall } } })._pkcRpcClient
                ._webSocketClient;
            const originalCall = webSocketClient.call;
            let rejectedUnsubscribes = 0;
            webSocketClient.call = function (this: unknown, method: string, params: unknown[]): Promise<unknown> {
                if (method === "unsubscribe") {
                    rejectedUnsubscribes += 1;
                    return Promise.reject(new Error("connection dropped mid-call (simulated)"));
                }
                return originalCall.call(this, method, params);
            };
            try {
                community.removeListener("exportschange", listener);
                await pollUntil(() => rejectedUnsubscribes === 1, { timeoutMs: 5_000 });
                // pollUntil gives up silently on timeout; the assertion below reports the outcome
                await pollUntil(() => registrySizes(client).subscriptionEvents === baseline.subscriptionEvents, { timeoutMs: 2_000 });
            } finally {
                webSocketClient.call = originalCall;
            }
            expect({ rejectedUnsubscribes, registries: registrySizes(client) }).toEqual({ rejectedUnsubscribes: 1, registries: baseline });
        } finally {
            await client.destroy();
        }
    });

    // PR #503 review: a terminal record that reaches the client before the exportCommunity response is no
    // longer tracked as in flight, so the exports subscription of a stopped instance is dropped right
    // after the call. export() still attached its abort listener to the caller's signal, and only a later
    // terminal notification detaches it, which can no longer arrive.
    itIfRpc("export({ signal }) leaves no abort listener when the export finishes before its response", async () => {
        const client = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
        client.on("error", () => {});
        try {
            const community = await client.getCommunity({ address: communityAddress });
            const rpcClient = client._pkcRpcClient!;
            const isTerminal = (exportId: string) =>
                community.exports.some((rec) => rec.exportId === exportId && (rec.progress === 1 || rec.error !== undefined));

            // Hold the response back until the instance has absorbed the export's terminal record
            const realExportCommunity = rpcClient.exportCommunity.bind(rpcClient);
            let terminalBeforeResponse = false;
            vi.spyOn(rpcClient, "exportCommunity").mockImplementation(async (args) => {
                const response = await realExportCommunity(args);
                await pollUntil(() => isTerminal(response.exportId), { timeoutMs: 30_000 });
                terminalBeforeResponse = isTerminal(response.exportId);
                return response;
            });
            const cancelExportSpy = vi.spyOn(rpcClient, "cancelExport");

            const longLivedAbort = new AbortController();
            await community.export({ signal: longLivedAbort.signal });
            const abortListenersAfterExport = getEventListeners(longLivedAbort.signal, "abort").length;
            longLivedAbort.abort();

            expect({ terminalBeforeResponse, abortListenersAfterExport, cancelExportCalls: cancelExportSpy.mock.calls.length }).toEqual({
                terminalBeforeResponse: true,
                abortListenersAfterExport: 0,
                cancelExportCalls: 0
            });
        } finally {
            vi.restoreAllMocks();
            await client.destroy();
        }
    });
});

type WebSocketCall = (method: string, params: unknown[]) => Promise<unknown>;

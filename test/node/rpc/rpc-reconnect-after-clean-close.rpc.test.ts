// Reproduces issue #479: a client survives a dropped connection (#425) but not a clean server
// shutdown. PKCWsServer.destroy() closes every client with code 1000, and rpc-websockets returns
// before its reconnect logic on that code, whatever max_reconnects says. PKCRpcClient's close
// handler schedules nothing either, so the client stays stopped for good with no error, and the
// RPC calls it makes after that fail too. A long-running client looks healthy until it is restarted.
//
// The contract asserted: however the server went away, the client reconnects to a server that comes
// back at the same address, and its subscriptions work again, with no action from the consumer.
//
// Every case restarts a real PKCWsServer on the same port. The dropped-connection case is the
// control: it runs the same steps but cuts the sockets first, so the client sees 1006 and not 1000.
import { describe, it, afterEach, expect } from "vitest";
import PKC from "../../../dist/node/index.js";
import { mockRpcServerPKC, expectCommunityListed, findListedCommunity } from "../../../dist/node/test/test-util.js";
import { createInProcessRpcServer, pollUntil, uniqueTmpDataPath, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import { describeIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";

const RPC_AUTH_KEY = "test-rpc-reconnect-after-clean-close";
const WS_CLOSE_NORMAL = 1000;
const WS_CLOSE_ABNORMAL = 1006;

// Longer than _reconnectMaxIntervalMs (30s), so any retry the client had scheduled has fired by then
const RECONNECT_WINDOW_MS = 35_000;
const TEST_TIMEOUT_MS = 120_000;

type RpcServerInternals = {
    rpcWebsockets: { wss: { clients: Set<{ terminate: () => void }> } };
};

type RpcClientInternals = {
    state: string;
    _webSocketClient: { on: (event: "close", listener: (code: number) => void) => unknown };
};

type ErrorWithCode = Error & { code?: string };

describeIfRpc("RPC client after the server shuts down (#479)", () => {
    let rpcServer: PKCWsServerType | undefined;
    let serverPKC: PKCType | undefined;
    let client: PKCType | undefined;

    const connectedClientsOnServer = () => (rpcServer ? (rpcServer as unknown as RpcServerInternals).rpcWebsockets.wss.clients.size : 0);

    async function startServer(opts: { dataPath: string; port?: number }) {
        serverPKC = await mockRpcServerPKC({ dataPath: opts.dataPath });
        const started = await createInProcessRpcServer({ serverPKC, authKey: RPC_AUTH_KEY, port: opts.port });
        rpcServer = started.rpcServer;
        return started;
    }

    // destroy() also destroys the server's PKC instance
    async function stopServer() {
        const server = rpcServer;
        rpcServer = undefined;
        serverPKC = undefined;
        if (server) await server.destroy();
    }

    // A connected client whose communities subscription is proven live, on a server that is then shut
    // down. Resolves once the client has seen the close, with the close code it saw.
    async function connectClientThenStopServer(opts: { cutSocketsFirst: boolean }) {
        const dataPath = uniqueTmpDataPath("pkc-rpc-clean-close");
        const { rpcUrl, port } = await startServer({ dataPath });
        client = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
        const errors: ErrorWithCode[] = [];
        client.on("error", (error) => errors.push(error));

        const connectedClient = client;
        const created = await serverPKC!.createCommunity({});
        await pollUntil(() => findListedCommunity({ pkc: connectedClient, publicKey: created.publicKey! }) !== undefined, {
            timeoutMs: 30_000
        });
        expectCommunityListed({ pkc: connectedClient, publicKey: created.publicKey!, address: created.address, name: created.name });

        const rpcClient = connectedClient.clients.pkcRpcClients[rpcUrl] as unknown as RpcClientInternals;
        expect(rpcClient.state).toBe("connected");
        const closeCodes: number[] = [];
        rpcClient._webSocketClient.on("close", (code) => closeCodes.push(code));

        if (opts.cutSocketsFirst)
            for (const socket of (rpcServer as unknown as RpcServerInternals).rpcWebsockets.wss.clients) socket.terminate();
        await stopServer();
        await pollUntil(() => rpcClient.state !== "connected", { timeoutMs: 5_000 });
        await pollUntil(() => closeCodes.length > 0, { timeoutMs: 5_000 });

        return { connectedClient, rpcClient, dataPath, port, closeCodes, errors };
    }

    afterEach(async () => {
        const clientToDestroy = client;
        client = undefined;
        if (clientToDestroy && !clientToDestroy.destroyed) await clientToDestroy.destroy();
        await stopServer();
    });

    const cases = [
        { name: "a dropped connection (control)", cutSocketsFirst: true, expectedCloseCode: WS_CLOSE_ABNORMAL },
        { name: "a clean shutdown", cutSocketsFirst: false, expectedCloseCode: WS_CLOSE_NORMAL }
    ];

    describe.each(cases)("after $name", ({ cutSocketsFirst, expectedCloseCode }) => {
        it(
            `the client reconnects to the restarted server and pkc.communities delivers again (close code ${expectedCloseCode})`,
            async () => {
                const { connectedClient, rpcClient, dataPath, port, closeCodes } = await connectClientThenStopServer({ cutSocketsFirst });
                expect(closeCodes).toEqual([expectedCloseCode]);

                await startServer({ dataPath, port });
                await pollUntil(() => rpcClient.state === "connected" && connectedClientsOnServer() > 0, {
                    timeoutMs: RECONNECT_WINDOW_MS
                });
                expect({ state: rpcClient.state, connectedClientsOnServer: connectedClientsOnServer() }).toEqual({
                    state: "connected",
                    connectedClientsOnServer: 1
                });

                // Proves the #425 re-subscribe ran: the connection alone would not deliver this
                const createdAfterRestart = await serverPKC!.createCommunity({});
                await pollUntil(
                    () => findListedCommunity({ pkc: connectedClient, publicKey: createdAfterRestart.publicKey! }) !== undefined,
                    {
                        timeoutMs: 15_000
                    }
                );
                expectCommunityListed({
                    pkc: connectedClient,
                    publicKey: createdAfterRestart.publicKey!,
                    address: createdAfterRestart.address,
                    name: createdAfterRestart.name
                });
            },
            TEST_TIMEOUT_MS
        );

        it(
            `an RPC call made once the server is back succeeds (close code ${expectedCloseCode})`,
            async () => {
                const { connectedClient, dataPath, port, closeCodes } = await connectClientThenStopServer({ cutSocketsFirst });
                expect(closeCodes).toEqual([expectedCloseCode]);

                await startServer({ dataPath, port });

                // createCommunity({}) has no local answer: it is always a call to the RPC server
                let createdPublicKey: string | undefined;
                let errorCode: string | undefined;
                try {
                    createdPublicKey = (await connectedClient.createCommunity({})).publicKey;
                } catch (error) {
                    errorCode = (error as ErrorWithCode).code;
                }
                expect({ called: typeof createdPublicKey, errorCode }).toEqual({ called: "string", errorCode: undefined });
            },
            TEST_TIMEOUT_MS
        );
    });

    it(
        "a client started while the server is down gets pkc.communities once the server comes up",
        async () => {
            const dataPath = uniqueTmpDataPath("pkc-rpc-clean-close");
            const { rpcUrl, port } = await startServer({ dataPath });
            await stopServer();

            client = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
            const startedClient = client;
            const errors: ErrorWithCode[] = [];
            startedClient.on("error", (error) => errors.push(error));
            const rpcClient = startedClient.clients.pkcRpcClients[rpcUrl] as unknown as RpcClientInternals;

            // The first communitiesSubscribe has given up by the time this error is out
            await pollUntil(() => errors.some((e) => e.code === "ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC"), { timeoutMs: 30_000 });
            expect(errors.map((e) => e.code)).toContain("ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC");

            await startServer({ dataPath, port });
            await pollUntil(() => rpcClient.state === "connected", { timeoutMs: RECONNECT_WINDOW_MS });
            expect(rpcClient.state).toBe("connected");

            const created = await serverPKC!.createCommunity({});
            await pollUntil(() => findListedCommunity({ pkc: startedClient, publicKey: created.publicKey! }) !== undefined, {
                timeoutMs: 15_000
            });
            expectCommunityListed({ pkc: startedClient, publicKey: created.publicKey!, address: created.address, name: created.name });
        },
        TEST_TIMEOUT_MS
    );
});

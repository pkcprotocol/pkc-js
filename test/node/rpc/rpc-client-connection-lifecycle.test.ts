// What PKCRpcClient reports while its connection is down (#479). rpc-reconnect-after-clean-close
// covers recovery end to end against a real PKCWsServer; this file pins the states and errors around
// it, against a scripted server that can hold a response back, reject upgrades and pick the close code.
//
// The contract asserted:
//   state    connected -> stopped -> connecting -> connected across an outage. "stopped" only lasts
//            when nothing is trying to connect, "failed" only when the client will not retry.
//   errors   every failed reconnect attempt emits ERR_RPC_RECONNECT_FAILED. A drop that recovers on
//            the first try emits nothing, and a client that never connected keeps its raw errors.
//   calls    a call waiting for a response when the socket closes rejects right away with
//            ERR_RPC_CONNECTION_LOST, where it used to hang until the call timeout. A re-subscribe lost
//            that way is not an error: the next open issues it again.
import { describe, it, afterEach, expect } from "vitest";
import Logger from "@pkcprotocol/pkc-logger";
import { createServer, type Server as HTTPServer } from "node:http";
import { once } from "node:events";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket as WsSocket, type RawData } from "ws";
import PKCRpcClient from "../../../dist/node/clients/rpc-client/pkc-rpc-client.js";
import { pollUntil } from "../../helpers/rpc-server-harness.js";

// Free signer/verify helpers and raw clients take a required log (issue #493); tests use the process-default root
const testLog = Logger({ namespace: "pkc-js:test:rpc-client-connection-lifecycle" });

const WS_CLOSE_NORMAL = 1000;
const WS_CLOSE_ABNORMAL = 1006;
const CLOSE_REASON = "scripted shutdown";

type JsonRpcRequest = { id: number; method: string };
type Responder = (opts: { request: JsonRpcRequest; connectionNumber: number; socket: WsSocket }) => void;

const respondWith = (socket: WsSocket, id: number, result: unknown) => socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));

class ScriptedRpcServer {
    connections = 0;
    rejectUpgradesWith403 = false;
    onConnection?: (socket: WsSocket) => void;
    // Answers everything with {} unless a test takes over
    responder: Responder = ({ request, socket }) => respondWith(socket, request.id, {});
    private readonly wss = new WebSocketServer({ noServer: true });
    private readonly httpServer: HTTPServer = createServer();
    upgradeAttempts = 0;
    port = 0;

    constructor() {
        this.httpServer.on("upgrade", (request, socket: Duplex, head) => {
            this.upgradeAttempts++;
            if (this.rejectUpgradesWith403) {
                socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
                return;
            }
            this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit("connection", ws, request));
        });
        this.wss.on("connection", (socket: WsSocket) => {
            const connectionNumber = ++this.connections;
            socket.on("message", (raw: RawData) => {
                const request = JSON.parse(raw.toString()) as JsonRpcRequest;
                if (typeof request.id === "number") this.responder({ request, connectionNumber, socket });
            });
            this.onConnection?.(socket);
        });
    }

    get url() {
        return `ws://127.0.0.1:${this.port}`;
    }

    async listen() {
        this.httpServer.listen(this.port, "127.0.0.1");
        await once(this.httpServer, "listening");
        const address = this.httpServer.address();
        if (address === null || typeof address === "string") throw Error("Expected the scripted server to listen on a TCP port");
        this.port = address.port;
    }

    // 1000 is what PKCWsServer.destroy() sends, terminate() is a network drop as the client sees it
    cutClients(closeCode: number) {
        for (const socket of this.wss.clients) {
            if (closeCode === WS_CLOSE_NORMAL) socket.close(WS_CLOSE_NORMAL, CLOSE_REASON);
            else socket.terminate();
        }
    }

    // Cuts the clients and stops listening, so every reconnect attempt is refused until listen()
    async goDown(closeCode: number) {
        if (!this.httpServer.listening) return;
        const closed = new Promise<void>((resolve) => this.httpServer.close(() => resolve()));
        this.cutClients(closeCode);
        await closed;
    }

    async destroy() {
        await this.goDown(WS_CLOSE_ABNORMAL);
        this.wss.close();
    }
}

type ErrorWithDetails = Error & { code?: string; details?: Record<string, unknown> };

type RpcClientInternals = {
    _timeoutSeconds: number;
    _reconnectIntervalMs: number;
    _reconnectBaseIntervalMs: number;
    _reconnectMaxIntervalMs: number;
    _webSocketClient: { setAutoReconnect: (reconnect: boolean) => void };
};

describe("PKCRpcClient while its connection is down (#479)", () => {
    const servers: ScriptedRpcServer[] = [];
    const clients: PKCRpcClient[] = [];

    afterEach(async () => {
        for (const client of clients.splice(0)) await client.destroy();
        for (const server of servers.splice(0)) await server.destroy();
    });

    async function startServer() {
        const server = new ScriptedRpcServer();
        servers.push(server);
        await server.listen();
        return server;
    }

    function createClient(url: string, opts?: { fastBackoff?: boolean; openTimeoutSeconds?: number }) {
        const client = new PKCRpcClient(url, testLog);
        clients.push(client);
        const internals = client as unknown as RpcClientInternals;
        if (opts?.fastBackoff) {
            internals._reconnectIntervalMs = 50;
            internals._reconnectBaseIntervalMs = 50;
            internals._reconnectMaxIntervalMs = 200;
        }
        if (opts?.openTimeoutSeconds) internals._timeoutSeconds = opts.openTimeoutSeconds;
        const errors: ErrorWithDetails[] = [];
        const states: string[] = [];
        client.on("error", (error) => errors.push(error as ErrorWithDetails));
        client.on("statechange", (state) => states.push(state));
        return { client, errors, states, internals };
    }

    async function connectedClient(server: ScriptedRpcServer, opts?: { fastBackoff?: boolean; openTimeoutSeconds?: number }) {
        const created = createClient(server.url, opts);
        await created.client.rpcCall("ping", []);
        expect(created.client.state).toBe("connected");
        created.states.length = 0;
        return created;
    }

    const closeCases = [
        { name: "a clean close", closeCode: WS_CLOSE_NORMAL, closeReason: CLOSE_REASON },
        { name: "a dropped connection", closeCode: WS_CLOSE_ABNORMAL, closeReason: "" }
    ];

    describe.each(closeCases)("after $name (close code $closeCode)", ({ closeCode, closeReason }) => {
        it("a drop that recovers on the first try changes state and emits no error", async () => {
            const server = await startServer();
            const { client, errors, states } = await connectedClient(server, { fastBackoff: true });

            server.cutClients(closeCode);
            await pollUntil(() => server.connections === 2 && client.state === "connected", { timeoutMs: 5_000 });

            expect({ states, errors: errors.map((e) => e.message) }).toEqual({
                states: ["stopped", "connecting", "connected"],
                errors: []
            });
        });

        it("an outage stays connecting, and every failed attempt emits ERR_RPC_RECONNECT_FAILED with what happened", async () => {
            const server = await startServer();
            const { client, errors, states } = await connectedClient(server, { fastBackoff: true });

            await server.goDown(closeCode);
            await pollUntil(() => errors.length >= 3, { timeoutMs: 5_000 });

            expect(client.state).toBe("connecting");
            expect(states).toEqual(["stopped", "connecting"]);
            const reported = errors.slice(0, 3);
            expect(reported.map((e) => e.code)).toEqual(Array(3).fill("ERR_RPC_RECONNECT_FAILED"));
            expect(
                reported.map((e) => ({
                    rpcServerUrl: e.details?.rpcServerUrl,
                    closeCode: e.details?.closeCode,
                    closeReason: e.details?.closeReason,
                    attempt: e.details?.attempt,
                    nextRetryMs: e.details?.nextRetryMs
                }))
            ).toEqual(
                [
                    { attempt: 1, nextRetryMs: 100 },
                    { attempt: 2, nextRetryMs: 200 },
                    { attempt: 3, nextRetryMs: 200 }
                ].map((attempt) => ({ rpcServerUrl: server.url, closeCode, closeReason, ...attempt }))
            );
            expect(reported.every((e) => e.details?.error instanceof Error)).toBe(true);

            await server.listen();
            await pollUntil(() => client.state === "connected", { timeoutMs: 5_000 });
            expect(states).toEqual(["stopped", "connecting", "connected"]);

            // A second outage counts its attempts from 1 again
            errors.length = 0;
            await server.goDown(closeCode);
            await pollUntil(() => errors.length >= 1, { timeoutMs: 5_000 });
            expect(errors[0].details?.attempt).toBe(1);
        });

        it("a call made during an outage throws after the open timeout, and the state stays connecting", async () => {
            const server = await startServer();
            const { client, states } = await connectedClient(server, { fastBackoff: true, openTimeoutSeconds: 1 });

            await server.goDown(closeCode);
            await pollUntil(() => client.state === "connecting", { timeoutMs: 5_000 });
            await expect(client.rpcCall("ping", [])).rejects.toMatchObject({ code: "ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC" });

            expect(client.state).toBe("connecting");
            expect(states).not.toContain("failed");
        });

        it("a call waiting for its response rejects with ERR_RPC_CONNECTION_LOST as soon as the socket closes", async () => {
            const server = await startServer();
            const { client, errors } = await connectedClient(server, { fastBackoff: true });
            let requestReceived = false;
            server.responder = ({ request, socket }) => {
                if (request.method === "neverAnswered") requestReceived = true;
                else respondWith(socket, request.id, {});
            };

            let settled = "pending";
            let error: ErrorWithDetails | undefined;
            const outcome = client.rpcCall("neverAnswered", []).then(
                () => {
                    settled = "resolved";
                },
                (rejection: ErrorWithDetails) => {
                    settled = "rejected";
                    error = rejection;
                }
            );
            await pollUntil(() => requestReceived, { timeoutMs: 5_000 });
            expect(requestReceived).toBe(true);

            const startedAt = Date.now();
            server.cutClients(closeCode);
            await outcome;

            expect(Date.now() - startedAt).toBeLessThan(2_000);
            expect(settled).toBe("rejected");
            expect(error?.code).toBe("ERR_RPC_CONNECTION_LOST");
            expect(error?.details).toMatchObject({ rpcMethod: "neverAnswered", rpcServerUrl: server.url, closeCode, closeReason });
            // It reaches the caller. The PKC error event is for what no caller is waiting on
            expect(errors.map((e) => e.code)).not.toContain("ERR_RPC_CONNECTION_LOST");

            // The connection comes back and takes calls again
            await pollUntil(() => client.state === "connected", { timeoutMs: 5_000 });
            await expect(client.rpcCall("ping", [])).resolves.toEqual({});
        });

        it("a call answered before the close is left alone", async () => {
            const server = await startServer();
            const { client } = await connectedClient(server, { fastBackoff: true });

            await expect(client.rpcCall("ping", [])).resolves.toEqual({});
            server.cutClients(closeCode);
            await pollUntil(() => client.state === "connected" && server.connections === 2, { timeoutMs: 5_000 });

            await expect(client.rpcCall("ping", [])).resolves.toEqual({});
        });

        it("a re-subscribe lost with the connection is no error, and the next open issues it again", async () => {
            const server = await startServer();
            const { client, errors } = await connectedClient(server, { fastBackoff: true });
            const subscribesByConnection: Record<number, number> = {};
            server.responder = ({ request, connectionNumber, socket }) => {
                if (request.method !== "settingsSubscribe") return respondWith(socket, request.id, {});
                subscribesByConnection[connectionNumber] = (subscribesByConnection[connectionNumber] ?? 0) + 1;
                // The connection right after the first drop loses the re-subscribe: no answer, then gone
                if (connectionNumber === 2)
                    return void (closeCode === WS_CLOSE_NORMAL ? socket.close(WS_CLOSE_NORMAL, CLOSE_REASON) : socket.terminate());
                const subscriptionId = 100 + connectionNumber;
                respondWith(socket, request.id, { subscriptionId });
                if (connectionNumber === 3)
                    socket.send(
                        JSON.stringify({
                            jsonrpc: "2.0",
                            method: "settingschange",
                            params: { event: "settingschange", subscription: subscriptionId, result: { delivered: true } }
                        })
                    );
            };
            const settingsSeen: unknown[] = [];
            client.on("settingschange", (settings) => settingsSeen.push(settings));
            await client.initalizeSettingschangeEvent();

            server.cutClients(closeCode);
            await pollUntil(() => settingsSeen.length > 0, { timeoutMs: 5_000 });

            expect({ subscribesByConnection, settingsSeen, errors: errors.map((e) => e.code) }).toEqual({
                subscribesByConnection: { 1: 1, 2: 1, 3: 1 },
                settingsSeen: [{ delivered: true }],
                errors: []
            });
        });

        it("with auto-reconnect turned off the client stays stopped and does not connect", async () => {
            const server = await startServer();
            const { client, internals, states } = await connectedClient(server, { fastBackoff: true });

            internals._webSocketClient.setAutoReconnect(false);
            server.cutClients(closeCode);
            await pollUntil(() => client.state === "stopped", { timeoutMs: 5_000 });
            await new Promise((resolve) => setTimeout(resolve, 500));

            expect({ states, connections: server.connections }).toEqual({ states: ["stopped"], connections: 1 });
        });

        it("destroy() during the wait for the next attempt leaves no connection behind", async () => {
            const server = await startServer();
            const { client } = await connectedClient(server); // the default 1s interval leaves time to destroy

            server.cutClients(closeCode);
            await pollUntil(() => client.state === "connecting", { timeoutMs: 5_000 });
            expect(client.state).toBe("connecting");
            await client.destroy();
            await new Promise((resolve) => setTimeout(resolve, 2_000));

            expect({ state: client.state, connections: server.connections }).toEqual({ state: "stopped", connections: 1 });
        });
    });

    it("a server that accepts and immediately closes with 1000 is retried at the backoff pace, not in a tight loop", async () => {
        const server = await startServer();
        const { client } = await connectedClient(server); // the default 1s interval
        server.onConnection = (socket) => socket.close(WS_CLOSE_NORMAL, CLOSE_REASON);

        const connectionsBefore = server.connections;
        server.cutClients(WS_CLOSE_NORMAL);
        await new Promise((resolve) => setTimeout(resolve, 2_500));
        const attempts = server.connections - connectionsBefore;

        // Two at a 1s pace; a retry with no delay would reach hundreds in this window
        expect(attempts).toBeGreaterThanOrEqual(1);
        expect(attempts).toBeLessThanOrEqual(3);

        server.onConnection = undefined;
        await pollUntil(() => client.state === "connected", { timeoutMs: 5_000 });
        expect(client.state).toBe("connected");
    });

    it("a 403 on a reconnect attempt is failed for good: ERR_RPC_AUTH_REQUIRED and no more attempts", async () => {
        const server = await startServer();
        const { client, errors, states } = await connectedClient(server, { fastBackoff: true });

        server.rejectUpgradesWith403 = true;
        const attemptsBefore = server.upgradeAttempts;
        server.cutClients(WS_CLOSE_NORMAL);
        await pollUntil(() => client.state === "failed", { timeoutMs: 5_000 });
        await new Promise((resolve) => setTimeout(resolve, 500));

        expect({
            states,
            attempts: server.upgradeAttempts - attemptsBefore,
            errorCodes: errors.map((e) => e.code)
        }).toEqual({
            states: ["stopped", "connecting", "failed"],
            attempts: 1,
            errorCodes: ["ERR_RPC_AUTH_REQUIRED"]
        });
    });

    it("a client that never connected stays connecting past the open timeout and keeps its raw errors", async () => {
        // Bound once for a port nothing listens on, so every attempt is refused
        const server = await startServer();
        await server.goDown(WS_CLOSE_ABNORMAL);
        const { client, errors, states } = createClient(server.url, { fastBackoff: true, openTimeoutSeconds: 1 });

        await expect(client.rpcCall("ping", [])).rejects.toMatchObject({ code: "ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC" });

        expect(client.state).toBe("connecting");
        expect(states).toEqual(["connecting"]);
        const codes = new Set(errors.map((e) => e.code));
        expect(codes.has("ERR_RPC_RECONNECT_FAILED")).toBe(false);
        expect(errors.some((e) => e.code === "ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC")).toBe(true);

        await server.listen();
        await pollUntil(() => client.state === "connected", { timeoutMs: 5_000 });
        expect(client.state).toBe("connected");
    });

    describe("calls made during a long outage", () => {
        const MEASURED_OPEN_TIMEOUT_SECONDS = 1;

        async function timedCall(client: PKCRpcClient) {
            const startedAt = Date.now();
            let errorCode: string | undefined;
            try {
                await client.rpcCall("ping", []);
            } catch (error) {
                errorCode = (error as ErrorWithDetails).code;
            }
            return { elapsedMs: Date.now() - startedAt, errorCode };
        }

        it("every call waits the full open timeout, not only the first one", async () => {
            const server = await startServer();
            const { client, errors } = await connectedClient(server, {
                fastBackoff: true,
                openTimeoutSeconds: MEASURED_OPEN_TIMEOUT_SECONDS
            });
            await server.goDown(WS_CLOSE_NORMAL);
            await pollUntil(() => client.state === "connecting", { timeoutMs: 5_000 });

            const calls = [await timedCall(client), await timedCall(client), await timedCall(client)];

            for (const { elapsedMs, errorCode } of calls) {
                expect(errorCode).toBe("ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC");
                expect(elapsedMs).toBeGreaterThanOrEqual(MEASURED_OPEN_TIMEOUT_SECONDS * 1000 - 50);
            }
            const timeouts = errors.filter((e) => e.code === "ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC");
            expect(timeouts).toHaveLength(3);
            // Calls after the first _init() see what went wrong too
            for (const timeout of timeouts) expect(timeout.details?.error).toBeDefined();
        });

        it("a call waiting when the server returns succeeds, after an earlier call timed out", async () => {
            const server = await startServer();
            const { client } = await connectedClient(server, {
                fastBackoff: true,
                openTimeoutSeconds: MEASURED_OPEN_TIMEOUT_SECONDS
            });
            await server.goDown(WS_CLOSE_NORMAL);
            await pollUntil(() => client.state === "connecting", { timeoutMs: 5_000 });
            expect((await timedCall(client)).errorCode).toBe("ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC");

            const waitingCall = client.rpcCall("ping", []);
            await server.listen();

            await expect(waitingCall).resolves.toEqual({});
        });

        it("calls that overlap a timeout share one wait and leave no listeners behind", async () => {
            const server = await startServer();
            const { client } = await connectedClient(server, {
                fastBackoff: true,
                openTimeoutSeconds: MEASURED_OPEN_TIMEOUT_SECONDS
            });
            const listenersWhenConnected = client.listenerCount("statechange");
            await server.goDown(WS_CLOSE_NORMAL);
            await pollUntil(() => client.state === "connecting", { timeoutMs: 5_000 });

            const overlapping = await Promise.all([timedCall(client), timedCall(client), timedCall(client)]);
            expect(overlapping.map((call) => call.errorCode)).toEqual(Array(3).fill("ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC"));
            await timedCall(client);
            await timedCall(client);

            // The waits that timed out must not stay subscribed for the rest of the outage
            expect(client.listenerCount("statechange")).toBe(listenersWhenConnected);
        });

        it.each([
            { closeName: "a clean close", closeCode: WS_CLOSE_NORMAL },
            { closeName: "a dropped connection", closeCode: WS_CLOSE_ABNORMAL }
        ])(
            "a connected client that gets a 403 on reconnect after $closeName fails later calls right away with ERR_RPC_AUTH_REQUIRED",
            async ({ closeCode }) => {
                const server = await startServer();
                const { client } = await connectedClient(server, { fastBackoff: true, openTimeoutSeconds: 5 });

                server.rejectUpgradesWith403 = true;
                server.cutClients(closeCode);
                await pollUntil(() => client.state === "failed", { timeoutMs: 5_000 });
                expect(client.state).toBe("failed");

                const calls = [await timedCall(client), await timedCall(client)];

                expect(calls.map((call) => call.errorCode)).toEqual(["ERR_RPC_AUTH_REQUIRED", "ERR_RPC_AUTH_REQUIRED"]);
                for (const { elapsedMs } of calls) expect(elapsedMs).toBeLessThan(500);
                expect(client.state).toBe("failed");
            }
        );

        it("after a 403 later calls keep failing right away with ERR_RPC_AUTH_REQUIRED", async () => {
            const server = await startServer();
            server.rejectUpgradesWith403 = true;
            const { client } = createClient(server.url, { openTimeoutSeconds: 5 });

            const first = await timedCall(client);
            const second = await timedCall(client);

            expect(first.errorCode).toBe("ERR_RPC_AUTH_REQUIRED");
            expect(second.errorCode).toBe("ERR_RPC_AUTH_REQUIRED");
            expect(second.elapsedMs).toBeLessThan(500);
            expect(client.state).toBe("failed");
        });
    });

    // PKC starts these two subscriptions in the background and only logs a failure, so no caller can
    // retry them. A failed first attempt must not leave a connected client without the lists for good
    describe.each([
        {
            method: "settingsSubscribe",
            event: "settingschange",
            result: { delivered: true },
            delivered: { delivered: true },
            initialize: (client: PKCRpcClient) => client.initalizeSettingschangeEvent()
        },
        {
            method: "communitiesSubscribe",
            event: "communitieschange",
            result: { communities: [] },
            delivered: { communities: [] },
            initialize: (client: PKCRpcClient) => client.initalizeCommunitieschangeEvent()
        }
    ])("the first $method fails with the connection", ({ method, event, result, delivered, initialize }) => {
        function answerSubscribeOnConnection(server: ScriptedRpcServer, answeringConnection: number) {
            const subscribesByConnection: Record<number, number> = {};
            server.responder = ({ request, connectionNumber, socket }) => {
                if (request.method !== method) return respondWith(socket, request.id, {});
                subscribesByConnection[connectionNumber] = (subscribesByConnection[connectionNumber] ?? 0) + 1;
                if (connectionNumber !== answeringConnection) return;
                const subscriptionId = 100 + connectionNumber;
                respondWith(socket, request.id, { subscriptionId });
                socket.send(JSON.stringify({ jsonrpc: "2.0", method: event, params: { event, subscription: subscriptionId, result } }));
            };
            return subscribesByConnection;
        }

        function collectEvents(client: PKCRpcClient) {
            const seen: unknown[] = [];
            (client as unknown as { on: (name: string, listener: (value: unknown) => void) => unknown }).on(event, (value) =>
                seen.push(value)
            );
            return seen;
        }

        it("server down at startup: the subscribe is issued once the client connects, and the list arrives", async () => {
            const server = await startServer();
            await server.goDown(WS_CLOSE_ABNORMAL);
            const { client } = createClient(server.url, { fastBackoff: true, openTimeoutSeconds: 1 });
            const seen = collectEvents(client);

            await expect(initialize(client)).rejects.toMatchObject({ code: "ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC" });

            const subscribesByConnection = answerSubscribeOnConnection(server, 1);
            await server.listen();
            await pollUntil(() => seen.length > 0, { timeoutMs: 5_000 });
            expect({ subscribesByConnection, seen }).toEqual({ subscribesByConnection: { 1: 1 }, seen: [delivered] });
        });

        it.each([
            { closeName: "a clean close", closeCode: WS_CLOSE_NORMAL },
            { closeName: "a dropped connection", closeCode: WS_CLOSE_ABNORMAL }
        ])("$closeName during the first subscribe: the next open issues it again", async ({ closeCode }) => {
            const server = await startServer();
            const { client } = await connectedClient(server, { fastBackoff: true });
            const seen = collectEvents(client);
            const subscribesByConnection = answerSubscribeOnConnection(server, 2);

            const firstAttempt = initialize(client);
            await pollUntil(() => subscribesByConnection[1] === 1, { timeoutMs: 5_000 });
            server.cutClients(closeCode);
            await expect(firstAttempt).rejects.toMatchObject({ code: "ERR_RPC_CONNECTION_LOST" });

            await pollUntil(() => seen.length > 0, { timeoutMs: 5_000 });
            expect({ subscribesByConnection, seen }).toEqual({ subscribesByConnection: { 1: 1, 2: 1 }, seen: [delivered] });
        });

        it("a first subscribe the server rejects is not retried", async () => {
            const server = await startServer();
            const { client } = await connectedClient(server, { fastBackoff: true });
            let subscribes = 0;
            server.responder = ({ request, socket }) => {
                if (request.method !== method) return respondWith(socket, request.id, {});
                subscribes++;
                socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32000, message: "refused by the server" } }));
            };

            await expect(initialize(client)).rejects.toBeDefined();
            server.cutClients(WS_CLOSE_ABNORMAL);
            await pollUntil(() => server.connections === 2 && client.state === "connected", { timeoutMs: 5_000 });
            await new Promise((resolve) => setTimeout(resolve, 200));

            expect(subscribes).toBe(1);
        });

        it("destroy() forgets a subscribe waiting to be issued again", async () => {
            const server = await startServer();
            await server.goDown(WS_CLOSE_ABNORMAL);
            const { client } = createClient(server.url, { fastBackoff: true, openTimeoutSeconds: 1 });
            await expect(initialize(client)).rejects.toMatchObject({ code: "ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC" });

            await client.destroy();
            await server.listen();
            await new Promise((resolve) => setTimeout(resolve, 500));

            expect(server.connections).toBe(0);
        });
    });
});

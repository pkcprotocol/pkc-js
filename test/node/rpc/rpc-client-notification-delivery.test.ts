import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { EventEmitter } from "events";
import PKCRpcClient from "../../../dist/node/clients/rpc-client/pkc-rpc-client.js";

// Repro harness for issue #197: the RPC server relayed update/error notifications for a fresh
// communityUpdateSubscribe, but the client never observed a single event and the test hung.
// Each case delivers notifications at a different point relative to the subscribe response, all
// orderings a real server produces:
//   - "before":    server emits events while the subscribe handler is still running (startCommunity
//                  emits "update" before start() returns), so frames precede the response
//   - "after":     server emits right after dispatching the response (the ordering in CI run
//                  29060395726 — error at +17ms, update at +41ms)
//   - "reconnect": the websocket drops after subscribing and rpc-websockets auto-reconnects; the
//                  server sends the next notification on the new socket. PKCRpcClient binds its raw
//                  notification handler to `_webSocketClient.socket` once in _init, so if the socket
//                  object is replaced on reconnect the handler is left on the dead socket.

interface JsonRpcRequest {
    jsonrpc: "2.0";
    id?: number;
    method: string;
    params: unknown[];
}

const SUBSCRIPTION_ID = 424242;

const updateNotification = () =>
    JSON.stringify({
        jsonrpc: "2.0",
        method: "communityUpdate",
        params: { result: { updatedAt: 1234567890 }, subscription: SUBSCRIPTION_ID, event: "update" }
    });

const errorNotification = () =>
    JSON.stringify({
        jsonrpc: "2.0",
        method: "communityUpdate",
        params: {
            result: { code: "ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY", message: "test error", details: {} },
            subscription: SUBSCRIPTION_ID,
            event: "error"
        }
    });

class ScriptableRpcServer {
    wss: WebSocketServer;
    port: number;
    sockets: WebSocket[] = [];
    /** called with (socket, message) for each JSON-RPC call; return false to suppress the default response */
    onCall?: (socket: WebSocket, message: JsonRpcRequest) => boolean | void;

    private constructor(wss: WebSocketServer, port: number) {
        this.wss = wss;
        this.port = port;
        wss.on("connection", (socket: WebSocket) => {
            this.sockets.push(socket);
            socket.on("message", (raw: RawData) => {
                const message = JSON.parse(raw.toString()) as JsonRpcRequest;
                if (typeof message.id !== "number") return;
                const sendDefaultResponse = this.onCall?.(socket, message);
                if (sendDefaultResponse === false) return;
                socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { subscriptionId: SUBSCRIPTION_ID } }));
            });
        });
    }

    static async create(): Promise<ScriptableRpcServer> {
        const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
        await EventEmitter.once(wss, "listening");
        const address = wss.address();
        if (address === null || typeof address === "string") throw Error("Expected WebSocketServer to listen on a TCP port");
        return new ScriptableRpcServer(wss, address.port);
    }

    get latestSocket(): WebSocket {
        const socket = this.sockets[this.sockets.length - 1];
        if (!socket) throw Error("No websocket connection established yet");
        return socket;
    }

    async waitForNewConnection(previousCount: number, timeoutMs = 10_000): Promise<WebSocket> {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            if (this.sockets.length > previousCount) return this.latestSocket;
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw Error("Timed out waiting for the client to reconnect");
    }

    async destroy() {
        for (const client of this.wss.clients) client.terminate();
        await new Promise<void>((resolve, reject) => this.wss.close((err) => (err ? reject(err) : resolve())));
    }
}

// Mirrors the standard consumer pattern from RpcRemoteCommunity._initRpcUpdateSubscription:
// subscribe -> register listeners -> flush pending messages
const subscribeWithStandardWiring = async (client: PKCRpcClient, receivedEvents: string[]) => {
    const { subscriptionId } = await client.communityUpdateSubscribe({ publicKey: "12D3KooWFakePublicKeyForNotificationTest" });
    client
        .getSubscription(subscriptionId)
        .on("update", () => receivedEvents.push("update"))
        .on("error", () => receivedEvents.push("error"));
    client.emitAllPendingMessages(subscriptionId);
    return subscriptionId;
};

const waitFor = async (predicate: () => boolean, timeoutMs: number): Promise<boolean> => {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (predicate()) return true;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return predicate();
};

describe("PKCRpcClient subscription notification delivery (issue #197)", () => {
    let server: ScriptableRpcServer;
    let client: PKCRpcClient;

    afterEach(async () => {
        await client?.destroy();
        await server?.destroy();
    });

    it("delivers notifications sent before the subscribe response", async () => {
        server = await ScriptableRpcServer.create();
        server.onCall = (socket, message) => {
            if (message.method !== "communityUpdateSubscribe") return;
            socket.send(updateNotification());
            socket.send(errorNotification());
            // default response is sent after the notifications
        };
        client = new PKCRpcClient(`ws://127.0.0.1:${server.port}`);

        const receivedEvents: string[] = [];
        await subscribeWithStandardWiring(client, receivedEvents);

        expect(await waitFor(() => receivedEvents.length === 2, 5_000), `received only: ${receivedEvents.join(",")}`).to.equal(true);
        expect(receivedEvents).to.include("update");
        expect(receivedEvents).to.include("error");
    });

    it("delivers notifications sent right after the subscribe response", async () => {
        server = await ScriptableRpcServer.create();
        server.onCall = (socket, message) => {
            if (message.method !== "communityUpdateSubscribe") return;
            setImmediate(() => {
                socket.send(updateNotification());
                socket.send(errorNotification());
            });
        };
        client = new PKCRpcClient(`ws://127.0.0.1:${server.port}`);

        const receivedEvents: string[] = [];
        await subscribeWithStandardWiring(client, receivedEvents);

        expect(await waitFor(() => receivedEvents.length === 2, 5_000), `received only: ${receivedEvents.join(",")}`).to.equal(true);
        expect(receivedEvents).to.include("update");
        expect(receivedEvents).to.include("error");
    });

    it("delivers notifications sent after the websocket reconnects", async () => {
        server = await ScriptableRpcServer.create();
        client = new PKCRpcClient(`ws://127.0.0.1:${server.port}`);

        const receivedEvents: string[] = [];
        await subscribeWithStandardWiring(client, receivedEvents);
        const updateCount = () => receivedEvents.filter((e) => e === "update").length;

        // Sanity: delivery works on the original socket
        server.latestSocket.send(updateNotification());
        expect(await waitFor(() => updateCount() === 1, 5_000), "notification on original socket was not delivered").to.equal(true);

        // Drop the connection; rpc-websockets reconnects automatically (default reconnect: true)
        const connectionCountBeforeDrop = server.sockets.length;
        server.latestSocket.terminate();
        const newSocket = await server.waitForNewConnection(connectionCountBeforeDrop);

        // The server relays the next event on the new connection
        newSocket.send(updateNotification());

        expect(
            await waitFor(() => updateCount() === 2, 5_000),
            "notification after reconnect was not delivered — raw socket handler is bound to the dead socket"
        ).to.equal(true);
    });

    it("emits a stale-subscription error on live subscriptions after the websocket reconnects", async () => {
        server = await ScriptableRpcServer.create();
        client = new PKCRpcClient(`ws://127.0.0.1:${server.port}`);

        const receivedEvents: string[] = [];
        const receivedErrors: { code?: string }[] = [];
        const { subscriptionId } = await client.communityUpdateSubscribe({ publicKey: "12D3KooWFakePublicKeyForNotificationTest" });
        client
            .getSubscription(subscriptionId)
            .on("update", () => receivedEvents.push("update"))
            .on("error", (message: { params: { result: { code?: string } } }) => receivedErrors.push(message.params.result));
        client.emitAllPendingMessages(subscriptionId);

        // Drop the connection; rpc-websockets reconnects automatically. The server-side subscription
        // is keyed to the dead connection, so the client must tell consumers it went stale.
        const connectionCountBeforeDrop = server.sockets.length;
        server.latestSocket.terminate();
        await server.waitForNewConnection(connectionCountBeforeDrop);

        expect(await waitFor(() => receivedErrors.length === 1, 5_000), "no stale-subscription error was emitted after reconnect").to.equal(
            true
        );
        expect(receivedErrors[0].code).to.equal("ERR_RPC_SUBSCRIPTION_STALE_AFTER_RECONNECT");
    });
});

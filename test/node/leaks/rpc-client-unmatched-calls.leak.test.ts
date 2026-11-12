// Leak suite (#496): what the RPC client keeps for calls and notifications it can
// no longer match. A minimal JSON-RPC server scripts the server side so each sequence is deterministic.
import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { EventEmitter } from "events";
import PKCRpcClient from "../../../dist/node/clients/rpc-client/pkc-rpc-client.js";

// it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
// starts failing once the leak is fixed: remove the .fails then.

interface JsonRpcRequest {
    jsonrpc: "2.0";
    id?: number;
    method: string;
    params: unknown[];
}

type Handler = (socket: WebSocket, message: JsonRpcRequest) => void;

async function createScriptedServer(handler: Handler) {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await EventEmitter.once(wss, "listening");
    const address = wss.address();
    if (address === null || typeof address === "string") throw Error("Expected a TCP port");
    wss.on("connection", (socket: WebSocket) => {
        socket.on("message", (raw: RawData) => {
            const message = JSON.parse(raw.toString()) as JsonRpcRequest;
            if (typeof message.id === "number") handler(socket, message);
        });
    });
    return {
        wss,
        url: `ws://127.0.0.1:${address.port}`,
        destroy: async () => {
            for (const client of wss.clients) client.terminate();
            await new Promise<void>((resolve, reject) => wss.close((err) => (err ? reject(err) : resolve())));
        }
    };
}

interface ClientInternals {
    _callTimeoutMs: number;
    _pendingSubscriptionMsgs: Record<string, unknown[]>;
    _subscriptionEvents: Record<string, unknown>;
    _webSocketClient: { queue: Record<string, unknown> };
}
const internals = (client: PKCRpcClient) => client as unknown as ClientInternals;
const notification = (subscription: number, event: string, result: unknown) =>
    JSON.stringify({ jsonrpc: "2.0", method: "startCommunity", params: { result, subscription, event } });

const CALLS = 10;

describe("leak: RPC client state for unmatched calls and notifications", () => {
    let server: Awaited<ReturnType<typeof createScriptedServer>> | undefined;
    let client: PKCRpcClient | undefined;

    afterEach(async () => {
        await client?.destroy();
        await server?.destroy();
        client = undefined;
        server = undefined;
    });

    // Finding 3, bounded variant: the server emits under a new subscription id, then the subscribe call rejects
    // (startCommunity sends `update` before community.start(), which can throw). The client never learns the id.
    it.fails(`a subscribe call that rejects after the server emitted leaves no buffered notifications (${CALLS} calls)`, async () => {
        let subscriptionCounter = 1000;
        server = await createScriptedServer((socket, message) => {
            const subscription = ++subscriptionCounter;
            socket.send(notification(subscription, "update", { payload: "x".repeat(1000) }));
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "start failed" } }));
        });
        client = new PKCRpcClient(server.url);
        for (let i = 0; i < CALLS; i++) await client.startCommunity({ publicKey: `12D3KooWFakePublicKeyForLeakTest${i}` }).catch(() => {});
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect({
            pendingSubscriptionMsgs: Object.keys(internals(client)._pendingSubscriptionMsgs).length,
            subscriptionEvents: Object.keys(internals(client)._subscriptionEvents).length
        }).toEqual({ pendingSubscriptionMsgs: 0, subscriptionEvents: 0 });
    });

    // Finding 3, unbounded variant: the subscribe response is lost, the call times out, the server subscription
    // lives on and keeps sending.
    it.fails("notifications that keep arriving for a timed-out subscribe call are not buffered", async () => {
        const NOTIFICATIONS = 50;
        let liveSocket: WebSocket | undefined;
        server = await createScriptedServer((socket) => {
            liveSocket = socket; // no response: the call times out on the client
        });
        client = new PKCRpcClient(server.url);
        internals(client)._callTimeoutMs = 300;
        const error = await client
            .startCommunity({ publicKey: "12D3KooWFakePublicKeyForLeakTestTimeout" })
            .catch((e: { code?: string }) => e);
        expect((error as { code?: string }).code).toBe("ERR_RPC_CALL_TIMED_OUT");
        for (let i = 0; i < NOTIFICATIONS; i++) liveSocket!.send(notification(2000, "update", { payload: "x".repeat(1000), i }));
        await new Promise((resolve) => setTimeout(resolve, 300));
        const buffered = Object.values(internals(client)._pendingSubscriptionMsgs).reduce((sum, list) => sum + list.length, 0);
        expect({ bufferedNotifications: buffered }).toEqual({ bufferedNotifications: 0 });
    });

    // Finding 6a: rpc-websockets only deletes a queue entry when its response arrives
    it.fails(`calls that time out leave no entry in the rpc-websockets queue (${CALLS} calls)`, async () => {
        server = await createScriptedServer(() => {}); // never answers
        client = new PKCRpcClient(server.url);
        internals(client)._callTimeoutMs = 200;
        for (let i = 0; i < CALLS; i++) await client.startCommunity({ publicKey: `12D3KooWFakePublicKeyForLeakTest${i}` }).catch(() => {});
        expect({ queuedCalls: Object.keys(internals(client)._webSocketClient.queue).length }).toEqual({ queuedCalls: 0 });
    });

    it.fails(`calls rejected by a lost connection leave no entry in the rpc-websockets queue (${CALLS} calls)`, async () => {
        const sockets: WebSocket[] = [];
        server = await createScriptedServer((socket) => {
            sockets.push(socket);
        });
        client = new PKCRpcClient(server.url);
        const calls = Array.from({ length: CALLS }, (_, i) =>
            client!.startCommunity({ publicKey: `12D3KooWFakePublicKeyForLeakTest${i}` }).catch((e: { code?: string }) => e.code)
        );
        const deadline = Date.now() + 10_000;
        while (sockets.length < CALLS) {
            if (Date.now() > deadline) throw Error(`Setup failed: only ${sockets.length}/${CALLS} calls reached the server`);
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        sockets[0].terminate();
        const outcomes = await Promise.all(calls);
        expect(new Set(outcomes)).toEqual(new Set(["ERR_RPC_CONNECTION_LOST"]));
        expect({ queuedCalls: Object.keys(internals(client)._webSocketClient.queue).length }).toEqual({ queuedCalls: 0 });
    });
});

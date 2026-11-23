// A websocket server that speaks no JSON-RPC: it sends one fixed frame per connection and answers nothing.
// It stands in for a hostile or broken RPC server when a test needs the client side of the connection.
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";

export async function startFrameSendingServer(frame: string): Promise<{ url: string; close: () => Promise<void> }> {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    server.on("connection", (socket) => socket.send(frame));
    return {
        url: `ws://127.0.0.1:${(<AddressInfo>server.address()).port}`,
        close: () => {
            for (const client of server.clients) client.terminate();
            return new Promise((resolve) => server.close(() => resolve(undefined)));
        }
    };
}

// A JSON-RPC server that accepts `commentUpdateSubscribe` with subscription id 1, then sends the given notifications
// on that subscription. Every other call is answered with an empty result. It stands in for a hostile RPC server when
// a test needs the client reading live notifications.
export async function startNotificationSendingServer(
    notifications: { event: string; result: unknown }[]
): Promise<{ url: string; close: () => Promise<void> }> {
    const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((resolve) => server.once("listening", resolve));
    server.on("connection", (socket) => {
        socket.on("message", (data) => {
            const request = JSON.parse(data.toString()) as { id?: number; method: string };
            if (request.id === undefined) return;
            if (request.method === "unsubscribe") {
                socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: true }));
                return;
            }
            if (request.method !== "commentUpdateSubscribe") {
                socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }));
                return;
            }
            socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { subscriptionId: 1 } }));
            setTimeout(() => {
                for (const { event, result } of notifications)
                    socket.send(
                        JSON.stringify({ jsonrpc: "2.0", method: "commentUpdateNotification", params: { subscription: 1, event, result } })
                    );
            }, 100);
        });
    });
    return {
        url: `ws://127.0.0.1:${(<AddressInfo>server.address()).port}`,
        close: () => {
            for (const client of server.clients) client.terminate();
            return new Promise((resolve) => server.close(() => resolve(undefined)));
        }
    };
}

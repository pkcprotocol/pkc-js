import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { EventEmitter } from "events";
import PKC from "../../../dist/node/index.js";

// pkc.communities is { name?, publicKey, started }[] since issue #455, and RPC servers and clients update together, so
// the client does not parse the old string[] list. A server that still sends it (or anything else the schema rejects)
// must make the client fail with ERR_INVALID_RPC_COMMUNITIES_SCHEMA, not leave createCommunity waiting forever for a
// first list that never arrives. The server below answers every subscribe call and sends one old-shape list.

interface JsonRpcRequest {
    jsonrpc: "2.0";
    id?: number;
    method: string;
    params: unknown[];
}

class OldShapeCommunitiesRpcServer {
    wss: WebSocketServer;
    port: number;
    private subscriptionCounter = 0;

    private constructor(wss: WebSocketServer, port: number) {
        this.wss = wss;
        this.port = port;
        wss.on("connection", (socket: WebSocket) => {
            socket.on("message", (raw: RawData) => this._handleMessage(socket, raw));
        });
    }

    static async create(): Promise<OldShapeCommunitiesRpcServer> {
        const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
        await EventEmitter.once(wss, "listening");
        const address = wss.address();
        if (address === null || typeof address === "string") throw Error("Expected WebSocketServer to listen on a TCP port");
        return new OldShapeCommunitiesRpcServer(wss, address.port);
    }

    private _handleMessage(socket: WebSocket, raw: RawData) {
        const message = JSON.parse(raw.toString()) as JsonRpcRequest;
        if (typeof message.id !== "number") return;
        const subscriptionId = ++this.subscriptionCounter;
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { subscriptionId } }));
        if (message.method === "communitiesSubscribe")
            socket.send(
                JSON.stringify({
                    jsonrpc: "2.0",
                    method: "communitiesNotification",
                    params: { subscription: subscriptionId, event: "communitieschange", result: { communities: ["old-shape.bso"] } }
                })
            );
    }

    async destroy() {
        for (const client of this.wss.clients) client.terminate();
        await new Promise<void>((resolve, reject) => this.wss.close((err) => (err ? reject(err) : resolve())));
    }
}

describe("RPC client receiving a communities list it can't parse", () => {
    let server: OldShapeCommunitiesRpcServer;

    beforeAll(async () => {
        server = await OldShapeCommunitiesRpcServer.create();
    });

    afterAll(async () => {
        await server.destroy();
    });

    it("createCommunity rejects with ERR_INVALID_RPC_COMMUNITIES_SCHEMA instead of hanging", async () => {
        const pkc = await PKC({ pkcRpcClientsOptions: [`ws://127.0.0.1:${server.port}`], httpRoutersOptions: [] });
        const errors: { code?: string }[] = [];
        pkc.on("error", (error) => errors.push(error as { code?: string }));
        try {
            let sentinel: NodeJS.Timeout | undefined;
            const outcome = await Promise.race([
                pkc.createCommunity({ address: "old-shape.bso" }).then(
                    () => ({ status: "resolved" as const, error: undefined as { code?: string } | undefined }),
                    (error: { code?: string }) => ({ status: "rejected" as const, error })
                ),
                new Promise<{ status: "hung"; error: { code?: string } | undefined }>((resolve) => {
                    sentinel = setTimeout(() => resolve({ status: "hung", error: undefined }), 10_000);
                })
            ]);
            clearTimeout(sentinel);
            expect(outcome.status).to.equal("rejected");
            expect(outcome.error?.code).to.equal("ERR_INVALID_RPC_COMMUNITIES_SCHEMA");
            expect(errors.map((error) => error.code)).to.include("ERR_INVALID_RPC_COMMUNITIES_SCHEMA");
        } finally {
            await pkc.destroy();
        }
    });
});

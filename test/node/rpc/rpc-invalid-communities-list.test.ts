import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { EventEmitter } from "events";
import PKC from "../../../dist/node/index.js";

// pkc.communities is { name?, publicKey, started }[] since issue #455, and RPC servers and clients update together, so
// the client does not parse the old string[] list. A server that still sends it (or anything else the schema rejects)
// must make the client fail with ERR_INVALID_RPC_COMMUNITIES_SCHEMA, not leave createCommunity waiting forever for a
// first list that never arrives. The server below answers every subscribe call and sends one list: old-shape by
// default, or a valid empty one followed later by sendInvalidCommunities(), for a wait that starts after the first list.

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
    private firstCommunities: unknown;
    private communitiesSubscriptions: { socket: WebSocket; subscriptionId: number }[] = [];

    private constructor(wss: WebSocketServer, port: number, firstCommunities: unknown) {
        this.wss = wss;
        this.port = port;
        this.firstCommunities = firstCommunities;
        wss.on("connection", (socket: WebSocket) => {
            socket.on("message", (raw: RawData) => this._handleMessage(socket, raw));
        });
    }

    static async create({
        firstCommunities = ["old-shape.bso"]
    }: { firstCommunities?: unknown } = {}): Promise<OldShapeCommunitiesRpcServer> {
        const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
        await EventEmitter.once(wss, "listening");
        const address = wss.address();
        if (address === null || typeof address === "string") throw Error("Expected WebSocketServer to listen on a TCP port");
        return new OldShapeCommunitiesRpcServer(wss, address.port, firstCommunities);
    }

    private _handleMessage(socket: WebSocket, raw: RawData) {
        const message = JSON.parse(raw.toString()) as JsonRpcRequest;
        if (typeof message.id !== "number") return;
        const subscriptionId = ++this.subscriptionCounter;
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { subscriptionId } }));
        if (message.method === "communitiesSubscribe") {
            this.communitiesSubscriptions.push({ socket, subscriptionId });
            this._sendCommunities(socket, subscriptionId, this.firstCommunities);
        }
    }

    private _sendCommunities(socket: WebSocket, subscriptionId: number, communities: unknown) {
        socket.send(
            JSON.stringify({
                jsonrpc: "2.0",
                method: "communitiesNotification",
                params: { subscription: subscriptionId, event: "communitieschange", result: { communities } }
            })
        );
    }

    sendInvalidCommunities() {
        for (const { socket, subscriptionId } of this.communitiesSubscriptions)
            this._sendCommunities(socket, subscriptionId, ["old-shape.bso"]);
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

// The same failure after a valid first list: RPC createCommunity of a new community waits for the server's list to
// include it (_awaitCommunitiesToIncludeCommunity). A list the client can't parse arriving during that wait must fail it
// with the schema error too, not leave it waiting for a list that never comes
describe("RPC client receiving a communities list it can't parse while waiting for a community to be listed", () => {
    let server: OldShapeCommunitiesRpcServer;

    beforeAll(async () => {
        server = await OldShapeCommunitiesRpcServer.create({ firstCommunities: [] });
    });

    afterAll(async () => {
        await server.destroy();
    });

    it("the wait rejects with ERR_INVALID_RPC_COMMUNITIES_SCHEMA instead of hanging", async () => {
        const pkc = await PKC({ pkcRpcClientsOptions: [`ws://127.0.0.1:${server.port}`], httpRoutersOptions: [] });
        pkc.on("error", () => {});
        try {
            // protected: the wait for the server's first list, which createCommunity runs first
            await (pkc as unknown as { _waitForCommunitiesToBeDefined(): Promise<void> })._waitForCommunitiesToBeDefined();
            expect(pkc.communities).to.deep.equal([]);

            let sentinel: NodeJS.Timeout | undefined;
            const wait = pkc._awaitCommunitiesToIncludeCommunity("not-listed-yet.bso").then(
                () => ({ status: "resolved" as const, error: undefined as { code?: string } | undefined }),
                (error: { code?: string }) => ({ status: "rejected" as const, error })
            );
            server.sendInvalidCommunities();
            const outcome = await Promise.race([
                wait,
                new Promise<{ status: "hung"; error: { code?: string } | undefined }>((resolve) => {
                    sentinel = setTimeout(() => resolve({ status: "hung", error: undefined }), 10_000);
                })
            ]);
            clearTimeout(sentinel);
            expect(outcome.status).to.equal("rejected");
            expect(outcome.error?.code).to.equal("ERR_INVALID_RPC_COMMUNITIES_SCHEMA");
        } finally {
            await pkc.destroy();
        }
    });
});

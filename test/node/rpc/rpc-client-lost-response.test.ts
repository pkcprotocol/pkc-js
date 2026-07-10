import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { EventEmitter } from "events";
import PKCRpcClient from "../../../dist/node/clients/rpc-client/pkc-rpc-client.js";

// Reproduces the CI hang from issue #195 (rpc.auto-start "rapid concurrent state updates" timing out on
// windows-latest): the RPC server completed all 5 startCommunity calls, but one JSON-RPC response never
// reached the awaiting client promise, and PKCRpcClient's call layer has no per-call timeout, so
// Promise.all(starts) pended until the vitest timeout with zero diagnostics.
//
// The server below speaks just enough JSON-RPC to answer startCommunity, and drops the response for one
// designated call. Without a per-call timeout in PKCRpcClient the affected call never settles.

interface JsonRpcRequest {
    jsonrpc: "2.0";
    id?: number;
    method: string;
    params: unknown[];
}

class LossyRpcServer {
    wss: WebSocketServer;
    port: number;
    callsReceived: JsonRpcRequest[] = [];
    /** 1-based index of the call whose response gets dropped; 0 = drop nothing */
    dropNthCall: number;
    private subscriptionCounter = 0;

    private constructor(wss: WebSocketServer, port: number, dropNthCall: number) {
        this.wss = wss;
        this.port = port;
        this.dropNthCall = dropNthCall;
        wss.on("connection", (socket: WebSocket) => {
            socket.on("message", (raw: RawData) => this._handleMessage(socket, raw));
        });
    }

    static async create(dropNthCall: number): Promise<LossyRpcServer> {
        const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
        await EventEmitter.once(wss, "listening");
        const address = wss.address();
        if (address === null || typeof address === "string") throw Error("Expected WebSocketServer to listen on a TCP port");
        return new LossyRpcServer(wss, address.port, dropNthCall);
    }

    private _handleMessage(socket: WebSocket, raw: RawData) {
        const message = JSON.parse(raw.toString()) as JsonRpcRequest;
        if (typeof message.id !== "number") return; // notification, nothing to respond to
        this.callsReceived.push(message);
        if (this.callsReceived.length === this.dropNthCall) return; // simulate the lost response
        this.subscriptionCounter++;
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { subscriptionId: this.subscriptionCounter } }));
    }

    async destroy() {
        for (const client of this.wss.clients) client.terminate();
        await new Promise<void>((resolve, reject) => this.wss.close((err) => (err ? reject(err) : resolve())));
    }
}

const raceAgainstHang = async <T>(promise: Promise<T>, ms: number): Promise<"settled" | "hung"> => {
    let sentinel: NodeJS.Timeout;
    const hangSentinel = new Promise<"hung">((resolve) => {
        sentinel = setTimeout(() => resolve("hung"), ms);
    });
    const outcome = await Promise.race([
        promise.then(
            () => "settled" as const,
            () => "settled" as const
        ),
        hangSentinel
    ]);
    clearTimeout(sentinel!);
    return outcome;
};

describe("PKCRpcClient calls whose response is lost", () => {
    let server: LossyRpcServer;
    let client: PKCRpcClient;

    beforeAll(async () => {
        server = await LossyRpcServer.create(3); // drop the response of the 3rd call, like the CI incident
        client = new PKCRpcClient(`ws://127.0.0.1:${server.port}`);
    });

    afterAll(async () => {
        await client.destroy();
        await server.destroy();
    });

    it("concurrent startCommunity calls all settle even when the server drops one response", async () => {
        // Lower the per-call timeout so the dropped call settles well within the hang sentinel
        (client as unknown as { _callTimeoutMs: number })._callTimeoutMs = 8_000;

        const communityCount = 5;
        const starts = Array.from({ length: communityCount }, (_, i) =>
            client.startCommunity({ publicKey: `12D3KooWFakePublicKeyForLostResponseRepro${i}` }).then(
                (res) => ({ status: "resolved" as const, res, err: undefined as unknown }),
                (err: unknown) => ({ status: "rejected" as const, res: undefined as { subscriptionId: number } | undefined, err })
            )
        );

        const outcome = await raceAgainstHang(Promise.all(starts), 30_000);

        // The server received and processed every call; only one response was dropped.
        expect(server.callsReceived.filter((c) => c.method === "startCommunity").length).to.equal(communityCount);

        // Without a per-call timeout this hangs forever (the CI symptom); with one it settles with an error.
        expect(outcome).to.equal("settled");

        const settledStarts = await Promise.all(starts);
        const resolved = settledStarts.filter((s) => s.status === "resolved");
        const rejected = settledStarts.filter((s) => s.status === "rejected");
        expect(resolved.length).to.equal(communityCount - 1);
        expect(rejected.length).to.equal(1);
        for (const s of resolved) expect(s.res?.subscriptionId).to.be.a("number");

        const timeoutError = rejected[0].err as { code?: string; details?: { rpcMethod?: string } };
        expect(timeoutError.code).to.equal("ERR_RPC_CALL_TIMED_OUT");
        expect(timeoutError.details?.rpcMethod).to.equal("startCommunity");
    });
});

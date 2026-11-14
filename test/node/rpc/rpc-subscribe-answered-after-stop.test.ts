import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { EventEmitter } from "events";
import PKC from "../../../dist/node/index.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import { findUpdatingCommunity } from "../../../dist/node/pkc/tracked-instance-registry-util.js";
import { pollUntil } from "../../helpers/rpc-server-harness.js";

// A community instance has no subscription id until the server answers its subscribe call, so a stop() in that window
// finds nothing to unsubscribe. The answer used to be taken anyway: the server kept the subscription, the client
// re-issued it on every reconnect, and the stopped instance, which no later stop() reaches, kept its handlers. Likewise
// a second start() while the first was in flight overwrote the first one's subscription id. A stop() even earlier, while
// update() was still creating the instance that subscribes for it, was missed the same way. The server below answers
// subscribe calls only when a test releases them, and records every subscription it hands out and every unsubscribe.

interface JsonRpcRequest {
    jsonrpc: "2.0";
    id?: number;
    method: string;
    params: unknown[];
}

const localCommunityPublicKey = "12D3KooWN5rLmRJ8fWMwTtkDN7w2RgPPGRM4mtWTnfbjpi1Sh7zR";
const remoteCommunityPublicKey = "12D3KooWG3XbzoVyAE6Y9vHZKF64Yuuu4TjdgQKedk14iYmTEPWu";
// Only the fields RpcLocalCommunity.initRpcInternalCommunityBeforeFirstUpdateNoMerge reads from a createCommunity response
const createdCommunityProps = {
    localCommunity: {
        address: localCommunityPublicKey,
        publicKey: localCommunityPublicKey,
        signer: { type: "ed25519", address: localCommunityPublicKey, publicKey: "dGVzdA" },
        settings: {},
        started: false
    }
};

class HoldingRpcServer {
    wss: WebSocketServer;
    port: number;
    calls: JsonRpcRequest[] = [];
    // The subscription id the server answered to each subscribe call
    subscribed: { method: string; subscriptionId: number }[] = [];
    unsubscribed: number[] = [];
    // Methods whose response waits for release()
    holdMethods = new Set<string>();
    private held: { socket: WebSocket; request: JsonRpcRequest }[] = [];
    private subscriptionCounter = 0;

    private constructor(wss: WebSocketServer, port: number) {
        this.wss = wss;
        this.port = port;
        wss.on("connection", (socket: WebSocket) => {
            socket.on("message", (raw: RawData) => this._handleMessage(socket, raw));
        });
    }

    static async create(): Promise<HoldingRpcServer> {
        const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
        await EventEmitter.once(wss, "listening");
        const address = wss.address();
        if (address === null || typeof address === "string") throw Error("Expected WebSocketServer to listen on a TCP port");
        return new HoldingRpcServer(wss, address.port);
    }

    get url() {
        return `ws://127.0.0.1:${this.port}`;
    }

    callsOf(method: string) {
        return this.calls.filter((call) => call.method === method);
    }

    heldCount(method: string) {
        return this.held.filter(({ request }) => request.method === method).length;
    }

    // Answers the oldest held call of the method with a new subscription id, and returns that id
    release(method: string): number {
        const index = this.held.findIndex(({ request }) => request.method === method);
        if (index === -1) throw Error(`No held ${method} call to release`);
        const [{ socket, request }] = this.held.splice(index, 1);
        return this._respondWithSubscription(socket, request);
    }

    private _handleMessage(socket: WebSocket, raw: RawData) {
        const request = JSON.parse(raw.toString()) as JsonRpcRequest;
        if (typeof request.id !== "number") return;
        this.calls.push(request);
        if (this.holdMethods.has(request.method)) {
            this.held.push({ socket, request });
            return;
        }
        if (request.method === "unsubscribe") {
            this.unsubscribed.push((request.params[0] as { subscriptionId: number }).subscriptionId);
            this._respond(socket, request.id, { success: true });
        } else if (request.method === "stopCommunity") this._respond(socket, request.id, { success: true });
        else if (request.method === "createCommunity") this._respond(socket, request.id, createdCommunityProps);
        else {
            const subscriptionId = this._respondWithSubscription(socket, request);
            if (request.method === "communitiesSubscribe")
                this._notify(socket, subscriptionId, "communitieschange", {
                    communities: [{ publicKey: localCommunityPublicKey, started: false }]
                });
            // RpcLocalCommunity waits for the first exports list when it is created
            else if (request.method === "exportsSubscribe") this._notify(socket, subscriptionId, "exportschange", { records: [] });
        }
    }

    subscriptionIdsOf(method: string) {
        return this.subscribed.filter((subscription) => subscription.method === method).map(({ subscriptionId }) => subscriptionId);
    }

    private _respondWithSubscription(socket: WebSocket, request: JsonRpcRequest): number {
        const subscriptionId = ++this.subscriptionCounter;
        this.subscribed.push({ method: request.method, subscriptionId });
        this._respond(socket, request.id!, { subscriptionId });
        return subscriptionId;
    }

    private _respond(socket: WebSocket, id: number, result: unknown) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
    }

    private _notify(socket: WebSocket, subscriptionId: number, event: string, result: unknown) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", method: "notification", params: { subscription: subscriptionId, event, result } }));
    }

    async destroy() {
        for (const client of this.wss.clients) client.terminate();
        await new Promise<void>((resolve, reject) => this.wss.close((err) => (err ? reject(err) : resolve())));
    }
}

describe("RPC subscriptions answered after the community instance was stopped", () => {
    let server: HoldingRpcServer;
    let pkc: PKCType;

    beforeEach(async () => {
        server = await HoldingRpcServer.create();
        pkc = await PKC({ pkcRpcClientsOptions: [server.url], dataPath: undefined, httpRoutersOptions: [] });
    });

    afterEach(async () => {
        await pkc.destroy();
        await server.destroy();
    });

    const rpcClient = () => pkc.clients.pkcRpcClients[server.url];

    it("update() then stop() before the server answers: the answered subscription is unsubscribed", async () => {
        const community = await pkc.createCommunity({ publicKey: remoteCommunityPublicKey });
        server.holdMethods.add("communityUpdateSubscribe");
        const updatePromise = community.update();
        await pollUntil(() => server.heldCount("communityUpdateSubscribe") === 1, { intervalMs: 10 });

        await community.stop();
        expect(community.state).to.equal("stopped");

        const subscriptionId = server.release("communityUpdateSubscribe");
        await updatePromise;
        await pollUntil(() => server.unsubscribed.includes(subscriptionId), { timeoutMs: 2_000, intervalMs: 10 });

        // Checked before pkc.destroy(), which unsubscribes whatever is left
        expect(server.unsubscribed, "the server must not keep a subscription nobody owns").to.include(subscriptionId);
        expect(rpcClient().subscriptionActive(subscriptionId), "nor may the client keep or re-issue it").to.be.false;
        expect(community.state).to.equal("stopped");
    });

    it("update() then stop() before the subscribe is sent: no subscription is left, and the instance mirrors nothing", async () => {
        const community = await pkc.createCommunity({ publicKey: remoteCommunityPublicKey });
        // update() awaits the creation of the instance that subscribes on its behalf before it sends the subscribe, and
        // this stop() lands in that wait, the mount/unmount pattern of React StrictMode
        const updatePromise = community.update();
        await community.stop();
        await updatePromise;

        const isLive = (subscriptionId: number) =>
            !server.unsubscribed.includes(subscriptionId) || rpcClient().subscriptionActive(subscriptionId);
        await pollUntil(() => !server.subscriptionIdsOf("communityUpdateSubscribe").some(isLive), { timeoutMs: 2_000, intervalMs: 10 });

        // Checked before pkc.destroy(), which unsubscribes whatever is left
        for (const subscriptionId of server.subscriptionIdsOf("communityUpdateSubscribe"))
            expect(isLive(subscriptionId), `communityUpdate subscription ${subscriptionId} must not stay live`).to.be.false;
        expect(findUpdatingCommunity(pkc, { publicKey: remoteCommunityPublicKey }), "no updating entry may stay tracked").to.be.undefined;
        const mirrored = (community as unknown as { _updatingRpcCommunityInstanceWithListeners?: unknown })
            ._updatingRpcCommunityInstanceWithListeners;
        expect(mirrored, "the stopped instance must not mirror an updating entry").to.be.undefined;
        expect(community.state).to.equal("stopped");
    });

    it("getCommunity aborted while its subscribe is in flight: the answered subscription is unsubscribed", async () => {
        server.holdMethods.add("communityUpdateSubscribe");
        const abortController = new AbortController();
        const getCommunityPromise = pkc.getCommunity({ publicKey: localCommunityPublicKey, abortSignal: abortController.signal });
        await pollUntil(() => server.heldCount("communityUpdateSubscribe") === 1, { intervalMs: 10 });

        abortController.abort();
        const getCommunityError = await getCommunityPromise.then(
            (): undefined => undefined,
            (error: unknown) => error
        );
        expect(getCommunityError, "getCommunity must reject once aborted").to.exist;

        const subscriptionId = server.release("communityUpdateSubscribe");
        await pollUntil(() => server.unsubscribed.includes(subscriptionId), { timeoutMs: 2_000, intervalMs: 10 });

        expect(server.unsubscribed, "the server must not keep a subscription nobody owns").to.include(subscriptionId);
        expect(rpcClient().subscriptionActive(subscriptionId), "nor may the client keep or re-issue it").to.be.false;
    });

    it("a second start() while the first is in flight throws instead of orphaning the first subscription", async () => {
        const community = (await pkc.createCommunity({})) as RpcLocalCommunity;
        server.holdMethods.add("startCommunity");
        const firstStart = community.start();
        await pollUntil(() => server.heldCount("startCommunity") === 1, { intervalMs: 10 });
        let secondStartSettled = false;
        const secondStart = community.start().then(
            (): undefined => undefined,
            (error: { code?: string }) => error
        );
        void secondStart.then(() => (secondStartSettled = true));
        // Either the second start() is refused, or its startCommunity call reaches the server before any answer
        await pollUntil(() => secondStartSettled || server.heldCount("startCommunity") === 2, { intervalMs: 10 });
        const startedSubscriptionIds: number[] = [];
        while (server.heldCount("startCommunity") > 0) startedSubscriptionIds.push(server.release("startCommunity"));

        await firstStart;
        expect((await secondStart)?.code).to.equal("ERR_COMMUNITY_ALREADY_STARTED");
        expect(server.callsOf("startCommunity")).to.have.length(1);
        expect(community.state).to.equal("started");

        await community.stop();
        for (const subscriptionId of startedSubscriptionIds)
            expect(server.unsubscribed, `start subscription ${subscriptionId} must be unsubscribed by stop()`).to.include(subscriptionId);
    });
});

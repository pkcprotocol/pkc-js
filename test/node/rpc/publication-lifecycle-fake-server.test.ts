import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { EventEmitter } from "events";
import PKC from "../../../dist/node/index.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { SignerType } from "../../../dist/node/signer/types.js";
import type Publication from "../../../dist/node/publications/publication.js";

// State-machine regressions of publications and comment updates over PKC RPC, against a fake RPC server so they run
// without the test server: the server answers every subscribe call with a new subscription id, can hold the response
// of one method until the test releases it, and pushes the notifications a real server would send.

interface JsonRpcRequest {
    jsonrpc: "2.0";
    id?: number;
    method: string;
    params: unknown[];
}

class FakeRpcServer {
    calls: { method: string; params: unknown[]; subscriptionId?: number }[] = [];
    private socket?: WebSocket;
    private nextSubscriptionId = 1;
    private heldMethods = new Set<string>();
    private heldResponses = new Map<string, () => number>();

    private constructor(
        private wss: WebSocketServer,
        readonly url: string
    ) {
        wss.on("connection", (socket: WebSocket) => {
            this.socket = socket;
            socket.on("message", (raw: RawData) => this._handleMessage(socket, raw));
        });
    }

    static async create(): Promise<FakeRpcServer> {
        const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
        await EventEmitter.once(wss, "listening");
        const address = wss.address();
        if (address === null || typeof address === "string") throw Error("Expected WebSocketServer to listen on a TCP port");
        return new FakeRpcServer(wss, `ws://127.0.0.1:${address.port}`);
    }

    // The response to the next call of this method waits until releaseHeldResponse()
    holdResponsesTo(method: string) {
        this.heldMethods.add(method);
    }

    async waitForHeldCall(method: string) {
        await vi.waitFor(() => expect(this.heldResponses.has(method)).to.be.true, { timeout: 10000, interval: 10 });
    }

    // Sends the held response and returns the subscription id it carried
    releaseHeldResponse(method: string): number {
        const release = this.heldResponses.get(method);
        if (!release) throw Error(`No held response for ${method}`);
        this.heldResponses.delete(method);
        return release();
    }

    subscriptionIdOf(method: string): number {
        const call = this.calls.find((c) => c.method === method);
        if (typeof call?.subscriptionId !== "number") throw Error(`No ${method} call was answered with a subscription id`);
        return call.subscriptionId;
    }

    unsubscribedIds(): number[] {
        return this.calls
            .filter((call) => call.method === "unsubscribe")
            .map((call) => (call.params[0] as { subscriptionId: number }).subscriptionId);
    }

    sendNotification({ method, subscription, event, result }: { method: string; subscription: number; event: string; result: unknown }) {
        if (!this.socket) throw Error("No client is connected");
        this.socket.send(JSON.stringify({ jsonrpc: "2.0", method, params: { subscription, event, result } }));
    }

    private _handleMessage(socket: WebSocket, raw: RawData) {
        const message = JSON.parse(raw.toString()) as JsonRpcRequest;
        if (typeof message.id !== "number") return;
        const respond = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        if (message.method === "unsubscribe") {
            this.calls.push({ method: message.method, params: message.params });
            respond(true);
            return;
        }
        const subscriptionId = this.nextSubscriptionId++;
        this.calls.push({ method: message.method, params: message.params, subscriptionId });
        if (this.heldMethods.has(message.method)) {
            this.heldMethods.delete(message.method);
            this.heldResponses.set(message.method, () => {
                respond({ subscriptionId });
                return subscriptionId;
            });
        } else respond({ subscriptionId });
    }

    async destroy() {
        for (const client of this.wss.clients) client.terminate();
        await new Promise<void>((resolve, reject) => this.wss.close((err) => (err ? reject(err) : resolve())));
    }
}

// A CHALLENGEVERIFICATION as the server encodes it for the client. The client does not verify what the server relays,
// so the signature only has to decode
const encodedChallengeVerification = ({
    challengeRequestId,
    challengeSuccess
}: {
    challengeRequestId: string;
    challengeSuccess: boolean;
}) => ({
    challengeVerification: {
        type: "CHALLENGEVERIFICATION",
        challengeRequestId,
        challengeSuccess,
        ...(challengeSuccess ? {} : { reason: "rejected by the fake server" }),
        signature: {
            type: "ed25519",
            publicKey: Buffer.from("public key").toString("base64"),
            signature: Buffer.from("signature").toString("base64"),
            signedPropertyNames: ["type", "challengeRequestId", "challengeSuccess"]
        },
        protocolVersion: "1.0.0",
        userAgent: "fake-rpc-server",
        timestamp: Math.round(Date.now() / 1000)
    }
});

// Skips the community fetch: these tests are about the RPC publish subscription, not about loading the community
const setLoadedCommunity = (publication: Publication, communitySigner: SignerType) => {
    publication._community = {
        address: communitySigner.address,
        publicKey: communitySigner.publicKey!,
        encryption: { type: "ed25519-aes-gcm", publicKey: communitySigner.publicKey! },
        pubsubTopic: communitySigner.address
    };
};

const recordEvents = (publication: Publication) => {
    const events: string[] = [];
    publication.on("statechange", (state) => events.push(`statechange:${state}`));
    publication.on("publishingstatechange", (state) => events.push(`publishingstatechange:${state}`));
    publication.on("challenge", () => events.push("challenge"));
    publication.on("challengeverification", (verification) => events.push(`challengeverification:${verification.challengeSuccess}`));
    publication.on("error", (error) => events.push(`error:${(error as { code?: string }).code}`));
    return events;
};

describe("publications over RPC (fake RPC server)", () => {
    let server: FakeRpcServer;
    let pkc: PKCType;
    let communitySigner: SignerType;

    beforeEach(async () => {
        server = await FakeRpcServer.create();
        pkc = await PKC({ pkcRpcClientsOptions: [server.url], dataPath: undefined, httpRoutersOptions: [] });
        pkc.on("error", () => {});
        communitySigner = await pkc.createSigner();
    });

    afterEach(async () => {
        if (!pkc.destroyed) await pkc.destroy();
        await server.destroy();
    });

    const createPost = async () => {
        const post = await pkc.createComment({
            signer: await pkc.createSigner(),
            communityAddress: communitySigner.address,
            title: "fake rpc server post",
            content: "content"
        });
        setLoadedCommunity(post, communitySigner);
        return post;
    };

    const createVote = async () => {
        const vote = await pkc.createVote({
            signer: await pkc.createSigner(),
            communityAddress: communitySigner.address,
            commentCid: "QmUFu8fzuT1th3jJYgR4oRgGpw3sgRALr4nbenA4pyoCav",
            vote: 1
        });
        setLoadedCommunity(vote, communitySigner);
        return vote;
    };

    describe("a publication whose challenge verification arrived", () => {
        it("is no longer registered in pkc._publishingPublications", async () => {
            const post = await createPost();
            const events = recordEvents(post);
            await post.publish();
            expect(pkc._publishingPublications.has(post)).to.be.true;

            server.sendNotification({
                method: "publishCommentNotification",
                subscription: server.subscriptionIdOf("publishComment"),
                event: "challengeverification",
                result: encodedChallengeVerification({ challengeRequestId: communitySigner.address, challengeSuccess: false })
            });
            await vi.waitFor(() => expect(events).to.include("challengeverification:false"), { timeout: 10000, interval: 10 });

            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("failed");
            await vi.waitFor(() => expect(pkc._publishingPublications.has(post)).to.be.false, { timeout: 10000, interval: 10 });
        });

        it("keeps its final publishing state through pkc.destroy()", async () => {
            const vote = await createVote();
            const events = recordEvents(vote);
            await vote.publish();

            server.sendNotification({
                method: "publishVoteNotification",
                subscription: server.subscriptionIdOf("publishVote"),
                event: "challengeverification",
                result: encodedChallengeVerification({ challengeRequestId: communitySigner.address, challengeSuccess: true })
            });
            await vi.waitFor(() => expect(vote.publishingState).to.equal("succeeded"), { timeout: 10000, interval: 10 });

            await pkc.destroy();

            // destroy() stops every registered publication, and Publication.stop() wrote "stopped" over the result
            expect(vote.publishingState).to.equal("succeeded");
            expect(events.filter((event) => event.startsWith("publishingstatechange"))).to.deep.equal(["publishingstatechange:succeeded"]);
        });
    });

    describe("stop() while the server is starting the publish", () => {
        it("drops the subscription the server returns afterwards and ignores its events", async () => {
            const post = await createPost();
            const events = recordEvents(post);
            server.holdResponsesTo("publishComment");

            const publishOutcome = post.publish().then(
                () => "resolved",
                (error: { code?: string }) => `rejected:${error.code}`
            );
            await server.waitForHeldCall("publishComment");
            // The server answers a publish call only after its own publish() started, so the comment is already on its
            // way when stop() runs here, and stop() has no subscription id to unsubscribe yet
            await post.stop();
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("stopped");

            const subscriptionId = server.releaseHeldResponse("publishComment");
            await publishOutcome;
            await vi.waitFor(() => expect(server.unsubscribedIds()).to.include(subscriptionId), { timeout: 10000, interval: 10 });

            // Anything the server still sends for it must not reach the stopped publication
            server.sendNotification({
                method: "publishCommentNotification",
                subscription: subscriptionId,
                event: "challengeverification",
                result: encodedChallengeVerification({ challengeRequestId: communitySigner.address, challengeSuccess: false })
            });
            await new Promise((resolve) => setTimeout(resolve, 200));

            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("stopped");
            expect(events).to.not.include("challengeverification:false");
            expect(pkc._publishingPublications.has(post)).to.be.false;
        });
    });
});

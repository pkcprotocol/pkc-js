import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import { EventEmitter } from "events";
import PKC from "../../../dist/node/index.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { SignerType } from "../../../dist/node/signer/types.js";
import type Publication from "../../../dist/node/publications/publication.js";
import { trackUpdatingComment } from "../../../dist/node/pkc/tracked-instance-registry-util.js";

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
    private heldResponses = new Map<string, (outcome?: { error: string }) => number>();

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

    // Sends the held response, or a JSON-RPC error if `outcome` has one, and returns the subscription id it carried (for
    // an unsubscribe call, the id it unsubscribes)
    releaseHeldResponse(method: string, outcome?: { error: string }): number {
        const release = this.heldResponses.get(method);
        if (!release) throw Error(`No held response for ${method}`);
        this.heldResponses.delete(method);
        return release(outcome);
    }

    // Answers every held call and stops holding, so a test that failed while holding a call does not hang the teardown
    releaseAllHeldResponses() {
        this.heldMethods.clear();
        for (const method of [...this.heldResponses.keys()]) this.releaseHeldResponse(method);
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
        const isUnsubscribe = message.method === "unsubscribe";
        // An unsubscribe call answers true and carries the id it unsubscribes; every other call opens a new subscription
        const subscriptionId = isUnsubscribe ? (message.params[0] as { subscriptionId: number }).subscriptionId : this.nextSubscriptionId++;
        this.calls.push({ method: message.method, params: message.params, ...(isUnsubscribe ? {} : { subscriptionId }) });
        const result = isUnsubscribe ? true : { subscriptionId };
        if (this.heldMethods.has(message.method)) {
            this.heldMethods.delete(message.method);
            this.heldResponses.set(message.method, (outcome) => {
                if (outcome)
                    socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: outcome.error } }));
                else respond(result);
                return subscriptionId;
            });
        } else respond(result);
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
        server.releaseAllHeldResponses();
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

    describe("publish() again", () => {
        const publishCommentCalls = () => server.calls.filter((call) => call.method === "publishComment").length;

        it("calls the server again after the previous publish call was answered with an error", async () => {
            const post = await createPost();
            server.holdResponsesTo("publishComment");
            const firstPublish = post.publish().then(
                (): Error | undefined => undefined,
                (error: Error) => error
            );
            await server.waitForHeldCall("publishComment");
            server.releaseHeldResponse("publishComment", { error: "stubbed publishComment failure" });
            expect(await firstPublish).to.be.instanceOf(Error);
            // The rejected publish() leaves state "publishing", with nothing in flight
            expect(post.state).to.equal("publishing");

            await post.publish();
            // The guard against publishing while in flight used to read state, so this publish() resolved without a call
            expect(publishCommentCalls()).to.equal(2);
            expect(pkc._publishingPublications.has(post)).to.be.true;
        });

        it("does not call the server again while a comment's success verification is being applied", async () => {
            const post = await createPost();
            const events = recordEvents(post);
            await post.publish();
            const subscriptionId = server.subscriptionIdOf("publishComment");
            // Holds the step that checks the comment the server relayed, which runs after the verdict is recorded
            let releaseCommentCheck!: () => void;
            const commentCheckGate = new Promise<void>((resolve) => (releaseCommentCheck = resolve));
            const commentCheck = vi
                .spyOn(
                    post as unknown as { _verifyDecryptedChallengeVerificationAndUpdateCommentProps: () => Promise<void> },
                    "_verifyDecryptedChallengeVerificationAndUpdateCommentProps"
                )
                .mockImplementation(async () => {
                    await commentCheckGate;
                });
            const { challengeVerification } = encodedChallengeVerification({
                challengeRequestId: communitySigner.address,
                challengeSuccess: true
            });
            server.sendNotification({
                method: "publishCommentNotification",
                subscription: subscriptionId,
                event: "challengeverification",
                result: { challengeVerification: { ...challengeVerification, comment: { content: "content" } } }
            });
            await vi.waitFor(() => expect(commentCheck).toHaveBeenCalled(), { timeout: 10000, interval: 10 });

            await post.stop();
            await post.publish();
            // The recorded verdict still ends the publication. This publish() used to make the server publish the comment
            // a second time, and the verdict then stopped the publication under that new publish
            expect(publishCommentCalls()).to.equal(1);

            releaseCommentCheck();
            await vi.waitFor(() => expect(events).to.include("challengeverification:true"), { timeout: 10000, interval: 10 });
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("succeeded");
            expect(server.unsubscribedIds()).to.deep.equal([subscriptionId]);
            await vi.waitFor(() => expect(pkc._publishingPublications.has(post)).to.be.false, { timeout: 10000, interval: 10 });
        });

        // The publication's teardown (_postSucessOrFailurePublishing) awaits the unsubscribe call. These hold it and call
        // publish() inside it
        const publishVoteCalls = () => server.calls.filter((call) => call.method === "publishVote").length;

        it("does not call the server again while a verification's teardown unsubscribes", async () => {
            const vote = await createVote();
            await vote.publish();
            const unsubscribe = vi.spyOn(pkc._pkcRpcClient!, "unsubscribe");
            server.holdResponsesTo("unsubscribe");
            server.sendNotification({
                method: "publishVoteNotification",
                subscription: server.subscriptionIdOf("publishVote"),
                event: "challengeverification",
                result: encodedChallengeVerification({ challengeRequestId: communitySigner.address, challengeSuccess: false })
            });
            await server.waitForHeldCall("unsubscribe");
            await vote.publish();
            // This publish() used to make the server publish the vote a second time, while the first publish's teardown was
            // still running, and that teardown then set the RPC client state to "stopped" under it
            expect(publishVoteCalls()).to.equal(1);

            server.releaseHeldResponse("unsubscribe");
            await unsubscribe.mock.results[0].value;
            await new Promise((resolve) => setTimeout(resolve, 0)); // lets the teardown's caller finish
            expect(vote.state).to.equal("stopped");
            expect(vote.publishingState).to.equal("failed");

            // Once it has ended, publish() calls the server again
            await vote.publish();
            expect(publishVoteCalls()).to.equal(2);
        });

        it("does not call the server again while a publish the server failed is being ended", async () => {
            const vote = await createVote();
            const events = recordEvents(vote);
            await vote.publish();
            server.holdResponsesTo("unsubscribe");
            // What the server sends when its own publish() threw
            server.sendNotification({
                method: "publishVoteNotification",
                subscription: server.subscriptionIdOf("publishVote"),
                event: "error",
                result: {
                    code: "ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS",
                    message: "stubbed server publish failure",
                    details: { publishThrowError: true, newPublishingState: "failed" }
                }
            });
            await server.waitForHeldCall("unsubscribe");
            await vote.publish();
            // This publish() used to make the server publish the vote again, and the error of the publish that failed was
            // then emitted on it
            expect(publishVoteCalls()).to.equal(1);

            server.releaseHeldResponse("unsubscribe");
            await vi.waitFor(() => expect(events).to.include("error:ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS"), {
                timeout: 10000,
                interval: 10
            });
            expect(vote.state).to.equal("stopped");
            expect(vote.publishingState).to.equal("failed");
        });

        // The server reports a failure that does not end its publication (for example, a challenge answer it could not
        // publish): the client's publishingState becomes "failed" and the publish subscription stays live
        const publishVoteTheServerReportsAsFailed = async () => {
            const vote = await createVote();
            const events = recordEvents(vote);
            await vote.publish();
            const firstSubscriptionId = server.subscriptionIdOf("publishVote");
            server.sendNotification({
                method: "publishVoteNotification",
                subscription: firstSubscriptionId,
                event: "publishingstatechange",
                result: { state: "failed" }
            });
            await vi.waitFor(() => expect(vote.publishingState).to.equal("failed"), { timeout: 10000, interval: 10 });
            return { vote, events, firstSubscriptionId };
        };
        const sendVerdict = (subscription: number) =>
            server.sendNotification({
                method: "publishVoteNotification",
                subscription,
                event: "challengeverification",
                result: encodedChallengeVerification({ challengeRequestId: communitySigner.address, challengeSuccess: true })
            });

        it("drops the subscription of a publish the server reported as failed before calling the server again", async () => {
            const { vote, events, firstSubscriptionId } = await publishVoteTheServerReportsAsFailed();

            await vote.publish();
            expect(publishVoteCalls()).to.equal(2);
            const methods = server.calls.map((call) => call.method);
            expect(methods.indexOf("unsubscribe")).to.be.lessThan(methods.lastIndexOf("publishVote"));
            expect(server.unsubscribedIds()).to.deep.equal([firstSubscriptionId]);
            const secondSubscriptionId = server.calls.filter((call) => call.method === "publishVote")[1].subscriptionId!;

            // The first publish's verdict used to end this one as succeeded, and its teardown then unsubscribed this
            // publish instead of the first one
            sendVerdict(firstSubscriptionId);
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(vote.state).to.equal("publishing");
            expect(events).to.not.include("challengeverification:true");

            sendVerdict(secondSubscriptionId);
            await vi.waitFor(() => expect(vote.publishingState).to.equal("succeeded"), { timeout: 10000, interval: 10 });
            expect(vote.state).to.equal("stopped");
            await vi.waitFor(() => expect(server.unsubscribedIds()).to.deep.equal([firstSubscriptionId, secondSubscriptionId]), {
                timeout: 10000,
                interval: 10
            });
        });

        it("ignores the events of a publish the server reported as failed while it is being dropped", async () => {
            const { vote, events, firstSubscriptionId } = await publishVoteTheServerReportsAsFailed();
            server.holdResponsesTo("unsubscribe");

            const secondPublish = vote.publish();
            await server.waitForHeldCall("unsubscribe");
            sendVerdict(firstSubscriptionId);
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(vote.state).to.equal("publishing");
            expect(events).to.not.include("challengeverification:true");
            expect(publishVoteCalls()).to.equal(1);

            server.releaseHeldResponse("unsubscribe");
            await secondPublish;
            expect(publishVoteCalls()).to.equal(2);
            expect(vote.state).to.equal("publishing");
        });

        it("does not call the server again when stop() runs while the failed publish is being dropped", async () => {
            const { vote, firstSubscriptionId } = await publishVoteTheServerReportsAsFailed();
            server.holdResponsesTo("unsubscribe");

            const secondPublish = vote.publish();
            await server.waitForHeldCall("unsubscribe");
            await vote.stop();
            server.releaseHeldResponse("unsubscribe");
            await secondPublish;

            expect(publishVoteCalls()).to.equal(1);
            expect(server.unsubscribedIds()).to.deep.equal([firstSubscriptionId]);
            expect(vote.state).to.equal("stopped");
            expect(vote.publishingState).to.equal("stopped");
            expect(pkc._publishingPublications.has(vote)).to.be.false;
        });

        it("does not call the server again while the retry of a publish the server reported as failed is starting", async () => {
            const { vote, firstSubscriptionId } = await publishVoteTheServerReportsAsFailed();
            server.holdResponsesTo("publishVote");
            const retry = vote.publish();
            await server.waitForHeldCall("publishVote");
            const retrySubscriptionId = server.calls.filter((call) => call.method === "publishVote")[1].subscriptionId!;
            // The server has put the retry's request on the wire and reports its state before it answers the publish call.
            // The client holds that state until the answer, so the vote still shows the failed publish's "failed"
            server.sendNotification({
                method: "publishVoteNotification",
                subscription: retrySubscriptionId,
                event: "publishingstatechange",
                result: { state: "waiting-challenge" }
            });
            await vote.publish(); // for example a second click on a retry button
            // This publish() used to pass the guard on that "failed": it asked the server to publish the vote a third time,
            // and the retry's subscription was then unsubscribed as stale
            expect(publishVoteCalls()).to.equal(2);

            server.releaseHeldResponse("publishVote");
            await retry;
            await vi.waitFor(() => expect(vote.publishingState).to.equal("waiting-challenge"), { timeout: 10000, interval: 10 });
            expect(vote.state).to.equal("publishing");
            expect(server.unsubscribedIds()).to.deep.equal([firstSubscriptionId]);

            // A failure the server reports for the retry itself lets publish() run again
            server.sendNotification({
                method: "publishVoteNotification",
                subscription: retrySubscriptionId,
                event: "publishingstatechange",
                result: { state: "failed" }
            });
            await vi.waitFor(() => expect(vote.publishingState).to.equal("failed"), { timeout: 10000, interval: 10 });
            await vote.publish();
            expect(publishVoteCalls()).to.equal(3);
            expect(server.unsubscribedIds()).to.deep.equal([firstSubscriptionId, retrySubscriptionId]);
        });

        it("calls the server again when the retry's first reported state is a failure", async () => {
            const { vote, events, firstSubscriptionId } = await publishVoteTheServerReportsAsFailed();
            await vote.publish();
            const retrySubscriptionId = server.calls.filter((call) => call.method === "publishVote")[1].subscriptionId!;
            // The vote already shows the failed publish's "failed", so this one does not change publishingState
            server.sendNotification({
                method: "publishVoteNotification",
                subscription: retrySubscriptionId,
                event: "publishingstatechange",
                result: { state: "failed" }
            });
            await vi.waitFor(() => expect(events.filter((event) => event === "publishingstatechange:failed")).to.have.length(2), {
                timeout: 10000,
                interval: 10
            });

            await vote.publish();
            expect(publishVoteCalls()).to.equal(3);
            expect(server.unsubscribedIds()).to.deep.equal([firstSubscriptionId, retrySubscriptionId]);
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

    describe("comment.stop() while update() is subscribing", () => {
        it("unsubscribes the comment update subscription the server returns afterwards", async () => {
            const comment = await pkc.createComment({ cid: "QmUFu8fzuT1th3jJYgR4oRgGpw3sgRALr4nbenA4pyoCav" });
            const updatingStates: string[] = [];
            comment.on("updatingstatechange", (state) => updatingStates.push(state));
            server.holdResponsesTo("commentUpdateSubscribe");

            const updatePromise = comment.update();
            await server.waitForHeldCall("commentUpdateSubscribe");
            const [sharedInstance] = pkc._updatingComments.values();
            // The shared pkc._updatingComments instance has no subscription id yet, so this stop() untracks it and
            // has nothing to unsubscribe
            await comment.stop();

            const subscriptionId = server.releaseHeldResponse("commentUpdateSubscribe");
            await updatePromise;
            await vi.waitFor(() => expect(server.unsubscribedIds()).to.include(subscriptionId), { timeout: 10000, interval: 10 });
            expect(sharedInstance.state).to.equal("stopped");
            expect(comment.state).to.equal("stopped");
            expect(pkc._updatingComments.size()).to.equal(0);

            server.sendNotification({
                method: "commentUpdateNotification",
                subscription: subscriptionId,
                event: "updatingstatechange",
                result: { state: "fetching-update-ipfs" }
            });
            await new Promise((resolve) => setTimeout(resolve, 200));
            expect(sharedInstance.updatingState).to.equal("stopped");
            expect(updatingStates).to.not.include("fetching-update-ipfs");
        });

        // Here the comment is the pkc._updatingComments entry itself, so update() subscribes on it directly instead of
        // mirroring a shared instance. stop() and a new update() during that subscribe set the state back to "updating",
        // which is all the first update() used to check when its subscribe returned
        const startUpdateThenStopAndUpdateAgain = async () => {
            const comment = await pkc.createComment({ cid: "QmUFu8fzuT1th3jJYgR4oRgGpw3sgRALr4nbenA4pyoCav" });
            trackUpdatingComment(pkc, comment);
            server.holdResponsesTo("commentUpdateSubscribe");
            const firstUpdate = comment.update();
            await server.waitForHeldCall("commentUpdateSubscribe");
            await comment.stop();
            // stop() untracked the comment, so this update() creates a shared instance and mirrors it
            await comment.update();
            const [sharedInstance] = pkc._updatingComments.values();
            expect(sharedInstance).to.not.equal(comment);
            return { comment, firstUpdate, sharedInstance };
        };

        it("unsubscribes the subscription of an update() that stop() and a new update() replaced", async () => {
            const { comment, firstUpdate, sharedInstance } = await startUpdateThenStopAndUpdateAgain();

            const staleSubscriptionId = server.releaseHeldResponse("commentUpdateSubscribe");
            await firstUpdate;
            await vi.waitFor(() => expect(server.unsubscribedIds()).to.include(staleSubscriptionId), { timeout: 3000, interval: 10 });
            expect(server.unsubscribedIds()).to.deep.equal([staleSubscriptionId]);
            // The comment keeps mirroring the second update()'s shared instance, without a subscription of its own
            expect(comment.state).to.equal("updating");
            expect(comment._updatingCommentInstance?.comment).to.equal(sharedInstance);
            expect(sharedInstance._numOfListenersForUpdatingInstance).to.equal(1);

            await comment.stop();
            expect(sharedInstance.state).to.equal("stopped");
            expect(pkc._updatingComments.size()).to.equal(0);
        });

        it("leaves the new update() running when the replaced update()'s subscribe fails", async () => {
            const { comment, firstUpdate, sharedInstance } = await startUpdateThenStopAndUpdateAgain();

            server.releaseHeldResponse("commentUpdateSubscribe", { error: "stubbed commentUpdateSubscribe failure" });
            // The failure used to run the stop path on the comment: it detached the new mirror, which stopped the shared
            // instance, set the comment "stopped" with updatingState "failed", and rejected the first update()
            await firstUpdate;
            expect(comment.state).to.equal("updating");
            expect(comment._updatingCommentInstance?.comment).to.equal(sharedInstance);
            expect(sharedInstance.state).to.equal("updating");
            expect(sharedInstance._numOfListenersForUpdatingInstance).to.equal(1);
        });
    });
});

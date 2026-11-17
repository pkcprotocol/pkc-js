import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import { EventEmitter } from "node:events";
import * as cborg from "cborg";
import PKC from "../../../dist/node/index.js";
import { trackStartedCommunity, untrackStartedCommunity } from "../../../dist/node/pkc/tracked-instance-registry-util.js";
import { cleanUpBeforePublishing, signChallengeMessage, signChallengeVerification } from "../../../dist/node/signer/signatures.js";
import { encryptEd25519AesGcm } from "../../../dist/node/signer/index.js";
import env from "../../../dist/node/version.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type Publication from "../../../dist/node/publications/publication.js";
import type { SignerType } from "../../../dist/node/signer/types.js";
import type { IpfsHttpClientPubsubMessage, PubsubSubscriptionHandler } from "../../../dist/node/types.js";
import type {
    ChallengeMessageType,
    ChallengeRequestMessageType,
    ChallengeVerificationMessageType
} from "../../../dist/node/pubsub-messages/types.js";

// State-machine regressions of a publication publishing over pubsub without an RPC client. The pubsub provider is
// stubbed on the publication's clients manager, so these run without the test server: the test decides which publish
// calls fail and sees every challenge request the publication puts on the wire.

// The thresholds are private on Publication; cast through unknown like pubsub.test.ts does.
type PublishThresholds = {
    _publishToDifferentProviderThresholdSeconds: number;
    _setProviderFailureThresholdSeconds: number;
};

const PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS = 1;
const PROVIDER_FAILURE_SECONDS = 2;

// The key a community encrypts its answer to: the pubsub signer of the request
const requestPublicKey = (request: ChallengeRequestMessageType) => Buffer.from(request.signature.publicKey).toString("base64");

const nowInSeconds = () => Math.round(Date.now() / 1000);

// A CHALLENGE for the request, signed by `by` (the community, or someone else on the topic)
const challengeFor = async ({ request, by }: { request: ChallengeRequestMessageType; by: SignerType }): Promise<ChallengeMessageType> => {
    const toSign: Omit<ChallengeMessageType, "signature"> = cleanUpBeforePublishing({
        type: "CHALLENGE",
        challengeRequestId: request.challengeRequestId,
        encrypted: await encryptEd25519AesGcm(
            JSON.stringify({ challenges: { "0": { type: "text/plain", challenge: "1+1=?" } } }),
            by.privateKey,
            requestPublicKey(request)
        ),
        userAgent: "test-community",
        protocolVersion: env.PROTOCOL_VERSION,
        timestamp: nowInSeconds()
    });
    return { ...toSign, signature: await signChallengeMessage({ challengeMessage: toSign, signer: by }) };
};

// A CHALLENGEVERIFICATION for the request, signed by `by`, with `encryptedPlaintext` as its encrypted part if given
const challengeVerificationFor = async ({
    request,
    by,
    challengeSuccess,
    encryptedPlaintext
}: {
    request: ChallengeRequestMessageType;
    by: SignerType;
    challengeSuccess: boolean;
    encryptedPlaintext?: string;
}): Promise<ChallengeVerificationMessageType> => {
    const toSign: Omit<ChallengeVerificationMessageType, "signature"> = cleanUpBeforePublishing({
        type: "CHALLENGEVERIFICATION",
        challengeRequestId: request.challengeRequestId,
        challengeSuccess,
        reason: challengeSuccess ? undefined : "wrong answer",
        encrypted: encryptedPlaintext
            ? await encryptEd25519AesGcm(encryptedPlaintext, by.privateKey, requestPublicKey(request))
            : undefined,
        userAgent: "test-community",
        protocolVersion: env.PROTOCOL_VERSION,
        timestamp: nowInSeconds()
    });
    return { ...toSign, signature: await signChallengeVerification({ challengeVerification: toSign, signer: by }) };
};

describe("publication publishing over a stubbed pubsub provider", () => {
    let pkc: PKCType;
    let communitySigner: SignerType;

    beforeEach(async () => {
        // One pubsub provider: _getPubsubProviders lists it twice, so a failed publish is retried on it once
        pkc = await PKC({
            pubsubKuboRpcClientsOptions: ["http://localhost:23425/api/v0"],
            kuboRpcClientsOptions: undefined,
            ipfsGatewayUrls: ["http://localhost:23426"],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        pkc.on("error", () => {});
        communitySigner = await pkc.createSigner();
    });

    afterEach(async () => {
        if (!pkc.destroyed) await pkc.destroy();
    });

    const createPostWithStubbedPubsub = async ({
        failingPublishCalls = [],
        kind = "post"
    }: { failingPublishCalls?: number[]; kind?: "post" | "vote" } = {}) => {
        const signer = await pkc.createSigner();
        const post: Publication =
            kind === "post"
                ? await pkc.createComment({ signer, communityAddress: communitySigner.address, title: "stubbed pubsub post", content: "c" })
                : await pkc.createVote({
                      signer,
                      communityAddress: communitySigner.address,
                      commentCid: "QmUFu8fzuT1th3jJYgR4oRgGpw3sgRALr4nbenA4pyoCav",
                      vote: 1
                  });
        // Skip the community fetch, the community is the test
        post._community = {
            address: communitySigner.address,
            publicKey: communitySigner.publicKey!,
            encryption: { type: "ed25519-aes-gcm", publicKey: communitySigner.publicKey! },
            pubsubTopic: communitySigner.address
        };
        const thresholds = post as unknown as PublishThresholds;
        thresholds._publishToDifferentProviderThresholdSeconds = PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS;
        thresholds._setProviderFailureThresholdSeconds = PROVIDER_FAILURE_SECONDS;

        const pubsub: { handler?: PubsubSubscriptionHandler; publishCalls: number; requests: ChallengeRequestMessageType[] } = {
            publishCalls: 0,
            requests: []
        };
        const clientsManager = post._clientsManager;
        vi.spyOn(clientsManager, "pubsubSubscribeOnProvider").mockImplementation(async (_topic, handler) => {
            pubsub.handler = handler;
        });
        vi.spyOn(clientsManager, "pubsubUnsubscribeOnProvider").mockResolvedValue(undefined);
        vi.spyOn(clientsManager, "pubsubUnsubscribe").mockResolvedValue(undefined);
        vi.spyOn(clientsManager, "pubsubPublishOnProvider").mockImplementation(async (_topic, message) => {
            pubsub.publishCalls += 1;
            if (failingPublishCalls.includes(pubsub.publishCalls))
                throw new Error(`stubbed failure of publish call ${pubsub.publishCalls}`);
            if ((message as { type?: string }).type === "CHALLENGEREQUEST") pubsub.requests.push(message as ChallengeRequestMessageType);
        });

        const events: string[] = [];
        const errorCodes: string[] = [];
        post.on("statechange", (state) => events.push(`statechange:${state}`));
        post.on("publishingstatechange", (state) => events.push(`publishingstatechange:${state}`));
        post.on("challengerequest", () => events.push("challengerequest"));
        post.on("challenge", () => events.push("challenge"));
        post.on("challengeverification", (verification) => events.push(`challengeverification:${verification.challengeSuccess}`));
        post.on("error", (error) => errorCodes.push(String((error as { code?: string }).code)));
        return { post, pubsub, events, errorCodes };
    };

    // Hands a message to the publication the way its pubsub subscription does, and waits until it is handled
    const deliver = async (
        pubsub: { handler?: PubsubSubscriptionHandler },
        message: ChallengeMessageType | ChallengeVerificationMessageType
    ) => {
        if (!pubsub.handler) throw Error("The publication is not subscribed");
        await pubsub.handler({ data: cborg.encode(message) } as unknown as IpfsHttpClientPubsubMessage);
    };

    const publishingStates = (events: string[]) =>
        events.filter((event) => event.startsWith("publishingstatechange:")).map((event) => event.slice("publishingstatechange:".length));

    describe("no-response watchdog", () => {
        it("fails with an error when the request is held by the last provider because the first one threw", async () => {
            // Publish call 1 (provider 0) throws, call 2 (the last provider) succeeds and nothing answers it
            const { post, pubsub, errorCodes } = await createPostWithStubbedPubsub({ failingPublishCalls: [1] });

            await post.publish();
            expect(pubsub.requests.length).to.equal(1);
            expect(post.publishingState).to.equal("waiting-challenge");

            await vi.waitFor(() => expect(post.state).to.equal("stopped"), { timeout: 20000, interval: 50 });
            // The watchdog used to stop here, PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS after the request, without an error and
            // with publishingState left at "waiting-challenge"
            await vi.waitFor(() => expect(post.publishingState).to.equal("failed"), { timeout: 2000, interval: 50 });
            // A request did reach pubsub, so this is "no response", not "every provider threw" (#362)
            expect(errorCodes).to.deep.equal(["ERR_PUBSUB_DID_NOT_RECEIVE_RESPONSE_AFTER_PUBLISHING_CHALLENGE_REQUEST"]);
            expect(pubsub.requests.length).to.equal(1);
        });
    });

    describe("stop() during publish()", () => {
        it("leaves the publication stopped when it lands while the challenge request is being published", async () => {
            const { post, events } = await createPostWithStubbedPubsub();
            let releasePublish!: () => void;
            const publishGate = new Promise<void>((resolve) => (releasePublish = resolve));
            vi.mocked(post._clientsManager.pubsubPublishOnProvider).mockImplementationOnce(async () => {
                await publishGate;
            });

            const publishOutcome = post.publish();
            await vi.waitFor(() => expect(post._clientsManager.pubsubPublishOnProvider).toHaveBeenCalled(), {
                timeout: 5000,
                interval: 10
            });
            await post.stop();
            releasePublish();
            await publishOutcome;
            // Past the no-response watchdog's first wake-up, had one been started
            await new Promise((resolve) => setTimeout(resolve, PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS * 1000 + 500));

            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("stopped");
            expect(events).to.not.include("challengerequest");
            expect(post._clientsManager.pubsubPublishOnProvider).toHaveBeenCalledTimes(1);
        });
    });

    // The provider is listed once per pubsub client, and a single client twice
    const providerPubsubState = (post: Publication) => Object.values(post.clients.pubsubKuboRpcClients)[0].state;

    // Holds the given pubsub subscribe call (1-based) until the returned release() is called
    const holdSubscribeCall = (post: Publication, pubsub: { handler?: PubsubSubscriptionHandler }, callToHold: number) => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let subscribeCalls = 0;
        vi.mocked(post._clientsManager.pubsubSubscribeOnProvider).mockImplementation(async (_topic, handler) => {
            pubsub.handler = handler;
            subscribeCalls += 1;
            if (subscribeCalls === callToHold) await gate;
        });
        return release;
    };

    // Holds the first pubsub unsubscribe call, the one of the teardown that ends a publish, until release() is called
    const holdFirstUnsubscribe = (post: Publication) => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => (release = resolve));
        let unsubscribeCalls = 0;
        vi.mocked(post._clientsManager.pubsubUnsubscribe).mockImplementation(async () => {
            unsubscribeCalls += 1;
            if (unsubscribeCalls === 1) await gate;
        });
        return release;
    };

    // A started local community that takes the request and, unless a test passes its own handlers, never answers. While it
    // is tracked, publish() hands the request to it directly instead of going over pubsub. Untrack it before the test
    // ends: pkc.destroy() stops every tracked community, and this one has no stop()
    const trackFakeLocalCommunity = ({
        handleChallengeRequest = async () => {},
        handleChallengeAnswer = async () => {}
    }: {
        handleChallengeRequest?: (request: ChallengeRequestMessageType) => Promise<void>;
        handleChallengeAnswer?: () => Promise<void>;
    } = {}) => {
        const community = Object.assign(new EventEmitter(), {
            address: communitySigner.address,
            publicKey: communitySigner.address,
            signer: { address: communitySigner.address },
            handleChallengeRequest: vi.fn(handleChallengeRequest),
            handleChallengeAnswer: vi.fn(handleChallengeAnswer)
        });
        const started = community as unknown as Parameters<typeof trackStartedCommunity>[1];
        trackStartedCommunity(pkc, started);
        return { community, untrack: () => untrackStartedCommunity(pkc, started) };
    };

    type AlreadyCalledError = {
        code?: string;
        details?: { state?: string; publishingState?: string; receivedChallenge?: boolean; receivedChallengeVerification?: boolean };
    };
    const secondPublishError = (post: Publication): Promise<AlreadyCalledError | undefined> =>
        post.publish().then(
            (): AlreadyCalledError | undefined => undefined,
            (error: AlreadyCalledError) => error
        );

    // A publication instance runs one challenge exchange. publish() is spent by its first call, whatever came of it: a
    // retry is a new instance. A second call used to start a second exchange on the same instance, whose requests,
    // watchdog, verdicts and teardown then crossed with the first one's
    describe("a second publish() on the same instance", () => {
        it("rejects while the first request is still waiting, and the first exchange carries on", async () => {
            const { post: vote, pubsub, events } = await createPostWithStubbedPubsub({ kind: "vote" });
            await vote.publish();

            const error = await secondPublishError(vote);
            expect(error?.code).to.equal("ERR_PUBLICATION_PUBLISH_ALREADY_CALLED");
            expect(error?.details).to.include({
                state: "publishing",
                publishingState: "waiting-challenge",
                receivedChallenge: false,
                receivedChallengeVerification: false
            });
            // A second request for the same vote used to go on the wire, and its verdict decided the result
            expect(pubsub.requests.length).to.equal(1);
            expect(vote.publishingState).to.equal("waiting-challenge");

            await deliver(
                pubsub,
                await challengeVerificationFor({ request: pubsub.requests[0], by: communitySigner, challengeSuccess: true })
            );
            expect(vote.state).to.equal("stopped");
            expect(vote.publishingState).to.equal("succeeded");
            expect(events.filter((event) => event === "challengerequest")).to.have.length(1);
        });

        it("rejects after a challenge arrived, and says so", async () => {
            const { post, pubsub } = await createPostWithStubbedPubsub();
            await post.publish();
            await deliver(pubsub, await challengeFor({ request: pubsub.requests[0], by: communitySigner }));

            const error = await secondPublishError(post);
            expect(error?.code).to.equal("ERR_PUBLICATION_PUBLISH_ALREADY_CALLED");
            expect(error?.details).to.include({
                publishingState: "waiting-challenge-answers",
                receivedChallenge: true,
                receivedChallengeVerification: false
            });
            expect(pubsub.requests.length).to.equal(1);
            // The exchange is untouched: its challenge can still be answered
            await post.publishChallengeAnswers({ challengeAnswers: { "0": "2" } });
            expect(post.publishingState).to.equal("waiting-challenge-verification");
        });

        it("rejects after a verification ended the first one", async () => {
            const { post, pubsub } = await createPostWithStubbedPubsub();
            await post.publish();
            await deliver(
                pubsub,
                await challengeVerificationFor({ request: pubsub.requests[0], by: communitySigner, challengeSuccess: false })
            );
            expect(post.publishingState).to.equal("failed");

            const error = await secondPublishError(post);
            expect(error?.code).to.equal("ERR_PUBLICATION_PUBLISH_ALREADY_CALLED");
            expect(error?.details).to.include({ state: "stopped", publishingState: "failed", receivedChallengeVerification: true });
            expect(pubsub.requests.length).to.equal(1);
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("failed");
            expect(pkc._publishingPublications.has(post)).to.be.false;
        });

        // The obvious way to retry a wrong answer. It must fail loudly, not be dropped or cross with the teardown
        it("rejects when called from a challengeverification listener", async () => {
            const { post: vote, pubsub } = await createPostWithStubbedPubsub({ kind: "vote" });
            await vote.publish();
            const listenerPublishes: Promise<AlreadyCalledError | undefined>[] = [];
            vote.once("challengeverification", () => listenerPublishes.push(secondPublishError(vote)));
            await deliver(
                pubsub,
                await challengeVerificationFor({ request: pubsub.requests[0], by: communitySigner, challengeSuccess: false })
            );

            expect((await Promise.all(listenerPublishes)).map((error) => error?.code)).to.deep.equal([
                "ERR_PUBLICATION_PUBLISH_ALREADY_CALLED"
            ]);
            expect(pubsub.requests.length).to.equal(1);
            expect(vote.state).to.equal("stopped");
            expect(vote.publishingState).to.equal("failed");
            expect(providerPubsubState(vote)).to.equal("stopped");
        });

        it("rejects after stop()", async () => {
            const { post, pubsub, errorCodes } = await createPostWithStubbedPubsub();
            await post.publish();
            await post.stop();

            const error = await secondPublishError(post);
            expect(error?.code).to.equal("ERR_PUBLICATION_PUBLISH_ALREADY_CALLED");
            expect(error?.details).to.include({ state: "stopped", publishingState: "stopped" });
            expect(pubsub.requests.length).to.equal(1);
            // Past the no-response watchdog's first wake-up: the stopped exchange's watchdog sends nothing either
            await new Promise((resolve) => setTimeout(resolve, PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS * 1000 + 500));
            expect(pubsub.requests.length).to.equal(1);
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("stopped");
            expect(errorCodes).to.deep.equal([]);
        });

        // stop()'s teardown is still running when publish() is called. An exchange started there used to have "stopped"
        // written over it and its provider reset by that teardown
        it("rejects right after a stop() that was not awaited", async () => {
            const { post, pubsub } = await createPostWithStubbedPubsub();
            await post.publish();
            const releaseUnsubscribe = holdFirstUnsubscribe(post);
            const stopping = post.stop();

            const error = await secondPublishError(post);
            expect(error?.code).to.equal("ERR_PUBLICATION_PUBLISH_ALREADY_CALLED");
            releaseUnsubscribe();
            await stopping;
            expect(pubsub.requests.length).to.equal(1);
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("stopped");
            expect(providerPubsubState(post)).to.equal("stopped");
        });

        // Pre-flight (the community fetch, signing, the signature hook) runs before anything leaves this instance. A
        // publish() that rejects there has no exchange to cross with, so the instance is not spent and can publish again
        it("publishes again after the signature hook rejected the first publish(), before anything was sent", async () => {
            const { post, pubsub } = await createPostWithStubbedPubsub();
            vi.spyOn(post as unknown as { _validateSignatureHook: () => Promise<void> }, "_validateSignatureHook").mockRejectedValueOnce(
                new Error("stubbed pre-flight failure")
            );
            await expect(post.publish()).rejects.toThrow("stubbed pre-flight failure");
            expect(pubsub.requests.length).to.equal(0);
            expect(pkc._publishingPublications.has(post)).to.be.false;

            await post.publish();
            expect(pubsub.requests.length).to.equal(1);
            expect(post.state).to.equal("publishing");
            expect(post.publishingState).to.equal("waiting-challenge");
            expect(pkc._publishingPublications.has(post)).to.be.true;
            // From here on it is spent
            expect((await secondPublishError(post))?.code).to.equal("ERR_PUBLICATION_PUBLISH_ALREADY_CALLED");
        });

        // Holds the first publish() in its pre-flight until release() is called
        const holdSignatureHook = (post: Publication) => {
            let release!: () => void;
            const gate = new Promise<void>((resolve) => (release = resolve));
            const hook = vi
                .spyOn(post as unknown as { _validateSignatureHook: () => Promise<void> }, "_validateSignatureHook")
                .mockImplementationOnce(async () => {
                    await gate;
                });
            return { release, hook };
        };

        it("rejects while the first publish() is still in pre-flight", async () => {
            const { post, pubsub } = await createPostWithStubbedPubsub();
            const { release, hook } = holdSignatureHook(post);
            const firstPublish = post.publish();
            await vi.waitFor(() => expect(hook).toHaveBeenCalled(), { timeout: 5000, interval: 10 });

            // Two publish() calls running side by side on one instance is what single-use rules out
            expect((await secondPublishError(post))?.code).to.equal("ERR_PUBLICATION_PUBLISH_ALREADY_CALLED");
            release();
            await firstPublish;
            expect(pubsub.requests.length).to.equal(1);
            expect(post.publishingState).to.equal("waiting-challenge");
        });

        it("rejects after a stop() during pre-flight", async () => {
            const { post, pubsub } = await createPostWithStubbedPubsub();
            const { release, hook } = holdSignatureHook(post);
            const firstPublish = post.publish();
            await vi.waitFor(() => expect(hook).toHaveBeenCalled(), { timeout: 5000, interval: 10 });
            await post.stop();
            release();
            await firstPublish;

            // stop() ended this instance's publish, also when it had not sent anything yet
            expect((await secondPublishError(post))?.code).to.equal("ERR_PUBLICATION_PUBLISH_ALREADY_CALLED");
            expect(pubsub.requests.length).to.equal(0);
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("stopped");
        });

        // Past pre-flight the instance is spent, also when the step that failed sent nothing itself
        it("rejects after the pubsub provider lookup rejected the first publish()", async () => {
            const { post, pubsub } = await createPostWithStubbedPubsub();
            vi.spyOn(post as unknown as { _getPubsubProviders: () => string[] }, "_getPubsubProviders").mockImplementationOnce(() => {
                throw new Error("stubbed provider lookup failure");
            });
            await expect(post.publish()).rejects.toThrow("stubbed provider lookup failure");
            expect(pkc._publishingPublications.has(post)).to.be.false;

            expect((await secondPublishError(post))?.code).to.equal("ERR_PUBLICATION_PUBLISH_ALREADY_CALLED");
            expect(pubsub.requests.length).to.equal(0);
            expect(pkc._publishingPublications.has(post)).to.be.false;
        });

        it("a stop() before the first publish() does not spend the instance", async () => {
            const { post, pubsub } = await createPostWithStubbedPubsub();
            await post.stop();
            await post.publish();
            expect(pubsub.requests.length).to.equal(1);
            expect(post.state).to.equal("publishing");
            expect(post.publishingState).to.equal("waiting-challenge");
        });

        it("a stop() that was not awaited before the first publish() leaves that publish alone", async () => {
            for (const kind of ["post", "vote"] as const) {
                const { post, pubsub } = await createPostWithStubbedPubsub({ kind });
                const publishingStates: string[] = [];
                post.on("publishingstatechange", (state) => publishingStates.push(state));
                const stopped = post.stop();
                await post.publish();
                await stopped;
                expect(pubsub.requests.length).to.equal(1);
                expect(post.state).to.equal("publishing");
                expect(post.publishingState).to.equal("waiting-challenge");
                // The stop() had no publish to end, so it must not write "stopped" into the publish that followed it
                expect(publishingStates).to.not.include("stopped");
            }
        });

        it("a new instance of the same publication publishes after the first one failed", async () => {
            const { post: vote, pubsub } = await createPostWithStubbedPubsub({ kind: "vote" });
            await vote.publish();
            await deliver(
                pubsub,
                await challengeVerificationFor({ request: pubsub.requests[0], by: communitySigner, challengeSuccess: false })
            );
            expect(vote.publishingState).to.equal("failed");

            // What the error tells the caller to do
            const { post: retry, pubsub: retryPubsub } = await createPostWithStubbedPubsub({ kind: "vote" });
            await retry.publish();
            expect(retryPubsub.requests.length).to.equal(1);
            await deliver(
                retryPubsub,
                await challengeVerificationFor({ request: retryPubsub.requests[0], by: communitySigner, challengeSuccess: true })
            );
            expect(retry.publishingState).to.equal("succeeded");
            expect(vote.publishingState).to.equal("failed");
        });
    });

    describe("stop() while the publish is still at work", () => {
        it("undoes a subscription that resolves after stop()", async () => {
            const { post, pubsub } = await createPostWithStubbedPubsub();
            const releaseFirstSubscribe = holdSubscribeCall(post, pubsub, 1);

            const firstPublish = post.publish();
            await vi.waitFor(() => expect(post._clientsManager.pubsubSubscribeOnProvider).toHaveBeenCalled(), {
                timeout: 5000,
                interval: 10
            });
            await post.stop();
            releaseFirstSubscribe();
            await firstPublish;

            expect(pubsub.requests.length).to.equal(0);
            expect(post._clientsManager.pubsubUnsubscribeOnProvider).toHaveBeenCalledTimes(1);
            expect(providerPubsubState(post)).to.equal("stopped");
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("stopped");
        });

        // The message is handed over before stop(), so its handler is still verifying or decrypting it when stop() runs
        it("drops a challenge that was still being handled when stop() ran", async () => {
            const { post, pubsub, events } = await createPostWithStubbedPubsub();
            await post.publish();
            const handled = deliver(pubsub, await challengeFor({ request: pubsub.requests[0], by: communitySigner }));
            await post.stop();
            await handled;

            // It used to be recorded: "challenge" was emitted on the stopped publication, which moved to
            // "waiting-challenge-answers"
            expect(events).to.not.include("challenge");
            expect(publishingStates(events)).to.deep.equal(["publishing-challenge-request", "waiting-challenge", "stopped"]);
            expect(post.state).to.equal("stopped");
        });

        for (const { name, encryptedPlaintext } of [
            { name: "verification", encryptedPlaintext: undefined },
            { name: "verification whose encrypted part cannot be read", encryptedPlaintext: "not json" }
        ]) {
            it(`drops a ${name} that was still being handled when stop() ran`, async () => {
                const { post: vote, pubsub, events, errorCodes } = await createPostWithStubbedPubsub({ kind: "vote" });
                await vote.publish();
                const handled = deliver(
                    pubsub,
                    await challengeVerificationFor({
                        request: pubsub.requests[0],
                        by: communitySigner,
                        challengeSuccess: true,
                        encryptedPlaintext
                    })
                );
                await vote.stop();
                await handled;

                // stop() ended the publish first, so the verdict that was not recorded yet changes nothing
                expect(events.filter((event) => event.startsWith("challengeverification"))).to.deep.equal([]);
                expect(errorCodes).to.deep.equal([]);
                expect(vote.state).to.equal("stopped");
                expect(vote.publishingState).to.equal("stopped");
            });
        }

        it("lets a comment's success verification that was already recorded end the publication", async () => {
            const { post, pubsub, events } = await createPostWithStubbedPubsub();
            await post.publish();
            const request = pubsub.requests[0];
            // Holds the step that checks the comment the community returned, which runs after the verdict is recorded
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
            const signedComment = post.raw.pubsubMessageToPublish!;
            const handled = deliver(
                pubsub,
                await challengeVerificationFor({
                    request,
                    by: communitySigner,
                    challengeSuccess: true,
                    encryptedPlaintext: JSON.stringify({
                        comment: { ...signedComment, depth: 0 },
                        commentUpdate: {
                            cid: "QmUFu8fzuT1th3jJYgR4oRgGpw3sgRALr4nbenA4pyoCav",
                            signature: signedComment.signature,
                            protocolVersion: env.PROTOCOL_VERSION
                        }
                    })
                })
            );
            await vi.waitFor(() => expect(commentCheck).toHaveBeenCalled(), { timeout: 5000, interval: 10 });

            await post.stop();
            releaseCommentCheck();
            await handled;
            // The verdict was recorded before stop(), so it is the end of this publish
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("succeeded");
            expect(events.filter((event) => event.startsWith("challengeverification"))).to.deep.equal(["challengeverification:true"]);
            expect(pubsub.requests.length).to.equal(1);
        });

        it("does not answer a challenge after stop()", async () => {
            const { post, pubsub, events } = await createPostWithStubbedPubsub();
            await post.publish();
            await deliver(pubsub, await challengeFor({ request: pubsub.requests[0], by: communitySigner }));
            await post.stop();

            await expect(post.publishChallengeAnswers({ challengeAnswers: { "0": "2" } })).rejects.toMatchObject({
                code: "ERR_PUBLICATION_CHALLENGE_EXCHANGE_ENDED"
            });
            // Only the request: no answer went out for the stopped publication
            expect(pubsub.publishCalls).to.equal(1);
            expect(events).to.not.include("publishingstatechange:publishing-challenge-answer");
            expect(post.publishingState).to.equal("stopped");
        });

        it("does not send a challenge answer when stop() runs while it is being encrypted and signed", async () => {
            const { post, pubsub, events } = await createPostWithStubbedPubsub();
            await post.publish();
            await deliver(pubsub, await challengeFor({ request: pubsub.requests[0], by: communitySigner }));

            const answering = post.publishChallengeAnswers({ challengeAnswers: { "0": "2" } }).then(
                (): string | undefined => undefined,
                (error: { code?: string }) => error.code
            );
            const stopping = post.stop(); // in the same tick: the answer is not encrypted yet
            expect(await answering).to.equal("ERR_PUBLICATION_CHALLENGE_EXCHANGE_ENDED");
            await stopping;
            // Only the request: the answer used to go out after the teardown
            expect(pubsub.publishCalls).to.equal(1);
            expect(events).to.not.include("publishingstatechange:publishing-challenge-answer");
            expect(post.publishingState).to.equal("stopped");
        });

        it("leaves the states alone when stop() runs while a challenge answer is being published", async () => {
            const { post, pubsub, events } = await createPostWithStubbedPubsub();
            await post.publish();
            await deliver(pubsub, await challengeFor({ request: pubsub.requests[0], by: communitySigner }));
            let releaseAnswer!: () => void;
            const answerGate = new Promise<void>((resolve) => (releaseAnswer = resolve));
            vi.mocked(post._clientsManager.pubsubPublishOnProvider).mockImplementationOnce(async () => {
                await answerGate;
            });
            const answering = post.publishChallengeAnswers({ challengeAnswers: { "0": "2" } });
            await vi.waitFor(() => expect(post.publishingState).to.equal("publishing-challenge-answer"), { timeout: 5000, interval: 10 });

            await post.stop();
            releaseAnswer();
            await answering;
            // The answer used to move the stopped publication to "waiting-challenge-verification"
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("stopped");
            expect(events).to.not.include("publishingstatechange:waiting-challenge-verification");
        });
    });

    // A publish ends once: by the community's verdict, by a failure, or by stop(). Whichever is recorded first is the
    // end, and the others change nothing
    describe("two ends of the same publish", () => {
        it("drops a verification that arrives while the no-response failure is being torn down", async () => {
            const { post: vote, pubsub, events, errorCodes } = await createPostWithStubbedPubsub({ kind: "vote" });
            await vote.publish();
            const releaseUnsubscribe = holdFirstUnsubscribe(vote);
            // The watchdog retries once, on the provider's second listing, and fails PROVIDER_FAILURE_SECONDS later. Its
            // teardown awaits the unsubscribe, and the subscription still delivers until that returns
            await vi.waitFor(() => expect(vote._clientsManager.pubsubUnsubscribe).toHaveBeenCalled(), {
                timeout: (PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS + PROVIDER_FAILURE_SECONDS) * 1000 + 5000,
                interval: 5
            });
            await deliver(
                pubsub,
                await challengeVerificationFor({ request: pubsub.requests[0], by: communitySigner, challengeSuccess: true })
            );
            releaseUnsubscribe();

            await vi.waitFor(() => expect(vote.publishingState).to.equal("failed"), { timeout: 2000, interval: 10 });
            // The verdict used to be written and emitted, and the failure then wrote "failed" and its error over it
            expect(events.filter((event) => event.startsWith("challengeverification"))).to.deep.equal([]);
            expect(publishingStates(events)).to.not.include("succeeded");
            expect(errorCodes).to.deep.equal(["ERR_PUBSUB_DID_NOT_RECEIVE_RESPONSE_AFTER_PUBLISHING_CHALLENGE_REQUEST"]);
            expect(vote.state).to.equal("stopped");
        });

        // The verdict lands while the request's own publish call has not returned yet
        it("does not move back to waiting-challenge when the verification arrives while the request is being published", async () => {
            const { post: vote, pubsub, events } = await createPostWithStubbedPubsub({ kind: "vote" });
            let releasePublish!: () => void;
            const publishGate = new Promise<void>((resolve) => (releasePublish = resolve));
            vi.mocked(vote._clientsManager.pubsubPublishOnProvider).mockImplementationOnce(async (_topic, message) => {
                pubsub.requests.push(message as ChallengeRequestMessageType);
                await publishGate;
            });
            const publishing = vote.publish();
            await vi.waitFor(() => expect(pubsub.requests.length).to.equal(1), { timeout: 5000, interval: 10 });
            await deliver(
                pubsub,
                await challengeVerificationFor({ request: pubsub.requests[0], by: communitySigner, challengeSuccess: true })
            );
            expect(vote.publishingState).to.equal("succeeded");
            releasePublish();
            await publishing;
            // Past the no-response watchdog's first wake-up, had one been started
            await new Promise((resolve) => setTimeout(resolve, PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS * 1000 + 500));

            // The publish loop used to carry on: "waiting-challenge" over "succeeded", and a "challengerequest" event
            expect(vote.state).to.equal("stopped");
            expect(vote.publishingState).to.equal("succeeded");
            expect(publishingStates(events)).to.deep.equal(["publishing-challenge-request", "succeeded"]);
            expect(events).to.not.include("challengerequest");
            expect(pubsub.requests.length).to.equal(1);
        });

        // The community accepted the comment, but what it returned does not verify (a reply without postCid, a signature
        // that does not match). Like a verification that cannot be read, there is no result to report as succeeded
        it("ends as failed when the comment in a success verification does not verify", async () => {
            const { post, pubsub, events, errorCodes } = await createPostWithStubbedPubsub();
            await post.publish();
            const errorMessages: string[] = [];
            post.on("error", (error) => errorMessages.push(error.message));
            vi.spyOn(
                post as unknown as { _verifyDecryptedChallengeVerificationAndUpdateCommentProps: () => Promise<void> },
                "_verifyDecryptedChallengeVerificationAndUpdateCommentProps"
            ).mockRejectedValue(new Error("stubbed invalid comment in the verification"));
            const signedComment = post.raw.pubsubMessageToPublish!;
            await deliver(
                pubsub,
                await challengeVerificationFor({
                    request: pubsub.requests[0],
                    by: communitySigner,
                    challengeSuccess: true,
                    encryptedPlaintext: JSON.stringify({
                        comment: { ...signedComment, depth: 0 },
                        commentUpdate: {
                            cid: "QmUFu8fzuT1th3jJYgR4oRgGpw3sgRALr4nbenA4pyoCav",
                            signature: signedComment.signature,
                            protocolVersion: env.PROTOCOL_VERSION
                        }
                    })
                })
            );

            // The publication used to stay "publishing", subscribed and registered until stop()
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("failed");
            expect(errorMessages).to.deep.equal(["stubbed invalid comment in the verification"]);
            expect(errorCodes).to.have.length(1);
            expect(events.filter((event) => event.startsWith("challengeverification"))).to.deep.equal([]);
            expect(post._clientsManager.pubsubUnsubscribe).toHaveBeenCalled();
            expect(pkc._publishingPublications.has(post)).to.be.false;
        });

        // The same with the real check: the community returns the comment with its content changed. The check used to
        // emit the error and return normally, so the publication ended "succeeded" with no cid
        it("ends as failed when the community returns a comment that differs from the one published", async () => {
            const { post, pubsub, events, errorCodes } = await createPostWithStubbedPubsub();
            await post.publish();
            const signedComment = post.raw.pubsubMessageToPublish!;
            await deliver(
                pubsub,
                await challengeVerificationFor({
                    request: pubsub.requests[0],
                    by: communitySigner,
                    challengeSuccess: true,
                    encryptedPlaintext: JSON.stringify({
                        comment: { ...signedComment, content: "not what was published", depth: 0 },
                        commentUpdate: {
                            cid: "QmUFu8fzuT1th3jJYgR4oRgGpw3sgRALr4nbenA4pyoCav",
                            signature: signedComment.signature,
                            protocolVersion: env.PROTOCOL_VERSION
                        }
                    })
                })
            );

            expect(errorCodes).to.deep.equal(["ERR_COMMUNITY_CHANGED_COMMENT_PUBSUB_PUBLICATION_PROPS"]);
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("failed");
            expect(publishingStates(events)).to.not.include("succeeded");
            expect(events.filter((event) => event.startsWith("challengeverification"))).to.deep.equal([]);
            expect((post as unknown as { cid?: string }).cid).to.be.undefined;
            expect(pkc._publishingPublications.has(post)).to.be.false;
        });

        // A listener of the verdict that starts the comment's update loop, which sets state "updating"
        it("does not write state stopped over a state a challengeverification listener set", async () => {
            const { post: vote, pubsub } = await createPostWithStubbedPubsub({ kind: "vote" });
            await vote.publish();
            const stateSetter = vote as unknown as { _setStateWithEmission: (state: string) => void };
            vote.once("challengeverification", () => stateSetter._setStateWithEmission("updating"));
            await deliver(
                pubsub,
                await challengeVerificationFor({ request: pubsub.requests[0], by: communitySigner, challengeSuccess: true })
            );
            // The teardown that follows the emission used to set "stopped" again, under the running update
            expect(vote.state).to.equal("updating");
            expect(vote.publishingState).to.equal("succeeded");
        });

        it("keeps the failure when stop() runs while it is being torn down", async () => {
            const { post, errorCodes } = await createPostWithStubbedPubsub({ failingPublishCalls: [1, 2] });
            const releaseUnsubscribe = holdFirstUnsubscribe(post);
            const publishOutcome = post.publish().then(
                (): { code?: string } | undefined => undefined,
                (error: { code?: string }) => error
            );
            await vi.waitFor(() => expect(post._clientsManager.pubsubUnsubscribe).toHaveBeenCalled(), { timeout: 5000, interval: 5 });
            // The failure was recorded first, so it is the end: stop() does not replace it
            const stopping = post.stop();
            releaseUnsubscribe();
            await stopping;

            expect((await publishOutcome)?.code).to.equal("ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS");
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("failed");
            expect(errorCodes).to.deep.equal(["ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS"]);
        });
    });

    // A started local community handles the request in one call that settles once the exchange is over, and the
    // publication's listeners on the community are removed then. That call can reject with no verdict, or right after
    // the community emitted a failed one
    describe("a request the local community rejected", () => {
        const trackRejectingLocalCommunity = () => {
            let rejectRequest!: (error: Error) => void;
            const localCommunity = trackFakeLocalCommunity({
                handleChallengeRequest: () => new Promise<void>((_, reject) => (rejectRequest = reject))
            });
            return { ...localCommunity, rejectRequest: (error: Error) => rejectRequest(error) };
        };

        it("ends the publish as failed with the rejection", async () => {
            const { post, pubsub, events } = await createPostWithStubbedPubsub();
            const errorMessages: string[] = [];
            post.on("error", (error) => errorMessages.push(error.message));
            const localCommunity = trackRejectingLocalCommunity();
            try {
                await post.publish();
                expect(localCommunity.community.handleChallengeRequest).toHaveBeenCalledTimes(1);
                localCommunity.rejectRequest(new Error("stubbed handleChallengeRequest failure"));

                // Nothing ended the publish: it stayed "publishing" and registered until stop(), and the rejection was
                // unhandled
                await vi.waitFor(() => expect(post.state).to.equal("stopped"), { timeout: 5000, interval: 10 });
                expect(post.publishingState).to.equal("failed");
                expect(errorMessages).to.deep.equal(["stubbed handleChallengeRequest failure"]);
                expect(publishingStates(events).at(-1)).to.equal("failed");
                expect(pkc._publishingPublications.has(post)).to.be.false;
                expect(pubsub.requests.length).to.equal(0);
            } finally {
                localCommunity.untrack();
            }
        });

        it("leaves a stopped publication alone when the rejection comes after stop()", async () => {
            const { post, events, errorCodes } = await createPostWithStubbedPubsub();
            const localCommunity = trackRejectingLocalCommunity();
            try {
                await post.publish();
                await post.stop();
                const eventsAfterStop = events.length;
                localCommunity.rejectRequest(new Error("stubbed handleChallengeRequest failure"));
                await new Promise((resolve) => setTimeout(resolve, 100));

                expect(post.state).to.equal("stopped");
                expect(post.publishingState).to.equal("stopped");
                expect(events.slice(eventsAfterStop)).to.deep.equal([]);
                expect(errorCodes).to.deep.equal([]);
            } finally {
                localCommunity.untrack();
            }
        });

        it("lets the failed verdict the community emitted before it rejected end the publish", async () => {
            const { post, events } = await createPostWithStubbedPubsub();
            const errorMessages: string[] = [];
            post.on("error", (error) => errorMessages.push(error.message));
            // A request the community cannot decrypt or parse gets a failed verdict, and then the call rethrows the error
            const localCommunity = trackFakeLocalCommunity({
                handleChallengeRequest: async (request) => {
                    const verdict = await challengeVerificationFor({ request, by: communitySigner, challengeSuccess: false });
                    localCommunity.community.emit("challengeverification", verdict);
                    throw new Error("stubbed failure after the verdict");
                }
            });
            try {
                await post.publish();
                await vi.waitFor(() => expect(post.state).to.equal("stopped"), { timeout: 5000, interval: 10 });
                await new Promise((resolve) => setTimeout(resolve, 100));

                // The rejection used to overtake the verdict, which is recorded only once its signature is checked: the
                // publish ended as a failure with the rejection as an error, and the verdict landed on the stopped publication
                expect(errorMessages).to.deep.equal([]);
                expect(events).to.deep.equal([
                    "statechange:publishing",
                    "challengerequest",
                    "challengeverification:false",
                    "statechange:stopped",
                    "publishingstatechange:failed"
                ]);
                expect(post.publishingState).to.equal("failed");
                expect(pkc._publishingPublications.has(post)).to.be.false;
            } finally {
                localCommunity.untrack();
            }
        });
    });

    // Anyone on the topic can read a challengeRequestId and send a message for it. A message the community did not sign
    // says nothing about the publication, so it is logged and dropped: no state change and no "error" event
    describe("messages the community did not sign", () => {
        it("a CHALLENGEVERIFICATION with an invalid signature is dropped without an error or a state change", async () => {
            const forger = await pkc.createSigner();
            const { post: vote, pubsub, events, errorCodes } = await createPostWithStubbedPubsub({ kind: "vote" });
            await vote.publish();
            const request = pubsub.requests[0];
            const eventsBefore = events.length;

            await deliver(pubsub, await challengeVerificationFor({ request, by: forger, challengeSuccess: false }));
            expect(errorCodes).to.deep.equal([]);
            expect(events.slice(eventsBefore)).to.deep.equal([]);
            expect(vote.state).to.equal("publishing");
            expect(vote.publishingState).to.equal("waiting-challenge");

            await deliver(pubsub, await challengeVerificationFor({ request, by: communitySigner, challengeSuccess: true }));
            expect(vote.state).to.equal("stopped");
            expect(vote.publishingState).to.equal("succeeded");
            expect(publishingStates(events)).to.deep.equal(["publishing-challenge-request", "waiting-challenge", "succeeded"]);
        });

        it("a CHALLENGE with an invalid signature is dropped without an error or a state change", async () => {
            const forger = await pkc.createSigner();
            const { post, pubsub, events, errorCodes } = await createPostWithStubbedPubsub();
            await post.publish();
            const request = pubsub.requests[0];
            const eventsBefore = events.length;

            await deliver(pubsub, await challengeFor({ request, by: forger }));
            expect(errorCodes).to.deep.equal([]);
            expect(events.slice(eventsBefore)).to.deep.equal([]);
            expect(post.publishingState).to.equal("waiting-challenge");

            await deliver(pubsub, await challengeFor({ request, by: communitySigner }));
            expect(events).to.include("challenge");
            expect(publishingStates(events)).to.deep.equal([
                "publishing-challenge-request",
                "waiting-challenge",
                "waiting-challenge-answers"
            ]);
        });
    });

    describe("a success verification whose encrypted part cannot be read", () => {
        it("ends the publication as failed instead of leaving it publishing and subscribed", async () => {
            const { post, pubsub, events, errorCodes } = await createPostWithStubbedPubsub();
            await post.publish();
            const request = pubsub.requests[0];
            await deliver(pubsub, await challengeFor({ request, by: communitySigner }));
            await post.publishChallengeAnswers({ challengeAnswers: { "0": "2" } });
            expect(post.publishingState).to.equal("waiting-challenge-verification");

            // Signed by the community, so it is the real verdict, but the encrypted comment and update are not JSON
            const unreadable = await challengeVerificationFor({
                request,
                by: communitySigner,
                challengeSuccess: true,
                encryptedPlaintext: "not json"
            });
            await deliver(pubsub, unreadable);

            expect(errorCodes).to.deep.equal(["ERR_INVALID_JSON"]);
            // The no-response watchdog stopped watching once the challenge arrived, so nothing else would ever end it
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("failed");
            expect(post._clientsManager.pubsubUnsubscribe).toHaveBeenCalled();
            await vi.waitFor(() => expect(pkc._publishingPublications.has(post)).to.be.false, { timeout: 5000, interval: 20 });

            // A copy of it from another provider is not handled a second time
            await deliver(pubsub, unreadable);
            expect(errorCodes).to.deep.equal(["ERR_INVALID_JSON"]);
            expect(events.filter((event) => event === "statechange:stopped")).to.deep.equal(["statechange:stopped"]);
        });
    });
});

describe("publication.stop() while the community is being fetched", () => {
    let gateway: Server;
    const gatewaySockets = new Set<Socket>();
    let pkc: PKCType;

    beforeAll(async () => {
        // A gateway that accepts requests and never answers, so the community fetch is in flight until stop() aborts it
        gateway = createServer(() => {});
        gateway.on("connection", (socket) => gatewaySockets.add(socket));
        await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", () => resolve()));
        const address = gateway.address();
        if (address === null || typeof address === "string") throw Error("Expected the gateway to listen on a TCP port");
        pkc = await PKC({
            ipfsGatewayUrls: [`http://127.0.0.1:${address.port}`],
            kuboRpcClientsOptions: undefined,
            pubsubKuboRpcClientsOptions: ["http://localhost:23425/api/v0"],
            dataPath: undefined,
            httpRoutersOptions: []
        });
        pkc.on("error", () => {});
    });

    afterAll(async () => {
        if (pkc && !pkc.destroyed) await pkc.destroy();
        for (const socket of gatewaySockets) socket.destroy();
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
    });

    it("ends with publishingState stopped, not the aborted fetch's failed", async () => {
        const post = await pkc.createComment({
            signer: await pkc.createSigner(),
            communityAddress: (await pkc.createSigner()).address,
            title: "fetch stopped",
            content: "c"
        });
        const states: string[] = [];
        post.on("publishingstatechange", (state) => states.push(state));
        post.on("error", () => {});

        const publishOutcome = post.publish().then(
            (): { code?: string } | undefined => undefined,
            (error: { code?: string }) => error
        );
        await vi.waitFor(() => expect(post.publishingState).to.be.oneOf(["resolving-community-name", "fetching-community-ipns"]), {
            timeout: 10000,
            interval: 10
        });
        await post.stop();
        expect(post.publishingState).to.equal("stopped");

        // stop() aborts the fetch, and its rejection reaches publish() after stop() has already settled the states
        expect((await publishOutcome)?.code).to.equal("ERR_GET_COMMUNITY_ABORTED");
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(post.state).to.equal("stopped");
        expect(post.publishingState).to.equal("stopped");
        expect(states).to.not.include("failed");
    });
});

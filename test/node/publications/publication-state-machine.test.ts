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
            JSON.stringify({ challenges: [{ type: "text/plain", challenge: "1+1=?" }] }),
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
            expect(errorCodes).to.deep.equal(["ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS"]);
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

    describe("publish() again on the same instance", () => {
        it("sends a new challenge request after a verification failed the previous attempt", async () => {
            const { post, pubsub } = await createPostWithStubbedPubsub();
            await post.publish();
            await deliver(
                pubsub,
                await challengeVerificationFor({ request: pubsub.requests[0], by: communitySigner, challengeSuccess: false })
            );
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("failed");

            await post.publish();
            // The previous attempt's verification used to count as "challenge received", so nothing was sent and the
            // publication stayed "publishing" with publishingState "failed"
            expect(pubsub.requests.length).to.equal(2);
            expect(post.state).to.equal("publishing");
            expect(post.publishingState).to.equal("waiting-challenge");

            await deliver(
                pubsub,
                await challengeVerificationFor({ request: pubsub.requests[1], by: communitySigner, challengeSuccess: false })
            );
            expect(post.state).to.equal("stopped");
        });

        it("fails after stop() and publish() when the community stays silent, without the stopped attempt's watchdog publishing", async () => {
            const { post, pubsub, errorCodes } = await createPostWithStubbedPubsub();
            await post.publish();
            await new Promise((resolve) => setTimeout(resolve, 200));
            await post.stop();

            const requestsBeforeRepublish = pubsub.requests.length;
            await post.publish();
            // The first attempt's request and exchange used to stay counted, so _isAllAttemptsExhausted never matched the
            // number of providers and the publication stayed "publishing" for good
            await vi.waitFor(() => expect(post.state).to.equal("stopped"), { timeout: 15000, interval: 50 });
            await vi.waitFor(() => expect(post.publishingState).to.equal("failed"), { timeout: 2000, interval: 50 });
            expect(errorCodes).to.deep.equal(["ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS"]);
            // The new attempt's request and its watchdog's retry; the stopped attempt's watchdog woke up during the new
            // attempt and used to send a request of its own
            expect(pubsub.requests.length - requestsBeforeRepublish).to.equal(2);
        });

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

        const providerPubsubState = (post: Publication) => Object.values(post.clients.pubsubKuboRpcClients)[0].state;

        it("does not let the stopped attempt publish a request when publish() runs again during its pubsub subscribe", async () => {
            const { post, pubsub } = await createPostWithStubbedPubsub();
            const releaseFirstSubscribe = holdSubscribeCall(post, pubsub, 1);

            const firstPublish = post.publish();
            await vi.waitFor(() => expect(post._clientsManager.pubsubSubscribeOnProvider).toHaveBeenCalled(), {
                timeout: 5000,
                interval: 10
            });
            await post.stop();
            await post.publish();
            expect(pubsub.requests.length).to.equal(1);
            expect(providerPubsubState(post)).to.equal("waiting-challenge");

            releaseFirstSubscribe();
            await firstPublish;

            // The stopped attempt only checked for state "stopped", which the new attempt had replaced with "publishing", so
            // it moved the provider back to "publishing-challenge-request" and put a second request on the wire
            expect(pubsub.requests.length).to.equal(1);
            expect(providerPubsubState(post)).to.equal("waiting-challenge");
            // The new attempt holds the same topic subscription with the same handler, so it must not be undone
            expect(post._clientsManager.pubsubUnsubscribeOnProvider).not.toHaveBeenCalled();
            expect(post.state).to.equal("publishing");
            expect(post.publishingState).to.equal("waiting-challenge");

            await deliver(
                pubsub,
                await challengeVerificationFor({ request: pubsub.requests[0], by: communitySigner, challengeSuccess: false })
            );
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("failed");
        });

        it("does not let the stopped attempt's watchdog publish its retry when publish() runs again during its subscribe", async () => {
            const { post, pubsub } = await createPostWithStubbedPubsub();
            // Call 1 is the first request's subscribe; call 2 is the watchdog's retry on the next provider
            const releaseRetrySubscribe = holdSubscribeCall(post, pubsub, 2);

            await post.publish();
            expect(pubsub.requests.length).to.equal(1);
            await vi.waitFor(() => expect(post._clientsManager.pubsubSubscribeOnProvider).toHaveBeenCalledTimes(2), {
                timeout: PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS * 1000 + 5000,
                interval: 10
            });
            await post.stop();
            await post.publish();
            expect(pubsub.requests.length).to.equal(2);

            releaseRetrySubscribe();
            // Well before the new attempt's own watchdog retries, PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS after its request
            await new Promise((resolve) => setTimeout(resolve, 100));
            expect(pubsub.requests.length).to.equal(2);
            expect(providerPubsubState(post)).to.equal("waiting-challenge");
            expect(post.publishingState).to.equal("waiting-challenge");
        });

        it("still undoes a subscription that resolves after a plain stop()", async () => {
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

        // The exchange of an attempt that went to a local community stays recorded after the next attempt, and its
        // provider is not a pubsub client. Ending a later attempt resets the pubsub state of every exchange's provider,
        // which must skip that one instead of throwing
        it("ends a pubsub attempt that follows an attempt with a local community", async () => {
            const { post, pubsub, errorCodes } = await createPostWithStubbedPubsub();
            const localCommunity = trackFakeLocalCommunity();
            try {
                await post.publish();
                expect(localCommunity.community.handleChallengeRequest).toHaveBeenCalledTimes(1);
                expect(pubsub.requests.length).to.equal(0);
                await post.stop();
            } finally {
                localCommunity.untrack(); // the community stopped, so the next attempt goes over pubsub
            }

            await post.publish();
            expect(pubsub.requests.length).to.equal(1);
            expect(post.publishingState).to.equal("waiting-challenge");
            // This attempt goes over pubsub, so it tracks its provider's state instead of acting as if it were still local
            expect(providerPubsubState(post)).to.equal("waiting-challenge");

            await deliver(
                pubsub,
                await challengeVerificationFor({ request: pubsub.requests[0], by: communitySigner, challengeSuccess: false })
            );
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("failed");
            expect(providerPubsubState(post)).to.equal("stopped");
            await post.stop();
            expect(errorCodes).to.deep.equal([]);
        });

        it("stops a publish() that follows an attempt with a local community before it starts its exchange", async () => {
            const { post, pubsub, errorCodes } = await createPostWithStubbedPubsub();
            const localCommunity = trackFakeLocalCommunity();
            try {
                await post.publish();
                await post.stop();

                const secondPublish = post.publish();
                await post.stop(); // lands while the second publish() is still starting up
                await secondPublish;

                expect(localCommunity.community.handleChallengeRequest).toHaveBeenCalledTimes(1);
                expect(pubsub.requests.length).to.equal(0);
                expect(post.state).to.equal("stopped");
                expect(post.publishingState).to.equal("stopped");
                expect(errorCodes).to.deep.equal([]);
            } finally {
                localCommunity.untrack();
            }
        });

        it("leaves an attempt that is still in flight alone when publish() is called again without stop()", async () => {
            const { post: vote, pubsub, events } = await createPostWithStubbedPubsub({ kind: "vote" });
            await vote.publish();
            await vote.publish();
            // A second attempt used to start: it put a second request for the same vote on the wire, and from then on the
            // first request's verification was ignored, so the duplicate's verdict decided the result
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

        it("publishes again a publication that failed without being stopped", async () => {
            // Publish call 1 is the request, call 2 the challenge answer
            const { post, pubsub } = await createPostWithStubbedPubsub({ failingPublishCalls: [2] });
            await post.publish();
            await deliver(pubsub, await challengeFor({ request: pubsub.requests[0], by: communitySigner }));
            await expect(post.publishChallengeAnswers({ challengeAnswers: ["2"] })).rejects.toThrow("stubbed failure of publish call 2");
            // Nothing ends the exchange after its answer could not be published
            expect(post.state).to.equal("publishing");
            expect(post.publishingState).to.equal("failed");

            await post.publish();
            expect(pubsub.requests.length).to.equal(2);
            expect(post.publishingState).to.equal("waiting-challenge");
            await deliver(pubsub, await challengeFor({ request: pubsub.requests[1], by: communitySigner }));
            await post.publishChallengeAnswers({ challengeAnswers: ["2"] });
            expect(post.publishingState).to.equal("waiting-challenge-verification");
        });

        it("does not start another attempt while the retry of a failed publication waits for its challenge from a local community", async () => {
            const { post, pubsub } = await createPostWithStubbedPubsub();
            // The community challenges the first request at once, and holds the later ones until the test answers them
            let releaseLaterRequests!: () => void;
            const laterRequestsGate = new Promise<void>((resolve) => (releaseLaterRequests = resolve));
            const localCommunity = trackFakeLocalCommunity({
                handleChallengeRequest: async (request) => {
                    if (localCommunity.community.handleChallengeRequest.mock.calls.length === 1)
                        localCommunity.community.emit("challenge", await challengeFor({ request, by: communitySigner }));
                    else await laterRequestsGate;
                },
                handleChallengeAnswer: async () => {
                    throw new Error("stubbed handleChallengeAnswer failure");
                }
            });
            const { handleChallengeRequest } = localCommunity.community;
            try {
                await post.publish();
                await vi.waitFor(() => expect(post.publishingState).to.equal("waiting-challenge-answers"), { timeout: 5000, interval: 10 });
                await expect(post.publishChallengeAnswers({ challengeAnswers: ["2"] })).rejects.toThrow(
                    "stubbed handleChallengeAnswer failure"
                );
                expect(post.state).to.equal("publishing");
                expect(post.publishingState).to.equal("failed");

                await post.publish();
                expect(handleChallengeRequest).toHaveBeenCalledTimes(2);
                // The retry does not move publishingState before its challenge arrives, so it still shows the old "failed"
                expect(post.publishingState).to.equal("failed");
                await post.publish();
                // This publish() used to pass the guard on that "failed": it handed the community a third request, and the
                // retry's challenge was then ignored
                expect(handleChallengeRequest).toHaveBeenCalledTimes(2);

                const retryRequest = handleChallengeRequest.mock.calls[1][0];
                localCommunity.community.emit("challenge", await challengeFor({ request: retryRequest, by: communitySigner }));
                await vi.waitFor(() => expect(post.publishingState).to.equal("waiting-challenge-answers"), { timeout: 5000, interval: 10 });
                expect(post.state).to.equal("publishing");
                expect(pubsub.requests.length).to.equal(0);
            } finally {
                releaseLaterRequests();
                localCommunity.untrack();
            }
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

            it("ends the attempt as failed with the rejection, and publish() runs again", async () => {
                const { post, pubsub, events } = await createPostWithStubbedPubsub();
                const errorMessages: string[] = [];
                post.on("error", (error) => errorMessages.push(error.message));
                const localCommunity = trackRejectingLocalCommunity();
                try {
                    await post.publish();
                    expect(localCommunity.community.handleChallengeRequest).toHaveBeenCalledTimes(1);
                    localCommunity.rejectRequest(new Error("stubbed handleChallengeRequest failure"));

                    // Nothing ended the attempt: it stayed "publishing", in flight and registered until stop(), so publish()
                    // again was a no-op, and the rejection was unhandled
                    await vi.waitFor(() => expect(post.state).to.equal("stopped"), { timeout: 5000, interval: 10 });
                    expect(post.publishingState).to.equal("failed");
                    expect(errorMessages).to.deep.equal(["stubbed handleChallengeRequest failure"]);
                    expect(publishingStates(events).at(-1)).to.equal("failed");
                    expect(pkc._publishingPublications.has(post)).to.be.false;

                    await post.publish();
                    expect(localCommunity.community.handleChallengeRequest).toHaveBeenCalledTimes(2);
                    expect(post.state).to.equal("publishing");
                    expect(pkc._publishingPublications.has(post)).to.be.true;
                    localCommunity.rejectRequest(new Error("stubbed handleChallengeRequest failure"));
                    await vi.waitFor(() => expect(errorMessages).to.have.length(2), { timeout: 5000, interval: 10 });
                    expect(post.state).to.equal("stopped");
                    expect(post.publishingState).to.equal("failed");
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

            it("lets the failed verdict the community emitted before it rejected end the attempt", async () => {
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
                    // attempt ended as a failure with the rejection as an error, and the verdict landed on the stopped publication
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

        // A publication stays in pkc._publishingPublications until the community refresh its publish() fired from a stale
        // cache entry settles, so pkc.destroy() can still drain that refresh (#270)
        it("stays registered for a retry when the previous attempt's community refresh settles", async () => {
            const { post: vote, pubsub } = await createPostWithStubbedPubsub({ kind: "vote" });
            // The community comes from a stale cache entry, and the background refresh it fires waits for the test (or for
            // stop(), so a failing test does not hold up pkc.destroy())
            const community = vote._community!;
            vote._community = undefined;
            pkc._memCaches.communityForPublishing.set(vote.communityAddress, community);
            vi.spyOn(pkc._memCaches.communityForPublishing, "has").mockReturnValue(false);
            let settleRefresh!: () => void;
            vi.spyOn(pkc, "getCommunity").mockImplementation(
                ({ abortSignal }) =>
                    new Promise((_, reject) => {
                        settleRefresh = () => reject(new Error("stubbed community refresh failure"));
                        abortSignal?.addEventListener("abort", settleRefresh, { once: true });
                    })
            );

            await vote.publish();
            const refresh = vote._backgroundCommunityRefresh;
            expect(refresh).to.not.be.undefined;
            await deliver(
                pubsub,
                await challengeVerificationFor({ request: pubsub.requests[0], by: communitySigner, challengeSuccess: false })
            );
            expect(vote.publishingState).to.equal("failed");
            // Waits for the refresh
            expect(pkc._publishingPublications.has(vote)).to.be.true;

            await vote.publish();
            expect(pubsub.requests.length).to.equal(2);
            settleRefresh();
            await refresh;
            await new Promise((resolve) => setTimeout(resolve, 0));
            // The first attempt's deferred unregister used to remove the retry, which pkc.destroy() then could not stop
            expect(vote.state).to.equal("publishing");
            expect(pkc._publishingPublications.has(vote)).to.be.true;

            // With no refresh left, the retry leaves the registry as soon as it ends
            await deliver(
                pubsub,
                await challengeVerificationFor({ request: pubsub.requests[1], by: communitySigner, challengeSuccess: false })
            );
            expect(vote.state).to.equal("stopped");
            expect(pkc._publishingPublications.has(vote)).to.be.false;
        });

        // The message is handed over before stop(), so its handler is still verifying or decrypting it when stop() and
        // publish() run. The handlers used to filter by attempt only on entry
        it("ignores a challenge the stopped attempt was still handling when stop() and publish() ran", async () => {
            const { post, pubsub, events } = await createPostWithStubbedPubsub();
            await post.publish();
            const handled = deliver(pubsub, await challengeFor({ request: pubsub.requests[0], by: communitySigner }));
            await post.stop();
            await post.publish();
            await handled;

            // It used to be recorded on the stopped attempt's exchange: "challenge" was emitted for the old request and
            // publishingState moved to "waiting-challenge-answers", and publishChallengeAnswers then threw
            expect(events).to.not.include("challenge");
            expect(publishingStates(events)).to.deep.equal([
                "publishing-challenge-request",
                "waiting-challenge",
                "stopped",
                "publishing-challenge-request",
                "waiting-challenge"
            ]);
            expect(pubsub.requests.length).to.equal(2);

            await deliver(pubsub, await challengeFor({ request: pubsub.requests[1], by: communitySigner }));
            expect(events).to.include("challenge");
            await post.publishChallengeAnswers({ challengeAnswers: ["2"] });
            expect(post.publishingState).to.equal("waiting-challenge-verification");
        });

        for (const { name, encryptedPlaintext } of [
            { name: "verification", encryptedPlaintext: undefined },
            { name: "verification whose encrypted part cannot be read", encryptedPlaintext: "not json" }
        ]) {
            it(`does not let a ${name} the stopped attempt was still handling end the next attempt`, async () => {
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
                await vote.publish();
                await handled;

                // It used to be recorded on the stopped attempt's exchange and end the publication with its verdict
                expect(events.filter((event) => event.startsWith("challengeverification"))).to.deep.equal([]);
                expect(errorCodes).to.deep.equal([]);
                expect(vote.state).to.equal("publishing");
                expect(vote.publishingState).to.equal("waiting-challenge");
                expect(pubsub.requests.length).to.equal(2);
                expect(pkc._publishingPublications.has(vote)).to.be.true;
            });
        }

        // These steps run before the exchange starts. A publish() that rejects there leaves state "publishing", with
        // nothing in flight
        for (const { step, failOnce } of [
            {
                step: "the signature hook",
                failOnce: (post: Publication) =>
                    vi
                        .spyOn(post as unknown as { _validateSignatureHook: () => Promise<void> }, "_validateSignatureHook")
                        .mockRejectedValueOnce(new Error("stubbed pre-flight failure"))
            },
            {
                step: "the pubsub provider lookup",
                failOnce: (post: Publication) =>
                    vi
                        .spyOn(post as unknown as { _getPubsubProviders: () => string[] }, "_getPubsubProviders")
                        .mockImplementationOnce(() => {
                            throw new Error("stubbed pre-flight failure");
                        })
            }
        ]) {
            it(`publishes again after ${step} rejected the previous publish()`, async () => {
                const { post, pubsub } = await createPostWithStubbedPubsub();
                failOnce(post);
                await expect(post.publish()).rejects.toThrow("stubbed pre-flight failure");
                expect(post.state).to.equal("publishing");
                expect(pubsub.requests.length).to.equal(0);

                await post.publish();
                // The guard against publishing while in flight used to read state, which the rejected publish() left at
                // "publishing", so this publish() resolved without sending anything
                expect(pubsub.requests.length).to.equal(1);
                expect(post.publishingState).to.equal("waiting-challenge");
            });
        }

        it("does not start another attempt while a comment's success verification is being applied", async () => {
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
            await post.publish();
            // The recorded verdict still ends the publication. This publish() used to start an attempt that put a second
            // request on the wire, which the verdict then stopped under it: that attempt still moved to "waiting-challenge"
            // and its watchdog ended the publication there, without an error
            expect(pubsub.requests.length).to.equal(1);

            releaseCommentCheck();
            await handled;
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("succeeded");
            expect(events.filter((event) => event.startsWith("challengeverification"))).to.deep.equal(["challengeverification:true"]);
            // Past the no-response watchdog's first wake-up, had a new attempt started one
            await new Promise((resolve) => setTimeout(resolve, PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS * 1000 + 500));
            expect(post.state).to.equal("stopped");
            expect(post.publishingState).to.equal("succeeded");
            expect(pubsub.requests.length).to.equal(1);
        });

        // An attempt that ends tears its exchange down first (_postSucessOrFailurePublishing awaits the pubsub
        // unsubscribe) and only then writes how it ended, for a failure. These hold the first unsubscribe call, the one of
        // that teardown, and call publish() inside it
        describe("while the previous attempt is ending", () => {
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
            const waitForUnsubscribe = (post: Publication, timeout = 5000) =>
                vi.waitFor(() => expect(post._clientsManager.pubsubUnsubscribe).toHaveBeenCalled(), { timeout, interval: 5 });

            for (const withStop of [false, true]) {
                it(`does not start an attempt ${withStop ? "after stop() " : ""}while an unreadable success verification ends it`, async () => {
                    const { post: vote, pubsub, errorCodes } = await createPostWithStubbedPubsub({ kind: "vote" });
                    await vote.publish();
                    const releaseUnsubscribe = holdFirstUnsubscribe(vote);
                    const handled = deliver(
                        pubsub,
                        await challengeVerificationFor({
                            request: pubsub.requests[0],
                            by: communitySigner,
                            challengeSuccess: true,
                            encryptedPlaintext: "not json"
                        })
                    );
                    await waitForUnsubscribe(vote);
                    if (withStop) await vote.stop();
                    await vote.publish();
                    // This publish() used to start an attempt that put a second request on the wire. The verdict then wrote
                    // "failed" and ERR_INVALID_JSON over that live attempt, and the guard let a further publish() through
                    expect(pubsub.requests.length).to.equal(1);

                    releaseUnsubscribe();
                    await handled;
                    expect(vote.state).to.equal("stopped");
                    expect(vote.publishingState).to.equal("failed");
                    expect(errorCodes).to.deep.equal(["ERR_INVALID_JSON"]);
                    expect(pkc._publishingPublications.has(vote)).to.be.false;

                    // Once it has ended, publish() starts a new attempt
                    await vote.publish();
                    expect(pubsub.requests.length).to.equal(2);
                    expect(vote.publishingState).to.equal("waiting-challenge");
                });
            }

            it("does not start an attempt while a verification's teardown unsubscribes", async () => {
                const { post: vote, pubsub } = await createPostWithStubbedPubsub({ kind: "vote" });
                await vote.publish();
                const releaseUnsubscribe = holdFirstUnsubscribe(vote);
                const handled = deliver(
                    pubsub,
                    await challengeVerificationFor({ request: pubsub.requests[0], by: communitySigner, challengeSuccess: false })
                );
                await waitForUnsubscribe(vote);
                await vote.publish();
                // This publish() used to start an attempt, and the teardown then reset that attempt's provider to "stopped"
                // while it was waiting for a challenge
                expect(pubsub.requests.length).to.equal(1);

                releaseUnsubscribe();
                await handled;
                expect(vote.state).to.equal("stopped");
                expect(vote.publishingState).to.equal("failed");
                expect(providerPubsubState(vote)).to.equal("stopped");

                await vote.publish();
                expect(pubsub.requests.length).to.equal(2);
                expect(providerPubsubState(vote)).to.equal("waiting-challenge");
            });

            it("does not start an attempt while the no-response watchdog fails it", async () => {
                const { post: vote, pubsub, errorCodes } = await createPostWithStubbedPubsub({ kind: "vote" });
                await vote.publish();
                const releaseUnsubscribe = holdFirstUnsubscribe(vote);
                // The watchdog retries once, on the provider's second listing, and fails PROVIDER_FAILURE_SECONDS later
                await waitForUnsubscribe(vote, (PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS + PROVIDER_FAILURE_SECONDS) * 1000 + 5000);
                expect(pubsub.requests.length).to.equal(2);
                await vote.publish();
                // This publish() used to start an attempt, and the watchdog then wrote "failed" and
                // ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS over it while it was waiting for a challenge
                expect(pubsub.requests.length).to.equal(2);

                releaseUnsubscribe();
                await vi.waitFor(() => expect(vote.publishingState).to.equal("failed"), { timeout: 2000, interval: 10 });
                expect(vote.state).to.equal("stopped");
                expect(errorCodes).to.deep.equal(["ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS"]);
            });

            it("does not start an attempt while a publish() whose providers all threw fails it", async () => {
                const { post, pubsub, errorCodes } = await createPostWithStubbedPubsub({ failingPublishCalls: [1, 2] });
                const releaseUnsubscribe = holdFirstUnsubscribe(post);
                const firstPublish = post.publish().then(
                    (): { code?: string } | undefined => undefined,
                    (error: { code?: string }) => error
                );
                await waitForUnsubscribe(post);
                await post.publish();
                // This publish() used to start an attempt whose request went out, and the first publish() then wrote "failed"
                // and its error over it
                expect(pubsub.publishCalls).to.equal(2);

                releaseUnsubscribe();
                expect((await firstPublish)?.code).to.equal("ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS");
                expect(post.state).to.equal("stopped");
                expect(post.publishingState).to.equal("failed");
                expect(errorCodes).to.deep.equal(["ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS"]);
            });

            it("lets a listener of the failure's error publish again", async () => {
                const { post, pubsub } = await createPostWithStubbedPubsub({ failingPublishCalls: [1, 2] });
                // The failure is written once the teardown is done, so the attempt has ended when its error is emitted
                let retry: Promise<void> | undefined;
                post.once("error", () => (retry = post.publish()));
                await expect(post.publish()).rejects.toMatchObject({ code: "ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS" });
                await retry;
                expect(pubsub.requests.length).to.equal(1);
                expect(post.state).to.equal("publishing");
                expect(post.publishingState).to.equal("waiting-challenge");
                expect(pkc._publishingPublications.has(post)).to.be.true;
            });

            it("does not start an attempt from a statechange listener while a publish() to a community without a challenge exchange fails it", async () => {
                const { post, pubsub } = await createPostWithStubbedPubsub();
                post._community = { ...post._community!, pubsubTopic: undefined };
                // The teardown emits "stopped" before the failure is written
                const listenerPublishes: Promise<unknown>[] = [];
                post.on("statechange", (state) => {
                    if (state === "stopped" && listenerPublishes.length === 0) listenerPublishes.push(post.publish().catch((e) => e));
                });
                const statesAtError: string[] = [];
                post.on("error", () => statesAtError.push(`${post.state}/${post.publishingState}`));

                await expect(post.publish()).rejects.toMatchObject({ code: "ERR_COMMUNITY_CHALLENGE_EXCHANGE_DISABLED" });
                const listenerPublishOutcomes = await Promise.all(listenerPublishes);
                // The listener's publish() used to start an attempt, and the first publish() then wrote "failed" and its error
                // over that attempt while it was "publishing"
                expect(statesAtError).to.deep.equal(["stopped/failed"]);
                expect(listenerPublishOutcomes).to.deep.equal([undefined]);
                expect(post.state).to.equal("stopped");
                expect(pubsub.publishCalls).to.equal(0);
            });
        });
    });

    describe("messages the community did not sign", () => {
        it("a CHALLENGEVERIFICATION with an invalid signature emits an error without moving publishingState to failed", async () => {
            const forger = await pkc.createSigner();
            const { post: vote, pubsub, events, errorCodes } = await createPostWithStubbedPubsub({ kind: "vote" });
            await vote.publish();
            const request = pubsub.requests[0];

            // Anyone on the topic can read the challengeRequestId and send a verification for it
            await deliver(pubsub, await challengeVerificationFor({ request, by: forger, challengeSuccess: false }));
            expect(errorCodes).to.deep.equal(["ERR_CHALLENGE_VERIFICATION_SIGNATURE_IS_INVALID"]);
            expect(vote.state).to.equal("publishing");
            expect(vote.publishingState).to.equal("waiting-challenge");

            await deliver(pubsub, await challengeVerificationFor({ request, by: communitySigner, challengeSuccess: true }));
            expect(vote.state).to.equal("stopped");
            expect(vote.publishingState).to.equal("succeeded");
            expect(publishingStates(events)).to.deep.equal(["publishing-challenge-request", "waiting-challenge", "succeeded"]);
        });

        it("a CHALLENGE with an invalid signature emits an error without moving publishingState to failed", async () => {
            const forger = await pkc.createSigner();
            const { post, pubsub, events, errorCodes } = await createPostWithStubbedPubsub();
            await post.publish();
            const request = pubsub.requests[0];

            await deliver(pubsub, await challengeFor({ request, by: forger }));
            expect(errorCodes).to.deep.equal(["ERR_CHALLENGE_SIGNATURE_IS_INVALID"]);
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
            await post.publishChallengeAnswers({ challengeAnswers: ["2"] });
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

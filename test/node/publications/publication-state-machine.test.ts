import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import * as cborg from "cborg";
import PKC from "../../../dist/node/index.js";
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

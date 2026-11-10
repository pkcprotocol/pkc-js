import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import PKC from "../../../dist/node/index.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { SignerType } from "../../../dist/node/signer/types.js";
import type { PubsubSubscriptionHandler } from "../../../dist/node/types.js";
import type { ChallengeRequestMessageType } from "../../../dist/node/pubsub-messages/types.js";

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

    const createPostWithStubbedPubsub = async ({ failingPublishCalls = [] }: { failingPublishCalls?: number[] } = {}) => {
        const post: Comment = await pkc.createComment({
            signer: await pkc.createSigner(),
            communityAddress: communitySigner.address,
            title: "stubbed pubsub post",
            content: "content"
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
        post.on("error", (error) => errorCodes.push(String((error as { code?: string }).code)));
        return { post, pubsub, events, errorCodes };
    };

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
});

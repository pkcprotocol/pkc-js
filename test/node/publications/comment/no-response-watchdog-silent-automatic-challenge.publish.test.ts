// Regression for issue #362: the no-response watchdog abandoned a slow automatic exchange as a
// provider error, and the publisher never learns that the community accepted the publication.
//
// A community whose challenges are all automatic sends no CHALLENGE message: it awaits every
// challenge and publishes only the final CHALLENGEVERIFICATION. While that runs (or while the
// community's process is too busy to get to the request at all) the publisher sees silence.
//
// A non-RPC publisher with one pubsub provider publishes request A, hears nothing within
// _publishToDifferentProviderThresholdSeconds, re-sends the same signed publication as request B
// (the single provider is listed twice), and sleeps _setProviderFailureThresholdSeconds. Both
// requests were published without an exception. When the sleep ends, _isAllAttemptsExhausted()
// counts the silence as exhaustion, the publisher unsubscribes, and emits
// ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS although no provider threw. The community then finishes,
// stores the comment and publishes a successful verification that nobody is subscribed to hear.
//
// Expected: the silent deadline is reported as a missing response, and the publisher can still
// learn the cid by publishing the same signed publication again.
//
// Unlike #340, no challenge arrives before the deadline, so the #340 fix (a received challenge
// keeps the exchange alive) does not apply.
//
// Timeline is made deterministic with an in-process automatic challenge that holds its verdict
// until the test releases it, after the watchdog deadline has passed.

import { mockPKC, mockGatewayPKC, generateMockPost, resolveWhenConditionIsTrue } from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { it, beforeAll, beforeEach, afterAll, expect } from "vitest";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { PKCError } from "../../../../dist/node/pkc-error.js";
import type { ChallengeFileInput, CommunityChallengeSetting } from "../../../../dist/node/community/types.js";
import type {
    DecryptedChallengeMessageType,
    DecryptedChallengeVerificationMessageType
} from "../../../../dist/node/pubsub-messages/types.js";

// The thresholds are private on Publication; cast through unknown like pubsub.test.ts does.
type PublishThresholds = {
    _publishToDifferentProviderThresholdSeconds: number;
    _setProviderFailureThresholdSeconds: number;
};

type ExchangeInError = {
    challengeRequestPublishTimestamp?: number;
    challengeRequestPublishError?: unknown;
    challengeAnswerPublishError?: unknown;
};

type Gate = { waitForRelease: Promise<void>; release: () => void };
const makeGate = (): Gate => {
    let release!: () => void;
    const waitForRelease = new Promise<void>((resolve) => (release = resolve));
    return { waitForRelease, release };
};

// Publication state changes synchronously inside the pubsub handlers, often before an event
// listener attached afterwards could see them. Poll instead; the vitest timeout bounds a hang.
const waitFor = async (predicate: () => boolean): Promise<void> => {
    while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 20));
};

const PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS = 2;
const PROVIDER_FAILURE_SECONDS = 4;

// Skipped under RPC: registers an in-process challenge factory via pkc.settings.challenges and
// drives a non-RPC publisher's pubsub retry path directly (an RPC client delegates publishing
// to the server).
describeSkipIfRpc("no-response watchdog on a silent automatic exchange (#362)", () => {
    let pkc: PKCType;
    let publisherPKC: PKCType;
    let community: LocalCommunity;

    // Released by the test, after the watchdog deadline, to let the community reach its verdict.
    let verdictGate: Gate;

    const slowAutomaticChallenge = (_: { challengeSettings: CommunityChallengeSetting }): ChallengeFileInput => ({
        type: "text/plain",
        description: "Automatic: sends no challenge and returns its verdict when the test says so",
        getChallenge: async () => {
            await verdictGate.waitForRelease;
            return { success: true };
        }
    });

    beforeAll(async () => {
        pkc = await mockPKC();
        pkc.settings.challenges = { "slow-automatic": slowAutomaticChallenge };
        community = (await pkc.createCommunity()) as LocalCommunity;
        community.setMaxListeners(100);
        await community.edit({ settings: { challenges: [{ name: "slow-automatic" }] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        // One pubsub provider, as in the incident: _getPubsubProviders lists it twice so the
        // no-response path retries the same provider once. The mock pubsub clients all talk to the
        // same in-process bus regardless of the URL, so the community still sees both requests.
        publisherPKC = await mockGatewayPKC({
            forceMockPubsub: true,
            pkcOptions: { pubsubKuboRpcClientsOptions: ["http://localhost:15002/api/v0"] }
        });
    });

    beforeEach(() => {
        verdictGate = makeGate();
    });

    afterAll(async () => {
        verdictGate?.release();
        await publisherPKC.destroy();
        await community.delete();
        await pkc.destroy();
    });

    // Publishes a post, lets the watchdog deadline pass in silence, then releases the community's
    // verdict and waits until the community has accepted and stored the post.
    const runSilentExchangePastDeadline = async () => {
        const post: Comment = await generateMockPost({ communityAddress: community.address, pkc: publisherPKC });
        const thresholds = post as unknown as PublishThresholds;
        thresholds._publishToDifferentProviderThresholdSeconds = PUBLISH_TO_DIFFERENT_PROVIDER_SECONDS;
        thresholds._setProviderFailureThresholdSeconds = PROVIDER_FAILURE_SECONDS;

        const errors: PKCError[] = [];
        const publishingStates: string[] = [];
        const challenges: DecryptedChallengeMessageType[] = [];
        let verification: DecryptedChallengeVerificationMessageType | undefined;
        post.on("error", (error) => errors.push(error as PKCError));
        post.on("publishingstatechange", (state) => publishingStates.push(state));
        post.on("challengeverification", (msg) => (verification = msg));
        post.on("challenge", (challenge) => challenges.push(challenge));

        // Requests the community has seen for this signed publication: A, then the retry B.
        let requestsReceivedByCommunity = 0;
        let retryRequestReceivedAt: number | undefined;
        const countRequests = (request: { comment?: { signature: { signature: string } } }) => {
            if (request.comment?.signature.signature !== post.signature!.signature) return;
            requestsReceivedByCommunity += 1;
            if (requestsReceivedByCommunity === 2) retryRequestReceivedAt = Date.now();
        };
        community.on("challengerequest", countRequests);

        // The cid the community assigned when it accepted the post, read from its own verification.
        let cidAcceptedByCommunity: string | undefined;
        const recordAcceptance = (msg: { challengeSuccess?: boolean; commentUpdate?: { cid?: string } }) => {
            if (msg.challengeSuccess && msg.commentUpdate?.cid) cidAcceptedByCommunity ??= msg.commentUpdate.cid;
        };
        community.on("challengeverification", recordAcceptance);

        const step = (message: string) => console.log(`[#362] ${message}`);

        await post.publish();
        step("published request A");
        await waitFor(() => requestsReceivedByCommunity >= 2);
        step("community received retry B");

        // Let the watchdog deadline (B's request timestamp + failure threshold, plus the one-second
        // granularity of the timestamps involved) pass while the community stays silent.
        const deadlineMs = retryRequestReceivedAt! + (PROVIDER_FAILURE_SECONDS + 2) * 1000;
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadlineMs - Date.now())));
        step(`watchdog deadline passed, errors so far: ${JSON.stringify(errors.map((error) => error.code))}`);

        const errorsAtDeadline = [...errors];
        const stateAtDeadline = post.state;
        const publishingStateAtDeadline = post.publishingState;

        // The community now reaches its verdict and accepts the post.
        verdictGate.release();
        await waitFor(() => cidAcceptedByCommunity !== undefined);
        step(`community accepted the post as ${cidAcceptedByCommunity}`);
        // Give a still-subscribed publisher ample time to receive the verification.
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const cleanup = async () => {
            community.removeListener("challengerequest", countRequests);
            community.removeListener("challengeverification", recordAcceptance);
            await post.stop();
        };

        return {
            post,
            errors,
            errorsAtDeadline,
            stateAtDeadline,
            publishingStateAtDeadline,
            publishingStates,
            challenges,
            getVerification: () => verification,
            cidAcceptedByCommunity: cidAcceptedByCommunity!,
            cleanup
        };
    };

    it("does not report a silent deadline as ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS when no provider threw", async () => {
        const run = await runSilentExchangePastDeadline();
        try {
            expect(run.challenges.length, "an automatic challenge sends no CHALLENGE message").to.equal(0);

            // Precondition: every request was published without an exception.
            for (const error of run.errorsAtDeadline) {
                const exchanges = Object.values((error.details?.challengeExchanges ?? {}) as Record<string, ExchangeInError>);
                for (const exchange of exchanges) {
                    expect(exchange.challengeRequestPublishError, "no provider threw on the request").to.be.undefined;
                    expect(exchange.challengeAnswerPublishError, "no provider threw on the answer").to.be.undefined;
                    expect(exchange.challengeRequestPublishTimestamp, "the request was published").to.be.a("number");
                }
            }

            expect(
                run.errorsAtDeadline.map((error) => error.code),
                "silence after successful sends is a missing response, not a provider exception"
            ).to.deep.equal(["ERR_PUBSUB_DID_NOT_RECEIVE_RESPONSE_AFTER_PUBLISHING_CHALLENGE_REQUEST"]);
            expect(run.publishingStateAtDeadline).to.equal("failed");
            expect(run.stateAtDeadline).to.equal("stopped");
        } finally {
            await run.cleanup();
        }
    });

    // The verification the community published after the deadline reached nobody: the publisher had
    // already unsubscribed, and pubsub does not store and forward. Recovery does not depend on having
    // stayed subscribed for long enough. Publishing the same signed publication again is answered by
    // the community with an idempotent success carrying the cid it stored (issue #228).
    it("publishing the same signed publication again after the deadline returns the cid the community stored", async () => {
        const run = await runSilentExchangePastDeadline();
        try {
            // The community accepted and stored the very publication the publisher signed.
            const stored = community._dbHandler.queryComment(run.cidAcceptedByCommunity);
            expect(stored, "the community stored the post").to.exist;
            expect(stored!.signature.signature).to.equal(run.post.signature!.signature);

            // The publisher does not know: it reported a missing response and holds no cid.
            expect(run.getVerification(), "the late verification reached nobody").to.be.undefined;
            expect(run.post.cid).to.be.undefined;
            expect(run.post.publishingState).to.equal("failed");

            const signatureBeforeRetry = run.post.signature!.signature;
            await run.post.publish();
            await waitFor(() => run.getVerification() !== undefined);

            expect(run.post.signature!.signature, "the retry re-sends the same signed publication").to.equal(signatureBeforeRetry);
            expect(run.getVerification()!.challengeSuccess).to.be.true;
            expect(run.post.cid).to.equal(run.cidAcceptedByCommunity);
            expect(run.post.publishingState).to.equal("succeeded");
        } finally {
            await run.cleanup();
        }
    });
});

// Regression for issue #340: the no-response retry watchdog fails an exchange that already
// received a challenge (or even its verification).
//
// A non-RPC publisher with one pubsub provider publishes request A. No challenge arrives within
// _publishToDifferentProviderThresholdSeconds, so _handleNotReceivingResponseToChallengeRequest
// re-sends the same signed publication as request B (the single provider is listed twice) and then
// sleeps _setProviderFailureThresholdSeconds. During that sleep the community's CHALLENGE for A
// arrives and the publisher answers it. When the sleep ends the watchdog only checks destroyed /
// stopped, and _isAllAttemptsExhausted() counts an exchange as exhausted purely by request age, so
// the publisher unsubscribes and emits ERR_ALL_PUBSUB_PROVIDERS_THROW_ERRORS while the community is
// still verifying. The community then accepts and stores the publication, but the publisher never
// hears about it (its subscription is gone) and the user re-submits a duplicate.
//
// Expected: a received challenge ends the watchdog's authority over that exchange. The publisher
// stays subscribed, emits no error, and resolves the original publication when the verification
// arrives, whether the answer was already sent, is still pending on the user, or the verification
// itself already arrived before the deadline.
//
// Timeline is made deterministic with an in-process challenge: getChallenge waits until the
// community has received request B before returning the challenge (so the retry has fired), and
// verify() holds the verdict until the test releases it.

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

// What has happened on the live exchange by the time the watchdog's deadline passes.
type Scenario =
    | "challenge answered, verification pending"
    | "challenge received, answer pending on the user"
    | "verification already received";

// Skipped under RPC: registers an in-process challenge factory via pkc.settings.challenges and
// drives a non-RPC publisher's pubsub retry path directly (an RPC client delegates publishing
// to the server).
describeSkipIfRpc("no-response watchdog after a challenge was received (#340)", () => {
    let pkc: PKCType;
    let publisherPKC: PKCType;
    let community: LocalCommunity;

    // Released by the test once the community has received the retried request B.
    let challengeGate: Gate;
    // Released by the test to let the community publish its verdict.
    let verifyGate: Gate;
    // Parks any exchange after the first one; released when the scenario is over. Only request A
    // is ever challenged, so the publisher holds exactly one live exchange regardless of how the
    // community treats the duplicate request B (#228 changes that).
    let laterRequestsGate: Gate;
    let challengeCalls = 0;

    const slowInteractiveChallenge = (_: { challengeSettings: CommunityChallengeSetting }): ChallengeFileInput => ({
        type: "text/plain",
        description: "Sends its challenge late and verifies the answer when the test says so",
        getChallenge: async () => {
            challengeCalls += 1;
            if (challengeCalls > 1) {
                await laterRequestsGate.waitForRelease;
                return { success: false, error: "only the first request of a scenario is challenged" };
            }
            await challengeGate.waitForRelease;
            return {
                challenge: "say anything",
                type: "text/plain",
                verify: async () => {
                    await verifyGate.waitForRelease;
                    return { success: true };
                }
            };
        }
    });

    beforeAll(async () => {
        pkc = await mockPKC();
        pkc.settings.challenges = { "slow-interactive": slowInteractiveChallenge };
        community = (await pkc.createCommunity()) as LocalCommunity;
        community.setMaxListeners(100);
        await community.edit({ settings: { challenges: [{ name: "slow-interactive" }] } });
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
        challengeGate = makeGate();
        verifyGate = makeGate();
        laterRequestsGate = makeGate();
        challengeCalls = 0;
    });

    afterAll(async () => {
        challengeGate?.release();
        verifyGate?.release();
        laterRequestsGate?.release();
        await publisherPKC.destroy();
        await community.delete();
        await pkc.destroy();
    });

    const runScenario = async (scenario: Scenario) => {
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
        const answerChallenge = () =>
            post.publishChallengeAnswers({ challengeAnswers: ["anything"] }).catch((error) => errors.push(error as PKCError));

        // Requests the community has seen for this signed publication: A, then the retry B.
        let requestsReceivedByCommunity = 0;
        let retryRequestReceivedAt: number | undefined;
        const countRequests = (request: { comment?: { signature: { signature: string } } }) => {
            if (request.comment?.signature.signature !== post.signature!.signature) return;
            requestsReceivedByCommunity += 1;
            if (requestsReceivedByCommunity === 2) retryRequestReceivedAt = Date.now();
        };
        community.on("challengerequest", countRequests);

        const step = (message: string) => console.log(`[#340 ${scenario}] ${message}`);
        try {
            await post.publish();
            step("published request A");
            await waitFor(() => requestsReceivedByCommunity >= 1);
            step("community received A");

            // No challenge within the provider-switch threshold, so the publisher re-sends as B.
            await waitFor(() => requestsReceivedByCommunity >= 2);
            step("community received retry B");
            expect(challenges.length, "the challenge must arrive only after the retry fired").to.equal(0);

            // Now let the community send the challenge for A.
            challengeGate.release();
            await waitFor(() => challenges.length >= 1);
            step("publisher received the challenge");

            let expectedStateAtDeadline: Comment["publishingState"];
            if (scenario === "challenge received, answer pending on the user") {
                expectedStateAtDeadline = "waiting-challenge-answers";
            } else {
                await answerChallenge();
                step("answered the challenge");
                await waitFor(() => post.publishingState === "waiting-challenge-verification");
                step("publisher is waiting for the verification");
                expectedStateAtDeadline = "waiting-challenge-verification";
                if (scenario === "verification already received") {
                    verifyGate.release();
                    await waitFor(() => verification !== undefined);
                    expectedStateAtDeadline = "succeeded";
                }
            }

            // Let the watchdog deadline (B's request timestamp + failure threshold, plus the
            // one-second granularity of the timestamps involved) pass.
            const deadlineMs = retryRequestReceivedAt! + (PROVIDER_FAILURE_SECONDS + 2) * 1000;
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, deadlineMs - Date.now())));
            step("watchdog deadline passed");

            expect(
                errors.map((error) => error.code),
                "a challenge was received; the no-response watchdog must not fail the publication"
            ).to.deep.equal([]);
            expect(post.publishingState).to.equal(expectedStateAtDeadline);
            expect(publishingStates.filter((state) => state === "failed")).to.deep.equal([]);

            // Finish the exchange. The publisher must still be subscribed to receive the verdict.
            if (scenario === "challenge received, answer pending on the user") {
                expect(post.state).to.equal("publishing");
                await answerChallenge();
                await waitFor(() => post.publishingState === "waiting-challenge-verification");
            }
            if (scenario !== "verification already received") {
                expect(post.state).to.equal("publishing");
                expect(verification).to.be.undefined;
                verifyGate.release();
                await waitFor(() => verification !== undefined);
            }
            expect(verification!.challengeSuccess).to.be.true;
            expect(post.cid).to.be.a("string");
            expect(post.publishingState).to.equal("succeeded");
            expect(post.state).to.equal("stopped");
            expect(publishingStates.filter((state) => state === "failed")).to.deep.equal([]);
            expect(errors).to.deep.equal([]);
            expect(community._dbHandler.queryComment(post.cid!)).to.exist;
        } finally {
            community.removeListener("challengerequest", countRequests);
            challengeGate.release();
            verifyGate.release();
            laterRequestsGate.release();
            await post.stop();
        }
    };

    it("keeps waiting for the verification when the challenge was answered before the deadline", () =>
        runScenario("challenge answered, verification pending"));

    it("keeps waiting for the user's answer when the challenge arrived before the deadline", () =>
        runScenario("challenge received, answer pending on the user"));

    it("does not fail a publication whose verification already arrived before the deadline", () =>
        runScenario("verification already received"));
});

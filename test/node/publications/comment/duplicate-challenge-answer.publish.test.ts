// Regression for issue #349: publishChallengeAnswers accepts a second call for a challenge that was
// already answered.
//
// A UI that received the same challenge twice (see duplicate-challenge-delivery.publish.test.ts)
// answers twice. Without a guard the publisher signs and publishes a second CHALLENGEANSWER. The
// community consumed the first answer already, so the second one finds no resolve handle and the
// community's answer handler throws. Over pubsub that throw is only logged. For a community hosted in
// the same PKC instance the publisher awaits the community handler directly, so the throw propagates
// back into publishChallengeAnswers, which records it, moves the publishing state to "failed" and
// rethrows, while the community goes on to verify the first answer and store the publication.
//
// Expected: the second call rejects with ERR_CHALLENGE_ANSWER_ALREADY_PUBLISHED before doing any
// work, the community sees exactly one answer, the publishing state is never "failed", and the
// publication succeeds on the first answer. Two calls issued in the same tick must behave the same
// way, so the claim on the exchange has to be made before the first await.
//
// The community's verify() is held behind a gate so the second answer always lands while the first
// is still being verified, the ordering that makes the community handler throw.

import { mockPKC, mockGatewayPKC, generateMockPost, resolveWhenConditionIsTrue } from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { it, beforeAll, beforeEach, afterAll, expect } from "vitest";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { PKCError } from "../../../../dist/node/pkc-error.js";
import type { ChallengeFileInput, CommunityChallengeSetting } from "../../../../dist/node/community/types.js";
import type {
    DecryptedChallengeAnswerMessageType,
    DecryptedChallengeMessageType,
    DecryptedChallengeVerificationMessageType
} from "../../../../dist/node/pubsub-messages/types.js";

const PUBSUB_PROVIDER = "http://localhost:15002/api/v0";

type Gate = { waitForRelease: Promise<void>; release: () => void };
const makeGate = (): Gate => {
    let release!: () => void;
    const waitForRelease = new Promise<void>((resolve) => (release = resolve));
    return { waitForRelease, release };
};

// Publication state changes synchronously inside the pubsub handlers; poll instead of listening.
const waitFor = async (predicate: () => boolean): Promise<void> => {
    while (!predicate()) await new Promise((resolve) => setTimeout(resolve, 20));
};

// Long enough for a second answer that did get published to reach the community and be processed.
const SETTLE_MS = 1500;
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

// Skipped under RPC: registers an in-process challenge factory via pkc.settings.challenges, and the
// same-process scenario needs the publisher and the community in one PKC instance (an RPC client
// delegates the whole exchange to the server).
describeSkipIfRpc("a second publishChallengeAnswers call for the same challenge (#349)", () => {
    let pkc: PKCType;
    let publisherPKC: PKCType;
    let community: LocalCommunity;

    // Released by the test to let the community publish its verdict.
    let verifyGate: Gate;

    const gatedVerifyChallenge = (_: { challengeSettings: CommunityChallengeSetting }): ChallengeFileInput => ({
        type: "text/plain",
        description: "Sends its challenge immediately and verifies the answer when the test says so",
        getChallenge: async () => ({
            challenge: "say anything",
            type: "text/plain",
            verify: async () => {
                await verifyGate.waitForRelease;
                return { success: true };
            }
        })
    });

    beforeAll(async () => {
        pkc = await mockPKC();
        pkc.settings.challenges = { "gated-verify": gatedVerifyChallenge };
        community = (await pkc.createCommunity()) as LocalCommunity;
        community.setMaxListeners(100);
        await community.edit({ settings: { challenges: [{ name: "gated-verify" }] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        publisherPKC = await mockGatewayPKC({
            forceMockPubsub: true,
            pkcOptions: { pubsubKuboRpcClientsOptions: [PUBSUB_PROVIDER] }
        });
    });

    beforeEach(() => {
        verifyGate = makeGate();
    });

    afterAll(async () => {
        verifyGate?.release();
        await publisherPKC.destroy();
        await community.delete();
        await pkc.destroy();
    });

    type Observed = {
        post: Comment;
        errors: PKCError[];
        publishingStates: string[];
        challenges: DecryptedChallengeMessageType[];
        verifications: DecryptedChallengeVerificationMessageType[];
        answersSeenByCommunity: DecryptedChallengeAnswerMessageType[];
        detach: () => void;
    };

    const publishAndWaitForChallenge = async (publisher: PKCType): Promise<Observed> => {
        const post: Comment = await generateMockPost({ communityAddress: community.address, pkc: publisher });
        const errors: PKCError[] = [];
        const publishingStates: string[] = [];
        const challenges: DecryptedChallengeMessageType[] = [];
        const verifications: DecryptedChallengeVerificationMessageType[] = [];
        const answersSeenByCommunity: DecryptedChallengeAnswerMessageType[] = [];
        post.on("error", (error) => errors.push(error as PKCError));
        post.on("publishingstatechange", (state) => publishingStates.push(state));
        post.on("challenge", (challenge) => challenges.push(challenge));
        post.on("challengeverification", (verification) => verifications.push(verification));
        const countAnswers = (answer: DecryptedChallengeAnswerMessageType) => {
            if (challenges.some((challenge) => challenge.challengeRequestId.toString() === answer.challengeRequestId.toString()))
                answersSeenByCommunity.push(answer);
        };
        community.on("challengeanswer", countAnswers);

        await post.publish();
        await waitFor(() => challenges.length >= 1);
        expect(post.publishingState).to.equal("waiting-challenge-answers");

        return {
            post,
            errors,
            publishingStates,
            challenges,
            verifications,
            answersSeenByCommunity,
            detach: () => community.removeListener("challengeanswer", countAnswers)
        };
    };

    const expectAlreadyPublishedRejection = (result: PromiseSettledResult<unknown>) => {
        expect(result.status, "the second publishChallengeAnswers call must reject").to.equal("rejected");
        if (result.status !== "rejected") return;
        expect((result.reason as PKCError).code).to.equal("ERR_CHALLENGE_ANSWER_ALREADY_PUBLISHED");
    };

    const expectPublishedOnceAndSucceeded = async (observed: Observed) => {
        await settle();
        expect(observed.answersSeenByCommunity.length, "the community must see exactly one answer").to.equal(1);
        expect(observed.post.publishingState).to.equal("waiting-challenge-verification");
        expect(observed.publishingStates.filter((state) => state === "failed")).to.deep.equal([]);
        expect(observed.errors.map((error) => error.code)).to.deep.equal([]);

        verifyGate.release();
        await waitFor(() => observed.verifications.length >= 1);
        expect(observed.verifications[0].challengeSuccess).to.be.true;
        expect(observed.post.cid).to.be.a("string");
        expect(observed.post.publishingState).to.equal("succeeded");
        expect(observed.post.state).to.equal("stopped");
        expect(observed.publishingStates.filter((state) => state === "failed")).to.deep.equal([]);
        expect(observed.errors).to.deep.equal([]);
        expect(community._dbHandler.queryComment(observed.post.cid!)).to.exist;
    };

    it("rejects the second call and does not fail a publication to a community hosted in the same PKC instance", async () => {
        const observed = await publishAndWaitForChallenge(pkc);
        try {
            await observed.post.publishChallengeAnswers({ challengeAnswers: ["anything"] });
            expect(observed.post.publishingState).to.equal("waiting-challenge-verification");

            const [second] = await Promise.allSettled([observed.post.publishChallengeAnswers({ challengeAnswers: ["anything"] })]);
            expectAlreadyPublishedRejection(second);
            expect(observed.post.publishingState).to.equal("waiting-challenge-verification");

            await expectPublishedOnceAndSucceeded(observed);
        } finally {
            observed.detach();
            verifyGate.release();
            await observed.post.stop();
        }
    });

    it("rejects the second of two calls issued in the same tick over pubsub and publishes one answer", async () => {
        const observed = await publishAndWaitForChallenge(publisherPKC);
        try {
            const results = await Promise.allSettled([
                observed.post.publishChallengeAnswers({ challengeAnswers: ["anything"] }),
                observed.post.publishChallengeAnswers({ challengeAnswers: ["anything"] })
            ]);
            expect(results[0].status, "the first call must publish the answer").to.equal("fulfilled");
            expectAlreadyPublishedRejection(results[1]);

            await expectPublishedOnceAndSucceeded(observed);
        } finally {
            observed.detach();
            verifyGate.release();
            await observed.post.stop();
        }
    });
});

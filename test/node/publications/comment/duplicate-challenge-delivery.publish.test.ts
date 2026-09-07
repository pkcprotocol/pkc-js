// Regression: the same CHALLENGE (and CHALLENGEVERIFICATION) pubsub message delivered twice to a
// publisher is processed twice.
//
// A publisher subscribed to the challenge topic through more than one pubsub provider receives every
// community message once per provider. _handleIncomingChallengePubsubMessage guards against a second
// challenge with "if any exchange already holds a challenge, return", but the exchange's challenge
// is only recorded after the signature verification and the decryption have been awaited. Two copies
// dispatched close together both pass the guard, so the publisher decrypts the challenge twice and
// emits "challenge" twice (a UI would prompt twice and answer twice). When the second copy finishes
// after the user already answered the first one, it also drags the publishing state back from
// "waiting-challenge-verification" to "waiting-challenge-answers"; that ordering depends on how fast
// the answer is signed and published, and is what CI hit on the #340 watchdog test, where the single
// provider listed twice made the mock pubsub client deliver each message twice. The verification
// handler records its guard late in the same way, so a duplicated CHALLENGEVERIFICATION emits
// "challengeverification" twice as well, and because its guard is re-checked only after the comment
// props were updated from the decrypted verification, the second copy also re-verifies the comment
// and emits "update" a second time with nothing changed on the instance (the copy carries the same
// cid, CommentIpfs and CommentUpdate). "update" is emitted only when a prop actually changed
// everywhere else on Comment. The three event-count assertions fail deterministically; the state
// assertion after the answer documents the regression CI saw and holds once the duplicates are
// dropped.
//
// The duplicate is produced deterministically: the test taps the publisher's mock pubsub client with
// a second subscription on the same topic and hands every community message to the publication's
// pubsub handler a second time. The mock client dispatches to its subscriptions in one synchronous
// loop, so the copy always reaches the handler in the same tick as the original, exactly like a
// second provider that delivers the same message. The community's challenge and verification are
// held behind gates so each phase of the exchange can be observed at rest.

import { mockPKC, mockGatewayPKC, generateMockPost, resolveWhenConditionIsTrue } from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { it, beforeAll, afterAll, expect } from "vitest";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { PKCError } from "../../../../dist/node/pkc-error.js";
import type { ChallengeFileInput, CommunityChallengeSetting } from "../../../../dist/node/community/types.js";
import type { IpfsHttpClientPubsubMessage } from "../../../../dist/node/types.js";
import type {
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

// The duplicate copy finishes its verification and decryption within milliseconds of the original.
// Give it ample time so a duplicate that slipped through is observed rather than missed.
const SETTLE_MS = 1500;
const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

// The pubsub handler is private on Publication; reach it the same way pubsub.test.ts reaches the
// private thresholds.
type PublicationWithPubsubHandler = { _handleChallengeExchange: (msg: IpfsHttpClientPubsubMessage) => Promise<void> };

// Skipped under RPC: registers an in-process challenge factory via pkc.settings.challenges and taps
// a non-RPC publisher's pubsub client (an RPC client delegates the whole exchange to the server).
describeSkipIfRpc("a CHALLENGE delivered twice to the publisher", () => {
    let pkc: PKCType;
    let publisherPKC: PKCType;
    let community: LocalCommunity;

    const challengeGate = makeGate();
    const verifyGate = makeGate();

    const gatedChallenge = (_: { challengeSettings: CommunityChallengeSetting }): ChallengeFileInput => ({
        type: "text/plain",
        description: "Sends its challenge and verifies the answer when the test says so",
        getChallenge: async () => {
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
        pkc.settings.challenges = { gated: gatedChallenge };
        community = (await pkc.createCommunity()) as LocalCommunity;
        await community.edit({ settings: { challenges: [{ name: "gated" }] } });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        publisherPKC = await mockGatewayPKC({
            forceMockPubsub: true,
            pkcOptions: { pubsubKuboRpcClientsOptions: [PUBSUB_PROVIDER] }
        });
    });

    afterAll(async () => {
        challengeGate.release();
        verifyGate.release();
        await publisherPKC.destroy();
        await community.delete();
        await pkc.destroy();
    });

    it("emits one challenge and one verification and never leaves waiting-challenge-verification", async () => {
        const post: Comment = await generateMockPost({ communityAddress: community.address, pkc: publisherPKC });

        const errors: PKCError[] = [];
        const publishingStates: string[] = [];
        const challenges: DecryptedChallengeMessageType[] = [];
        const verifications: DecryptedChallengeVerificationMessageType[] = [];
        post.on("error", (error) => errors.push(error as PKCError));
        post.on("publishingstatechange", (state) => publishingStates.push(state));
        post.on("challenge", (challenge) => challenges.push(challenge));
        post.on("challengeverification", (verification) => verifications.push(verification));
        let updates = 0;
        post.on("update", () => updates++);

        const pubsubClient = publisherPKC.clients.pubsubKuboRpcClients[PUBSUB_PROVIDER]._client;
        const redeliverToPublication = (msg: IpfsHttpClientPubsubMessage) => {
            // Same tick as the mock client's own dispatch to the publication, like a second provider.
            void (post as unknown as PublicationWithPubsubHandler)._handleChallengeExchange(msg);
        };

        try {
            // publish() resolves once the request is out and the publication is subscribed. The
            // community holds its challenge until the gate opens, so the tap is in place before any
            // community message reaches the publisher.
            await post.publish();
            expect(post.publishingState).to.equal("waiting-challenge");
            await pubsubClient.pubsub.subscribe(community.pubsubTopic, redeliverToPublication);

            challengeGate.release();
            await waitFor(() => challenges.length >= 1);
            await settle();

            expect(errors.map((error) => error.code)).to.deep.equal([]);
            expect(challenges.length, "one CHALLENGE message must produce one challenge event").to.equal(1);
            expect(post.publishingState).to.equal("waiting-challenge-answers");

            await post.publishChallengeAnswers({ challengeAnswers: ["anything"] });
            await waitFor(() => post.publishingState === "waiting-challenge-verification");
            await settle();
            expect(
                post.publishingState,
                "a late duplicate of the CHALLENGE must not move an answered exchange back to waiting-challenge-answers"
            ).to.equal("waiting-challenge-verification");
            expect(challenges.length).to.equal(1);

            verifyGate.release();
            await waitFor(() => verifications.length >= 1);
            await settle();

            expect(errors.map((error) => error.code)).to.deep.equal([]);
            expect(verifications.length, "one CHALLENGEVERIFICATION message must produce one challengeverification event").to.equal(1);
            expect(verifications[0].challengeSuccess).to.be.true;
            expect(post.cid).to.be.a("string");
            expect(
                updates,
                "the first copy sets cid and the comment props, the second copy changes nothing, so update is emitted once"
            ).to.equal(1);
            expect(post.publishingState).to.equal("succeeded");
            expect(post.state).to.equal("stopped");
            expect(publishingStates.filter((state) => state === "succeeded").length).to.equal(1);
            expect(community._dbHandler.queryComment(post.cid!)).to.exist;
        } finally {
            await pubsubClient.pubsub.unsubscribe(community.pubsubTopic, redeliverToPublication);
            challengeGate.release();
            verifyGate.release();
            await post.stop();
        }
    });
});

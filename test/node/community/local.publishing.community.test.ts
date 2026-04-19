import { beforeAll, afterAll } from "vitest";
import {
    mockPKC,
    generatePostToAnswerMathQuestion,
    resolveWhenConditionIsTrue,
    createSubWithNoChallenge,
    publishRandomPost
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { SignerType } from "../../../dist/node/signer/types.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { PubsubClient } from "../../../dist/node/types.js";

// Derive pubsub message type from function signature
type PubsubSubscribeHandler = Extract<Parameters<PubsubClient["_client"]["pubsub"]["subscribe"]>[1], Function>;
type PubsubMessage = Parameters<PubsubSubscribeHandler>[0];

interface ReceivedPubsubMessage {
    topic: string;
    data: Uint8Array;
    timestamp: number;
}

describeSkipIfRpc("Local publishing to community", async () => {
    let pkc: PKCType;
    let community: LocalCommunity | RpcLocalCommunity;
    let commentSigner: SignerType;
    const receivedPubsubMessages: ReceivedPubsubMessage[] = [];
    let pubsubTopic: string;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        const challenges = [{ name: "question", options: { question: "1+1=?", answer: "2" } }];
        await community.edit({ settings: { challenges } });

        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
        commentSigner = await pkc.createSigner();

        // Get the pubsub topic for this community (pubsubTopic || address)
        pubsubTopic = community.pubsubTopic || community.address;

        // Subscribe to the pubsub topic to capture any messages that might be published
        const pubsubClient = pkc._clientsManager.getDefaultKuboPubsubClient();
        await pubsubClient._client.pubsub.subscribe(pubsubTopic, (msg: PubsubMessage) => {
            receivedPubsubMessages.push({
                topic: pubsubTopic,
                data: msg.data,
                timestamp: Date.now()
            });
        });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("should publish comment locally without going through pubsub exchange", async () => {
        // Create a comment that will answer the math question correctly
        const comment: Comment = await generatePostToAnswerMathQuestion(
            { communityAddress: community.address, signer: commentSigner },
            pkc
        );

        const challengeRequestPromise = new Promise((resolve) => comment.once("challengerequest", resolve));
        const challengePromise = new Promise((resolve) => comment.once("challenge", resolve));
        const challengeAnswerPromise = new Promise((resolve) => comment.once("challengeanswer", resolve));

        // Listen for challenge verification to ensure the challenge succeeded
        const challengeVerificationPromise = new Promise((resolve) => comment.once("challengeverification", resolve));

        // Publish the comment
        await comment.publish();

        const challengeRequest = await challengeRequestPromise;
        const challenge = await challengePromise;
        const challengeAnswer = await challengeAnswerPromise;

        // Wait for challenge verification to complete
        const challengeVerification = await challengeVerificationPromise;

        expect((challengeRequest as { challengeRequestId: Uint8Array }).challengeRequestId.toString()).to.equal(
            (challenge as { challengeRequestId: Uint8Array }).challengeRequestId.toString()
        );
        expect((challengeAnswer as { challengeAnswers: string[] }).challengeAnswers).to.deep.equal(["2"]);
        expect((challenge as { challenges: { challenge: string }[] }).challenges[0].challenge).to.equal("1+1=?");

        // Verify the challenge succeeded
        expect((challengeVerification as { challengeSuccess: boolean }).challengeSuccess).to.be.true;

        // Verify that the community is indeed local (running on the same pkc instance)
        expect(pkc._startedCommunities[community.address]).to.equal(community);

        // Verify that the publication was handled locally by checking the _publishingToLocalCommunity flag
        // This flag should be set during local publishing to prevent pubsub updates
        expect(comment._publishingToLocalCommunity).to.equal(community);

        // Verify that no pubsub messages were received during local publishing
        // If we receive any messages, it means pubsub was used when it shouldn't be for local publishing
        expect(receivedPubsubMessages.length).to.equal(0);
    });

    it("Should be able to publish comment without needing to await for updatedAt to be defined", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity | RpcLocalCommunity;
        await community.start();
        expect(community.updatedAt).to.be.undefined;

        await publishRandomPost({ communityAddress: community.address, pkc: pkc });
        await community.delete();
    });
});

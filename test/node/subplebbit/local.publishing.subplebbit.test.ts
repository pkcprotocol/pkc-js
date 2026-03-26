import { beforeAll, afterAll } from "vitest";
import {
    mockPlebbit,
    generatePostToAnswerMathQuestion,
    resolveWhenConditionIsTrue,
    describeSkipIfRpc,
    createSubWithNoChallenge,
    publishRandomPost
} from "../../../dist/node/test/test-util.js";

import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/subplebbit/rpc-local-subplebbit.js";
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

describeSkipIfRpc("Local publishing to subplebbit", async () => {
    let plebbit: PlebbitType;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let commentSigner: SignerType;
    const receivedPubsubMessages: ReceivedPubsubMessage[] = [];
    let pubsubTopic: string;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        subplebbit = (await plebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        const challenges = [{ name: "question", options: { question: "1+1=?", answer: "2" } }];
        await subplebbit.edit({ settings: { challenges } });

        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
        commentSigner = await plebbit.createSigner();

        // Get the pubsub topic for this subplebbit (pubsubTopic || address)
        pubsubTopic = subplebbit.pubsubTopic || subplebbit.address;

        // Subscribe to the pubsub topic to capture any messages that might be published
        const pubsubClient = plebbit._clientsManager.getDefaultKuboPubsubClient();
        await pubsubClient._client.pubsub.subscribe(pubsubTopic, (msg: PubsubMessage) => {
            receivedPubsubMessages.push({
                topic: pubsubTopic,
                data: msg.data,
                timestamp: Date.now()
            });
        });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
    });

    it("should publish comment locally without going through pubsub exchange", async () => {
        // Create a comment that will answer the math question correctly
        const comment: Comment = await generatePostToAnswerMathQuestion(
            { communityAddress: subplebbit.address, signer: commentSigner },
            plebbit
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

        // Verify that the subplebbit is indeed local (running on the same plebbit instance)
        expect(plebbit._startedSubplebbits[subplebbit.address]).to.equal(subplebbit);

        // Verify that the publication was handled locally by checking the _publishingToLocalSubplebbit flag
        // This flag should be set during local publishing to prevent pubsub updates
        expect(comment._publishingToLocalSubplebbit).to.equal(subplebbit);

        // Verify that no pubsub messages were received during local publishing
        // If we receive any messages, it means pubsub was used when it shouldn't be for local publishing
        expect(receivedPubsubMessages.length).to.equal(0);
    });

    it("Should be able to publish comment without needing to await for updatedAt to be defined", async () => {
        const subplebbit = (await createSubWithNoChallenge({}, plebbit)) as LocalSubplebbit | RpcLocalSubplebbit;
        await subplebbit.start();
        expect(subplebbit.updatedAt).to.be.undefined;

        await publishRandomPost({ communityAddress: subplebbit.address, plebbit: plebbit });
        await subplebbit.delete();
    });
});

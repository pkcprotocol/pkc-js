import {
    generateMockPost,
    getAvailablePKCConfigsToTestAgainst,
    publishWithExpectedResult,
    ensurePublicationIsSigned
} from "../../../../../dist/node/test/test-util.js";
import signers from "../../../../fixtures/signers.js";
import { describe, beforeAll, afterAll, it } from "vitest";
import type { PKC } from "../../../../../dist/node/pkc/pkc.js";

// Type matching ensurePublicationIsSigned's community parameter
type CommunityForSigning = {
    address: string;
    signer?: { address: string };
    encryption: { type: string; publicKey: string };
    pubsubTopic?: string;
    name?: string;
};

// Type for challengerequest event data
type ChallengeRequestEvent = {
    challengeAnswers?: string[];
    challengeCommentCids?: string[];
};
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`Pubsub request fields in pkc.createComment - ${config.name}`, async () => {
        let pkc: PKC;
        let community: CommunityForSigning;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            const loadedCommunity = await pkc.getCommunity({ address: signers[0].address });
            community = loadedCommunity as CommunityForSigning;
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`pkc.createComment({challengeRequest: challengeAnswers}) includes challengeAnswers in request pubsub message`, async () => {
            const challengeRequestFields = { challengeAnswers: ["12345"] };
            const comment = await generateMockPost({
                communityAddress: signers[0].address,
                pkc: pkc,
                postProps: { challengeRequest: challengeRequestFields }
            });
            expect(comment.challengeRequest).to.deep.equal(challengeRequestFields);

            if (!comment.raw.pubsubMessageToPublish) await ensurePublicationIsSigned(comment, community);
            expect(comment.toJSONPubsubRequestToEncrypt().challengeAnswers).to.deep.equal(challengeRequestFields.challengeAnswers);
            const challengeRequestPromise = new Promise<ChallengeRequestEvent>((resolve) =>
                comment.once("challengerequest", resolve as (request: unknown) => void)
            );
            await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });
            const challengeRequestFromEvent = await challengeRequestPromise;
            for (const challengerequest of [challengeRequestFromEvent])
                expect(challengerequest.challengeAnswers).to.deep.equal(challengeRequestFields.challengeAnswers);
        });
        it(`pkc.createComment({challengeRequest: challengeCommentCids}) includes challengeCommentCids in request pubsub message`, async () => {
            const challengeRequestFields = { challengeCommentCids: ["QmXsYKgNH7XoZXdLko5uDvtWSRNE2AXuQ4u8KxVpCacrZx"] }; // random cid
            const comment = await generateMockPost({
                communityAddress: signers[0].address,
                pkc: pkc,
                postProps: { challengeRequest: challengeRequestFields }
            });

            if (!comment.raw.pubsubMessageToPublish) await ensurePublicationIsSigned(comment, community);
            expect(comment.toJSONPubsubRequestToEncrypt().challengeCommentCids).to.deep.equal(challengeRequestFields.challengeCommentCids);
            const challengeRequestPromise = new Promise<ChallengeRequestEvent>((resolve) =>
                comment.once("challengerequest", resolve as (request: unknown) => void)
            );
            await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });
            const challengeRequestFromEvent = await challengeRequestPromise;
            for (const challengerequest of [challengeRequestFromEvent])
                expect(challengerequest.challengeCommentCids).to.deep.equal(challengeRequestFields.challengeCommentCids);
        });

        it(`Pubsub fields are copied properly with JSON.parse(JSON.stringify(comment)))`, async () => {
            const challengeRequestFields = {
                challengeCommentCids: ["QmXsYKgNH7XoZXdLko5uDvtWSRNE2AXuQ4u8KxVpCacrZx"],
                challengeAnswers: ["12345"]
            }; // random cid
            const comment = await generateMockPost({
                communityAddress: signers[0].address,
                pkc: pkc,
                postProps: { challengeRequest: challengeRequestFields }
            });
            const recreatedComment = await pkc.createComment(JSON.parse(JSON.stringify(comment)));
            expect(recreatedComment.challengeRequest).to.deep.equal(comment.challengeRequest);

            if (!recreatedComment.raw.pubsubMessageToPublish) await ensurePublicationIsSigned(recreatedComment, community);
            expect(recreatedComment.toJSONPubsubRequestToEncrypt().challengeCommentCids).to.deep.equal(
                challengeRequestFields.challengeCommentCids
            );
            expect(recreatedComment.toJSONPubsubRequestToEncrypt().challengeAnswers).to.deep.equal(challengeRequestFields.challengeAnswers);
            const challengeRequestPromise = new Promise<ChallengeRequestEvent>((resolve) =>
                recreatedComment.once("challengerequest", resolve as (request: unknown) => void)
            );

            await publishWithExpectedResult({ publication: recreatedComment, expectedChallengeSuccess: true });
            const challengeRequestFromEvent = await challengeRequestPromise;
            for (const challengerequest of [challengeRequestFromEvent]) {
                expect(challengerequest.challengeCommentCids).to.deep.equal(challengeRequestFields.challengeCommentCids);
                expect(challengerequest.challengeAnswers).to.deep.equal(challengeRequestFields.challengeAnswers);
            }
        });
    });
});

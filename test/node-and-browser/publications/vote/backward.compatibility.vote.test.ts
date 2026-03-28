import {
    generateMockVote,
    getAvailablePlebbitConfigsToTestAgainst,
    publishRandomPost,
    publishWithExpectedResult,
    setExtraPropOnVoteAndSign
} from "../../../../dist/node/test/test-util.js";

import { messages } from "../../../../dist/node/errors.js";
import signers from "../../../fixtures/signers.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";
import type { DecryptedChallengeRequestMessageType } from "../../../../dist/node/pubsub-messages/types.js";

// Type for challenge request event with vote
type ChallengeRequestWithVote = DecryptedChallengeRequestMessageType & NonNullable<Pick<DecryptedChallengeRequestMessageType, "vote">>;

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.concurrent(`Backward compatibility for Vote - ${config.name}`, async () => {
        // A subplebbit should accept a vote with unknown props
        // However, it should not process the unknown props, it should strip them out after validation

        let plebbit: Plebbit;
        let commentToVoteOn: Comment;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            commentToVoteOn = await publishRandomPost({ communityAddress: signers[0].address, plebbit: plebbit });
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`Publishing vote.extraProp should fail if it's not included in vote.signature.signedPropertyNames`, async () => {
            // We skip with RPC because rpc server will check if signature is valid before publishing
            // If signature is invalid, like in this test, it will throw before publishing
            const vote = await generateMockVote(commentToVoteOn as unknown as CommentIpfsWithCidDefined, 1, plebbit);
            await setExtraPropOnVoteAndSign(vote, { extraProp: "1234" }, false); // will include extra prop in request.vote, but not in signedPropertyNames

            await plebbit.createVote(JSON.parse(JSON.stringify(vote))); // attempt to create just to see if createVote will throw due to extra prop
            const challengeRequestPromise = new Promise<ChallengeRequestWithVote>((resolve) =>
                vote.once("challengerequest", resolve as (req: unknown) => void)
            );

            await publishWithExpectedResult({
                publication: vote,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_VOTE_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
            });
            const challengeRequest = await challengeRequestPromise;
            expect(challengeRequest.vote.extraProp).to.equal("1234");
        });

        it(`publishing vote.extraProp should succeed if it's included in vote.signature.signedPropertyNames`, async () => {
            const vote = await generateMockVote(commentToVoteOn as unknown as CommentIpfsWithCidDefined, 1, plebbit);
            await setExtraPropOnVoteAndSign(vote, { extraProp: "1234" }, true); // will include extra prop in request.vote, and signedPropertyNames

            const challengeRequestPromise = new Promise<ChallengeRequestWithVote>((resolve) =>
                vote.once("challengerequest", resolve as (req: unknown) => void)
            );

            await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true });
            const challengeRequest = await challengeRequestPromise;
            expect(challengeRequest.vote.extraProp).to.equal("1234");
        });

        it(`Publishing vote.reservedField should be rejected`, async () => {
            const vote = await generateMockVote(commentToVoteOn as unknown as CommentIpfsWithCidDefined, 1, plebbit);
            await setExtraPropOnVoteAndSign(vote, { insertedAt: "1234" }, true);

            const challengeRequestPromise = new Promise<ChallengeRequestWithVote>((resolve) =>
                vote.once("challengerequest", resolve as (req: unknown) => void)
            );

            await publishWithExpectedResult({
                publication: vote,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_VOTE_HAS_RESERVED_FIELD
            });
            const challengeRequest = await challengeRequestPromise;
            expect(challengeRequest.vote.insertedAt).to.equal("1234");
        });

        describe.concurrent(`Publishing vote with extra props in author field - ${config.name}`, async () => {
            it(`Publishing with extra prop for author should fail if it's a reserved field`, async () => {
                const vote = await generateMockVote(commentToVoteOn as unknown as CommentIpfsWithCidDefined, 1, plebbit);
                await setExtraPropOnVoteAndSign(
                    vote,
                    {
                        author: {
                            ...(vote.raw.pubsubMessageToPublish?.author ?? (vote.raw as any).unsignedPublicationOptions?.author),
                            subplebbit: "random"
                        }
                    },
                    true
                );

                const challengeRequestPromise = new Promise<ChallengeRequestWithVote>((resolve) =>
                    vote.once("challengerequest", resolve as (req: unknown) => void)
                );

                await publishWithExpectedResult({
                    publication: vote,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_PUBLICATION_AUTHOR_HAS_RESERVED_FIELD
                });
                const challengeRequest = await challengeRequestPromise;
                expect(challengeRequest.vote.author.subplebbit).to.equal("random");
            });
            it(`Publishing with extra prop for author should succeed`, async () => {
                const vote = await generateMockVote(commentToVoteOn as unknown as CommentIpfsWithCidDefined, 1, plebbit);
                const extraProps = { extraProp: "1234" };
                await setExtraPropOnVoteAndSign(
                    vote,
                    {
                        author: {
                            ...(vote.raw.pubsubMessageToPublish?.author ?? (vote.raw as any).unsignedPublicationOptions?.author),
                            ...extraProps
                        }
                    },
                    true
                );

                await plebbit.createVote(JSON.parse(JSON.stringify(vote))); // attempt to create just to see if createVote will throw due to extra prop
                const challengeRequestPromise = new Promise<ChallengeRequestWithVote>((resolve) =>
                    vote.once("challengerequest", resolve as (req: unknown) => void)
                );

                await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true });
                const challengeRequest = await challengeRequestPromise;
                expect(challengeRequest.vote.author.extraProp).to.equal(extraProps.extraProp);
            });
        });
    });
});

import signers from "../../../fixtures/signers.js";
import {
    generateMockVote,
    publishRandomPost,
    publishRandomReply,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    getAvailablePlebbitConfigsToTestAgainst
} from "../../../../dist/node/test/test-util.js";
import * as remeda from "remeda";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";
import type { SignerWithPublicKeyAddress } from "../../../../dist/node/signer/index.js";
import type Vote from "../../../../dist/node/publications/vote/vote.js";
import type { DecryptedChallengeRequestMessageType } from "../../../../dist/node/pubsub-messages/types.js";

// Type for challenge request event with vote
type ChallengeRequestWithVote = DecryptedChallengeRequestMessageType & NonNullable<Pick<DecryptedChallengeRequestMessageType, "vote">>;

const subplebbitAddress = signers[0].address;

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    const previousVotes: Vote[] = [];

    describe.concurrent(`Test upvote - ${config.name}`, async () => {
        let plebbit: Plebbit, postToVote: Comment, replyToVote: Comment, signer: SignerWithPublicKeyAddress;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise({ plebbitOptions: { validatePages: false } });
            signer = await plebbit.createSigner();
            postToVote = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit, postProps: { signer } });
            replyToVote = await publishRandomReply({
                parentComment: postToVote as CommentIpfsWithCidDefined,
                plebbit: plebbit,
                commentProps: { signer }
            });
            await postToVote.update();
            await replyToVote.update();
            await resolveWhenConditionIsTrue({ toUpdate: postToVote, predicate: async () => typeof postToVote.updatedAt === "number" });
            await resolveWhenConditionIsTrue({ toUpdate: replyToVote, predicate: async () => typeof replyToVote.updatedAt === "number" });
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`(vote: Vote) === plebbit.createVote(JSON.parse(JSON.stringify(vote)))`, async () => {
            const vote = await generateMockVote(
                postToVote as unknown as CommentIpfsWithCidDefined,
                1,
                plebbit,
                remeda.sample(signers, 1)[0]
            );
            const voteFromStringifiedVote = await plebbit.createVote(JSON.parse(JSON.stringify(vote)));
            const jsonPropsToOmit = ["clients"];

            const voteJson = remeda.omit(JSON.parse(JSON.stringify(vote)), jsonPropsToOmit) as Record<string, unknown>;
            const stringifiedVoteJson = remeda.omit(JSON.parse(JSON.stringify(voteFromStringifiedVote)), jsonPropsToOmit) as Record<
                string,
                unknown
            >;
            expect(voteJson.signer).to.be.a("object").and.to.deep.equal(stringifiedVoteJson.signer); // make sure internal props like signer are copied properly
            expect(voteJson).to.deep.equal(stringifiedVoteJson);
        });

        it.sequential("Can upvote a post", async () => {
            const originalUpvote = remeda.clone(postToVote.upvoteCount);
            const vote = await generateMockVote(postToVote as unknown as CommentIpfsWithCidDefined, 1, plebbit);
            await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true });
            await resolveWhenConditionIsTrue({
                toUpdate: postToVote,
                predicate: async () => postToVote.upvoteCount === originalUpvote + 1
            });
            expect(postToVote.upvoteCount).to.be.equal(originalUpvote + 1);
            expect(postToVote.downvoteCount).to.be.equal(0);
            expect(postToVote.author.subplebbit.replyScore).to.equal(0);
            expect(postToVote.author.subplebbit.postScore).to.equal(1);
            expect(postToVote.author.subplebbit.lastCommentCid).to.equal(replyToVote.cid);
            previousVotes.push(vote);
        });

        it(`Can upvote a reply`, async () => {
            const originalUpvote = remeda.clone(replyToVote.upvoteCount);
            const vote = await generateMockVote(replyToVote as unknown as CommentIpfsWithCidDefined, 1, plebbit);
            await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true });
            await resolveWhenConditionIsTrue({
                toUpdate: replyToVote,
                predicate: async () => replyToVote.upvoteCount === originalUpvote + 1
            });
            expect(replyToVote.upvoteCount).to.equal(originalUpvote + 1);
            expect(replyToVote.downvoteCount).to.equal(0);
            expect(replyToVote.author.subplebbit.replyScore).to.equal(1);
            expect(replyToVote.author.subplebbit.postScore).to.equal(1);
            expect(replyToVote.author.subplebbit.lastCommentCid).to.equal(replyToVote.cid);

            previousVotes.push(vote);
        });

        it.sequential("Can change post upvote to downvote", async () => {
            const originalUpvote = remeda.clone(postToVote.upvoteCount);
            const originalDownvote = remeda.clone(postToVote.downvoteCount);
            const vote = await plebbit.createVote({
                commentCid: previousVotes[0].commentCid,
                signer: previousVotes[0].signer,
                communityAddress: previousVotes[0].communityAddress,
                vote: -1
            });
            await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true });
            await resolveWhenConditionIsTrue({
                toUpdate: postToVote,
                predicate: async () => postToVote.upvoteCount === originalUpvote - 1
            });

            expect(postToVote.upvoteCount).to.equal(originalUpvote - 1);
            expect(postToVote.downvoteCount).to.equal(originalDownvote + 1);
            expect(postToVote.author.subplebbit.postScore).to.equal(-1);
            expect(postToVote.author.subplebbit.replyScore).to.equal(1);
            expect(postToVote.author.subplebbit.lastCommentCid).to.equal(replyToVote.cid);
        });

        it.sequential("Can change reply upvote to downvote", async () => {
            const originalUpvote = remeda.clone(replyToVote.upvoteCount);
            const originalDownvote = remeda.clone(replyToVote.downvoteCount);
            const vote = await plebbit.createVote({
                commentCid: previousVotes[1].commentCid,
                signer: previousVotes[1].signer,
                communityAddress: previousVotes[1].communityAddress,
                vote: -1
            });
            await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true });
            await resolveWhenConditionIsTrue({
                toUpdate: replyToVote,
                predicate: async () => replyToVote.upvoteCount === originalUpvote - 1
            });

            expect(replyToVote.upvoteCount).to.equal(originalUpvote - 1);
            expect(replyToVote.downvoteCount).to.equal(originalDownvote + 1);
            expect(replyToVote.author.subplebbit.postScore).to.equal(-1);
            expect(replyToVote.author.subplebbit.replyScore).to.equal(-1);
            expect(replyToVote.author.subplebbit.lastCommentCid).to.equal(replyToVote.cid);
        });

        it.sequential("Does not throw an error when vote is duplicated", async () => {
            const vote = await plebbit.createVote({
                commentCid: previousVotes[0].commentCid,
                signer: previousVotes[0].signer,
                communityAddress: previousVotes[0].communityAddress,
                vote: previousVotes[0].vote
            });
            await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true });
        });

        it(`Can publish a vote that was created from jsonfied vote instance`, async () => {
            const vote = await generateMockVote(
                postToVote as unknown as CommentIpfsWithCidDefined,
                1,
                plebbit,
                remeda.sample(signers, 1)[0]
            );
            const voteFromStringifiedVote = await plebbit.createVote(JSON.parse(JSON.stringify(vote)));
            const challengeRequestPromise = new Promise<ChallengeRequestWithVote>((resolve) =>
                voteFromStringifiedVote.once("challengerequest", resolve)
            );

            await publishWithExpectedResult({ publication: voteFromStringifiedVote, expectedChallengeSuccess: true });
            const challengerequest = await challengeRequestPromise;
            expect(challengerequest.vote).to.deep.equal(voteFromStringifiedVote.raw.pubsubMessageToPublish!);

            expect(voteFromStringifiedVote.raw.pubsubMessageToPublish).to.exist;
        });

        it(`A vote=0 is rejected if the author never published a vote on the comment before`, async () => {
            const vote = await generateMockVote(postToVote as CommentIpfsWithCidDefined, 0, plebbit); // will generate random signer

            await publishWithExpectedResult({
                publication: vote,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_THERE_IS_NO_PREVIOUS_VOTE_TO_CANCEL
            });
        });
    });
});

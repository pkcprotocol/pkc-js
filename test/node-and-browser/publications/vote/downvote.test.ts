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
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";
import type { SignerWithPublicKeyAddress } from "../../../../dist/node/signer/index.js";
import type Vote from "../../../../dist/node/publications/vote/vote.js";

const subplebbitAddress = signers[0].address;

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.concurrent(`Test Downvote - ${config.name}`, async () => {
        const previousVotes: Vote[] = [];

        let plebbit: Plebbit, postToVote: Comment, replyToVote: Comment, signer: SignerWithPublicKeyAddress;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            signer = await plebbit.createSigner();
            postToVote = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit, postProps: { signer } });
            replyToVote = await publishRandomReply({
                parentComment: postToVote as unknown as CommentIpfsWithCidDefined,
                plebbit: plebbit,
                commentProps: { signer }
            });
            await Promise.all([postToVote.update(), replyToVote.update()]);
            await resolveWhenConditionIsTrue({ toUpdate: postToVote, predicate: async () => typeof postToVote.updatedAt === "number" });
            await resolveWhenConditionIsTrue({ toUpdate: replyToVote, predicate: async () => typeof replyToVote.updatedAt === "number" });
        });
        afterAll(async () => {
            await plebbit.destroy();
        });

        it.sequential("Can downvote a post", async () => {
            const originalDownvote = remeda.clone(postToVote.downvoteCount);
            const vote = await generateMockVote(postToVote as unknown as CommentIpfsWithCidDefined, -1, plebbit);
            await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: postToVote,
                predicate: async () => postToVote.downvoteCount === originalDownvote + 1
            });

            expect(postToVote.downvoteCount).to.equal(originalDownvote + 1);
            expect(postToVote.upvoteCount).to.equal(0);
            expect(postToVote.author.subplebbit.replyScore).to.equal(0);
            expect(postToVote.author.subplebbit.postScore).to.equal(-1);
            expect(postToVote.author.subplebbit.lastCommentCid).to.equal(replyToVote.cid);
            previousVotes.push(vote);
        });

        it.sequential(`Can downvote a reply`, async () => {
            const originalDownvote = remeda.clone(replyToVote.downvoteCount);
            const vote = await generateMockVote(replyToVote as unknown as CommentIpfsWithCidDefined, -1, plebbit);
            await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: replyToVote,
                predicate: async () => replyToVote.downvoteCount === originalDownvote + 1
            });

            expect(replyToVote.downvoteCount).to.equal(originalDownvote + 1);
            expect(replyToVote.upvoteCount).to.equal(0);
            expect(replyToVote.author.subplebbit.replyScore).to.equal(-1);
            expect(replyToVote.author.subplebbit.postScore).to.equal(-1);
            expect(replyToVote.author.subplebbit.lastCommentCid).to.equal(replyToVote.cid);

            previousVotes.push(vote);
        });

        it.sequential("Can change post downvote to upvote", async () => {
            const originalUpvote = remeda.clone(postToVote.upvoteCount);
            const originalDownvote = remeda.clone(postToVote.downvoteCount);
            const vote = await plebbit.createVote({
                commentCid: previousVotes[0].commentCid,
                communityAddress: previousVotes[0].communityAddress,
                signer: previousVotes[0].signer,
                vote: 1
            });
            await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: postToVote,
                predicate: async () => postToVote.upvoteCount === originalUpvote + 1
            });

            expect(postToVote.upvoteCount).to.equal(originalUpvote + 1);
            expect(postToVote.downvoteCount).to.equal(originalDownvote - 1);
            expect(postToVote.author.subplebbit.postScore).to.equal(1);
            expect(postToVote.author.subplebbit.replyScore).to.equal(-1);
            expect(postToVote.author.subplebbit.lastCommentCid).to.equal(replyToVote.cid);
        });

        it.sequential("Can change reply downvote to upvote", async () => {
            const originalUpvote = remeda.clone(replyToVote.upvoteCount);
            const originalDownvote = remeda.clone(replyToVote.downvoteCount);
            const vote = await plebbit.createVote({
                commentCid: previousVotes[1].commentCid,
                communityAddress: previousVotes[1].communityAddress,
                signer: previousVotes[1].signer,
                vote: 1
            });
            await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: replyToVote,
                predicate: async () => replyToVote.upvoteCount === originalUpvote + 1
            });

            expect(replyToVote.upvoteCount).to.equal(originalUpvote + 1);
            expect(replyToVote.downvoteCount).to.equal(originalDownvote - 1);
            expect(replyToVote.author.subplebbit.postScore).to.equal(1);
            expect(replyToVote.author.subplebbit.replyScore).to.equal(1);
            expect(replyToVote.author.subplebbit.lastCommentCid).to.equal(replyToVote.cid);
        });

        it("plebbit.createVote fails when commentCid is invalid ", async () => {
            try {
                await plebbit.createVote({
                    vote: previousVotes[1].vote,
                    communityAddress: previousVotes[1].communityAddress,
                    signer: previousVotes[1].signer,
                    commentCid: "gibbrish"
                });
                expect.fail("should fail");
            } catch (e: unknown) {
                expect((e as { code: string }).code).to.equal("ERR_INVALID_CREATE_VOTE_ARGS_SCHEMA");
                expect(
                    (e as { details: { zodError: { issues: Array<{ message: string }> } } }).details.zodError.issues[0].message
                ).to.equal("CID is invalid");
            }
        });

        it(`Subplebbits rejects votes with invalid commentCid`);

        // TODO add a test for spreading Vote instance
    });
});

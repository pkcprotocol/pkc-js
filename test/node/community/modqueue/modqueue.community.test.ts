import { beforeAll, afterAll } from "vitest";
import {
    mockPKC,
    publishWithExpectedResult,
    generateMockVote,
    publishRandomPost,
    publishToModQueueWithDepth,
    resolveWhenConditionIsTrue,
    createSubWithNoChallenge
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { SignerType } from "../../../../dist/node/signer/types.js";
import type { DecryptedChallengeVerificationMessageType } from "../../../../dist/node/pubsub-messages/types.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

// TODO test skeletons
// comment.approved = true is treated like a regular comment

describe(`Pending approval modqueue functionality`, async () => {
    let plebbit: PKCType;
    let subplebbit: LocalCommunity | RpcLocalCommunity;
    let modSigner: SignerType;
    let regularPublishedComment: Comment;

    beforeAll(async () => {
        plebbit = await mockPKC();
        subplebbit = await createSubWithNoChallenge({}, plebbit);
        await subplebbit.start();

        regularPublishedComment = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: plebbit });

        modSigner = await plebbit.createSigner();
        await subplebbit.edit({
            roles: {
                [modSigner.address]: { role: "moderator" }
            },
            settings: {
                challenges: [
                    {
                        name: "question",
                        options: { question: "1+1=?", answer: "2" },
                        pendingApproval: true,
                        exclude: [{ role: ["moderator"] }]
                    }
                ]
            }
        });

        expect(Object.keys(subplebbit.modQueue.pageCids)).to.deep.equal([]); // should be empty

        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => Boolean(subplebbit.updatedAt) });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
    });

    describe("Challenge with pendingApproval", () => {
        it("Should support pendingApproval field in challenge settings", async () => {
            const newUpdatePromise = new Promise((resolve) => subplebbit.once("update", resolve));
            await subplebbit.edit({ settings: { challenges: [{ ...subplebbit.settings!.challenges![0], pendingApproval: true }] } });
            expect(subplebbit.settings!.challenges![0].pendingApproval).to.be.true;
            await newUpdatePromise;
        });

        it("Should reflect settings in subplebbit.challenges[x].pendingApproval", async () => {
            expect(subplebbit.challenges![0].pendingApproval).to.be.true;
        });
    });

    describe("Comment moderation approval of pending comment", () => {
        // TODO: Test that pending approval can exclude certain types
        // TODO need to test for publications that should not support pending approval
        // like vote, subplebbitEdit, commentModeration, commentEdit

        it("Should exclude vote type from pending approval", async () => {
            // it should fail because vote is not applicable for pendingApproval AND it published the wrong answers
            const vote = await generateMockVote(regularPublishedComment as CommentIpfsWithCidDefined, 1, plebbit);

            vote.once("challenge", async () => await vote.publishChallengeAnswers(["1234 " + Math.random()])); // wrong answers

            const challengeVerificationPromise = new Promise<DecryptedChallengeVerificationMessageType>((resolve) =>
                vote.once("challengeverification", resolve)
            );

            await publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: false });

            const challengeVerification = await challengeVerificationPromise;
            expect(challengeVerification.challengeSuccess).to.equal(false);
            expect(challengeVerification.challengeErrors!["0"]).to.equal("Wrong answer.");
        });

        it(`should exclude CommentEdit from pending approval`, async () => {
            // it should fail because CommentEdit is not applicable for pendingApproval AND it published the wrong answers
            const edit = await plebbit.createCommentEdit({
                communityAddress: regularPublishedComment.communityAddress,
                commentCid: regularPublishedComment.cid!,
                reason: "random reason should fail",
                content: "text to edit on pending comment",
                signer: regularPublishedComment.signer
            });
            edit.once("challenge", async () => await edit.publishChallengeAnswers(["1234 " + Math.random()])); // wrong answers

            const challengeVerificationPromise = new Promise<DecryptedChallengeVerificationMessageType>((resolve) =>
                edit.once("challengeverification", resolve)
            );

            await publishWithExpectedResult({ publication: edit, expectedChallengeSuccess: false });

            const challengeVerification = await challengeVerificationPromise;
            expect(challengeVerification.challengeSuccess).to.equal(false);
            expect(challengeVerification.challengeErrors!["0"]).to.equal("Wrong answer.");
        });
    });
});

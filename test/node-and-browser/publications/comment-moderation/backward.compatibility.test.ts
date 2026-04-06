import {
    getAvailablePKCConfigsToTestAgainst,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    setExtraPropOnCommentModerationAndSign
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import signers from "../../../fixtures/signers.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";

// Type for challenge request event with comment moderation
type ChallengeRequestWithCommentModeration = {
    commentModeration: {
        extraProp?: string;
        insertedAt?: string;
        author?: { extraProp?: string };
        commentModeration?: {
            extraProp?: string;
            locked?: boolean;
        };
    };
};

const roles = [
    { role: "owner", signer: signers[1] },
    { role: "admin", signer: signers[2] },
    { role: "mod", signer: signers[3] }
];

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`Backward compatibility for CommentModeration - ${config.name}`, async () => {
        // A subplebbit should accept a CommentModeration with unknown props
        // However, it should not process the unknown props, it should strip them out after validation

        let plebbit: PKC;
        let commentToMod: Comment;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            commentToMod = await publishRandomPost({ communityAddress: signers[0].address, plebbit: plebbit });
            await commentToMod.update();
            await resolveWhenConditionIsTrue({ toUpdate: commentToMod, predicate: async () => typeof commentToMod.updatedAt === "number" });
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`Publishing commentModeration.extraProp should fail if it's not included in commentModeration.signature.signedPropertyNames`, async () => {
            // Skipped for rpc because it will generate an invalid signature, which will be thrown in rpc server
            const commentModeration = await plebbit.createCommentModeration({
                commentCid: commentToMod.cid,
                communityAddress: commentToMod.communityAddress,
                commentModeration: { removed: true },
                signer: roles[0].signer
            });
            await setExtraPropOnCommentModerationAndSign(commentModeration, { extraProp: "1234" }, false);

            const challengeRequestPromise = new Promise<ChallengeRequestWithCommentModeration>((resolve) =>
                commentModeration.once("challengerequest", resolve as (req: unknown) => void)
            );
            await publishWithExpectedResult({
                publication: commentModeration,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_MODERATION_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
            });
            const challengeRequest = await challengeRequestPromise;
            expect(challengeRequest.commentModeration.extraProp).to.equal("1234");
        });

        it(`publishing commentModerationPublication.extraProp should succeed with {removed:true}  if it's included in commentModeration.signature.signedPropertyNames, but it shouldn't include it in CommentUpdate`, async () => {
            const commentModeration = await plebbit.createCommentModeration({
                commentCid: commentToMod.cid,
                communityAddress: commentToMod.communityAddress,
                commentModeration: { removed: true },
                signer: roles[0].signer
            });
            await setExtraPropOnCommentModerationAndSign(commentModeration, { extraProp: "1234" }, true);

            const challengeRequestPromise = new Promise<ChallengeRequestWithCommentModeration>((resolve) =>
                commentModeration.once("challengerequest", resolve as (req: unknown) => void)
            );

            await publishWithExpectedResult({ publication: commentModeration, expectedChallengeSuccess: true });

            await new Promise<void>((resolve) => commentToMod.once("update", () => resolve()));
            expect(commentToMod.removed).to.be.true; // should process only removed since it's the known field to the sub
            expect((commentToMod as any).extraProp).to.be.undefined;
            const challengeRequest = await challengeRequestPromise;
            expect(challengeRequest.commentModeration.extraProp).to.equal("1234");
            await plebbit.createCommentModeration(JSON.parse(JSON.stringify(commentModeration))); // Just to test if create will throw because of extra prop

            await resolveWhenConditionIsTrue({ toUpdate: commentToMod, predicate: async () => commentToMod.removed });
            expect(commentToMod.removed).to.be.true; // should process only locked since it's the known field to the sub
            expect((commentToMod as any).extraProp).to.be.undefined;
        });

        it(`publishing commentModerationPublication.commentModeration.extraProp should succeed, but it shouldn't include it in CommentUpdate`, async () => {
            const commentModeration = await plebbit.createCommentModeration({
                commentCid: commentToMod.cid,
                communityAddress: commentToMod.communityAddress,
                commentModeration: { locked: true },
                signer: roles[0].signer
            });

            await setExtraPropOnCommentModerationAndSign(commentModeration, { commentModeration: { extraProp: "1234" } }, true);

            const challengeRequestPromise = new Promise<ChallengeRequestWithCommentModeration>((resolve) =>
                commentModeration.once("challengerequest", resolve as (req: unknown) => void)
            );

            await publishWithExpectedResult({ publication: commentModeration, expectedChallengeSuccess: true });
            const challengeRequest = await challengeRequestPromise;
            expect(challengeRequest.commentModeration.commentModeration?.extraProp).to.equal("1234");
            expect(challengeRequest.commentModeration.commentModeration?.locked).to.be.true;

            await resolveWhenConditionIsTrue({ toUpdate: commentToMod, predicate: async () => commentToMod.locked });
            // if commentToEdit emits update that means the signature of update.edit is correct
            expect(commentToMod.locked).to.be.true; // should process only locked since it's the known field to the sub
            expect((commentToMod as any).extraProp).to.be.undefined;

            await plebbit.createCommentModeration(JSON.parse(JSON.stringify(commentModeration))); // Just to test if create will throw because of extra prop
        });

        it(`Publishing commentModeration.reservedField should be rejected`, async () => {
            const commentModeration = await plebbit.createCommentModeration({
                commentCid: commentToMod.cid,
                communityAddress: commentToMod.communityAddress,
                commentModeration: { locked: true },
                signer: commentToMod.signer
            });
            await setExtraPropOnCommentModerationAndSign(commentModeration, { insertedAt: "1234" }, true);

            const challengeRequestPromise = new Promise<ChallengeRequestWithCommentModeration>((resolve) =>
                commentModeration.once("challengerequest", resolve as (req: unknown) => void)
            );
            await publishWithExpectedResult({
                publication: commentModeration,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_MODERATION_HAS_RESERVED_FIELD
            });
            const challengerequest = await challengeRequestPromise;
            expect(challengerequest.commentModeration.insertedAt).to.equal("1234");
        });

        describe.concurrent(
            `Publishing CommentModeration with extra props in commentModerationPublication.author field - ${config.name}`,
            async () => {
                it(`Publishing commentModeration.author.extraProp should succeed`, async () => {
                    const commentModeration = await plebbit.createCommentModeration({
                        commentCid: commentToMod.cid,
                        communityAddress: commentToMod.communityAddress,
                        commentModeration: { removed: true },

                        signer: signers[3]
                    });
                    const extraProps = { extraProp: "1234" };
                    await setExtraPropOnCommentModerationAndSign(commentModeration, { author: extraProps }, true);

                    await plebbit.createCommentModeration(JSON.parse(JSON.stringify(commentModeration))); // Just to test if create will throw because of extra prop

                    const challengeRequestPromise = new Promise<ChallengeRequestWithCommentModeration>((resolve) =>
                        commentModeration.once("challengerequest", resolve as (req: unknown) => void)
                    );
                    await publishWithExpectedResult({ publication: commentModeration, expectedChallengeSuccess: true });
                    const challengeRequest = await challengeRequestPromise;
                    expect(challengeRequest.commentModeration.author?.extraProp).to.equal(extraProps.extraProp);
                });
            }
        );

        describe.concurrent(
            `Publishing CommentModeration with extra props in commentModerationPublication.commentModeration.author field - ${config.name}`,
            async () => {
                it(`Publishing commentModerationPublication.commentModeration.author.extraProp`, async () => {
                    const commentToModWithAuthor = await publishRandomPost({
                        communityAddress: commentToMod.communityAddress,
                        plebbit: plebbit
                    });
                    const commentModeration = await plebbit.createCommentModeration({
                        commentCid: commentToModWithAuthor.cid,
                        communityAddress: commentToModWithAuthor.communityAddress,
                        commentModeration: { removed: true },
                        signer: signers[3]
                    });
                    const extraProps = { extraProp: "1234" };
                    await setExtraPropOnCommentModerationAndSign(commentModeration, { author: extraProps }, true);

                    await plebbit.createCommentModeration(JSON.parse(JSON.stringify(commentModeration))); // Just to test if create will throw because of extra prop

                    const challengeRequestPromise = new Promise<ChallengeRequestWithCommentModeration>((resolve) =>
                        commentModeration.once("challengerequest", resolve as (req: unknown) => void)
                    );

                    await publishWithExpectedResult({ publication: commentModeration, expectedChallengeSuccess: true });
                    const challengeRequest = await challengeRequestPromise;
                    expect(challengeRequest.commentModeration.author?.extraProp).to.equal(extraProps.extraProp);

                    await commentToModWithAuthor.update();
                    await resolveWhenConditionIsTrue({
                        toUpdate: commentToModWithAuthor,
                        predicate: async () => commentToModWithAuthor.removed === true
                    });
                    expect(commentToModWithAuthor.author.subplebbit.extraProp).to.be.undefined;
                    expect(commentToModWithAuthor.raw.commentUpdate.author.subplebbit.extraProp).to.be.undefined;
                    expect(commentToModWithAuthor.raw.commentUpdate.author.extraProp).to.be.undefined;

                    await commentToModWithAuthor.stop();
                });
            }
        );
    });
});

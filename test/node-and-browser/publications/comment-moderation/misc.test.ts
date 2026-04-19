import signers from "../../../fixtures/signers.js";
import {
    getAvailablePKCConfigsToTestAgainst,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";

// Type for challenge request event with comment moderation
type ChallengeRequestWithCommentModeration = {
    commentModeration: Record<string, unknown>;
};

const communityAddress = signers[0].address;

const roles = [
    { role: "owner", signer: signers[1] },
    { role: "admin", signer: signers[2] },
    { role: "mod", signer: signers[3] }
];

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.sequential("pkc.createCommentModeration misc - " + config.name, async () => {
        let pkc: PKC;
        let commentToMod: Comment;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            commentToMod = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`(commentMod: CommentModeration) === pkc.createCommentModeration(JSON.parse(JSON.stringify(commentMod)))`, async () => {
            const modProps = {
                communityAddress: communityAddress,
                commentCid: commentToMod.cid,
                commentModeration: { removed: true, reason: "mod Reason" + Date.now() },
                signer: signers[7] // Create a new signer, different than the signer of the original comment
            };
            const commentMod = await pkc.createCommentModeration(modProps);
            const modFromStringifiedMod = await pkc.createCommentModeration(JSON.parse(JSON.stringify(commentMod)));
            for (const curMod of [commentMod, modFromStringifiedMod]) {
                expect(curMod.communityAddress).to.equal(modProps.communityAddress);
                expect(curMod.commentModeration).to.deep.equal(modProps.commentModeration);
                expect(curMod.commentCid).to.equal(modProps.commentCid);
                expect(curMod.author.address).to.deep.equal(modProps.signer.address);
            }

            expect(commentMod.timestamp).to.equal(modFromStringifiedMod.timestamp);

            expect(deterministicStringify(commentMod)).to.equal(deterministicStringify(modFromStringifiedMod));
        });

        it(`(commentMod: CommentModeration) === await pkc.createCommentModeration(commentMod)`, async () => {
            const props = {
                challengeRequest: {
                    challengeCommentCids: ["QmVZR5Ts9MhRc66hr6TsYnX1A2oPhJ2H1fRJknxgjLLwrh"],
                    challengeAnswers: ["test123"]
                },
                communityAddress: communityAddress,
                commentCid: commentToMod.cid,
                commentModeration: { locked: true, reason: "editReason" + Date.now() },
                signer: signers[7] // Create a new signer, different than the signer of the original comment
            };
            const localMod = await pkc.createCommentModeration(props);
            const recreatedLocalMod = await pkc.createCommentModeration(JSON.parse(JSON.stringify(localMod)));
            [localMod, recreatedLocalMod].forEach((curMod) => {
                expect(curMod.communityAddress).to.equal(props.communityAddress);
                expect(curMod.commentCid).to.equal(props.commentCid);
                expect(curMod.commentModeration).to.deep.equal(props.commentModeration);
                expect(curMod.author.address).to.deep.equal(props.signer.address);
                expect(curMod.challengeRequest).to.deep.equal(props.challengeRequest);
            });

            if (localMod.raw.pubsubMessageToPublish && recreatedLocalMod.raw.pubsubMessageToPublish) {
                expect(localMod.toJSONPubsubRequestToEncrypt().commentModeration).to.deep.equal(localMod.raw.pubsubMessageToPublish);
                expect(recreatedLocalMod.toJSONPubsubRequestToEncrypt().commentModeration).to.deep.equal(
                    recreatedLocalMod.raw.pubsubMessageToPublish
                );
            }

            const localModJson = JSON.parse(JSON.stringify(localMod));
            const recreatedLocalModJson = JSON.parse(JSON.stringify(recreatedLocalMod));
            expect(localMod.timestamp).to.equal(recreatedLocalMod.timestamp);

            expect(localModJson.signer).to.be.a("object").and.deep.equal(recreatedLocalModJson.signer);

            expect(deterministicStringify(localMod)).to.equal(deterministicStringify(recreatedLocalMod));
        });

        it.sequential(`Can publish a CommentModeration that was created from jsonfied CommentModeration instance`, async () => {
            const modProps = {
                communityAddress: communityAddress,
                commentCid: commentToMod.cid,
                commentModeration: { removed: true, reason: "mod Reason" + Date.now() },
                signer: roles[0].signer // mod signer
            };
            const commentMod = await pkc.createCommentModeration(modProps);
            const modFromStringifiedMod = await pkc.createCommentModeration(JSON.parse(JSON.stringify(commentMod)));

            const challengeRequestPromise = new Promise<ChallengeRequestWithCommentModeration>((resolve) =>
                modFromStringifiedMod.once("challengerequest", resolve as (req: unknown) => void)
            );

            await publishWithExpectedResult({ publication: modFromStringifiedMod, expectedChallengeSuccess: true });
            const challengerequest = await challengeRequestPromise;

            expect(challengerequest.commentModeration).to.deep.equal(modFromStringifiedMod.raw.pubsubMessageToPublish!);
            expect(modFromStringifiedMod.raw.pubsubMessageToPublish).to.exist;
        });
    });

    describe.concurrent(`Changing multiple fields simultaneously in one CommentModeration - ${config.name}`, async () => {
        let pkc: PKC;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`A mod publishing multiple mod edit fields and they all should appear on the comment`, async () => {
            const modPost = await publishRandomPost({
                communityAddress: communityAddress,
                pkc: pkc,
                postProps: { signer: roles[2].signer }
            });
            const fieldsToChange = {
                removed: true,
                pinned: true,
                locked: true,
                spoiler: true,
                nsfw: true,
                reason: "Testing as a mod" + Date.now()
            };

            const commentMod = await pkc.createCommentModeration({
                commentModeration: fieldsToChange,
                commentCid: modPost.cid,
                signer: roles[2].signer,
                communityAddress: communityAddress
            });
            await publishWithExpectedResult({ publication: commentMod, expectedChallengeSuccess: true });
            await modPost.update();

            await resolveWhenConditionIsTrue({ toUpdate: modPost, predicate: async () => modPost.removed === true });
            await modPost.stop();
            expect(modPost.locked).to.be.true;
            expect(modPost.raw.commentUpdate.locked).to.be.true;

            expect(modPost.pinned).to.be.true;
            expect(modPost.raw.commentUpdate.pinned).to.be.true;

            expect(modPost.removed).to.be.true;
            expect(modPost.raw.commentUpdate.removed).to.be.true;

            expect(modPost.spoiler).to.be.true;
            expect(modPost.raw.commentUpdate.spoiler).to.be.true;

            expect(modPost.nsfw).to.be.true;
            expect(modPost.raw.commentUpdate.nsfw).to.be.true;

            expect(modPost.reason).to.equal(fieldsToChange.reason);
            expect(modPost.raw.commentUpdate.reason).to.equal(fieldsToChange.reason);
        });
    });

    describe.concurrent(`Changing multiple fields in separate comment moderations`, async () => {
        let pkc: PKC;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`As a mod`, async () => {
            const modPost = await publishRandomPost({
                communityAddress: communityAddress,
                pkc: pkc,
                postProps: { signer: roles[2].signer }
            });
            const fieldsToChange = {
                removed: true,
                reason: "Testing removing",
                pinned: true,
                locked: true,
                spoiler: true,
                nsfw: true
            };

            const commentModeration1 = await pkc.createCommentModeration({
                commentModeration: fieldsToChange,
                commentCid: modPost.cid,
                signer: modPost.signer,
                communityAddress: communityAddress
            });
            await publishWithExpectedResult({ publication: commentModeration1, expectedChallengeSuccess: true });

            fieldsToChange.removed = false;
            fieldsToChange.reason = "Testing unremoving" + Date.now();
            fieldsToChange.locked = false;
            const commentModeration2 = await pkc.createCommentModeration({
                commentModeration: fieldsToChange,
                commentCid: modPost.cid,
                signer: modPost.signer,
                communityAddress: communityAddress
            });

            await publishWithExpectedResult({ publication: commentModeration2, expectedChallengeSuccess: true });

            await modPost.update();
            await resolveWhenConditionIsTrue({ toUpdate: modPost, predicate: async () => modPost.removed === fieldsToChange.removed });

            await modPost.stop();
            expect(modPost.locked).to.be.false;

            expect(modPost.raw.commentUpdate.edit).to.be.undefined;
            expect(modPost.raw.commentUpdate.locked).to.be.false;

            expect(modPost.pinned).to.be.true;
            expect(modPost.raw.commentUpdate.pinned).to.be.true;

            expect(modPost.removed).to.be.false;
            expect(modPost.raw.commentUpdate.removed).to.be.false;

            expect(modPost.reason).to.equal(fieldsToChange.reason);
            expect(modPost.raw.commentUpdate.reason).equal(fieldsToChange.reason);

            expect(modPost.spoiler).to.be.true;
            expect(modPost.raw.commentUpdate.spoiler).to.be.true;

            expect(modPost.nsfw).to.be.true;
            expect(modPost.raw.commentUpdate.nsfw).to.be.true;
        });

        it(`Correct value of CommentUpdate after author edit, then mod edit`, async () => {
            const authorFieldsToChange = {
                spoiler: true,
                nsfw: true,
                content: "Test new content as author" + Date.now(),
                reason: "Test as an author" + Date.now()
            };

            const authorPost = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc }); // generate random signer

            const authorEdit = await pkc.createCommentEdit({
                ...authorFieldsToChange,
                commentCid: authorPost.cid,
                signer: authorPost.signer,
                communityAddress: communityAddress
            });
            await publishWithExpectedResult({ publication: authorEdit, expectedChallengeSuccess: true });

            const modFieldsToChange = {
                removed: true,
                reason: "Test remove as mod",
                spoiler: false,
                nsfw: false,
                pinned: true
            };
            const modEdit = await pkc.createCommentModeration({
                commentModeration: modFieldsToChange,
                commentCid: authorPost.cid,
                signer: roles[2].signer,
                communityAddress: communityAddress
            });

            await publishWithExpectedResult({ publication: modEdit, expectedChallengeSuccess: true });

            await authorPost.update();

            await resolveWhenConditionIsTrue({
                toUpdate: authorPost,
                predicate: async () => authorPost.removed === (modFieldsToChange as Record<string, unknown>).removed
            });

            await authorPost.stop();

            // check mod changes here (removed is not in modFieldsToChange, so it's undefined)
            expect(authorPost.removed).to.equal((modFieldsToChange as Record<string, unknown>).removed);
            expect(authorPost.raw.commentUpdate.removed).to.equal((modFieldsToChange as Record<string, unknown>).removed);
            expect(authorPost.reason).to.equal(modFieldsToChange.reason);
            expect(authorPost.raw.commentUpdate.reason).to.equal(modFieldsToChange.reason);

            expect(authorPost.spoiler).to.equal(modFieldsToChange.spoiler);
            expect(authorPost.raw.commentUpdate.spoiler).to.equal(modFieldsToChange.spoiler);

            expect(authorPost.nsfw).to.equal(modFieldsToChange.nsfw);
            expect(authorPost.raw.commentUpdate.nsfw).to.equal(modFieldsToChange.nsfw);

            expect(authorPost.pinned).to.equal(modFieldsToChange.pinned);
            expect(authorPost.raw.commentUpdate.pinned).to.equal(modFieldsToChange.pinned);

            // Check author changes here

            expect(authorPost.raw.commentUpdate.edit.spoiler).to.equal(authorFieldsToChange.spoiler);
            expect(authorPost.edit.spoiler).to.equal(authorFieldsToChange.spoiler);

            expect(authorPost.raw.commentUpdate.edit.nsfw).to.equal(authorFieldsToChange.nsfw);
            expect(authorPost.edit.nsfw).to.equal(authorFieldsToChange.nsfw);

            expect(authorPost.content).to.equal(authorFieldsToChange.content);
            expect(authorPost.edit.content).to.equal(authorFieldsToChange.content);
            expect(authorPost.raw.commentUpdate.edit.content).to.equal(authorFieldsToChange.content);

            expect(authorPost.edit.reason).to.equal(authorFieldsToChange.reason);
            expect(authorPost.raw.commentUpdate.edit.reason).to.equal(authorFieldsToChange.reason);
        });

        it(`Correct value of CommentUpdate after mod edit, then author edit`, async () => {
            const authorPost = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc }); // generate random signer

            const modFieldsToChange = {
                reason: "Test setting spoiler as mod",
                spoiler: true,
                nsfw: true,
                pinned: true
            };
            const modEdit = await pkc.createCommentModeration({
                commentModeration: modFieldsToChange,
                commentCid: authorPost.cid,
                signer: roles[2].signer,
                communityAddress: communityAddress
            });

            await publishWithExpectedResult({ publication: modEdit, expectedChallengeSuccess: true });

            const authorFieldsToChange = {
                spoiler: false,
                nsfw: false,
                content: "Test new content as author" + Date.now(),
                reason: "Test as an author" + Date.now()
            };
            const authorEdit = await pkc.createCommentEdit({
                ...authorFieldsToChange,
                commentCid: authorPost.cid,
                signer: authorPost.signer,
                communityAddress: communityAddress
            });
            await publishWithExpectedResult({ publication: authorEdit, expectedChallengeSuccess: true });

            await authorPost.update();

            await resolveWhenConditionIsTrue({
                toUpdate: authorPost,
                predicate: async () => authorPost?.edit?.spoiler === authorFieldsToChange.spoiler
            });

            await authorPost.stop();

            // check mod changes here (removed is not in modFieldsToChange, so it's undefined)
            expect(authorPost.removed).to.equal((modFieldsToChange as Record<string, unknown>).removed);
            expect(authorPost.raw.commentUpdate.removed).to.equal((modFieldsToChange as Record<string, unknown>).removed);
            expect(authorPost.reason).to.equal(modFieldsToChange.reason);
            expect(authorPost.raw.commentUpdate.reason).to.equal(modFieldsToChange.reason);

            expect(authorPost.spoiler).to.equal(modFieldsToChange.spoiler);
            expect(authorPost.raw.commentUpdate.spoiler).to.equal(modFieldsToChange.spoiler);

            expect(authorPost.nsfw).to.equal(modFieldsToChange.nsfw);
            expect(authorPost.raw.commentUpdate.nsfw).to.equal(modFieldsToChange.nsfw);

            expect(authorPost.pinned).to.equal(modFieldsToChange.pinned);
            expect(authorPost.raw.commentUpdate.pinned).to.equal(modFieldsToChange.pinned);

            // Check author changes here

            expect(authorPost.raw.commentUpdate.edit.spoiler).to.equal(authorFieldsToChange.spoiler);
            expect(authorPost.edit.spoiler).to.equal(authorFieldsToChange.spoiler);

            expect(authorPost.raw.commentUpdate.edit.nsfw).to.equal(authorFieldsToChange.nsfw);
            expect(authorPost.edit.nsfw).to.equal(authorFieldsToChange.nsfw);

            expect(authorPost.content).to.equal(authorFieldsToChange.content);
            expect(authorPost.edit.content).to.equal(authorFieldsToChange.content);
            expect(authorPost.raw.commentUpdate.edit.content).to.equal(authorFieldsToChange.content);

            expect(authorPost.edit.reason).to.equal(authorFieldsToChange.reason);
            expect(authorPost.raw.commentUpdate.edit.reason).to.equal(authorFieldsToChange.reason);
        });
    });
});

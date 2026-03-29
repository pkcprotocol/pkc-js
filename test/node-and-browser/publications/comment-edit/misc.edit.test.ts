import signers from "../../../fixtures/signers.js";
import {
    getAvailablePlebbitConfigsToTestAgainst,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";

// Type for challenge request event
type ChallengeRequestWithEdit = {
    commentEdit: Record<string, unknown>;
};

const subplebbitAddress = signers[0].address;

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.concurrent("plebbit.createCommentEdit - " + config.name, async () => {
        let plebbit: Plebbit;
        let commentToEdit: Comment;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            commentToEdit = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
            expect(commentToEdit.cid).to.be.a("string");
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`(edit: CommentEdit) === plebbit.createCommentEdit(JSON.parse(JSON.stringify(edit)))`, async () => {
            const props = {
                communityAddress: subplebbitAddress,
                commentCid: commentToEdit.cid,
                reason: "editReason" + Date.now(),
                content: "editedText" + Date.now(),
                signer: signers[7] // Create a new signer, different than the signer of the original comment
            };
            const edit = await plebbit.createCommentEdit(props);
            const editFromStringifiedEdit = await plebbit.createCommentEdit(JSON.parse(JSON.stringify(edit)));
            for (const curEdit of [edit, editFromStringifiedEdit]) {
                expect(curEdit.communityAddress).to.equal(props.communityAddress);
                expect(curEdit.commentCid).to.equal(props.commentCid);
                expect(curEdit.reason).to.equal(props.reason);
                expect(curEdit.content).to.equal(props.content);
                expect(curEdit.author.address).to.deep.equal(props.signer.address);
            }

            expect(edit.timestamp).to.equal(editFromStringifiedEdit.timestamp);

            expect(deterministicStringify(edit)).to.equal(deterministicStringify(editFromStringifiedEdit));
        });

        it(`(edit: CommentEdit) === await plebbit.createCommentEdit(edit)`, async () => {
            const props = {
                challengeRequest: { challengeCommentCids: ["QmVZR5Ts9MhRc66hr6TsYnX1A2oPhJ2H1fRJknxgjLLwrh"], challengeAnswers: ["1234"] },
                communityAddress: subplebbitAddress,
                commentCid: commentToEdit.cid,
                reason: "editReason" + Date.now(),
                content: "editedText" + Date.now(),
                signer: signers[7] // Create a new signer, different than the signer of the original comment
            };
            const localEdit = await plebbit.createCommentEdit(props);
            const recreatedLocalEdit = await plebbit.createCommentEdit(JSON.parse(JSON.stringify(localEdit)));
            [localEdit, recreatedLocalEdit].forEach((curEdit) => {
                expect(curEdit.communityAddress).to.equal(props.communityAddress);
                expect(curEdit.commentCid).to.equal(props.commentCid);
                expect(curEdit.reason).to.equal(props.reason);
                expect(curEdit.content).to.equal(props.content);
                expect(curEdit.author.address).to.deep.equal(props.signer.address);
                expect(curEdit.challengeRequest).to.deep.equal(props.challengeRequest);
            });

            if (localEdit.raw.pubsubMessageToPublish && recreatedLocalEdit.raw.pubsubMessageToPublish) {
                expect(localEdit.toJSONPubsubRequestToEncrypt().commentEdit).to.deep.equal(localEdit.raw.pubsubMessageToPublish);
                expect(recreatedLocalEdit.toJSONPubsubRequestToEncrypt().commentEdit).to.deep.equal(
                    recreatedLocalEdit.raw.pubsubMessageToPublish
                );
            }

            const localEditJson = JSON.parse(JSON.stringify(localEdit));
            const recreatedLocalEditJson = JSON.parse(JSON.stringify(recreatedLocalEdit));
            expect(localEdit.timestamp).to.equal(recreatedLocalEdit.timestamp);

            expect(localEditJson.signer).to.be.a("object").and.deep.equal(recreatedLocalEditJson.signer);

            expect(deterministicStringify(localEdit)).to.equal(deterministicStringify(recreatedLocalEdit));
        });

        it.sequential(`Can publish a CommentEdit that was created from jsonfied CommentEdit instance`, async () => {
            const props = {
                communityAddress: subplebbitAddress,
                commentCid: commentToEdit.cid,
                reason: "editReason" + Date.now(),
                content: "editedText" + Date.now(),
                signer: commentToEdit.signer
            };
            const edit = await plebbit.createCommentEdit(props);
            const editFromStringifiedEdit = await plebbit.createCommentEdit(JSON.parse(JSON.stringify(edit)));

            const challengeRequestPromise = new Promise<ChallengeRequestWithEdit>((resolve) =>
                editFromStringifiedEdit.once("challengerequest", resolve as (req: unknown) => void)
            );
            await publishWithExpectedResult({ publication: editFromStringifiedEdit, expectedChallengeSuccess: true });
            const challengerequest = await challengeRequestPromise;

            expect(challengerequest.commentEdit).to.deep.equal(editFromStringifiedEdit.raw.pubsubMessageToPublish!);
            expect(editFromStringifiedEdit.raw.pubsubMessageToPublish).to.exist;
        });
    });

    describe.sequential(`Changing multiple fields simultaneously in one CommentEdit - ` + config.name, async () => {
        let plebbit: Plebbit;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`An author publishing multiple author edit fields`, async () => {
            const authorPost = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit }); // random signer

            const fieldsToChange = {
                deleted: true,
                spoiler: true,
                nsfw: true,
                content: "Test new content as author" + Date.now(),
                reason: "Test as an author" + Date.now()
            };

            const edit = await plebbit.createCommentEdit({
                ...fieldsToChange,
                commentCid: authorPost.cid,
                signer: authorPost.signer,
                communityAddress: subplebbitAddress
            });
            await publishWithExpectedResult({ publication: edit, expectedChallengeSuccess: true });
            await authorPost.update();
            await resolveWhenConditionIsTrue({ toUpdate: authorPost, predicate: async () => authorPost.deleted });
            await authorPost.stop();
            expect(authorPost.deleted).to.be.true;
            expect(authorPost.raw.commentUpdate.edit.deleted).to.be.true;

            expect(authorPost.spoiler).to.be.true;
            expect(authorPost.raw.commentUpdate.edit.spoiler).to.be.true;

            expect(authorPost.nsfw).to.be.true;
            expect(authorPost.raw.commentUpdate.edit.nsfw).to.be.true;

            expect(authorPost.content).to.equal(fieldsToChange.content);
            expect(authorPost.raw.commentUpdate.edit.content).equal(fieldsToChange.content);

            expect(authorPost.edit.reason).to.equal(fieldsToChange.reason);
            expect(authorPost.raw.commentUpdate.edit.reason).equal(fieldsToChange.reason);
            expect(authorPost.reason).to.be.undefined;
            expect(authorPost.raw.commentUpdate.reason).to.be.undefined;
        });
    });

    describe.concurrent(`Changing multiple edit fields in separate edits - ${config.name}`, async () => {
        let plebbit: Plebbit;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`as an author`, async () => {
            const firstEditProps = {
                spoiler: true,
                nsfw: true,
                content: "Test new content as author" + Date.now(),
                reason: "Test as an author" + Date.now()
            };

            const authorPost = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit }); // generate random signer

            const edit1 = await plebbit.createCommentEdit({
                ...firstEditProps,
                commentCid: authorPost.cid,
                signer: authorPost.signer,
                communityAddress: subplebbitAddress
            });
            await publishWithExpectedResult({ publication: edit1, expectedChallengeSuccess: true });

            const secondEditProps = {
                ...firstEditProps,
                deleted: true,
                reason: "Testing undeleting" + Date.now(),
                content: "Test new content" + Date.now()
            };
            const edit2 = await plebbit.createCommentEdit({
                ...secondEditProps,
                commentCid: authorPost.cid,
                signer: authorPost.signer,
                communityAddress: subplebbitAddress
            });

            await publishWithExpectedResult({ publication: edit2, expectedChallengeSuccess: true });

            await authorPost.update();
            await resolveWhenConditionIsTrue({
                toUpdate: authorPost,
                predicate: async () => authorPost.deleted === secondEditProps.deleted
            });

            await authorPost.stop();
            expect(authorPost.deleted).to.equal(secondEditProps.deleted);
            expect(authorPost.raw.commentUpdate.edit.deleted).to.equal(secondEditProps.deleted);

            expect(authorPost.edit.reason).to.equal(secondEditProps.reason);
            expect(authorPost.raw.commentUpdate.edit.reason).to.equal(secondEditProps.reason);

            expect(authorPost.reason).to.be.undefined; // reserved for mods
            expect(authorPost.raw.commentUpdate.reason).to.be.undefined;

            expect(authorPost.content).to.equal(secondEditProps.content);
            expect(authorPost.raw.commentUpdate.edit.content).to.equal(secondEditProps.content);

            expect(authorPost.spoiler).to.equal(firstEditProps.spoiler);
            expect(authorPost.raw.commentUpdate.edit.spoiler).to.equal(firstEditProps.spoiler);
            expect(authorPost.raw.commentUpdate.spoiler).to.be.undefined;

            expect(authorPost.nsfw).to.equal(firstEditProps.nsfw);
            expect(authorPost.raw.commentUpdate.edit.nsfw).to.equal(firstEditProps.nsfw);
            expect(authorPost.raw.commentUpdate.nsfw).to.be.undefined;
        });
    });
});

import signers from "../../../fixtures/signers.js";
import {
    getAvailablePKCConfigsToTestAgainst,
    iterateThroughPagesToFindCommentInParentPagesInstance,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";

const communityAddress = signers[0].address;

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.sequential(`Authors can set flairs on their own comment - ${config.name}`, async () => {
        let pkc: PKC, authorPost: Comment;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            authorPost = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            expect(authorPost.flairs).to.be.undefined;
            await authorPost.update();
            await resolveWhenConditionIsTrue({ toUpdate: authorPost, predicate: async () => typeof authorPost.updatedAt === "number" });
            expect(authorPost.flairs).to.be.undefined;
        });

        afterAll(async () => {
            await authorPost?.stop();
            await pkc.destroy();
        });

        it(`Regular author can't set flairs on another author's comment`, async () => {
            const flairsEdit = await pkc.createCommentEdit({
                communityAddress: authorPost.communityAddress,
                commentCid: authorPost.cid,
                flairs: [{ text: "Hacked" }],
                signer: await pkc.createSigner()
            });
            await publishWithExpectedResult({
                publication: flairsEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_EDIT_CAN_NOT_EDIT_COMMENT_IF_NOT_ORIGINAL_AUTHOR
            });
        });

        it(`Author can't set flairs not in the allowed list`, async () => {
            const flairsEdit = await pkc.createCommentEdit({
                communityAddress: authorPost.communityAddress,
                commentCid: authorPost.cid,
                flairs: [{ text: "NotAllowed" }],
                signer: authorPost.signer
            });
            await publishWithExpectedResult({
                publication: flairsEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_POST_FLAIR_NOT_IN_ALLOWED_FLAIRS
            });
        });

        it.sequential(`Author can set flairs on their own comment`, async () => {
            expect(authorPost.flairs).to.be.undefined;

            const flairsEdit = await pkc.createCommentEdit({
                communityAddress: authorPost.communityAddress,
                commentCid: authorPost.cid,
                flairs: [{ text: "Discussion" }],
                signer: authorPost.signer,
                reason: "Author adding flairs"
            });
            await publishWithExpectedResult({ publication: flairsEdit, expectedChallengeSuccess: true });
        });

        it.sequential(`A new CommentUpdate is published with flairs`, async () => {
            await resolveWhenConditionIsTrue({
                toUpdate: authorPost,
                predicate: async () => authorPost.flairs !== undefined && authorPost.flairs.length > 0
            });
            expect(authorPost.edit.flairs).to.deep.equal([{ text: "Discussion" }]);
            expect(authorPost.raw.commentUpdate.edit).to.exist;
            expect(authorPost.raw.commentUpdate.edit.flairs).to.deep.equal([{ text: "Discussion" }]);

            expect(authorPost.flairs).to.deep.equal([{ text: "Discussion" }]);
        });

        it(`flairs appear in pages of community`, async () => {
            const sub = await pkc.createCommunity({ address: authorPost.communityAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(authorPost.cid, sub.posts);
                    return Boolean(commentInPage?.flairs);
                }
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(authorPost.cid, sub.posts);
            expect(commentInPage.flairs).to.deep.equal([{ text: "Discussion" }]);
        });

        it.sequential(`Author can update flairs with multiple entries`, async () => {
            const flairsEdit = await pkc.createCommentEdit({
                communityAddress: authorPost.communityAddress,
                commentCid: authorPost.cid,
                flairs: [{ text: "Updated" }, { text: "Important", backgroundColor: "#ff0000" }],
                signer: authorPost.signer,
                reason: "Author updating flairs"
            });
            await publishWithExpectedResult({ publication: flairsEdit, expectedChallengeSuccess: true });
        });

        it.sequential(`A new CommentUpdate is published with updated flairs`, async () => {
            await resolveWhenConditionIsTrue({
                toUpdate: authorPost,
                predicate: async () => authorPost.flairs !== undefined && authorPost.flairs.length === 2
            });
            expect(authorPost.flairs).to.deep.equal([{ text: "Updated" }, { text: "Important", backgroundColor: "#ff0000" }]);
        });
    });
});

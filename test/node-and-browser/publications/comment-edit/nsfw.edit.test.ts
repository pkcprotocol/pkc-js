import signers from "../../../fixtures/signers.js";
import {
    getAvailablePKCConfigsToTestAgainst,
    iterateThroughPagesToFindCommentInParentPagesInstance,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { verifyCommentIpfs, verifyCommentUpdate } from "../../../../dist/node/signer/signatures.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidPostCidDefined } from "../../../../dist/node/publications/comment/types.js";

const communityAddress = signers[0].address;
const roles = [
    { role: "owner", signer: signers[1] },
    { role: "admin", signer: signers[2] },
    { role: "mod", signer: signers[3] }
];

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`Authors can mark their own comment as nsfw - ${config.name}`, async () => {
        let pkc: PKC, authorPost: Comment;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            authorPost = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            await authorPost.update();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`Regular author can't mark another author comment as nsfw`, async () => {
            const nsfwEdit = await pkc.createCommentEdit({
                communityAddress: authorPost.communityAddress,
                commentCid: authorPost.cid,
                nsfw: true,
                signer: await pkc.createSigner()
            });
            await publishWithExpectedResult({
                publication: nsfwEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_EDIT_CAN_NOT_EDIT_COMMENT_IF_NOT_ORIGINAL_AUTHOR
            });
        });

        it(`Author can mark their own comment as nsfw with CommentEdit`, async () => {
            expect([false, undefined]).to.include(authorPost.nsfw);

            const nsfwEdit = await pkc.createCommentEdit({
                communityAddress: authorPost.communityAddress,
                commentCid: authorPost.cid,
                nsfw: true,
                signer: authorPost.signer,
                reason: "Author marking their own comment as nsfw"
            });
            await publishWithExpectedResult({ publication: nsfwEdit, expectedChallengeSuccess: true });
        });
        it(`A new CommentUpdate is published with nsfw=true`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: authorPost, predicate: async () => authorPost.nsfw === true });
            expect(authorPost.edit.nsfw).to.be.true;
            expect(authorPost.raw.commentUpdate.reason).to.be.undefined;
            expect(authorPost.raw.commentUpdate.nsfw).to.be.undefined;
            expect(authorPost.raw.commentUpdate.edit).to.exist;
            expect(authorPost.raw.commentUpdate.edit.reason).to.equal("Author marking their own comment as nsfw");
            expect(authorPost.raw.commentUpdate.edit.nsfw).to.be.true;

            expect(authorPost.reason).to.be.undefined; // reason is only for mods editing other authors' posts
            expect(authorPost.edit.reason).to.equal("Author marking their own comment as nsfw");

            expect(authorPost.nsfw).to.be.true;
        });

        it(`nsfw=true appears in pages of community`, async () => {
            const sub = await pkc.createCommunity({ address: authorPost.communityAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(authorPost.cid, sub.posts);
                    return commentInPage?.nsfw === true;
                }
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(authorPost.cid, sub.posts);
            expect(commentInPage.nsfw).to.be.true;
            await sub.stop();
        });

        it(`The new Comment with nsfw=true has valid signature`, async () => {
            const recreatedPost = await pkc.createComment({ cid: authorPost.cid });
            await recreatedPost.update();
            await resolveWhenConditionIsTrue({
                toUpdate: recreatedPost,
                predicate: async () => typeof recreatedPost.updatedAt === "number"
            });

            await recreatedPost.stop();
            expect(recreatedPost.nsfw).to.be.true;

            const commentIpfsValidity = await verifyCommentIpfs({
                comment: recreatedPost.raw.comment!,
                resolveAuthorNames: true,
                clientsManager: recreatedPost._clientsManager,
                calculatedCommentCid: recreatedPost.cid
            });
            expect(commentIpfsValidity).to.deep.equal({ valid: true });

            const commentUpdateValidity = await verifyCommentUpdate({
                update: recreatedPost.raw.commentUpdate,
                resolveAuthorNames: true,
                clientsManager: recreatedPost._clientsManager,
                community: { address: recreatedPost.communityAddress },
                comment: recreatedPost as unknown as Pick<CommentIpfsWithCidPostCidDefined, "signature" | "cid" | "depth" | "postCid">,
                validatePages: true,
                validateUpdateSignature: true
            });
            expect(commentUpdateValidity).to.deep.equal({ valid: true });
        });

        it(`Author can unnsfw their own comment`, async () => {
            const unnsfwEdit = await pkc.createCommentEdit({
                communityAddress: authorPost.communityAddress,
                commentCid: authorPost.cid,
                nsfw: false,
                signer: authorPost.signer,
                reason: "An author unnsfwing their own comment"
            });
            await publishWithExpectedResult({ publication: unnsfwEdit, expectedChallengeSuccess: true });
        });
        it(`A new CommentUpdate is published with nsfw=false`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: authorPost, predicate: async () => authorPost.nsfw === false });
            expect(authorPost.edit.nsfw).to.be.false;
            expect(authorPost.raw.commentUpdate.reason).to.be.undefined;
            expect(authorPost.raw.commentUpdate.nsfw).to.be.undefined;
            expect(authorPost.raw.commentUpdate.edit).to.exist;
            expect(authorPost.raw.commentUpdate.edit.reason).to.equal("An author unnsfwing their own comment");
            expect(authorPost.raw.commentUpdate.edit.nsfw).to.be.false;

            expect(authorPost.edit.reason).to.equal("An author unnsfwing their own comment");
            expect(authorPost.reason).to.be.undefined;

            expect(authorPost.nsfw).to.be.false;
        });

        it(`nsfw=false appears in pages of community`, async () => {
            const sub = await pkc.createCommunity({ address: authorPost.communityAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(authorPost.cid, sub.posts);
                    return commentInPage?.nsfw === false;
                }
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(authorPost.cid, sub.posts);
            expect(commentInPage.nsfw).to.be.false;
            await sub.stop();
        });
    });

    describe(`Mods marking their own comment as nsfw - ${config.name}`, async () => {
        let pkc: PKC, modPost: Comment;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            modPost = await publishRandomPost({
                communityAddress: communityAddress,
                pkc: pkc,
                postProps: { signer: roles[2].signer }
            });
            await modPost.update();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`Mod can mark their own comment as nsfw`, async () => {
            const nsfwEdit = await pkc.createCommentEdit({
                communityAddress: modPost.communityAddress,
                commentCid: modPost.cid,
                nsfw: true,
                signer: roles[2].signer,
                reason: "Mod marking their own comment as nsfw"
            });
            await publishWithExpectedResult({ publication: nsfwEdit, expectedChallengeSuccess: true });
        });

        it(`A new CommentUpdate is published with nsfw=true`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: modPost, predicate: async () => modPost.nsfw === true });
            expect(modPost.edit.nsfw).to.be.true;
            expect(modPost.raw.commentUpdate.reason).to.be.undefined;
            expect(modPost.raw.commentUpdate.nsfw).to.be.undefined;
            expect(modPost.raw.commentUpdate.edit).to.exist;
            expect(modPost.raw.commentUpdate.edit.reason).to.equal("Mod marking their own comment as nsfw");
            expect(modPost.raw.commentUpdate.edit.nsfw).to.be.true;

            expect(modPost.reason).to.be.undefined; // reason is defined only when it's a mod editing other authors' posts
            expect(modPost.edit.reason).to.equal("Mod marking their own comment as nsfw");
            expect(modPost.nsfw).to.be.true;
        });

        it(`nsfw=true appears in getPage of community`, async () => {
            const sub = await pkc.createCommunity({ address: modPost.communityAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(modPost.cid, sub.posts);
                    return commentInPage?.nsfw === true;
                }
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(modPost.cid, sub.posts);
            expect(commentInPage.nsfw).to.be.true;
            await sub.stop();
        });

        it(`Mod can unnsfw their own comment`, async () => {
            const unnsfwEdit = await pkc.createCommentEdit({
                communityAddress: modPost.communityAddress,
                commentCid: modPost.cid,
                nsfw: false,
                signer: roles[2].signer,
                reason: "Mod unnsfwing their own comment"
            });
            await publishWithExpectedResult({ publication: unnsfwEdit, expectedChallengeSuccess: true });
        });

        it(`A new CommentUpdate is published with nsfw=false`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: modPost, predicate: async () => modPost.nsfw === false });
            expect(modPost.edit.nsfw).to.be.false;
            expect(modPost.raw.commentUpdate.reason).to.be.undefined;
            expect(modPost.raw.commentUpdate.nsfw).to.be.undefined;
            expect(modPost.raw.commentUpdate.edit).to.exist;
            expect(modPost.raw.commentUpdate.edit.reason).to.equal("Mod unnsfwing their own comment");
            expect(modPost.raw.commentUpdate.edit.nsfw).to.be.false;

            expect(modPost.reason).to.be.undefined;
            expect(modPost.edit.reason).to.equal("Mod unnsfwing their own comment");
            expect(modPost.nsfw).to.be.false;
        });

        it.sequential(`nsfw=false appears in pages of community`, async () => {
            const sub = await pkc.createCommunity({ address: modPost.communityAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(modPost.cid, sub.posts);
                    return commentInPage?.nsfw === false;
                }
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(modPost.cid, sub.posts);
            expect(commentInPage.nsfw).to.be.false;
            await sub.stop();
        });
    });
});

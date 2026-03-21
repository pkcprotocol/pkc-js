import signers from "../../../fixtures/signers.js";
import {
    getAvailablePlebbitConfigsToTestAgainst,
    iterateThroughPagesToFindCommentInParentPagesInstance,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { verifyCommentIpfs, verifyCommentUpdate } from "../../../../dist/node/signer/signatures.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidPostCidDefined } from "../../../../dist/node/publications/comment/types.js";

const subplebbitAddress = signers[0].address;
const roles = [
    { role: "owner", signer: signers[1] },
    { role: "admin", signer: signers[2] },
    { role: "mod", signer: signers[3] }
];

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe(`Authors can mark their own comment as nsfw - ${config.name}`, async () => {
        let plebbit: Plebbit, authorPost: Comment;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            authorPost = await publishRandomPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit });
            await authorPost.update();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`Regular author can't mark another author comment as nsfw`, async () => {
            const nsfwEdit = await plebbit.createCommentEdit({
                subplebbitAddress: authorPost.subplebbitAddress,
                commentCid: authorPost.cid,
                nsfw: true,
                signer: await plebbit.createSigner()
            });
            await publishWithExpectedResult({
                publication: nsfwEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_EDIT_CAN_NOT_EDIT_COMMENT_IF_NOT_ORIGINAL_AUTHOR
            });
        });

        it(`Author can mark their own comment as nsfw with CommentEdit`, async () => {
            expect([false, undefined]).to.include(authorPost.nsfw);

            const nsfwEdit = await plebbit.createCommentEdit({
                subplebbitAddress: authorPost.subplebbitAddress,
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

        it(`nsfw=true appears in pages of subplebbit`, async () => {
            const sub = await plebbit.getSubplebbit({ address: authorPost.subplebbitAddress });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(authorPost.cid, sub.posts);
            expect(commentInPage.nsfw).to.be.true;
        });

        it(`The new Comment with nsfw=true has valid signature`, async () => {
            const recreatedPost = await plebbit.createComment({ cid: authorPost.cid });
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
                subplebbit: { address: recreatedPost.subplebbitAddress },
                comment: recreatedPost as unknown as Pick<CommentIpfsWithCidPostCidDefined, "signature" | "cid" | "depth" | "postCid">,
                validatePages: true,
                validateUpdateSignature: true
            });
            expect(commentUpdateValidity).to.deep.equal({ valid: true });
        });

        it(`Author can unnsfw their own comment`, async () => {
            const unnsfwEdit = await plebbit.createCommentEdit({
                subplebbitAddress: authorPost.subplebbitAddress,
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

        it(`nsfw=false appears in pages of subplebbit`, async () => {
            const sub = await plebbit.getSubplebbit({ address: authorPost.subplebbitAddress });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(authorPost.cid, sub.posts);
            expect(commentInPage.nsfw).to.be.false;
        });
    });

    describe(`Mods marking their own comment as nsfw - ${config.name}`, async () => {
        let plebbit: Plebbit, modPost: Comment;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            modPost = await publishRandomPost({
                subplebbitAddress: subplebbitAddress,
                plebbit: plebbit,
                postProps: { signer: roles[2].signer }
            });
            await modPost.update();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`Mod can mark their own comment as nsfw`, async () => {
            const nsfwEdit = await plebbit.createCommentEdit({
                subplebbitAddress: modPost.subplebbitAddress,
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

        it(`nsfw=true appears in getPage of subplebbit`, async () => {
            const sub = await plebbit.getSubplebbit({ address: modPost.subplebbitAddress });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(modPost.cid, sub.posts);
            expect(commentInPage.nsfw).to.be.true;
        });

        it(`Mod can unnsfw their own comment`, async () => {
            const unnsfwEdit = await plebbit.createCommentEdit({
                subplebbitAddress: modPost.subplebbitAddress,
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

        it.sequential(`nsfw=false appears in pages of subplebbit`, async () => {
            const sub = await plebbit.getSubplebbit({ address: modPost.subplebbitAddress });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(modPost.cid, sub.posts);
            expect(commentInPage.nsfw).to.be.false;
        });
    });
});

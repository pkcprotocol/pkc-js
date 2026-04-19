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
import { describe, it, beforeAll, afterAll, expect } from "vitest";
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
    describe(`Authors can mark their own comment as spoiler - ${config.name}`, async () => {
        let pkc: PKC, authorPost: Comment;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            authorPost = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            await authorPost.update();
        });

        afterAll(async () => {
            await authorPost.stop();
        });

        it(`Regular author can't mark another author comment as spoiler`, async () => {
            const spoilerEdit = await pkc.createCommentEdit({
                communityAddress: authorPost.communityAddress,
                commentCid: authorPost.cid,
                spoiler: true,
                signer: await pkc.createSigner()
            });
            await publishWithExpectedResult({
                publication: spoilerEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_EDIT_CAN_NOT_EDIT_COMMENT_IF_NOT_ORIGINAL_AUTHOR
            });
        });

        it(`Author can mark their own comment as spoiler`, async () => {
            expect([false, undefined]).to.include(authorPost.spoiler);

            const spoilerEdit = await pkc.createCommentEdit({
                communityAddress: authorPost.communityAddress,
                commentCid: authorPost.cid,
                spoiler: true,
                signer: authorPost.signer,
                reason: "Author marking their own comment as spoiler"
            });
            await publishWithExpectedResult({ publication: spoilerEdit, expectedChallengeSuccess: true });
        });
        it(`A new CommentUpdate is published with spoiler=true`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: authorPost, predicate: async () => authorPost.spoiler === true });
            expect(authorPost.edit.spoiler).to.be.true;
            expect(authorPost.raw.commentUpdate.reason).to.be.undefined;
            expect(authorPost.raw.commentUpdate.spoiler).to.be.undefined;
            expect(authorPost.raw.commentUpdate.edit).to.exist;
            expect(authorPost.raw.commentUpdate.edit.reason).to.equal("Author marking their own comment as spoiler");
            expect(authorPost.raw.commentUpdate.edit.spoiler).to.be.true;

            expect(authorPost.reason).to.be.undefined; // reason is only for mods editing other authors' posts
            expect(authorPost.edit.reason).to.equal("Author marking their own comment as spoiler");

            expect(authorPost.spoiler).to.be.true;
        });

        it(`spoiler=true appears in pages of community`, async () => {
            const community = await pkc.createCommunity({ address: authorPost.communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => {
                    const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(authorPost.cid, community.posts);
                    return commentInPage?.spoiler === true;
                }
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(authorPost.cid, community.posts);
            expect(commentInPage.spoiler).to.be.true;
            await community.stop();
        });

        it(`The new Comment with spoiler=true has valid signature`, async () => {
            const recreatedPost = await pkc.createComment({ cid: authorPost.cid });
            await recreatedPost.update();
            await resolveWhenConditionIsTrue({
                toUpdate: recreatedPost,
                predicate: async () => typeof recreatedPost.updatedAt === "number"
            });

            await recreatedPost.stop();
            expect(recreatedPost.spoiler).to.be.true;

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
                community: { publicKey: recreatedPost.communityPublicKey, name: recreatedPost.communityName },
                comment: recreatedPost as unknown as Pick<CommentIpfsWithCidPostCidDefined, "signature" | "cid" | "depth" | "postCid">,
                validatePages: true,
                validateUpdateSignature: true
            });
            expect(commentUpdateValidity).to.deep.equal({ valid: true });
        });

        it(`Author can unspoiler their own comment`, async () => {
            const unspoilerEdit = await pkc.createCommentEdit({
                communityAddress: authorPost.communityAddress,
                commentCid: authorPost.cid,
                spoiler: false,
                signer: authorPost.signer,
                reason: "An author unspoilering their own comment"
            });
            await publishWithExpectedResult({ publication: unspoilerEdit, expectedChallengeSuccess: true });
        });
        it(`A new CommentUpdate is published with spoiler=false`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: authorPost, predicate: async () => authorPost.spoiler === false });
            expect(authorPost.edit.spoiler).to.be.false;
            expect(authorPost.raw.commentUpdate.reason).to.be.undefined;
            expect(authorPost.raw.commentUpdate.spoiler).to.be.undefined;
            expect(authorPost.raw.commentUpdate.edit).to.exist;
            expect(authorPost.raw.commentUpdate.edit.reason).to.equal("An author unspoilering their own comment");
            expect(authorPost.raw.commentUpdate.edit.spoiler).to.be.false;

            expect(authorPost.edit.reason).to.equal("An author unspoilering their own comment");
            expect(authorPost.reason).to.be.undefined;

            expect(authorPost.spoiler).to.be.false;
        });

        it(`spoiler=false appears pages of community`, async () => {
            const community = await pkc.createCommunity({ address: authorPost.communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => {
                    const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(authorPost.cid, community.posts);
                    return commentInPage?.spoiler === false;
                }
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(authorPost.cid, community.posts);
            expect(commentInPage.spoiler).to.be.false;
            await community.stop();
        });
    });

    describe(`Mods marking their own comment as spoiler - ${config.name}`, async () => {
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
            await modPost.stop();
            await pkc.destroy();
        });

        it(`Mod can mark their own comment as spoiler`, async () => {
            const spoilerEdit = await pkc.createCommentEdit({
                communityAddress: modPost.communityAddress,
                commentCid: modPost.cid,
                spoiler: true,
                signer: roles[2].signer,
                reason: "Mod marking their own comment as spoiler"
            });
            await publishWithExpectedResult({ publication: spoilerEdit, expectedChallengeSuccess: true });
        });

        it(`A new CommentUpdate is published with spoiler=true`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: modPost, predicate: async () => modPost.spoiler === true });
            expect(modPost.edit.spoiler).to.be.true;
            expect(modPost.raw.commentUpdate.reason).to.be.undefined;
            expect(modPost.raw.commentUpdate.spoiler).to.be.undefined;
            expect(modPost.raw.commentUpdate.edit).to.exist;
            expect(modPost.raw.commentUpdate.edit.reason).to.equal("Mod marking their own comment as spoiler");
            expect(modPost.raw.commentUpdate.edit.spoiler).to.be.true;

            expect(modPost.reason).to.be.undefined; // reason is defined only when it's a mod editing other authors' posts
            expect(modPost.edit.reason).to.equal("Mod marking their own comment as spoiler");
            expect(modPost.spoiler).to.be.true;
        });

        it(`spoiler=true appears in pages of community`, async () => {
            const community = await pkc.createCommunity({ address: modPost.communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => {
                    const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(modPost.cid, community.posts);
                    return commentInPage?.spoiler === true;
                }
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(modPost.cid, community.posts);
            expect(commentInPage.spoiler).to.be.true;
            await community.stop();
        });

        it(`Mod can unspoiler their own comment`, async () => {
            const unspoilerEdit = await pkc.createCommentEdit({
                communityAddress: modPost.communityAddress,
                commentCid: modPost.cid,
                spoiler: false,
                signer: roles[2].signer,
                reason: "Mod unspoilering their own comment"
            });
            await publishWithExpectedResult({ publication: unspoilerEdit, expectedChallengeSuccess: true });
        });

        it(`A new CommentUpdate is published with spoiler=false`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: modPost, predicate: async () => modPost.spoiler === false });
            expect(modPost.edit.spoiler).to.be.false;
            expect(modPost.raw.commentUpdate.reason).to.be.undefined;
            expect(modPost.raw.commentUpdate.spoiler).to.be.undefined;
            expect(modPost.raw.commentUpdate.edit).to.exist;
            expect(modPost.raw.commentUpdate.edit.reason).to.equal("Mod unspoilering their own comment");
            expect(modPost.raw.commentUpdate.edit.spoiler).to.be.false;

            expect(modPost.reason).to.be.undefined;
            expect(modPost.edit.reason).to.equal("Mod unspoilering their own comment");
            expect(modPost.spoiler).to.be.false;
        });

        it.sequential(`spoiler=false appears pages of community`, async () => {
            const community = await pkc.createCommunity({ address: modPost.communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => {
                    const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(modPost.cid, community.posts);
                    return commentInPage?.spoiler === false;
                }
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(modPost.cid, community.posts);
            expect(commentInPage.spoiler).to.be.false;
            await community.stop();
        });
    });
});

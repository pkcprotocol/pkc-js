import signers from "../../../fixtures/signers.js";
import {
    getAvailablePlebbitConfigsToTestAgainst,
    iterateThroughPagesToFindCommentInParentPagesInstance,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";

const subplebbitAddress = signers[0].address;
const roles = [
    { role: "owner", signer: signers[1] },
    { role: "admin", signer: signers[2] },
    { role: "mod", signer: signers[3] }
];

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe(`Mods marking an author comment as nsfw - ${config.name}`, async () => {
        let plebbit: Plebbit, randomPost: Comment;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            randomPost = await publishRandomPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit });
            await randomPost.update();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`Mod can mark an author comment as nsfw`, async () => {
            const modnsfwEdit = await plebbit.createCommentModeration({
                subplebbitAddress: randomPost.subplebbitAddress,
                commentCid: randomPost.cid,
                commentModeration: { nsfw: true, reason: "Mod marking an author comment as nsfw" },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: modnsfwEdit, expectedChallengeSuccess: true });
        });

        it(`A new CommentUpdate is published with nsfw=true`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: randomPost, predicate: async () => randomPost.nsfw === true });
            expect(randomPost.raw.commentUpdate.reason).to.equal("Mod marking an author comment as nsfw");
            expect(randomPost.raw.commentUpdate.nsfw).to.be.true;
            expect(randomPost.raw.commentUpdate.edit).to.be.undefined;

            expect(randomPost.reason).to.equal("Mod marking an author comment as nsfw");
            expect(randomPost.nsfw).to.be.true;
        });

        it(`nsfw=true appears in pages of subplebibt`, async () => {
            const sub = await plebbit.createSubplebbit({ address: randomPost.subplebbitAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => typeof sub.updatedAt === "number"
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(randomPost.cid, sub.posts);
            expect(commentInPage.nsfw).to.be.true;
            await sub.stop();
        });

        it(`Mod can mark unnsfw author comment `, async () => {
            const unnsfwEdit = await plebbit.createCommentModeration({
                subplebbitAddress: randomPost.subplebbitAddress,
                commentCid: randomPost.cid,
                commentModeration: { nsfw: false, reason: "Mod unnsfwing an author comment" },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: unnsfwEdit, expectedChallengeSuccess: true });
        });

        it(`A new CommentUpdate is published with nsfw=false`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: randomPost, predicate: async () => randomPost.nsfw === false });
            expect(randomPost.raw.commentUpdate.reason).to.equal("Mod unnsfwing an author comment");
            expect(randomPost.raw.commentUpdate.nsfw).to.be.false;
            expect(randomPost.raw.commentUpdate.edit).to.be.undefined;

            expect(randomPost.reason).to.equal("Mod unnsfwing an author comment");
            expect(randomPost.nsfw).to.be.false;
        });

        it(`nsfw=false appears in pages of subplebbit`, async () => {
            const sub = await plebbit.createSubplebbit({ address: randomPost.subplebbitAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => typeof sub.updatedAt === "number"
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(randomPost.cid, sub.posts);
            expect(commentInPage.nsfw).to.be.false;
            await sub.stop();
        });
    });
});

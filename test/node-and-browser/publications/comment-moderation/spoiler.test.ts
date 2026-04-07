import signers from "../../../fixtures/signers.js";
import {
    getAvailablePKCConfigsToTestAgainst,
    iterateThroughPagesToFindCommentInParentPagesInstance,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
const communityAddress = signers[0].address;
const roles = [
    { role: "owner", signer: signers[1] },
    { role: "admin", signer: signers[2] },
    { role: "mod", signer: signers[3] }
];

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`Mods marking an author comment as spoiler - ${config.name}`, async () => {
        let pkc: PKC, randomPost: Comment;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            randomPost = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            await randomPost.update();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`Mod can mark an author comment as spoiler`, async () => {
            const modSpoilerEdit = await pkc.createCommentModeration({
                communityAddress: randomPost.communityAddress,
                commentCid: randomPost.cid,
                commentModeration: { spoiler: true, reason: "Mod marking an author comment as spoiler" },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: modSpoilerEdit, expectedChallengeSuccess: true });
        });

        it(`A new CommentUpdate is published with spoiler=true`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: randomPost, predicate: async () => randomPost.spoiler === true });
            expect(randomPost.raw.commentUpdate.reason).to.equal("Mod marking an author comment as spoiler");
            expect(randomPost.raw.commentUpdate.spoiler).to.be.true;
            expect(randomPost.raw.commentUpdate.edit).to.be.undefined;

            expect(randomPost.reason).to.equal("Mod marking an author comment as spoiler");
            expect(randomPost.spoiler).to.be.true;
        });

        it(`spoiler=true appears in pages of community`, async () => {
            const sub = await pkc.createCommunity({ address: randomPost.communityAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => typeof sub.updatedAt === "number"
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(randomPost.cid, sub.posts);
            expect(commentInPage.spoiler).to.be.true;
            await sub.stop();
        });

        it(`Mod can mark unspoiler author comment `, async () => {
            const unspoilerEdit = await pkc.createCommentModeration({
                communityAddress: randomPost.communityAddress,
                commentCid: randomPost.cid,
                commentModeration: { spoiler: false, reason: "Mod unspoilering an author comment" },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: unspoilerEdit, expectedChallengeSuccess: true });
        });

        it(`A new CommentUpdate is published with spoiler=false`, async () => {
            await resolveWhenConditionIsTrue({ toUpdate: randomPost, predicate: async () => randomPost.spoiler === false });
            expect(randomPost.raw.commentUpdate.reason).to.equal("Mod unspoilering an author comment");
            expect(randomPost.raw.commentUpdate.spoiler).to.be.false;
            expect(randomPost.raw.commentUpdate.edit).to.be.undefined;

            expect(randomPost.reason).to.equal("Mod unspoilering an author comment");
            expect(randomPost.spoiler).to.be.false;
        });

        it(`spoiler=false appears in pages of community`, async () => {
            const sub = await pkc.createCommunity({ address: randomPost.communityAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => typeof sub.updatedAt === "number"
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(randomPost.cid, sub.posts);
            expect(commentInPage.spoiler).to.be.false;
            await sub.stop();
        });
    });
});

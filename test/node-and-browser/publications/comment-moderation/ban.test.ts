import signers from "../../../fixtures/signers.js";
import {
    generateMockPost,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    getAvailablePlebbitConfigsToTestAgainst,
    iterateThroughPagesToFindCommentInParentPagesInstance
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { timestamp } from "../../../../dist/node/util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";

const subplebbitAddress = signers[0].address;
const roles = [
    { role: "owner", signer: signers[1] },
    { role: "admin", signer: signers[2] },
    { role: "mod", signer: signers[3] }
];

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.concurrent(`Banning authors`, async () => {
        let plebbit: Plebbit, commentToBeBanned: Comment, authorBanExpiresAt: number, reasonOfBan: string;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            commentToBeBanned = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
            await commentToBeBanned.update();
            authorBanExpiresAt = timestamp() + 10; // Ban stays for 10 seconds
            reasonOfBan = "Just so " + Date.now();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it.sequential(`Mod can ban an author for a comment`, async () => {
            const banCommentMod = await plebbit.createCommentModeration({
                communityAddress: commentToBeBanned.communityAddress,
                commentCid: commentToBeBanned.cid,
                commentModeration: {
                    author: { banExpiresAt: authorBanExpiresAt },
                    reason: reasonOfBan
                },
                signer: roles[2].signer
            });
            expect(banCommentMod.commentModeration.author.banExpiresAt).to.equal(authorBanExpiresAt);
            await publishWithExpectedResult({ publication: banCommentMod, expectedChallengeSuccess: true });
        });

        it(`Banned author can't publish`, async () => {
            const newCommentByBannedAuthor = await generateMockPost({
                communityAddress: commentToBeBanned.communityAddress,
                plebbit: plebbit,
                postProps: {
                    signer: commentToBeBanned.signer
                }
            });
            await publishWithExpectedResult({
                publication: newCommentByBannedAuthor,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_AUTHOR_IS_BANNED
            });
        });

        it.sequential(`A new CommentUpdate with comment.author.banExpiresAt is published`, async () => {
            await resolveWhenConditionIsTrue({
                toUpdate: commentToBeBanned,
                predicate: async () => typeof commentToBeBanned.author.subplebbit?.banExpiresAt === "number"
            });
            expect(commentToBeBanned.author.subplebbit.banExpiresAt).to.equals(authorBanExpiresAt);
            expect(commentToBeBanned.reason).to.equal(reasonOfBan);
        });

        it(`author.banExpires is included in pages of subplebbit`, async () => {
            const sub = await plebbit.createSubplebbit({ address: commentToBeBanned.communityAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => typeof sub.updatedAt === "number"
            });
            const postInSubplebbitPage = await iterateThroughPagesToFindCommentInParentPagesInstance(commentToBeBanned.cid, sub.posts);
            expect(postInSubplebbitPage.author.subplebbit.banExpiresAt).to.be.a("number");
            await sub.stop();
        });

        it(`Regular author can't ban another author`, async () => {
            const tryToBanComment = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });

            const banCommentEdit = await plebbit.createCommentModeration({
                communityAddress: tryToBanComment.communityAddress,
                commentCid: tryToBanComment.cid,
                commentModeration: { author: { banExpiresAt: authorBanExpiresAt + 1000 } },
                signer: await plebbit.createSigner()
            });
            await publishWithExpectedResult({
                publication: banCommentEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_MODERATION_ATTEMPTED_WITHOUT_BEING_MODERATOR
            });
        });

        it.sequential(`Banned author can publish after authorBanExpiresAt ends`, async () => {
            await new Promise((resolve) => setTimeout(resolve, (authorBanExpiresAt - timestamp()) * 1000.0 + 1000));
            expect(timestamp()).to.be.greaterThan(authorBanExpiresAt);
            const newCommentByBannedAuthor = await generateMockPost({
                communityAddress: commentToBeBanned.communityAddress,
                plebbit: plebbit,
                postProps: {
                    signer: commentToBeBanned.signer
                }
            });
            await publishWithExpectedResult({ publication: newCommentByBannedAuthor, expectedChallengeSuccess: true });
        });
    });
});

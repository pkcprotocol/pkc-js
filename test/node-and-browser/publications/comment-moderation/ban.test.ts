import signers from "../../../fixtures/signers.js";
import {
    generateMockPost,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    getAvailablePKCConfigsToTestAgainst,
    iterateThroughPagesToFindCommentInParentPagesInstance
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { timestamp } from "../../../../dist/node/util.js";
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
    describe.concurrent(`Banning authors`, async () => {
        let pkc: PKC, commentToBeBanned: Comment, authorBanExpiresAt: number, reasonOfBan: string;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            commentToBeBanned = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            await commentToBeBanned.update();
            authorBanExpiresAt = timestamp() + 10; // Ban stays for 10 seconds
            reasonOfBan = "Just so " + Date.now();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it.sequential(`Mod can ban an author for a comment`, async () => {
            const banCommentMod = await pkc.createCommentModeration({
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
                pkc: pkc,
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
                predicate: async () => typeof commentToBeBanned.author.community?.banExpiresAt === "number"
            });
            expect(commentToBeBanned.author.community.banExpiresAt).to.equals(authorBanExpiresAt);
            expect(commentToBeBanned.reason).to.equal(reasonOfBan);
        });

        it(`author.banExpires is included in pages of community`, async () => {
            const community = await pkc.createCommunity({ address: commentToBeBanned.communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => typeof community.updatedAt === "number"
            });
            const postInCommunityPage = await iterateThroughPagesToFindCommentInParentPagesInstance(commentToBeBanned.cid, community.posts);
            expect(postInCommunityPage.author.community.banExpiresAt).to.be.a("number");
            await community.stop();
        });

        it(`Regular author can't ban another author`, async () => {
            const tryToBanComment = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });

            const banCommentEdit = await pkc.createCommentModeration({
                communityAddress: tryToBanComment.communityAddress,
                commentCid: tryToBanComment.cid,
                commentModeration: { author: { banExpiresAt: authorBanExpiresAt + 1000 } },
                signer: await pkc.createSigner()
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
                pkc: pkc,
                postProps: {
                    signer: commentToBeBanned.signer
                }
            });
            await publishWithExpectedResult({ publication: newCommentByBannedAuthor, expectedChallengeSuccess: true });
        });
    });
});

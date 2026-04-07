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
    describe.concurrent(`Mods setting flairs on a comment - ${config.name}`, async () => {
        let pkc: PKC, randomPost: Comment;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            randomPost = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            await randomPost.update();
        });

        afterAll(async () => {
            await randomPost?.stop();
            await pkc.destroy();
        });

        it.sequential(`Mod can set flairs on a comment`, async () => {
            const modFlairs = await pkc.createCommentModeration({
                communityAddress: randomPost.communityAddress,
                commentCid: randomPost.cid,
                commentModeration: {
                    flairs: [{ text: "Mod Tag", backgroundColor: "#0000ff" }],
                    reason: "Mod adding flairs"
                },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: modFlairs, expectedChallengeSuccess: true });
        });

        it.sequential(`A new CommentUpdate is published with mod flairs`, async () => {
            await resolveWhenConditionIsTrue({
                toUpdate: randomPost,
                predicate: async () => randomPost.flairs !== undefined && randomPost.flairs.length > 0
            });
            expect(randomPost.raw.commentUpdate.flairs).to.deep.equal([{ text: "Mod Tag", backgroundColor: "#0000ff" }]);
            expect(randomPost.raw.commentUpdate.reason).to.equal("Mod adding flairs");
            expect(randomPost.raw.commentUpdate.edit).to.be.undefined;

            expect(randomPost.flairs).to.deep.equal([{ text: "Mod Tag", backgroundColor: "#0000ff" }]);
            expect(randomPost.reason).to.equal("Mod adding flairs");
        });

        it(`mod flairs appear in pages of community`, async () => {
            const community = await pkc.createCommunity({ address: randomPost.communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => typeof community.updatedAt === "number"
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(randomPost.cid, community.posts);
            expect(commentInPage.flairs).to.deep.equal([{ text: "Mod Tag", backgroundColor: "#0000ff" }]);
            await community.stop();
        });
    });

    describe.concurrent(`Mods setting flairs on an author - ${config.name}`, async () => {
        let pkc: PKC, randomPost: Comment;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            randomPost = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            await randomPost.update();
        });

        afterAll(async () => {
            await randomPost?.stop();
            await pkc.destroy();
        });

        it.sequential(`Mod can set flairs on an author`, async () => {
            const modAuthorFlairs = await pkc.createCommentModeration({
                communityAddress: randomPost.communityAddress,
                commentCid: randomPost.cid,
                commentModeration: {
                    author: { flairs: [{ text: "Trusted", textColor: "#fff", backgroundColor: "#00ff00" }] },
                    reason: "Mod adding author flairs"
                },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: modAuthorFlairs, expectedChallengeSuccess: true });
        });

        it.sequential(`A new CommentUpdate is published with author flairs`, async () => {
            await resolveWhenConditionIsTrue({
                toUpdate: randomPost,
                predicate: async () => randomPost.author?.flairs !== undefined && randomPost.author.flairs.length > 0
            });
            expect(randomPost.author.flairs).to.deep.equal([{ text: "Trusted", textColor: "#fff", backgroundColor: "#00ff00" }]);
        });

        it(`author flairs appear in pages of community`, async () => {
            const community = await pkc.createCommunity({ address: randomPost.communityAddress });
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => typeof community.updatedAt === "number"
            });
            const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(randomPost.cid, community.posts);
            expect(commentInPage.author.flairs).to.deep.equal([{ text: "Trusted", textColor: "#fff", backgroundColor: "#00ff00" }]);
            await community.stop();
        });
    });

    describe.concurrent(`Mod flairs override author flairs - ${config.name}`, async () => {
        let pkc: PKC, authorPost: Comment;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            // Author publishes post with flairs
            authorPost = await publishRandomPost({
                communityAddress: communityAddress,
                pkc: pkc,
                postProps: {
                    flairs: [{ text: "Author Flair" }]
                }
            });
            await authorPost.update();
        });

        afterAll(async () => {
            await authorPost?.stop();
            await pkc.destroy();
        });

        it.sequential(`Author publishes a post with flairs`, async () => {
            await resolveWhenConditionIsTrue({
                toUpdate: authorPost,
                predicate: async () => typeof authorPost.updatedAt === "number"
            });
            expect(authorPost.flairs).to.deep.equal([{ text: "Author Flair" }]);
        });

        it.sequential(`Mod overrides flairs on the comment`, async () => {
            const modFlairs = await pkc.createCommentModeration({
                communityAddress: authorPost.communityAddress,
                commentCid: authorPost.cid,
                commentModeration: {
                    flairs: [{ text: "Mod Override" }],
                    reason: "Mod overriding author flairs"
                },
                signer: roles[2].signer
            });
            await publishWithExpectedResult({ publication: modFlairs, expectedChallengeSuccess: true });
        });

        it.sequential(`CommentUpdate reflects mod flairs overriding author flairs`, async () => {
            await resolveWhenConditionIsTrue({
                toUpdate: authorPost,
                predicate: async () =>
                    authorPost.flairs !== undefined && authorPost.flairs.length === 1 && authorPost.flairs[0].text === "Mod Override"
            });
            expect(authorPost.flairs).to.deep.equal([{ text: "Mod Override" }]);
        });
    });
});

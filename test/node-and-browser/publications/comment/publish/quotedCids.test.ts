import signers from "../../../../fixtures/signers.js";
import {
    generateMockPost,
    generateMockComment,
    publishWithExpectedResult,
    publishRandomPost,
    setExtraPropOnCommentAndSign,
    publishRandomReply,
    getAvailablePlebbitConfigsToTestAgainst,
    resolveWhenConditionIsTrue
} from "../../../../../dist/node/test/test-util.js";
import { messages } from "../../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { Plebbit } from "../../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../../dist/node/publications/comment/types.js";

const subplebbitAddress = signers[0].address;
const modSubplebbitAddress = signers[7].address; // this sub has mod roles configured

// A valid CID format that won't exist in the database
const nonExistentCid = "QmYjtig7VJQ6XsnUjqqJvj7QaMcCAwtrgNdahSiFofrE7o";

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.concurrent(`quotedCids validation - ${config.name}`, async () => {
        let plebbit: Plebbit;
        let post: Comment;
        let reply1: Comment;
        let post2: Comment; // a different post for cross-thread testing

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            // Create a post
            post = await publishRandomPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit });
            // Create a reply under the post
            reply1 = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, plebbit: plebbit });
            // Create another post for cross-thread testing
            post2 = await publishRandomPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit });
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        describe("Valid quotedCids scenarios", () => {
            it("Reply with single valid quotedCid succeeds", async () => {
                const quotedCids = [post.cid!];
                const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                    signer: signers[1],
                    quotedCids
                });
                // Verify quotedCids is set on the Comment instance
                expect(reply.quotedCids).to.deep.equal(quotedCids);
                expect(reply.raw.pubsubMessageToPublish!.quotedCids).to.deep.equal(quotedCids);
                await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
                // Verify quotedCids exists in CommentIpfs after publishing
                expect(reply.raw.comment?.quotedCids).to.deep.equal(quotedCids);
                // Fetch the comment from IPFS and verify quotedCids
                const fetchedComment = JSON.parse(await plebbit.fetchCid({ cid: reply.cid! }));
                expect(fetchedComment.quotedCids).to.deep.equal(quotedCids);
            });

            it("Reply with multiple valid quotedCids succeeds", async () => {
                const quotedCids = [post.cid!, reply1.cid!];
                const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                    signer: signers[2],
                    quotedCids
                });
                expect(reply.quotedCids).to.deep.equal(quotedCids);
                expect(reply.raw.pubsubMessageToPublish!.quotedCids).to.deep.equal(quotedCids);
                await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
                // Verify quotedCids exists in CommentIpfs after publishing
                expect(reply.raw.comment?.quotedCids).to.deep.equal(quotedCids);
                // Fetch the comment from IPFS and verify quotedCids
                const fetchedComment = JSON.parse(await plebbit.fetchCid({ cid: reply.cid! }));
                expect(fetchedComment.quotedCids).to.deep.equal(quotedCids);
            });

            it("Reply quoting the post itself succeeds", async () => {
                const quotedCids = [post.cid!];
                const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                    signer: signers[3],
                    quotedCids
                });
                expect(reply.quotedCids).to.deep.equal(quotedCids);
                await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
                // Verify quotedCids exists in CommentIpfs after publishing
                expect(reply.raw.comment?.quotedCids).to.deep.equal(quotedCids);
                // Fetch the comment from IPFS and verify quotedCids
                const fetchedComment = JSON.parse(await plebbit.fetchCid({ cid: reply.cid! }));
                expect(fetchedComment.quotedCids).to.deep.equal(quotedCids);
            });

            it("Reply without quotedCids succeeds", async () => {
                const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                    signer: signers[4]
                });
                expect(reply.quotedCids).to.be.undefined;
                expect(reply.raw.pubsubMessageToPublish!.quotedCids).to.be.undefined;
                await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
                // Verify quotedCids is undefined in CommentIpfs after publishing
                expect(reply.raw.comment?.quotedCids).to.be.undefined;
                // Fetch the comment from IPFS and verify quotedCids is undefined
                const fetchedComment = JSON.parse(await plebbit.fetchCid({ cid: reply.cid! }));
                expect(fetchedComment.quotedCids).to.be.undefined;
            });

            it("Reply with empty quotedCids array succeeds", async () => {
                const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                    signer: signers[5],
                    quotedCids: []
                });
                expect(reply.quotedCids).to.deep.equal([]);
                await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
                // Empty array should be stored as empty array in CommentIpfs
                expect(reply.raw.comment?.quotedCids).to.deep.equal([]);
                // Fetch the comment from IPFS and verify quotedCids is empty array
                const fetchedComment = JSON.parse(await plebbit.fetchCid({ cid: reply.cid! }));
                expect(fetchedComment.quotedCids).to.deep.equal([]);
            });
        });

        describe("Invalid quotedCids scenarios", () => {
            it("Post with quotedCids is rejected", async () => {
                const newPost = await generateMockPost({
                    subplebbitAddress: subplebbitAddress,
                    plebbit: plebbit,
                    postProps: {
                        signer: signers[1]
                    }
                });
                await setExtraPropOnCommentAndSign(newPost, { quotedCids: [post.cid!] }, true);
                await publishWithExpectedResult({
                    publication: newPost,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_POST_CANNOT_HAVE_QUOTED_CIDS
                });
            });

            it("Reply with non-existent quotedCid is rejected", async () => {
                const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                    signer: signers[1],
                    quotedCids: [nonExistentCid]
                });
                await publishWithExpectedResult({
                    publication: reply,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_QUOTED_CID_DOES_NOT_EXIST
                });
            });

            it("Reply quoting comment from different post is rejected", async () => {
                // Try to quote post2 from a reply under post1
                const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                    signer: signers[1],
                    quotedCids: [post2.cid!]
                });
                await publishWithExpectedResult({
                    publication: reply,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_QUOTED_CID_NOT_UNDER_POST
                });
            });

            it("Reply with duplicate quotedCids is accepted", async () => {
                const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                    signer: signers[1],
                    quotedCids: [post.cid!, post.cid!]
                });
                await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
            });

            it("Reply with one valid and one non-existent quotedCid is rejected", async () => {
                const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                    signer: signers[1],
                    quotedCids: [post.cid!, nonExistentCid]
                });
                await publishWithExpectedResult({
                    publication: reply,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_QUOTED_CID_DOES_NOT_EXIST
                });
            });

            it("Reply with one valid and one from different post is rejected", async () => {
                // post.cid is valid (under this post), post2.cid exists but is under a different post
                const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                    signer: signers[1],
                    quotedCids: [post.cid!, post2.cid!]
                });
                await publishWithExpectedResult({
                    publication: reply,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_QUOTED_CID_NOT_UNDER_POST
                });
            });
        });

        describe("Edge case quotedCids scenarios", () => {
            it("Reply quoting a sibling reply (same parent) succeeds", async () => {
                // Create two sibling replies under the same post, then a third that quotes both
                const sibling1 = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, plebbit: plebbit });
                const sibling2 = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, plebbit: plebbit });

                const quotedCids = [sibling1.cid!, sibling2.cid!];
                const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                    signer: signers[6],
                    quotedCids
                });
                expect(reply.quotedCids).to.deep.equal(quotedCids);
                await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
                expect(reply.raw.comment?.quotedCids).to.deep.equal(quotedCids);

                const fetchedComment = JSON.parse(await plebbit.fetchCid({ cid: reply.cid! }));
                expect(fetchedComment.quotedCids).to.deep.equal(quotedCids);
            });

            it("Reply quoting a deeply nested comment chain succeeds", async () => {
                // Create a chain: reply1 → reply2 (quotes reply1) → reply3 (quotes both reply1 and reply2)
                const deepReply1 = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, plebbit: plebbit });

                // reply2 quotes reply1
                const deepReply2 = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                    signer: signers[7],
                    quotedCids: [deepReply1.cid!]
                });
                await publishWithExpectedResult({ publication: deepReply2, expectedChallengeSuccess: true });
                expect(deepReply2.raw.comment?.quotedCids).to.deep.equal([deepReply1.cid!]);

                // reply3 quotes both reply1 and reply2
                const quotedCids = [deepReply1.cid!, deepReply2.cid!];
                const deepReply3 = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                    signer: signers[8],
                    quotedCids
                });
                await publishWithExpectedResult({ publication: deepReply3, expectedChallengeSuccess: true });
                expect(deepReply3.raw.comment?.quotedCids).to.deep.equal(quotedCids);

                const fetchedComment = JSON.parse(await plebbit.fetchCid({ cid: deepReply3.cid! }));
                expect(fetchedComment.quotedCids).to.deep.equal(quotedCids);
            });

            it("Reply with many valid quotedCids succeeds", async () => {
                // Create multiple replies and quote all of them
                const replyPromises = [];
                for (let i = 0; i < 10; i++) {
                    replyPromises.push(publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, plebbit: plebbit }));
                }
                const replies = await Promise.all(replyPromises);

                const quotedCids = replies.map((r) => r.cid!);
                const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                    signer: signers[9],
                    quotedCids
                });
                expect(reply.quotedCids).to.deep.equal(quotedCids);
                await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
                expect(reply.raw.comment?.quotedCids).to.deep.equal(quotedCids);

                const fetchedComment = JSON.parse(await plebbit.fetchCid({ cid: reply.cid! }));
                expect(fetchedComment.quotedCids).to.deep.equal(quotedCids);
            });
        });
    });
});

// Separate test suite for removed/deleted comment quoting (uses modSubplebbitAddress which has roles)
getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.concurrent(`quotedCids with removed/deleted comments - ${config.name}`, async () => {
        let plebbit: Plebbit;
        let post: Comment;
        let replyToRemove: Comment;
        let replyToDelete: Comment;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            // Create a post
            post = await publishRandomPost({ subplebbitAddress: modSubplebbitAddress, plebbit: plebbit });
            // Create replies that will be removed/deleted
            replyToRemove = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, plebbit: plebbit });
            replyToDelete = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, plebbit: plebbit });

            // Remove the first reply (mod action)
            const removeModeration = await plebbit.createCommentModeration({
                subplebbitAddress: modSubplebbitAddress,
                commentCid: replyToRemove.cid,
                commentModeration: { removed: true, reason: "For quotedCids test" },
                signer: signers[3] // mod signer
            });
            await publishWithExpectedResult({ publication: removeModeration, expectedChallengeSuccess: true });

            // Delete the second reply (author action)
            const deleteEdit = await plebbit.createCommentEdit({
                subplebbitAddress: modSubplebbitAddress,
                commentCid: replyToDelete.cid,
                deleted: true,
                signer: replyToDelete.signer,
                reason: "For quotedCids test"
            });
            await publishWithExpectedResult({ publication: deleteEdit, expectedChallengeSuccess: true });

            // Wait for updates to be applied
            await replyToRemove.update();
            await replyToDelete.update();
            await resolveWhenConditionIsTrue({
                toUpdate: replyToRemove,
                predicate: async () => replyToRemove.removed === true
            });
            await resolveWhenConditionIsTrue({
                toUpdate: replyToDelete,
                predicate: async () => replyToDelete.deleted === true
            });
        });

        afterAll(async () => {
            await replyToRemove.stop();
            await replyToDelete.stop();
            await plebbit.destroy();
        });

        it("Reply quoting a removed comment succeeds", async () => {
            expect(replyToRemove.removed).to.be.true;
            const quotedCids = [replyToRemove.cid!];
            const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                signer: signers[1],
                quotedCids
            });
            expect(reply.quotedCids).to.deep.equal(quotedCids);
            await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
            expect(reply.raw.comment?.quotedCids).to.deep.equal(quotedCids);
        });

        it("Reply quoting a deleted comment succeeds", async () => {
            expect(replyToDelete.deleted).to.be.true;
            const quotedCids = [replyToDelete.cid!];
            const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                signer: signers[2],
                quotedCids
            });
            expect(reply.quotedCids).to.deep.equal(quotedCids);
            await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
            expect(reply.raw.comment?.quotedCids).to.deep.equal(quotedCids);
        });

        it("Reply quoting both removed and deleted comments succeeds", async () => {
            expect(replyToRemove.removed).to.be.true;
            expect(replyToDelete.deleted).to.be.true;
            const quotedCids = [replyToRemove.cid!, replyToDelete.cid!];
            const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
                signer: signers[4],
                quotedCids
            });
            expect(reply.quotedCids).to.deep.equal(quotedCids);
            await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
            expect(reply.raw.comment?.quotedCids).to.deep.equal(quotedCids);
        });
    });
});

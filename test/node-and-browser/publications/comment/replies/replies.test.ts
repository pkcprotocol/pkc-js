import {
    publishRandomPost,
    getAvailablePKCConfigsToTestAgainst,
    publishRandomReply,
    mockPKCV2,
    loadAllPagesBySortName,
    isPKCFetchingUsingGateways,
    waitTillReplyInParentPagesInstance,
    resolveWhenConditionIsTrue
} from "../../../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../../../helpers/conditional-tests.js";
import { POST_REPLIES_SORT_TYPES, REPLY_REPLIES_SORT_TYPES } from "../../../../../dist/node/pages/util.js";
import signers from "../../../../fixtures/signers.js";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { messages } from "../../../../../dist/node/errors.js";
import { testCommentFieldsInPageJson } from "../../../pages/pages-test-util.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKCError } from "../../../../../dist/node/pkc-error.js";
import type { CommentIpfsWithCidDefined } from "../../../../../dist/node/publications/comment/types.js";
import type { PKC } from "../../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../../dist/node/publications/comment/comment.js";
import type { RemoteCommunity } from "../../../../../dist/node/community/remote-community.js";

// Helper type for replies that require both cid and parentCid
type ReplyWithRequiredFields = Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & { communityAddress: string }>;

const communityAddress = signers[0].address;

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent("post.replies - " + config.name, async () => {
        let pkc: PKC, community: RemoteCommunity;
        let post: Comment, firstLevelReply: Comment, secondLevelReply: Comment, thirdLevelReply: Comment;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            community = await pkc.getCommunity({ address: signers[0].address });
            post = await publishRandomPost({ communityAddress: community.address, pkc: pkc });
            await post.update();
            await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => typeof post.updatedAt === "number" });
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`A post should have no replies field if it doesn't have replies`, async () => {
            expect(post.replies.pages).to.deep.equal({});
            expect(post.replies.pageCids).to.deep.equal({});
        });

        it.sequential(`If all replies fit in a single preloaded page, there should not be any pageCids on CommentUpdate`, async () => {
            firstLevelReply = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, pkc: pkc });
            secondLevelReply = await publishRandomReply({ parentComment: firstLevelReply as CommentIpfsWithCidDefined, pkc: pkc });
            thirdLevelReply = await publishRandomReply({ parentComment: secondLevelReply as CommentIpfsWithCidDefined, pkc: pkc });
            await waitTillReplyInParentPagesInstance(firstLevelReply as unknown as ReplyWithRequiredFields, post);
            await post.stop(); // make sure updates are stopped so it does't change props while run our expect statements
            expect(post.replies.pages.best).to.exist;
            expect(post.replies.pages.best.comments.length).to.be.at.least(1); // we don't know if other tests will publish more replies
            expect(post.replies.pages.best.comments[0].cid).to.equal(firstLevelReply.cid);
            expect(post.replies.pages.best.nextCid).to.be.undefined; // only a single preloaded page
            expect(post.replies.pageCids).to.deep.equal({}); // no page cids cause it's a single preloaded page
            await post.update();
        });
        it.sequential(`A preloaded page should not have a corresponding CID in post.replies.pageCids`, async () => {
            for (const preloadedPageSortName of Object.keys(post.replies.pages))
                expect(post.replies.pageCids[preloadedPageSortName]).to.be.undefined;
        });

        it.sequential(`The PageIpfs.comments.comment always correspond to PageIpfs.comment.commentUpdate.cid`, async () => {
            const postReplySortNames = Object.keys(POST_REPLIES_SORT_TYPES).filter(
                (sortName) => post.replies.pageCids[sortName] || post.replies.pages[sortName]
            );
            expect(postReplySortNames.length).to.be.greaterThan(0);
            for (const postReplySortName of postReplySortNames) {
                const commentsFromEachPage = await loadAllPagesBySortName(postReplySortName, post.replies);
                const commentsPageIpfs = commentsFromEachPage.map((comment) => comment.raw);

                for (const commentInPageIpfs of commentsPageIpfs) {
                    const calculatedCid = await calculateIpfsHash(JSON.stringify(commentInPageIpfs.comment));
                    expect(calculatedCid).to.equal(commentInPageIpfs.commentUpdate.cid);
                }
            }
        });
    });
});

getAvailablePKCConfigsToTestAgainst().map((config) => {
    let pkc: PKC, reply: Comment, community: RemoteCommunity;
    describe.concurrent(`reply.replies - ${config.name}`, async () => {
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            community = await pkc.getCommunity({ address: communityAddress });
            const post = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            reply = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, pkc: pkc });
            await reply.update();
        });
        afterAll(async () => {
            await pkc.destroy();
        });

        it(`A reply should have no replies field if it doesn't have replies`, async () => {
            expect(reply.replies.pages).to.deep.equal({});
            expect(reply.replies.pageCids).to.deep.equal({});
        });

        it.sequential(`If all replies fit in a single preloaded page, there should not be any pageCids on CommentUpdate`, async () => {
            const replyUnderReply = await publishRandomReply({ parentComment: reply as CommentIpfsWithCidDefined, pkc: pkc });
            await waitTillReplyInParentPagesInstance(replyUnderReply as unknown as ReplyWithRequiredFields, reply);
            expect(reply.replies.pages.best).to.exist;
            expect(reply.replies.pages.best.comments.length).to.equal(1);
            expect(reply.replies.pages.best.comments[0].cid).to.equal(replyUnderReply.cid);
            expect(reply.replies.pages.best.nextCid).to.be.undefined; // only a single preloaded page
            expect(reply.replies.pageCids).to.deep.equal({}); // no page cids cause it's a single preloaded page
        });

        it.sequential(`A preloaded page should not have a corresponding CID in reply.replies.pageCids`, async () => {
            for (const preloadedPageSortName of Object.keys(reply.replies.pages))
                expect(reply.replies.pageCids[preloadedPageSortName]).to.be.undefined;
        });

        it.sequential(`Stringified reply.replies still have all props`, async () => {
            const preloadedPages = reply.replies.pages;
            for (const preloadedSortType of Object.keys(preloadedPages)) {
                const stringifiedReplies = JSON.parse(JSON.stringify(reply.replies)).pages[preloadedSortType].comments;
                for (const reply of stringifiedReplies) testCommentFieldsInPageJson(reply);
            }
        });

        it.sequential(`The PageIpfs.comments.comment always correspond to PageIpfs.comment.commentUpdate.cid`, async () => {
            const availableReplySorts = Object.keys(REPLY_REPLIES_SORT_TYPES).filter(
                (sortName) => reply.replies.pageCids[sortName] || reply.replies.pages[sortName]
            );
            expect(availableReplySorts.length).to.be.greaterThan(0);
            for (const replySortName of availableReplySorts) {
                const commentsFromEachPage = await loadAllPagesBySortName(replySortName, reply.replies);
                const commentsPageIpfs = commentsFromEachPage.map((comment) => comment.raw);

                for (const commentInPageIpfs of commentsPageIpfs) {
                    const calculatedCid = await calculateIpfsHash(JSON.stringify(commentInPageIpfs.comment));
                    expect(calculatedCid).to.equal(commentInPageIpfs.commentUpdate.cid);
                }
            }
        });
    });
});
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent("comment.replies - " + config.name, async () => {
        let pkc: PKC, post: Comment;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            post = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        describe.concurrent(`comment.replies.getPage - ${config.name}`, async () => {
            itSkipIfRpc("replies.getPage will throw a timeout error when request times out", async () => {
                // Create a pkc instance with a very short timeout for page-ipfs
                const pkc = await mockPKCV2({ pkcOptions: { validatePages: false }, remotePKC: true });

                pkc._timeouts["page-ipfs"] = 100;

                // Create a comment with a CID that doesn't exist or will time out
                const nonExistentCid = "QmbSiusGgY4Uk5LdAe91bzLkBzidyKyKHRKwhXPDz7gGzx"; // Random CID that doesn't exist

                const comment = await pkc.getComment({ cid: post.cid });

                // Override the pageCid to use our non-existent CID
                comment.replies.pageCids.new = nonExistentCid;

                try {
                    // This should time out
                    await comment.replies.getPage({ cid: nonExistentCid });
                    expect.fail("Should have timed out");
                } catch (e) {
                    if (isPKCFetchingUsingGateways(pkc)) {
                        expect((e as PKCError).code).to.equal("ERR_FAILED_TO_FETCH_PAGE_IPFS_FROM_GATEWAYS");
                        for (const gatewayUrl of Object.keys(pkc.clients.ipfsGateways))
                            expect((e as PKCError).details.gatewayToError[gatewayUrl].code).to.equal("ERR_GATEWAY_TIMED_OUT_OR_ABORTED");
                    } else {
                        expect((e as PKCError).code).to.equal("ERR_FETCH_CID_P2P_TIMEOUT");
                    }
                }
                await pkc.destroy();
            });
        });
    });

    describe.concurrent("replies.validatePage validation tests", async () => {
        let pkc: PKC, postWithReplies: Comment;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise({ pkcOptions: { validatePages: false } });
            postWithReplies = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            const reply = await publishRandomReply({ parentComment: postWithReplies as CommentIpfsWithCidDefined, pkc: pkc });
            await publishRandomReply({ parentComment: reply as CommentIpfsWithCidDefined, pkc: pkc });

            await postWithReplies.update();
            await waitTillReplyInParentPagesInstance(reply as unknown as ReplyWithRequiredFields, postWithReplies);
            await postWithReplies.stop();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`replies.validatePage will throw if any comment is invalid`, async () => {
            const pkc = await config.pkcInstancePromise({ pkcOptions: { validatePages: false } });

            const pageWithInvalidComment = postWithReplies.replies.pages.best.nextCid
                ? await postWithReplies.replies.getPage({ cid: postWithReplies.replies.pageCids.new })
                : JSON.parse(JSON.stringify(postWithReplies.replies.pages.best));
            pageWithInvalidComment.comments[0].raw.comment.content = "this is to invalidate signature";

            const post = await pkc.getComment({ cid: postWithReplies.cid });
            try {
                await post.replies.validatePage(pageWithInvalidComment);
                expect.fail("Should have thrown");
            } catch (e) {
                expect((e as PKCError).code).to.equal("ERR_REPLIES_PAGE_IS_INVALID");
                expect((e as PKCError).details.signatureValidity.reason).to.equal(messages.ERR_SIGNATURE_IS_INVALID);
            }
            await pkc.destroy();
        });

        it(`replies.validatePage will throw if any comment is not of the same post`, async () => {
            const pkc = await config.pkcInstancePromise({ pkcOptions: { validatePages: false } });

            const pageWithInvalidComment = postWithReplies.replies.pages.best.nextCid
                ? await postWithReplies.replies.getPage({ cid: postWithReplies.replies.pageCids.new })
                : JSON.parse(JSON.stringify(postWithReplies.replies.pages.best));
            pageWithInvalidComment.comments[0].raw.comment.postCid += "1"; // will be a different post cid

            const post = await pkc.getComment({ cid: postWithReplies.cid });
            try {
                await post.replies.validatePage(pageWithInvalidComment);
                expect.fail("Should have thrown");
            } catch (e) {
                expect((e as PKCError).code).to.equal("ERR_REPLIES_PAGE_IS_INVALID");
                expect((e as PKCError).details.signatureValidity.reason).to.equal(
                    messages.ERR_PAGE_COMMENT_POST_CID_IS_NOT_SAME_AS_POST_CID_OF_COMMENT_INSTANCE
                );
            }
            await pkc.destroy();
        });

        it(`replies.validatePage will throw if postCid not defined on the parent comment`, async () => {
            const pkc = await config.pkcInstancePromise({ pkcOptions: { validatePages: false } });

            const pageWithInvalidComment = postWithReplies.replies.pages.best.nextCid
                ? await postWithReplies.replies.getPage({ cid: postWithReplies.replies.pageCids.new })
                : JSON.parse(JSON.stringify(postWithReplies.replies.pages.best));

            const post = await pkc.getComment({ cid: postWithReplies.cid });
            delete post.postCid;
            try {
                await post.replies.validatePage(pageWithInvalidComment);
                expect.fail("Should have thrown");
            } catch (e) {
                expect((e as PKCError).code).to.equal("ERR_USER_ATTEMPTS_TO_VALIDATE_REPLIES_PAGE_WITHOUT_PARENT_COMMENT_POST_CID");
            }
            await pkc.destroy();
        });

        it("validates flat pages correctly", async () => {
            if (!postWithReplies.replies.pages.best.nextCid) return; // can only test flat pages when we have multiple pages
            // Get a flat page
            const flatSortName = Object.keys(POST_REPLIES_SORT_TYPES).find((name) => POST_REPLIES_SORT_TYPES[name].flat);
            const flatPage = await postWithReplies.replies.getPage({ cid: postWithReplies.replies.pageCids[flatSortName] });
            // Verify that flat pages contain comments with different depths
            expect(flatPage.comments.some((comment) => comment.raw.comment.depth > 1)).to.be.true;
            expect(flatPage.comments.map((comment) => comment.raw.comment.depth)).to.not.deep.equal(
                Array(flatPage.comments.length).fill(flatPage.comments[0].raw.comment.depth)
            );

            // This should pass validation
            await postWithReplies.replies.validatePage(flatPage);

            // Modify the page to make it invalid and test that validation fails
            const invalidFlatPage = JSON.parse(JSON.stringify(flatPage));
            invalidFlatPage.comments[0].raw.comment.content = "modified content to invalidate signature";

            try {
                await postWithReplies.replies.validatePage(invalidFlatPage);
                expect.fail("Should have thrown");
            } catch (e) {
                expect((e as PKCError).code).to.equal("ERR_REPLIES_PAGE_IS_INVALID");
                expect((e as PKCError).details.signatureValidity.reason).to.equal(messages.ERR_SIGNATURE_IS_INVALID);
            }
        });

        it("fails validation when a comment has invalid depth (not parent.depth + 1)", async () => {
            const invalidPage = postWithReplies.replies.pages.best.nextCid
                ? await postWithReplies.replies.getPage({ cid: postWithReplies.replies.pageCids.new })
                : JSON.parse(JSON.stringify(postWithReplies.replies.pages.best));

            invalidPage.comments[0].raw.comment.depth = 5;
            invalidPage.comments[0].raw.commentUpdate.cid = await calculateIpfsHash(JSON.stringify(invalidPage.comments[0].raw.comment));
            try {
                await postWithReplies.replies.validatePage(invalidPage);
                expect.fail("Should have thrown");
            } catch (e) {
                expect((e as PKCError).code).to.equal("ERR_REPLIES_PAGE_IS_INVALID");
                expect((e as PKCError).details.signatureValidity.reason).to.equal(
                    messages.ERR_PAGE_COMMENT_DEPTH_VALUE_IS_NOT_RELATIVE_TO_ITS_PARENT
                );
            }
        });

        it("fails validation when a comment has different communityPublicKey", async () => {
            const invalidPage = postWithReplies.replies.pages.best.nextCid
                ? await postWithReplies.replies.getPage({ cid: postWithReplies.replies.pageCids.new })
                : JSON.parse(JSON.stringify(postWithReplies.replies.pages.best));

            invalidPage.comments[0].raw.comment.communityPublicKey = "different-address";
            invalidPage.comments[0].raw.commentUpdate.cid = await calculateIpfsHash(JSON.stringify(invalidPage.comments[0].raw.comment));

            try {
                await postWithReplies.replies.validatePage(invalidPage);
                expect.fail("Should have thrown");
            } catch (e) {
                expect((e as PKCError).code).to.equal("ERR_REPLIES_PAGE_IS_INVALID");
                expect((e as PKCError).details.signatureValidity.reason).to.equal(
                    messages.ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_COMMUNITY
                );
            }
        });

        it("fails validation when a reply has incorrect parentCid", async () => {
            const invalidPage = postWithReplies.replies.pages.best.nextCid
                ? await postWithReplies.replies.getPage({ cid: postWithReplies.replies.pageCids.new })
                : JSON.parse(JSON.stringify(postWithReplies.replies.pages.best));

            // Change the parentCid to an invalid value
            invalidPage.comments[0].raw.comment.parentCid = "QmInvalidParentCid";

            try {
                await postWithReplies.replies.validatePage(invalidPage);
                expect.fail("Should have thrown");
            } catch (e) {
                expect((e as PKCError).code).to.equal("ERR_REPLIES_PAGE_IS_INVALID");
                expect((e as PKCError).details.signatureValidity.reason).to.equal(
                    messages.ERR_PARENT_CID_OF_COMMENT_IN_PAGE_IS_NOT_CORRECT
                );
            }
        });

        it("fails validation when calculated CID doesn't match commentUpdate.cid", async () => {
            const invalidPage = postWithReplies.replies.pages.best.nextCid
                ? await postWithReplies.replies.getPage({ cid: postWithReplies.replies.pageCids.new })
                : JSON.parse(JSON.stringify(postWithReplies.replies.pages.best));

            // Modify the comment but keep the same commentUpdate.cid
            invalidPage.comments[0].raw.comment.timestamp += 1000; // Change timestamp
            // The commentUpdate.cid will now be incorrect because it was calculated from the original comment

            try {
                await postWithReplies.replies.validatePage(invalidPage);
                expect.fail("Should have thrown");
            } catch (e) {
                expect((e as PKCError).code).to.equal("ERR_REPLIES_PAGE_IS_INVALID");
                expect((e as PKCError).details.signatureValidity.reason).to.equal(messages.ERR_SIGNATURE_IS_INVALID);
            }
        });

        it("validates empty pages (no comments)", async () => {
            // Create an empty page
            const validPage = postWithReplies.replies.pages.best.nextCid
                ? await postWithReplies.replies.getPage({ cid: postWithReplies.replies.pageCids.new })
                : JSON.parse(JSON.stringify(postWithReplies.replies.pages.best));
            const emptyPage = {
                ...validPage,
                comments: []
            };

            // Empty pages should be valid
            await postWithReplies.replies.validatePage(emptyPage);
        });
    });
});

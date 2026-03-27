import {
    publishRandomPost,
    getAvailablePlebbitConfigsToTestAgainst,
    publishRandomReply,
    mockPlebbitV2,
    loadAllPagesBySortName,
    isPlebbitFetchingUsingGateways,
    waitTillReplyInParentPagesInstance,
    resolveWhenConditionIsTrue,
    itSkipIfRpc
} from "../../../../../dist/node/test/test-util.js";
import { POST_REPLIES_SORT_TYPES, REPLY_REPLIES_SORT_TYPES } from "../../../../../dist/node/pages/util.js";
import signers from "../../../../fixtures/signers.js";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { messages } from "../../../../../dist/node/errors.js";
import { testCommentFieldsInPageJson } from "../../../pages/pages-test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PlebbitError } from "../../../../../dist/node/plebbit-error.js";
import type { CommentIpfsWithCidDefined } from "../../../../../dist/node/publications/comment/types.js";
import type { Plebbit } from "../../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../../dist/node/publications/comment/comment.js";
import type { RemoteSubplebbit } from "../../../../../dist/node/subplebbit/remote-subplebbit.js";

// Helper type for replies that require both cid and parentCid
type ReplyWithRequiredFields = Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & { communityAddress: string }>;

const subplebbitAddress = signers[0].address;

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.concurrent("post.replies - " + config.name, async () => {
        let plebbit: Plebbit, subplebbit: RemoteSubplebbit;
        let post: Comment, firstLevelReply: Comment, secondLevelReply: Comment, thirdLevelReply: Comment;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            subplebbit = await plebbit.getSubplebbit({ address: signers[0].address });
            post = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: plebbit });
            await post.update();
            await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => typeof post.updatedAt === "number" });
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`A post should have no replies field if it doesn't have replies`, async () => {
            expect(post.replies.pages).to.deep.equal({});
            expect(post.replies.pageCids).to.deep.equal({});
        });

        it.sequential(`If all replies fit in a single preloaded page, there should not be any pageCids on CommentUpdate`, async () => {
            firstLevelReply = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, plebbit: plebbit });
            secondLevelReply = await publishRandomReply({ parentComment: firstLevelReply as CommentIpfsWithCidDefined, plebbit: plebbit });
            thirdLevelReply = await publishRandomReply({ parentComment: secondLevelReply as CommentIpfsWithCidDefined, plebbit: plebbit });
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

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    let plebbit: Plebbit, reply: Comment, subplebbit: RemoteSubplebbit;
    describe.concurrent(`reply.replies - ${config.name}`, async () => {
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            subplebbit = await plebbit.getSubplebbit({ address: subplebbitAddress });
            const post = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
            reply = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, plebbit: plebbit });
            await reply.update();
        });
        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`A reply should have no replies field if it doesn't have replies`, async () => {
            expect(reply.replies.pages).to.deep.equal({});
            expect(reply.replies.pageCids).to.deep.equal({});
        });

        it.sequential(`If all replies fit in a single preloaded page, there should not be any pageCids on CommentUpdate`, async () => {
            const replyUnderReply = await publishRandomReply({ parentComment: reply as CommentIpfsWithCidDefined, plebbit: plebbit });
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
getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.concurrent("comment.replies - " + config.name, async () => {
        let plebbit: Plebbit, post: Comment;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            post = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        describe.concurrent(`comment.replies.getPage - ${config.name}`, async () => {
            itSkipIfRpc("replies.getPage will throw a timeout error when request times out", async () => {
                // Create a plebbit instance with a very short timeout for page-ipfs
                const plebbit = await mockPlebbitV2({ plebbitOptions: { validatePages: false }, remotePlebbit: true });

                plebbit._timeouts["page-ipfs"] = 100;

                // Create a comment with a CID that doesn't exist or will time out
                const nonExistentCid = "QmbSiusGgY4Uk5LdAe91bzLkBzidyKyKHRKwhXPDz7gGzx"; // Random CID that doesn't exist

                const comment = await plebbit.getComment({ cid: post.cid });

                // Override the pageCid to use our non-existent CID
                comment.replies.pageCids.new = nonExistentCid;

                try {
                    // This should time out
                    await comment.replies.getPage({ cid: nonExistentCid });
                    expect.fail("Should have timed out");
                } catch (e) {
                    if (isPlebbitFetchingUsingGateways(plebbit)) {
                        expect((e as PlebbitError).code).to.equal("ERR_FAILED_TO_FETCH_PAGE_IPFS_FROM_GATEWAYS");
                        for (const gatewayUrl of Object.keys(plebbit.clients.ipfsGateways))
                            expect((e as PlebbitError).details.gatewayToError[gatewayUrl].code).to.equal(
                                "ERR_GATEWAY_TIMED_OUT_OR_ABORTED"
                            );
                    } else {
                        expect((e as PlebbitError).code).to.equal("ERR_FETCH_CID_P2P_TIMEOUT");
                    }
                }
                await plebbit.destroy();
            });
        });
    });

    describe.concurrent("replies.validatePage validation tests", async () => {
        let plebbit: Plebbit, postWithReplies: Comment;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise({ plebbitOptions: { validatePages: false } });
            postWithReplies = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
            const reply = await publishRandomReply({ parentComment: postWithReplies as CommentIpfsWithCidDefined, plebbit: plebbit });
            await publishRandomReply({ parentComment: reply as CommentIpfsWithCidDefined, plebbit: plebbit });

            await postWithReplies.update();
            await waitTillReplyInParentPagesInstance(reply as unknown as ReplyWithRequiredFields, postWithReplies);
            await postWithReplies.stop();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`replies.validatePage will throw if any comment is invalid`, async () => {
            const plebbit = await config.plebbitInstancePromise({ plebbitOptions: { validatePages: false } });

            const pageWithInvalidComment = postWithReplies.replies.pages.best.nextCid
                ? await postWithReplies.replies.getPage({ cid: postWithReplies.replies.pageCids.new })
                : JSON.parse(JSON.stringify(postWithReplies.replies.pages.best));
            pageWithInvalidComment.comments[0].raw.comment.content = "this is to invalidate signature";

            const post = await plebbit.getComment({ cid: postWithReplies.cid });
            try {
                await post.replies.validatePage(pageWithInvalidComment);
                expect.fail("Should have thrown");
            } catch (e) {
                expect((e as PlebbitError).code).to.equal("ERR_REPLIES_PAGE_IS_INVALID");
                expect((e as PlebbitError).details.signatureValidity.reason).to.equal(messages.ERR_SIGNATURE_IS_INVALID);
            }
            await plebbit.destroy();
        });

        it(`replies.validatePage will throw if any comment is not of the same post`, async () => {
            const plebbit = await config.plebbitInstancePromise({ plebbitOptions: { validatePages: false } });

            const pageWithInvalidComment = postWithReplies.replies.pages.best.nextCid
                ? await postWithReplies.replies.getPage({ cid: postWithReplies.replies.pageCids.new })
                : JSON.parse(JSON.stringify(postWithReplies.replies.pages.best));
            pageWithInvalidComment.comments[0].raw.comment.postCid += "1"; // will be a different post cid

            const post = await plebbit.getComment({ cid: postWithReplies.cid });
            try {
                await post.replies.validatePage(pageWithInvalidComment);
                expect.fail("Should have thrown");
            } catch (e) {
                expect((e as PlebbitError).code).to.equal("ERR_REPLIES_PAGE_IS_INVALID");
                expect((e as PlebbitError).details.signatureValidity.reason).to.equal(
                    messages.ERR_PAGE_COMMENT_POST_CID_IS_NOT_SAME_AS_POST_CID_OF_COMMENT_INSTANCE
                );
            }
            await plebbit.destroy();
        });

        it(`replies.validatePage will throw if postCid not defined on the parent comment`, async () => {
            const plebbit = await config.plebbitInstancePromise({ plebbitOptions: { validatePages: false } });

            const pageWithInvalidComment = postWithReplies.replies.pages.best.nextCid
                ? await postWithReplies.replies.getPage({ cid: postWithReplies.replies.pageCids.new })
                : JSON.parse(JSON.stringify(postWithReplies.replies.pages.best));

            const post = await plebbit.getComment({ cid: postWithReplies.cid });
            delete post.postCid;
            try {
                await post.replies.validatePage(pageWithInvalidComment);
                expect.fail("Should have thrown");
            } catch (e) {
                expect((e as PlebbitError).code).to.equal("ERR_USER_ATTEMPTS_TO_VALIDATE_REPLIES_PAGE_WITHOUT_PARENT_COMMENT_POST_CID");
            }
            await plebbit.destroy();
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
                expect((e as PlebbitError).code).to.equal("ERR_REPLIES_PAGE_IS_INVALID");
                expect((e as PlebbitError).details.signatureValidity.reason).to.equal(messages.ERR_SIGNATURE_IS_INVALID);
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
                expect((e as PlebbitError).code).to.equal("ERR_REPLIES_PAGE_IS_INVALID");
                expect((e as PlebbitError).details.signatureValidity.reason).to.equal(
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
                expect((e as PlebbitError).code).to.equal("ERR_REPLIES_PAGE_IS_INVALID");
                expect((e as PlebbitError).details.signatureValidity.reason).to.equal(messages.ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_SUB);
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
                expect((e as PlebbitError).code).to.equal("ERR_REPLIES_PAGE_IS_INVALID");
                expect((e as PlebbitError).details.signatureValidity.reason).to.equal(
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
                expect((e as PlebbitError).code).to.equal("ERR_REPLIES_PAGE_IS_INVALID");
                expect((e as PlebbitError).details.signatureValidity.reason).to.equal(messages.ERR_SIGNATURE_IS_INVALID);
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

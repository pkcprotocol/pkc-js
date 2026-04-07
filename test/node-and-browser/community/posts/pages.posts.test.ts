import {
    publishRandomPost,
    mockGatewayPKC,
    addStringToIpfs,
    getAvailablePKCConfigsToTestAgainst,
    waitTillPostInCommunityPages,
    publishRandomReply,
    loadAllPagesBySortName,
    isPKCFetchingUsingGateways,
    resolveWhenConditionIsTrue,
    itSkipIfRpc
} from "../../../../dist/node/test/test-util.js";
import { testCommentFieldsInPageJson, testPageCommentsIfSortedCorrectly } from "../../pages/pages-test-util.js";
import signers from "../../../fixtures/signers.js";
import * as remeda from "remeda";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { Buffer } from "buffer";
import { messages } from "../../../../dist/node/errors.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { describe, it, beforeAll, afterAll } from "vitest";

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../../dist/node/community/remote-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { PKCError } from "../../../../dist/node/pkc-error.js";
import type { PageTypeJson } from "../../../../dist/node/pages/types.js";
import type { CommentIpfsWithCidDefined, CommentWithinRepliesPostsPageJson } from "../../../../dist/node/publications/comment/types.js";

const communityAddress = signers[0].address;

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.sequential(`community.posts - ${config.name}`, async () => {
        let pkc: PKCType, newPost: Comment, community: RemoteCommunity;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            newPost = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc }); // After publishing this post it should appear on all pages
            await waitTillPostInCommunityPages(newPost as Comment & { cid: string }, pkc);
            community = await pkc.getCommunity({ address: communityAddress });
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`Stringified community.posts still have all props`, async () => {
            const stringifedPosts = JSON.parse(JSON.stringify(community)).posts.pages.hot.comments;

            for (const post of stringifedPosts) {
                if (!post.replies?.pages) continue;
                const pages = post.replies.pages;
                for (const preloadedSortType of Object.keys(pages)) {
                    const stringifiedReplies = JSON.parse(JSON.stringify(post.replies)).pages[preloadedSortType].comments;
                    for (const reply of stringifiedReplies) testCommentFieldsInPageJson(reply);
                }
            }
        });

        it(`If all posts fit in a single preloaded page, there should not be any pageCids on CommunityIpfs`, async () => {
            if (community.posts.pages.hot.nextCid) return;
            expect(community.posts.pageCids).to.deep.equal({});
        });
        it(`A preloaded page should not have a corresponding CID in community.posts.pageCids`, async () => {
            for (const preloadedPageSortName of Object.keys(community.posts.pages))
                expect(community.posts.pageCids[preloadedPageSortName]).to.be.undefined;
        });

        it(`Newly published post appears on preloaded pages`, async () => {
            expect(Object.keys(community.posts.pages).length).to.be.greaterThan(0);
            for (const preloadedPageSortName of Object.keys(community.posts.pages)) {
                const allPostsUnderPreloadedSortName = await loadAllPagesBySortName(preloadedPageSortName, community.posts);
                const postInPreloadedPage = allPostsUnderPreloadedSortName.find((postInPage) => postInPage.cid === newPost.cid);
                expect(postInPreloadedPage).to.exist;
                testCommentFieldsInPageJson(postInPreloadedPage as CommentWithinRepliesPostsPageJson);
            }
        });

        it(`Preloaded pages are sorted correctly`, async () => {
            expect(Object.keys(community.posts.pages).length).to.be.greaterThan(0);
            for (const preloadedPageSortName of Object.keys(community.posts.pages)) {
                const allPostsUnderPreloadedSortName = (await loadAllPagesBySortName(
                    preloadedPageSortName,
                    community.posts
                )) as CommentWithinRepliesPostsPageJson[];
                await testPageCommentsIfSortedCorrectly(allPostsUnderPreloadedSortName, preloadedPageSortName, community);
            }
        });

        it(`In preloaded pages The PageIpfs.comments.comment always correspond to PageIpfs.comment.commentUpdate.cid`, async () => {
            expect(Object.keys(community.posts.pages).length).to.be.greaterThan(0);
            for (const preloadedPageSortName of Object.keys(community.posts.pages)) {
                const allPostsUnderPreloadedSortName = await loadAllPagesBySortName(preloadedPageSortName, community.posts);
                for (const pageComment of allPostsUnderPreloadedSortName) {
                    const rawPageComment = pageComment.raw;
                    const calculatedCid = await calculateIpfsHash(JSON.stringify(rawPageComment.comment));
                    expect(calculatedCid).to.equal(rawPageComment.commentUpdate.cid);
                }
            }
        });

        it(`Hot page is pre-loaded`, () => expect(Object.keys(community.posts.pages)).to.include("hot"));

        itSkipIfRpc("posts.getPage will throw a timeout error when request times out", async () => {
            // Create a pkc instance with a very short timeout for page-ipfs
            const pkc = await config.pkcInstancePromise();

            pkc._timeouts["page-ipfs"] = 100;

            // Create a comment with a CID that doesn't exist or will time out
            const nonExistentCid = "QmbSiusGgY4Uk5LdAe91bzLkBzidyKyKHRKwhXPDz7gGzx"; // Random CID that doesn't exist

            const community = await pkc.getCommunity({ address: communityAddress });

            // Override the pageCid to use our non-existent CID
            community.posts.pageCids.hot = nonExistentCid;

            try {
                // This should time out
                await community.posts.getPage({ cid: nonExistentCid });
                expect.fail("Should have timed out");
            } catch (e) {
                const error = e as PKCError;
                if (isPKCFetchingUsingGateways(pkc)) {
                    expect(error.code).to.equal("ERR_FAILED_TO_FETCH_PAGE_IPFS_FROM_GATEWAYS");
                    for (const gatewayUrl of Object.keys(pkc.clients.ipfsGateways))
                        expect((error.details.gatewayToError[gatewayUrl] as PKCError).code).to.equal("ERR_GATEWAY_TIMED_OUT_OR_ABORTED");
                } else {
                    expect(error.code).to.equal("ERR_FETCH_CID_P2P_TIMEOUT");
                }
            }
            await pkc.destroy();
        });

        it(`.getPage will throw if the first page is over 1mb`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            const page = remeda.clone(community.raw.communityIpfs.posts.pages.hot);

            // Make sure the page is over 1MB
            // Keep adding comments until the page exceeds 1MB
            while (Buffer.byteLength(JSON.stringify(page)) <= 1024 * 1024) {
                page.comments.push(...page.comments);
            }

            // Verify the page is actually over 1MB
            const pageSizeInMB = Buffer.byteLength(JSON.stringify(page)) / (1024 * 1024);
            console.log(`Page size: ${pageSizeInMB.toFixed(2)}MB`);
            expect(pageSizeInMB).to.be.greaterThan(1, "Page should be larger than 1MB for this test");
            const pageCid = await addStringToIpfs(JSON.stringify(page));

            community.posts.pageCids.hot = pageCid;

            try {
                await community.posts.getPage({ cid: community.posts.pageCids.hot });
                expect.fail("Should have thrown");
            } catch (e) {
                const error = e as PKCError;
                if (isPKCFetchingUsingGateways(pkc)) {
                    expect(error.code).to.equal("ERR_FAILED_TO_FETCH_PAGE_IPFS_FROM_GATEWAYS");
                    for (const gatewayUrl of Object.keys(pkc.clients.ipfsGateways))
                        expect((error.details.gatewayToError[gatewayUrl] as PKCError).code).to.equal("ERR_OVER_DOWNLOAD_LIMIT");
                } else expect(error.code).to.equal("ERR_OVER_DOWNLOAD_LIMIT");
            }
        });

        describe.concurrent(`community.posts.validatePage - ${config.name}`, async () => {
            let pkc: PKCType, community: RemoteCommunity, validPageJson: PageTypeJson, newPost: Comment;

            beforeAll(async () => {
                pkc = await config.pkcInstancePromise({ pkcOptions: { validatePages: false } });
                newPost = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
                await publishRandomReply({ parentComment: newPost as CommentIpfsWithCidDefined, pkc: pkc });
                await waitTillPostInCommunityPages(newPost as Comment & { cid: string }, pkc);
                community = await pkc.getCommunity({ address: communityAddress });
                validPageJson = remeda.clone(community.posts.pages.hot); // PageTypeJson, not PageIpfs
            });

            afterAll(async () => {
                await pkc.destroy();
            });

            it("validates a legitimate page correctly", async () => {
                await community.posts.validatePage(validPageJson);
            });

            it("fails validation when a comment has invalid signature", async () => {
                const invalidPage = JSON.parse(JSON.stringify(validPageJson));
                invalidPage.comments[0].raw.comment.content = "modified content to invalidate signature";

                try {
                    await community.posts.validatePage(invalidPage);
                    expect.fail("Should have thrown");
                } catch (e) {
                    const error = e as PKCError;
                    expect(error.code).to.equal("ERR_POSTS_PAGE_IS_INVALID");
                    expect(error.details.signatureValidity.reason).to.equal(messages.ERR_SIGNATURE_IS_INVALID);
                }
            });

            it("fails validation when a comment belongs to a different community", async () => {
                const invalidPage = JSON.parse(JSON.stringify(validPageJson));
                invalidPage.comments[0].raw.comment.communityPublicKey = "different-address";

                try {
                    await community.posts.validatePage(invalidPage);
                    expect.fail("Should have thrown");
                } catch (e) {
                    const error = e as PKCError;
                    expect(error.code).to.equal("ERR_POSTS_PAGE_IS_INVALID");
                    expect(error.details.signatureValidity.reason).to.equal(messages.ERR_COMMENT_IN_PAGE_BELONG_TO_DIFFERENT_COMMUNITY);
                }
            });

            it("fails validation when calculated CID doesn't match commentUpdate.cid", async () => {
                const invalidPage = JSON.parse(JSON.stringify(validPageJson));
                // Modify the comment but keep the same commentUpdate.cid
                invalidPage.comments[0].raw.comment.timestamp += 1000;

                try {
                    await community.posts.validatePage(invalidPage);
                    expect.fail("Should have thrown");
                } catch (e) {
                    const error = e as PKCError;
                    expect(error.code).to.equal("ERR_POSTS_PAGE_IS_INVALID");
                    expect(error.details.signatureValidity.reason).to.equal(messages.ERR_SIGNATURE_IS_INVALID);
                }
            });

            it("fails validation when a comment has incorrect depth (not 0)", async () => {
                const invalidPage = JSON.parse(JSON.stringify(validPageJson));
                invalidPage.comments[0].raw.comment.depth = 1; // Should be 0 for posts

                // Update the commentUpdate.cid to match the modified comment
                invalidPage.comments[0].raw.commentUpdate.cid = await calculateIpfsHash(
                    JSON.stringify(invalidPage.comments[0].raw.comment)
                );

                try {
                    await community.posts.validatePage(invalidPage);
                    expect.fail("Should have thrown");
                } catch (e) {
                    const error = e as PKCError;
                    expect(error.code).to.equal("ERR_POSTS_PAGE_IS_INVALID");
                    expect(error.details.signatureValidity.reason).to.equal(
                        messages.ERR_PAGE_COMMENT_IS_A_REPLY_BUT_HAS_NO_PARENT_COMMENT_INSTANCE
                    );
                }
            });

            it("fails validation when a post has parentCid defined", async () => {
                const invalidPage = JSON.parse(JSON.stringify(validPageJson));
                invalidPage.comments[0].raw.comment.parentCid = "QmInvalidParentCid"; // Should be undefined for posts

                // Update the commentUpdate.cid to match the modified comment
                invalidPage.comments[0].raw.commentUpdate.cid = await calculateIpfsHash(
                    JSON.stringify(invalidPage.comments[0].raw.comment)
                );

                try {
                    await community.posts.validatePage(invalidPage);
                    expect.fail("Should have thrown");
                } catch (e) {
                    const error = e as PKCError;
                    expect(error.code).to.equal("ERR_POSTS_PAGE_IS_INVALID");
                    expect(error.details.signatureValidity.reason).to.equal(messages.ERR_PARENT_CID_OF_COMMENT_IN_PAGE_IS_NOT_CORRECT);
                }
            });

            it(`Fails validation when a post in page has postCid defined`, async () => {
                const validPageIpfs = community.raw.communityIpfs.posts.pages.hot;
                const invalidPage = JSON.parse(JSON.stringify(validPageIpfs));
                const postWithNoRepliesIndex = invalidPage.comments.findIndex(
                    (comment: { comment: { depth: number }; commentUpdate: { replies?: unknown } }) =>
                        comment.comment.depth === 0 && !comment.commentUpdate.replies
                );
                expect(postWithNoRepliesIndex).to.be.greaterThanOrEqual(0);
                invalidPage.comments[postWithNoRepliesIndex].comment.postCid =
                    invalidPage.comments[postWithNoRepliesIndex].commentUpdate.cid; // Should be undefined for posts

                // Update the commentUpdate.cid to match the modified comment
                invalidPage.comments[postWithNoRepliesIndex].commentUpdate.cid = await calculateIpfsHash(
                    deterministicStringify(invalidPage.comments[postWithNoRepliesIndex].comment)
                );

                console.log(invalidPage.comments[postWithNoRepliesIndex].commentUpdate.cid);
                const invalidPageCid = await addStringToIpfs(JSON.stringify(invalidPage));

                try {
                    await community.posts.validatePage(invalidPage);
                    expect.fail("Should have thrown");
                } catch (e) {
                    const error = e as PKCError;
                    expect(error.code).to.equal("ERR_POSTS_PAGE_IS_INVALID");
                    expect(error.details.signatureValidity.reason).to.equal(
                        messages.ERR_PAGE_COMMENT_POST_HAS_POST_CID_DEFINED_WITH_DEPTH_0
                    );
                }
            });

            it("validates posts pages differently than replies pages", async () => {
                // Get a post with replies

                const post = await pkc.getComment({ cid: newPost.cid });
                await post.update();
                await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => Boolean(post.replies.pages.best) });
                await post.stop();

                // Get a replies page
                const repliesPage = remeda.clone(post.replies.pages.best);

                // This should fail because we're using a replies page with posts.validatePage
                try {
                    await community.posts.validatePage(repliesPage);
                    expect.fail("Should have thrown");
                } catch (e) {
                    const error = e as PKCError;
                    expect(error.code).to.equal("ERR_POSTS_PAGE_IS_INVALID");
                    expect(error.details.signatureValidity.reason).to.equal(messages.ERR_PARENT_CID_OF_COMMENT_IN_PAGE_IS_NOT_CORRECT);
                }
            });

            it("validates empty posts pages (no comments)", async () => {
                // Create an empty page
                const emptyPage = {
                    ...validPageJson,
                    comments: [] as CommentWithinRepliesPostsPageJson[]
                };

                // Empty pages should be valid
                await community.posts.validatePage(emptyPage);
            });
        });
    });
});

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    describe.concurrent(`getPage - ${config.name}`, async () => {
        it(`.getPage will throw if retrieved page has an invalid signature `, async () => {
            const pkc = await config.pkcInstancePromise({ pkcOptions: { validatePages: true } });

            const community = await pkc.getCommunity({ address: communityAddress });

            const pageIpfs = { comments: community.posts.pages.hot.comments.map((comment) => comment.raw) };
            expect(pageIpfs).to.exist;

            const invalidPageIpfs = JSON.parse(JSON.stringify(pageIpfs));
            invalidPageIpfs.comments[0].comment.content += "invalidate signature";

            const invalidPageCid = await addStringToIpfs(JSON.stringify(invalidPageIpfs));
            community.posts.pageCids.active = invalidPageCid; // need to hardcode it here so we can calculate max size

            try {
                await community.posts.getPage({ cid: invalidPageCid });
                expect.fail("should fail");
            } catch (e) {
                const error = e as PKCError;
                expect(error.code).to.equal("ERR_POSTS_PAGE_IS_INVALID");
                expect(error.details.signatureValidity.reason).to.equal(messages.ERR_SIGNATURE_IS_INVALID);
            }
            await pkc.destroy();
        });
    });
});

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe.concurrent(`getPage - ${config.name}`, async () => {
        it(`.getPage will throw if retrieved page is not equivalent to its CID - IPFS Gateway`, async () => {
            const gatewayUrl = "http://localhost:13415"; // a gateway that's gonna respond with invalid content
            const pkc = await mockGatewayPKC({ pkcOptions: { ipfsGatewayUrls: [gatewayUrl], validatePages: true } });

            const community = await pkc.getCommunity({ address: communityAddress });

            const invalidPageCid = "QmUFu8fzuT1th3jJYgR4oRgGpw3sgRALr4nbenA4pyoCav"; // Gateway will respond with content that is not mapped to this cid
            community.posts.pageCids.active = invalidPageCid; // need to hardcode it here so we can calculate max size
            try {
                await community.posts.getPage({ cid: invalidPageCid });
                expect.fail("Should fail");
            } catch (e) {
                const error = e as PKCError;
                expect(error.code).to.equal("ERR_FAILED_TO_FETCH_PAGE_IPFS_FROM_GATEWAYS");
                expect((error.details.gatewayToError[gatewayUrl] as PKCError).code).to.equal("ERR_CALCULATED_CID_DOES_NOT_MATCH");
            }
            await pkc.destroy();
        });
    });
});

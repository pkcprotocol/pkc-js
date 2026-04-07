import {
    mockRemotePKC,
    describeSkipIfRpc,
    resolveWhenConditionIsTrue,
    getAvailablePKCConfigsToTestAgainst,
    mockPKC,
    createSubWithNoChallenge,
    publishRandomPost,
    forceLocalSubPagesToAlwaysGenerateMultipleChunks
} from "../../../dist/node/test/test-util.js";
import { PKCError } from "../../../dist/node/pkc-error.js";
import signers from "../../fixtures/signers.js";
import * as remeda from "remeda";
import { describe, beforeAll, afterAll, beforeEach, afterEach, it } from "vitest";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { CommentWithinRepliesPostsPageJson } from "../../../dist/node/publications/comment/types.js";

interface ValidateCommentTestEnvironment {
    communityAddress: string;
    postCid: string;
    repliesPostCid: string;
    cleanup: () => Promise<void>;
}

const cloneCommentInstance = (source: Comment): Comment => {
    const proto = Object.getPrototypeOf(source);
    const clone = proto ? Object.assign(Object.create(proto), source) : { ...source };
    if (typeof clone.toJSON === "function") {
        // shallow clone for nested refs; tests mutate only top-level props
        clone.raw = remeda.clone(source.raw);
    } else {
        clone.raw = JSON.parse(JSON.stringify(source.raw));
    }
    return clone;
};

getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true }).map((config) => {
    describeSkipIfRpc.concurrent(`pkc.validateComment - ${config.name}`, async () => {
        let remotePKC: PKC;
        let community: RemoteCommunity;
        let postCommentInstance: Comment;
        let postWithRepliesInstance: Comment;
        let postPageComment: CommentWithinRepliesPostsPageJson;
        let replyFromFlatPage: CommentWithinRepliesPostsPageJson;
        let replyFromBestPage: CommentWithinRepliesPostsPageJson;
        let publisherEnv: ValidateCommentTestEnvironment;

        beforeAll(async () => {
            publisherEnv = await createValidateCommentTestEnvironment();
            remotePKC = await config.pkcInstancePromise();
            community = (await remotePKC.getCommunity({ address: publisherEnv.communityAddress })) as RemoteCommunity;
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () =>
                    Boolean(
                        community.posts.pages.hot &&
                            community.posts.pages.hot.comments.find(
                                (comment) => comment.cid === publisherEnv.postCid || comment.cid === publisherEnv.repliesPostCid
                            )
                    )
            });

            postCommentInstance = await remotePKC.getComment({ cid: publisherEnv.postCid });
            await postCommentInstance.update();
            await resolveWhenConditionIsTrue({
                toUpdate: postCommentInstance,
                predicate: async () => typeof postCommentInstance.updatedAt === "number"
            });

            const foundPostPageComment = community.posts.pages.hot!.comments.find((c) => c.cid === postCommentInstance.cid);
            expect(foundPostPageComment, "Failed to find the post comment in the page").to.exist;
            postPageComment = foundPostPageComment!;

            postWithRepliesInstance = await remotePKC.getComment({ cid: publisherEnv.repliesPostCid });
            await postWithRepliesInstance.update();
            await resolveWhenConditionIsTrue({
                toUpdate: postWithRepliesInstance,
                predicate: async () => Boolean(postWithRepliesInstance.replies.pageCids?.newFlat)
            });

            const flatPageCid = postWithRepliesInstance.replies.pageCids?.newFlat;
            expect(flatPageCid, "Post must expose a flat replies page").to.be.a("string");
            const flatPage = await postWithRepliesInstance.replies.getPage({ cid: flatPageCid! });
            expect(flatPage.comments.length).to.be.greaterThan(0, "Flat page must contain comments");
            replyFromFlatPage = flatPage.comments[0];
            expect(replyFromFlatPage, "Failed to get a reply from the flat page").to.exist;
            expect(replyFromFlatPage.raw.comment.depth, "Reply from flat page should have depth > 0").to.be.greaterThan(0);

            let bestPage = postWithRepliesInstance.replies.pages.best;
            if (!bestPage?.comments?.length) {
                const bestPageCid = postWithRepliesInstance.replies.pageCids?.best;
                expect(bestPageCid, "Post must expose a best replies page").to.be.a("string");
                bestPage = await postWithRepliesInstance.replies.getPage({ cid: bestPageCid! });
            }
            expect(bestPage?.comments?.length, "Post must have replies on 'best' page for test").to.be.greaterThan(0);
            replyFromBestPage = bestPage!.comments[0];
            expect(replyFromBestPage, "Failed to get a reply from the 'best' page").to.exist;
        });

        afterAll(async () => {
            if (postCommentInstance) await postCommentInstance.stop();
            if (postWithRepliesInstance) await postWithRepliesInstance.stop();
            if (remotePKC) await remotePKC.destroy();
            if (publisherEnv) await publisherEnv.cleanup();
        });

        describe.concurrent("Valid Comments", () => {
            // --- Tests for Post Comment Instance ---
            it("should validate a valid Post Comment instance (validateReplies=undefined)", async () => {
                try {
                    await remotePKC.validateComment(cloneCommentInstance(postCommentInstance));
                } catch (e) {
                    expect.fail(`Expected promise to fulfill, but it rejected with: ${e}`);
                }
            });

            it("should validate a valid Post Comment instance (validateReplies=false)", async () => {
                try {
                    await remotePKC.validateComment(cloneCommentInstance(postCommentInstance), { validateReplies: false });
                } catch (e) {
                    expect.fail(`Expected promise to fulfill, but it rejected with: ${e}`);
                }
            });

            it("should validate a valid Post Comment instance (validateReplies=true)", async () => {
                try {
                    await remotePKC.validateComment(cloneCommentInstance(postCommentInstance), { validateReplies: true });
                } catch (e) {
                    expect.fail(`Expected promise to fulfill, but it rejected with: ${e}`);
                }
            });

            // --- Tests for Post Page Comment ---
            it("should validate a valid Post pageComment object (validateReplies=undefined)", async () => {
                try {
                    await remotePKC.validateComment(postPageComment);
                } catch (e) {
                    expect.fail(`Expected promise to fulfill, but it rejected with: ${e}`);
                }
            });

            it("should validate a valid Post pageComment object (validateReplies=false)", async () => {
                try {
                    await remotePKC.validateComment(remeda.clone(postPageComment), { validateReplies: false });
                } catch (e) {
                    expect.fail(`Expected promise to fulfill, but it rejected with: ${e}`);
                }
            });

            it("should validate a valid Post pageComment object (validateReplies=true)", async () => {
                try {
                    await remotePKC.validateComment(remeda.clone(postPageComment), { validateReplies: true });
                } catch (e) {
                    expect.fail(`Expected promise to fulfill, but it rejected with: ${e}`);
                }
            });

            // --- Tests for Reply Page Comment (from Flat Page) ---
            it("should validate a valid Reply pageComment object from flat page (validateReplies=undefined)", async () => {
                try {
                    await remotePKC.validateComment(remeda.clone(replyFromFlatPage));
                } catch (e) {
                    expect.fail(`Expected promise to fulfill for replyFromFlatPage, but it rejected with: ${e}`);
                }
            });

            it("should validate a valid Reply pageComment object from flat page (validateReplies=false)", async () => {
                try {
                    await remotePKC.validateComment(remeda.clone(replyFromFlatPage), { validateReplies: false });
                } catch (e) {
                    expect.fail(`Expected promise to fulfill for replyFromFlatPage, but it rejected with: ${e}`);
                }
            });

            it("should validate a valid Reply pageComment object from flat page (validateReplies=true)", async () => {
                // Since this reply might itself have replies (even though fetched via flat page), validating them is valid
                try {
                    await remotePKC.validateComment(remeda.clone(replyFromFlatPage), { validateReplies: true });
                } catch (e) {
                    expect.fail(`Expected promise to fulfill for replyFromFlatPage, but it rejected with: ${e}`);
                }
            });

            // --- Tests for Reply Page Comment (from Best Page) ---
            it("should validate a valid Reply pageComment object from best page (validateReplies=undefined)", async () => {
                try {
                    await remotePKC.validateComment(remeda.clone(replyFromBestPage));
                } catch (e) {
                    expect.fail(`Expected promise to fulfill for replyFromBestPage, but it rejected with: ${e}`);
                }
            });

            it("should validate a valid Reply pageComment object from best page (validateReplies=false)", async () => {
                try {
                    await remotePKC.validateComment(remeda.clone(replyFromBestPage), { validateReplies: false });
                } catch (e) {
                    expect.fail(`Expected promise to fulfill for replyFromBestPage, but it rejected with: ${e}`);
                }
            });

            it("should validate a valid Reply pageComment object from best page (validateReplies=true)", async () => {
                // Since this reply might itself have replies, validating them is valid
                try {
                    await remotePKC.validateComment(remeda.clone(replyFromBestPage), { validateReplies: true });
                } catch (e) {
                    expect.fail(`Expected promise to fulfill for replyFromBestPage, but it rejected with: ${e}`);
                }
            });
        });

        describe.sequential("Invalid Comments", () => {
            let pkc: PKC; // Use a separate pkc instance for invalid tests to reset caches if needed
            let sourcePostCommentInstance: Comment; // Need a valid instance for cloning/copying tests
            beforeEach(async () => {
                pkc = await mockRemotePKC();
                const community = (await pkc.getCommunity({ address: signers[0].address })) as RemoteCommunity;
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.lastPostCid === "string" });
                sourcePostCommentInstance = await pkc.getComment({ cid: community.lastPostCid! });
                await sourcePostCommentInstance.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: sourcePostCommentInstance,
                    predicate: async () => typeof sourcePostCommentInstance.updatedAt === "number"
                });
            });
            afterEach(async () => {
                if (sourcePostCommentInstance) {
                    await sourcePostCommentInstance.stop?.();
                    sourcePostCommentInstance = undefined!;
                }
                if (pkc) {
                    await pkc.destroy();
                    pkc = undefined!;
                }
            });

            // --- Invalid Post Comment Instance Tests ---
            it("should reject Post instance if CommentIpfs signature is invalid", async () => {
                let invalidComment: Comment | undefined;
                try {
                    invalidComment = await pkc.createComment(sourcePostCommentInstance); // Use source
                    invalidComment.raw.comment = remeda.clone(invalidComment.raw.comment);
                    invalidComment.raw.comment!.signature.signature += "invalid";
                    await pkc.validateComment(invalidComment);
                    expect.fail("Expected promise to reject, but it fulfilled.");
                } catch (e) {
                    expect(e).to.be.instanceOf(PKCError);
                    expect((e as PKCError).code).to.equal("ERR_INVALID_COMMENT_IPFS");
                } finally {
                    if (invalidComment) await invalidComment.stop();
                }
            });

            it("should reject Post instance if CommentUpdate signature is invalid", async () => {
                let invalidComment: Comment | undefined;
                try {
                    invalidComment = await pkc.createComment(sourcePostCommentInstance); // Use source
                    const tamperedUpdate = remeda.clone(invalidComment.raw.commentUpdate);
                    tamperedUpdate!.signature.signature += "invalid"; // Tamper signature directly
                    invalidComment.raw.commentUpdate = tamperedUpdate;
                    await pkc.validateComment(invalidComment);
                    expect.fail("Expected promise to reject, but it fulfilled.");
                } catch (e) {
                    expect(e).to.be.instanceOf(PKCError);
                    expect((e as PKCError).code).to.equal("ERR_INVALID_COMMENT_UPDATE");
                } finally {
                    if (invalidComment) await invalidComment.stop();
                }
            });

            it("should reject Post instance if CommentIpfs data is missing", async () => {
                let invalidComment: Comment | undefined;
                try {
                    invalidComment = await pkc.createComment(remeda.clone(sourcePostCommentInstance)); // Use source
                    invalidComment.raw.comment = undefined;
                    await pkc.validateComment(invalidComment);
                    expect.fail("Expected promise to reject, but it fulfilled.");
                } catch (e) {
                    expect(e).to.be.instanceOf(PKCError);
                    expect((e as PKCError).code).to.equal("ERR_COMMENT_MISSING_IPFS");
                } finally {
                    if (invalidComment) await invalidComment.stop();
                }
            });

            it("should reject Post instance if CommentUpdate data is missing", async () => {
                let invalidComment: Comment | undefined;
                try {
                    invalidComment = await pkc.createComment(sourcePostCommentInstance); // Use source
                    invalidComment.raw.commentUpdate = undefined;
                    await pkc.validateComment(invalidComment);
                    expect.fail("Expected promise to reject, but it fulfilled.");
                } catch (e) {
                    expect(e).to.be.instanceOf(PKCError);
                    expect((e as PKCError).code).to.equal("ERR_COMMENT_MISSING_UPDATE");
                } finally {
                    if (invalidComment) await invalidComment.stop();
                }
            });

            it("should reject Post instance if CID is missing", async () => {
                let invalidComment: Comment | undefined;
                try {
                    invalidComment = await pkc.createComment(sourcePostCommentInstance); // Use source
                    invalidComment.cid = undefined;
                    invalidComment.raw.commentUpdate!.cid = undefined!;
                    await pkc.validateComment(invalidComment);
                    expect.fail("Expected promise to reject, but it fulfilled.");
                } catch (e) {
                    expect(e).to.be.instanceOf(PKCError);
                    expect((e as PKCError).code).to.equal("ERR_COMMENT_MISSING_CID");
                } finally {
                    if (invalidComment) await invalidComment.stop();
                }
            });

            it("should reject Post instance if postCid is missing", async () => {
                let invalidComment: Comment | undefined;
                try {
                    invalidComment = await pkc.createComment(sourcePostCommentInstance); // Use source
                    invalidComment.postCid = undefined;
                    await pkc.validateComment(invalidComment);
                    expect.fail("Expected promise to reject, but it fulfilled.");
                } catch (e) {
                    expect(e).to.be.instanceOf(PKCError);
                    expect((e as PKCError).code).to.equal("ERR_COMMENT_MISSING_POST_CID");
                } finally {
                    if (invalidComment) await invalidComment.stop();
                }
            });

            // --- Invalid Shallow/Deep Copy Tests ---
            it("should fulfill when validating a shallow copy of a valid Comment instance", async () => {
                // Shallow copies lack prototype chain but retain own enumerable properties.
                // validateComment only accesses .raw, .cid, .postCid which are preserved.
                const shallowCopy = { ...sourcePostCommentInstance };
                try {
                    await pkc.validateComment(shallowCopy as Comment);
                    // Expect fulfillment
                } catch (e) {
                    expect.fail(`Expected promise to fulfill for shallow copy, but it rejected with: ${e}`);
                }
            });

            it("should fulfill when validating a deep-cloned plain object of a valid Comment instance", async () => {
                // Deep copies (via JSON) lose methods/prototype but retain serializable data.
                // validateComment only accesses .raw, .cid, .postCid which are preserved.
                const deepCopy = JSON.parse(JSON.stringify(sourcePostCommentInstance));
                try {
                    await pkc.validateComment(deepCopy);
                    // Expect fulfillment
                } catch (e) {
                    expect.fail(`Expected promise to fulfill for deep copy, but it rejected with: ${e}`);
                }
            });

            // --- Invalid Post Page Comment Tests ---
            it("should reject Post pageComment if comment signature is invalid", async () => {
                try {
                    const invalidPageComment = remeda.clone(postPageComment);
                    invalidPageComment.raw.comment.signature.signature += "invalid";
                    await pkc.validateComment(invalidPageComment);
                    expect.fail("Expected promise to reject, but it fulfilled.");
                } catch (e) {
                    expect(e).to.be.instanceOf(PKCError);
                    expect((e as PKCError).code).to.equal("ERR_INVALID_COMMENT_IPFS");
                }
            });

            it("should reject Post pageComment if commentUpdate signature is invalid", async () => {
                try {
                    const invalidPageComment = remeda.clone(postPageComment);
                    invalidPageComment.raw.commentUpdate = remeda.clone(invalidPageComment.raw.commentUpdate);
                    invalidPageComment.raw.commentUpdate.signature.signature += "invalid";
                    await pkc.validateComment(invalidPageComment);
                    expect.fail("Expected promise to reject, but it fulfilled.");
                } catch (e) {
                    expect(e).to.be.instanceOf(PKCError);
                    expect((e as PKCError).code).to.equal("ERR_INVALID_COMMENT_UPDATE");
                }
            });

            it("should reject Post pageComment if comment data is missing", async () => {
                try {
                    const invalidPageComment = remeda.clone(postPageComment);
                    (invalidPageComment.raw as { comment: undefined }).comment = undefined;
                    await pkc.validateComment(invalidPageComment);
                    expect.fail("Expected promise to reject, but it fulfilled.");
                } catch (e) {
                    expect(e).to.be.instanceOf(PKCError);
                    expect((e as PKCError).code).to.equal("ERR_COMMENT_MISSING_IPFS");
                }
            });

            it("should reject Post pageComment if commentUpdate data is missing", async () => {
                try {
                    const invalidPageComment = remeda.clone(postPageComment);
                    (invalidPageComment.raw as { commentUpdate: undefined }).commentUpdate = undefined;
                    await pkc.validateComment(invalidPageComment);
                    expect.fail("Expected promise to reject, but it fulfilled.");
                } catch (e) {
                    expect(e).to.be.instanceOf(PKCError);
                    expect((e as PKCError).code).to.equal("ERR_COMMENT_MISSING_UPDATE");
                }
            });

            it("should reject Post pageComment if commentUpdate.cid is missing", async () => {
                try {
                    const invalidPageComment = remeda.clone(postPageComment);
                    invalidPageComment.raw.commentUpdate.cid = undefined!;
                    invalidPageComment.cid = undefined!;
                    await pkc.validateComment(invalidPageComment);
                    expect.fail("Expected promise to reject, but it fulfilled.");
                } catch (e) {
                    expect(e).to.be.instanceOf(PKCError);
                    expect((e as PKCError).code).to.equal("ERR_COMMENT_MISSING_CID");
                }
            });

            it("should reject Post pageComment if postCid is missing", async () => {
                try {
                    const invalidPageComment = remeda.clone(postPageComment);
                    invalidPageComment.postCid = undefined!;
                    await pkc.validateComment(invalidPageComment);
                    expect.fail("Expected promise to reject, but it fulfilled.");
                } catch (e) {
                    expect(e).to.be.instanceOf(PKCError);
                    expect((e as PKCError).code).to.equal("ERR_COMMENT_MISSING_POST_CID");
                }
            });
        });
    });
});

async function createValidateCommentTestEnvironment(): Promise<ValidateCommentTestEnvironment> {
    const publisherPKC = await mockPKC();
    const community = (await createSubWithNoChallenge({}, publisherPKC)) as LocalCommunity;
    await community.start();
    await resolveWhenConditionIsTrue({
        toUpdate: community,
        predicate: async () => typeof community.updatedAt === "number"
    });

    const postForInstance = await publishRandomPost({
        communityAddress: community.address,
        pkc: publisherPKC,
        postProps: {
            content: `validate-comment-post ${Date.now()}`
        }
    });
    await postForInstance.update();
    await resolveWhenConditionIsTrue({
        toUpdate: postForInstance,
        predicate: async () => typeof postForInstance.updatedAt === "number"
    });

    const postWithReplies = await publishRandomPost({
        communityAddress: community.address,
        pkc: publisherPKC,
        postProps: {
            content: `validate-comment-reply-root ${Date.now()}`
        }
    });
    await postWithReplies.update();
    await resolveWhenConditionIsTrue({
        toUpdate: postWithReplies,
        predicate: async () => typeof postWithReplies.updatedAt === "number"
    });

    await ensureCommentHasPaginatedReplies({ community, comment: postWithReplies });

    await postForInstance.stop();
    await postWithReplies.stop();

    return {
        communityAddress: community.address,
        postCid: postForInstance.cid!,
        repliesPostCid: postWithReplies.cid!,
        cleanup: async () => {
            await community.delete().catch(() => {});
            await publisherPKC.destroy().catch(() => {});
        }
    };
}

async function ensureCommentHasPaginatedReplies({ community, comment }: { community: LocalCommunity; comment: Comment }): Promise<void> {
    const { cleanup: cleanupForcedChunking } = await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
        community,
        parentComment: comment,
        forcedPreloadedPageSizeBytes: 512
    });

    try {
        await resolveWhenConditionIsTrue({
            toUpdate: comment,
            predicate: async () => Boolean(comment.replies.pageCids?.newFlat && comment.replies.pageCids?.best)
        });
    } finally {
        cleanupForcedChunking();
    }

    const hasFlatPage = Boolean(comment.replies.pageCids?.newFlat);
    const hasBestPage = Boolean(comment.replies.pageCids?.best);
    if (!hasFlatPage || !hasBestPage) throw new Error("Forced pagination did not create the expected reply pageCids");

    const flatPageCid = comment.replies.pageCids?.newFlat;
    if (!flatPageCid) throw new Error("Failed to generate flat replies page for validateComment test");
    const flatPage = await comment.replies.getPage({ cid: flatPageCid });
    if (!flatPage.comments?.length) throw new Error("Flat replies page is empty");

    const bestPageCid = comment.replies.pageCids?.best;
    if (!bestPageCid) throw new Error("Failed to generate best replies page for validateComment test");
    const bestPage = await comment.replies.getPage({ cid: bestPageCid });
    if (!bestPage.comments?.length) throw new Error("Best replies page is empty");
}

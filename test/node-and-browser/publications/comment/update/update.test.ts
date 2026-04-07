import signers from "../../../../fixtures/signers.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import validCommentFixture from "../../../../fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json" with { type: "json" };
import {
    publishRandomPost,
    publishRandomReply,
    mockPKCNoDataPathWithOnlyKuboClient,
    mockPostToFailToLoadFromPostUpdates,
    createCommentUpdateWithInvalidSignature,
    mockPostToHaveCommunityWithNoPostUpdates,
    addStringToIpfs,
    resolveWhenConditionIsTrue,
    getAvailablePKCConfigsToTestAgainst,
    mockPostToReturnSpecificCommentUpdate,
    isPKCFetchingUsingGateways,
    itSkipIfRpc,
    waitTillReplyInParentPagesInstance
} from "../../../../../dist/node/test/test-util.js";
import { cleanUpBeforePublishing } from "../../../../../dist/node/signer/signatures.js";
import { messages } from "../../../../../dist/node/errors.js";
import type { PKCError } from "../../../../../dist/node/pkc-error.js";
import type { CommentIpfsWithCidDefined } from "../../../../../dist/node/publications/comment/types.js";
import type { PKC } from "../../../../../dist/node/pkc/pkc.js";

// Type for replies with required parentCid
type ReplyWithRequiredFields = Required<Pick<CommentIpfsWithCidDefined, "cid" | "parentCid"> & { communityAddress: string }>;

const communityAddress = signers[0].address;

// TODO add a test where we call comment.update() on 100 comments in parallel, will it resolve ipns name 100 times or once (should be once)
// TODO add a test where you call comment.update() on 100 comments who have the same cid, will it call _fetchCidP2P 100 times?

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`comment.update - ${config.name}`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it.sequential(
            `pkc.createComment({cid}).update() fetches comment ipfs and update correctly when cid is the cid of a post`,
            async () => {
                const originalPost = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });

                const recreatedPost = await pkc.createComment({ cid: originalPost.cid });

                const commentIpfsPromise = new Promise((resolve) => recreatedPost.once("update", resolve));
                await recreatedPost.update();

                await commentIpfsPromise; // Comment ipfs props should be defined now, but not CommentUpdate
                expect(recreatedPost.updatedAt).to.be.undefined;

                expect(recreatedPost.raw.comment!).to.deep.equal(originalPost.raw.comment!);

                await new Promise((resolve) => recreatedPost.once("update", resolve));
                await recreatedPost.stop();
                expect(recreatedPost.updatedAt).to.be.a("number");
            }
        );

        it.sequential(
            `pkc.createComment({cid}).update() fetches comment ipfs and update correctly when cid is the cid of a reply`,
            async () => {
                const community = await pkc.getCommunity({ address: communityAddress });

                const postCid =
                    community.posts.pages.hot.comments.find(
                        (post: { replyCount: number; locked?: boolean; removed?: boolean }) =>
                            post.replyCount > 0 && !post.locked && !post.removed
                    )?.cid || community.lastPostCid;

                const reply = await publishRandomReply({
                    parentComment: (await pkc.getComment({ cid: postCid })) as CommentIpfsWithCidDefined,
                    pkc: pkc
                });

                const recreatedReply = await pkc.createComment({ cid: reply.cid });

                const commentIpfsPromise = new Promise((resolve) => recreatedReply.once("update", resolve));
                await recreatedReply.update();

                await commentIpfsPromise;
                const commentUpdatePromise = new Promise((resolve) => recreatedReply.once("update", resolve));
                // Comment ipfs props should be defined now, but not CommentUpdate
                expect(recreatedReply.updatedAt).to.be.undefined;

                expect(recreatedReply.raw.comment!).to.deep.equal(reply.raw.comment!);

                await commentUpdatePromise;
                await recreatedReply.stop();

                expect(recreatedReply.updatedAt).to.be.a("number");
            }
        );

        it.sequential(`comment.stop() stops loading of comment updates (before update)`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });

            const comment = await pkc.createComment({ cid: community.posts.pages.hot.comments[0].cid });
            await comment.update();
            let updatedHasBeenCalled = false;
            await comment.stop();
            (comment as any)._setUpdatingState = async () => {
                updatedHasBeenCalled = true;
            };
            await new Promise((resolve) => setTimeout(resolve, pkc.updateInterval * 2));
            expect(updatedHasBeenCalled).to.be.false;
        });

        it.sequential(`comment.stop() stops loading of comment updates (after update)`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });

            const comment = await pkc.createComment({ cid: community.posts.pages.hot.comments[0].cid });
            await comment.update();
            await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
            await comment.stop();
            await new Promise((resolve) => setTimeout(resolve, pkc.updateInterval + 1));
            let updatedHasBeenCalled = false;
            (comment as any)._setUpdatingState = async () => {
                updatedHasBeenCalled = true;
            };

            await new Promise((resolve) => setTimeout(resolve, pkc.updateInterval * 2));
            expect(updatedHasBeenCalled).to.be.false;
        });

        it(`comment.update() is working as expected after calling comment.stop()`, async () => {
            const pkc = await config.pkcInstancePromise();
            try {
                const community = await pkc.getCommunity({ address: communityAddress });
                const postToStop = await pkc.createComment({ cid: community.posts.pages.hot.comments[0].cid });

                await postToStop.update();
                await resolveWhenConditionIsTrue({ toUpdate: postToStop, predicate: async () => typeof postToStop.updatedAt === "number" }); // CommentIpfs and CommentUpdate should be defined now
                await postToStop.stop();

                await postToStop.update();

                const reply = await publishRandomReply({ parentComment: postToStop as CommentIpfsWithCidDefined, pkc: pkc });
                await waitTillReplyInParentPagesInstance(reply as unknown as ReplyWithRequiredFields, postToStop);
                await postToStop.stop();
            } finally {
                await pkc.destroy();
            }
        });

        it(`comment.update() is working as expected after comment.publish()`, async () => {
            const post = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            await post.update();
            await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => typeof post.updatedAt === "number" });
            expect(post.updatedAt).to.be.a("number");
            await post.stop();
        });

        it.sequential(`reply can receive comment updates`, async () => {
            const post = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
            const reply = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, pkc: pkc });
            await reply.update();
            await resolveWhenConditionIsTrue({ toUpdate: reply, predicate: async () => typeof reply.updatedAt === "number" });

            await reply.stop();
            expect(reply.updatedAt).to.be.a("number");
            expect(reply.author.community).to.be.a("object");
        });
    });
});

const addCommentIpfsWithInvalidSignatureToIpfs = async () => {
    const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
    const community = await pkc.getCommunity({ address: communityAddress });

    const postIpfs = cleanUpBeforePublishing((await pkc.getComment({ cid: community.posts.pages.hot.comments[0].cid })).raw.comment!);

    postIpfs.title += "1234"; // Invalidate signature
    const postWithInvalidSignatureCid = addStringToIpfs(JSON.stringify(postIpfs));

    await pkc.destroy();

    return postWithInvalidSignatureCid;
};

const addCommentIpfsWithInvalidSchemaToIpfs = async () => {
    const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
    const community = await pkc.getCommunity({ address: communityAddress });

    const postIpfs = (await pkc.getComment({ cid: community.posts.pages.hot.comments[0].cid })).raw.comment!;

    (postIpfs as { content: string | number }).content = 1234; // Content is supposed to be a string, this will make the schema invalid

    const postWithInvalidSchemaCid = addStringToIpfs(JSON.stringify(postIpfs));

    await pkc.destroy();

    return postWithInvalidSchemaCid;
};

const addValidCommentIpfsToIpfs = async () => {
    return addStringToIpfs(JSON.stringify(validCommentFixture));
};

const addInvalidJsonToIpfs = async () => {
    return addStringToIpfs("<html>something</html>");
};

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`comment.update() emits errors for issues with CommentIpfs or CommentUpdate record - ${config.name}`, async () => {
        let invalidCommentIpfsCid: string;
        let cidOfInvalidJson: string;
        let cidOfCommentIpfsWithInvalidSchema: string;
        let cidOfCommentIpfsWithMismatchedCommunityAddress: string;
        let pkc: PKC;
        let commentUpdateWithInvalidSignatureJson: { cid: string };
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            invalidCommentIpfsCid = await addCommentIpfsWithInvalidSignatureToIpfs();
            cidOfInvalidJson = await addInvalidJsonToIpfs();
            cidOfCommentIpfsWithInvalidSchema = await addCommentIpfsWithInvalidSchemaToIpfs();
            cidOfCommentIpfsWithMismatchedCommunityAddress = await addValidCommentIpfsToIpfs();
            const sub = await pkc.getCommunity({ address: communityAddress });
            commentUpdateWithInvalidSignatureJson = await createCommentUpdateWithInvalidSignature(sub.posts.pages.hot.comments[0].cid);
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`pkc.createComment({cid}).update() emits error and stops updating if signature of CommentIpfs is invalid`, async () => {
            // A critical error, so it shouldn't keep on updating

            const createdComment = await pkc.createComment({ cid: invalidCommentIpfsCid });
            expect(createdComment.content).to.be.undefined; // Make sure it didn't use the props sub pages

            const errors: PKCError[] = [];
            const updatingStates: string[] = [];
            createdComment.on("updatingstatechange", () => updatingStates.push(createdComment.updatingState));
            createdComment.on("error", (err) => errors.push(err as PKCError));
            let updateHasBeenEmitted = false;
            createdComment.once("update", () => (updateHasBeenEmitted = true));
            await createdComment.update();
            expect(createdComment.content).to.be.undefined; // Make sure it didn't use the props sub pages

            await resolveWhenConditionIsTrue({ toUpdate: createdComment, predicate: async () => errors.length >= 1, eventName: "error" });
            expect(errors.length).to.equal(1);
            expect(errors[0].code).to.equal("ERR_COMMENT_IPFS_SIGNATURE_IS_INVALID");

            // should stop updating by itself because of the critical error

            expect(createdComment.depth).to.be.undefined; // Make sure it did not use the props from the invalid CommentIpfs
            expect(createdComment.state).to.equal("stopped");
            expect(createdComment.updatingState).to.equal("failed");
            expect(updatingStates).to.deep.equal(["fetching-ipfs", "failed"]);
            expect(updateHasBeenEmitted).to.be.false;
        });

        it(`comment.update() emits error and stops updating loop if CommentIpfs is an invalid json`, async () => {
            const createdComment = await pkc.createComment({ cid: cidOfInvalidJson });

            const updatingStates: string[] = [];
            createdComment.on("updatingstatechange", () => updatingStates.push(createdComment.updatingState));
            const errors: PKCError[] = [];
            createdComment.on("error", (err) => errors.push(err as PKCError));
            let updateHasBeenEmitted = false;
            createdComment.once("update", () => (updateHasBeenEmitted = true));
            await createdComment.update();

            await resolveWhenConditionIsTrue({ toUpdate: createdComment, predicate: async () => errors.length >= 1, eventName: "error" });
            expect(errors.length).to.equal(1);
            expect(errors[0].code).to.equal("ERR_INVALID_JSON");

            await new Promise((resolve) => setTimeout(resolve, 500)); // wait until RPC transmits other states
            // should stop updating by itself because of the critical error

            expect(createdComment.depth).to.be.undefined; // Make sure it did not use the props from the invalid CommentIpfs
            expect(createdComment.state).to.equal("stopped");
            expect(createdComment.updatingState).to.equal("failed");
            expect(updatingStates).to.deep.equal(["fetching-ipfs", "failed"]);
            expect(updateHasBeenEmitted).to.be.false;
        });

        it(`comment.update() emits error and stops updating loop if CommentIpfs is an invalid schema`, async () => {
            const createdComment = await pkc.createComment({ cid: cidOfCommentIpfsWithInvalidSchema });

            const updatingStates: string[] = [];
            createdComment.on("updatingstatechange", () => updatingStates.push(createdComment.updatingState));
            let updateHasBeenEmitted = false;
            createdComment.once("update", () => (updateHasBeenEmitted = true));
            const errors: PKCError[] = [];
            createdComment.on("error", (err) => errors.push(err as PKCError));
            await createdComment.update();

            await resolveWhenConditionIsTrue({ toUpdate: createdComment, predicate: async () => errors.length >= 1, eventName: "error" });
            expect(errors.length).to.equal(1);
            expect(errors[0].code).to.equal("ERR_INVALID_COMMENT_IPFS_SCHEMA");

            // should stop updating by itself because of the critical error

            expect(createdComment.depth).to.be.undefined; // Make sure it did not use the props from the invalid CommentIpfs
            expect(createdComment.state).to.equal("stopped");
            expect(createdComment.updatingState).to.equal("failed");
            expect(updatingStates).to.deep.equal(["fetching-ipfs", "failed"]);
            expect(updateHasBeenEmitted).to.be.false;
        });

        it(`comment.update() emits error and stops updating loop if CommentIpfs communityAddress does not match`, async () => {
            const expectedCommunityAddress = signers[1].address;
            expect(expectedCommunityAddress).to.not.equal(validCommentFixture.subplebbitAddress);

            const createdComment = await pkc.createComment({
                cid: cidOfCommentIpfsWithMismatchedCommunityAddress,
                communityAddress: expectedCommunityAddress
            });

            const updatingStates: string[] = [];
            createdComment.on("updatingstatechange", () => updatingStates.push(createdComment.updatingState));
            const errors: PKCError[] = [];
            createdComment.on("error", (err) => errors.push(err as PKCError));
            let updateHasBeenEmitted = false;
            createdComment.once("update", () => (updateHasBeenEmitted = true));
            await createdComment.update();

            await resolveWhenConditionIsTrue({ toUpdate: createdComment, predicate: async () => errors.length >= 1, eventName: "error" });
            expect(errors.length).to.equal(1);
            expect(errors[0].code).to.equal("ERR_COMMENT_IPFS_SIGNATURE_IS_INVALID");
            expect(errors[0].details.commentIpfsValidation.reason).to.equal(messages.ERR_COMMENT_IPFS_COMMUNITY_ADDRESS_MISMATCH);

            expect(createdComment.state).to.equal("stopped");
            expect(createdComment.updatingState).to.equal("failed");
            expect(updatingStates).to.deep.equal(["fetching-ipfs", "failed"]);
            expect(createdComment.raw.comment).to.be.undefined;
            expect(createdComment.raw.commentUpdate).to.be.undefined;
            expect(createdComment.content).to.be.undefined;
            expect(updateHasBeenEmitted).to.be.false;
        });

        it(`comment.update() loads CommentUpdate when communityPublicKey differs from initially provided value (key rotation)`, async () => {
            // Pass a communityPublicKey that differs from what the CommentIpfs actually has.
            // After CommentIpfs loads, the real communityPublicKey from the record takes over.
            // The full pipeline (CommentIpfs + CommentUpdate) should complete without errors.
            const sub = await pkc.getCommunity({ address: communityAddress });
            const commentCid = sub.posts.pages.hot.comments[0].cid;

            const createdComment = await pkc.createComment({ cid: commentCid, communityPublicKey: signers[6].address });
            expect(createdComment.communityPublicKey).to.equal(signers[6].address); // initially set to the "old" key

            const errors: PKCError[] = [];
            createdComment.on("error", (err) => errors.push(err as PKCError));
            await createdComment.update();

            // Wait for CommentUpdate to load (implies CommentIpfs already loaded successfully)
            await resolveWhenConditionIsTrue({
                toUpdate: createdComment,
                predicate: async () => createdComment.raw.commentUpdate !== undefined,
                eventName: "update"
            });

            // No community address mismatch error should have been emitted
            const addressMismatchErrors = errors.filter(
                (e) => e.details?.commentIpfsValidation?.reason === messages.ERR_COMMENT_IPFS_COMMUNITY_ADDRESS_MISMATCH
            );
            expect(addressMismatchErrors).to.deep.equal([]);
            // After loading, communityPublicKey is set from the actual CommentIpfs record
            expect(createdComment.communityPublicKey).to.be.a("string");
            expect(createdComment.updatedAt).to.be.a("number");
            await createdComment.stop();
        });

        itSkipIfRpc.sequential(`comment.update() emit an error if CommentUpdate signature is invalid `, async () => {
            // Should emit an error as well but stay subscribed to sub updates

            const createdComment = await pkc.createComment({
                cid: commentUpdateWithInvalidSignatureJson.cid
            });

            const errors: PKCError[] = [];

            createdComment.on("error", (err) => errors.push(err as PKCError));

            await createdComment.update();

            mockPostToReturnSpecificCommentUpdate(createdComment, JSON.stringify(commentUpdateWithInvalidSignatureJson));

            await Promise.all([
                resolveWhenConditionIsTrue({ toUpdate: createdComment, predicate: async () => errors.length >= 1, eventName: "error" }),
                publishRandomPost({ communityAddress: communityAddress, pkc: pkc })
            ]);

            expect(createdComment.updatedAt).to.be.undefined; // Make sure it didn't use the props from the invalid CommentUpdate
            expect(createdComment.state).to.equal("updating");
            expect(errors.length).to.greaterThanOrEqual(1);
            expect(pkc._updatingComments[createdComment.cid]._invalidCommentUpdateMfsPaths.size).to.equal(errors.length); // it should mark the path as invalid

            for (const error of errors) {
                if (isPKCFetchingUsingGateways(pkc)) {
                    expect(error.code).to.equal("ERR_FAILED_TO_FETCH_COMMENT_UPDATE_FROM_GATEWAYS");
                    for (const gatewayUrl of Object.keys(pkc.clients.ipfsGateways)) {
                        expect(error.details.gatewayToError[gatewayUrl].code).to.equal("ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID");
                    }
                } else expect(error.code).to.equal("ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID");
            }

            await createdComment.stop();
        });

        itSkipIfRpc(`comment.update() emits error if CommentUpdate is an invalid json`, async () => {
            // this test times out sometimes
            // Should emit an error and keep on updating
            const pkc = await config.pkcInstancePromise();

            try {
                const invalidCommentUpdateJson = "<html>something</html>";
                // Should emit an error as well but stay subscribed to sub updates

                const createdComment = await pkc.createComment({
                    cid: commentUpdateWithInvalidSignatureJson.cid
                });

                const errors: PKCError[] = [];

                createdComment.on("error", (err) => errors.push(err as PKCError));

                await createdComment.update();
                await mockPostToReturnSpecificCommentUpdate(createdComment, invalidCommentUpdateJson);

                await Promise.all([
                    resolveWhenConditionIsTrue({
                        toUpdate: createdComment,
                        predicate: async () => errors.length === 2,
                        eventName: "error"
                    }),
                    publishRandomPost({ communityAddress: communityAddress, pkc: pkc }) // force sub to publish a new update
                ]);

                expect(createdComment.updatedAt).to.be.undefined; // Make sure it didn't use the props from the invalid CommentUpdate
                expect(createdComment.state).to.equal("updating");
                expect(errors.length).to.equal(2);
                expect(pkc._updatingComments[createdComment.cid]._invalidCommentUpdateMfsPaths.size).to.equal(errors.length); // it should mark the path as invalid

                for (const error of errors) {
                    if (isPKCFetchingUsingGateways(pkc)) {
                        expect(error.code).to.equal("ERR_FAILED_TO_FETCH_COMMENT_UPDATE_FROM_GATEWAYS");
                        for (const gatewayUrl of Object.keys(pkc.clients.ipfsGateways)) {
                            expect(error.details.gatewayToError[gatewayUrl].code).to.equal("ERR_INVALID_JSON");
                        }
                    } else expect(error.code).to.equal("ERR_INVALID_JSON");
                }

                await createdComment.stop();
            } finally {
                await pkc.destroy();
            }
        });

        itSkipIfRpc.sequential(`comment.update() emits error if CommentUpdate is an invalid schema`, async () => {
            // Should emit an error as well but stay subscribed to sub updates
            const createdComment = await pkc.createComment({
                cid: commentUpdateWithInvalidSignatureJson.cid
            });

            const invalidCommentUpdateSchema = { hello: "this should fail the schema parse" };

            const errors: PKCError[] = [];

            createdComment.on("error", (err) => errors.push(err as PKCError));

            await createdComment.update();

            await mockPostToReturnSpecificCommentUpdate(createdComment, JSON.stringify(invalidCommentUpdateSchema));

            await Promise.all([
                resolveWhenConditionIsTrue({ toUpdate: createdComment, predicate: async () => errors.length >= 1, eventName: "error" }),
                publishRandomPost({ communityAddress: communityAddress, pkc: pkc }) // force sub to publish a new update
            ]);

            expect(createdComment.updatedAt).to.be.undefined; // Make sure it didn't use the props from the invalid CommentUpdate
            expect(createdComment.state).to.equal("updating");
            expect(errors.length).to.greaterThanOrEqual(1);
            expect(pkc._updatingComments[createdComment.cid]._invalidCommentUpdateMfsPaths.size).to.equal(errors.length); // it should mark the path as invalid

            for (const error of errors) {
                if (isPKCFetchingUsingGateways(pkc)) {
                    expect(error.code).to.equal("ERR_FAILED_TO_FETCH_COMMENT_UPDATE_FROM_GATEWAYS");
                    for (const gatewayUrl of Object.keys(pkc.clients.ipfsGateways)) {
                        expect(error.details.gatewayToError[gatewayUrl].code).to.equal("ERR_INVALID_COMMENT_UPDATE_SCHEMA");
                    }
                } else expect(error.code).to.equal("ERR_INVALID_COMMENT_UPDATE_SCHEMA");
            }

            await createdComment.stop();
        });

        itSkipIfRpc.sequential(`postCommentInstance.update() emits error when post fails to load from postUpdates`, async () => {
            const sub = await pkc.getCommunity({ address: communityAddress });
            const postCid = sub.posts.pages.hot.comments[0].cid;

            const post = await pkc.getComment({ cid: postCid });
            const errors: PKCError[] = [];
            post.on("error", (err) => errors.push(err as PKCError));
            await post.update();
            await mockPostToFailToLoadFromPostUpdates(post);

            await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => errors.length === 1, eventName: "error" });
            expect(post.updatingState).to.equal("waiting-retry"); // failing to load ipfs path is not critical error

            await post.stop();
            expect(post.state).to.equal("stopped");
            expect(post.updatingState).to.equal("stopped");

            expect(errors.length).to.equal(1);
            expect(errors[0].code).to.equal("ERR_FAILED_TO_FETCH_COMMENT_UPDATE_FROM_ALL_POST_UPDATES_RANGES");
        });

        itSkipIfRpc.sequential(`postCommentInstance.update() emits error when community has no postUpdates`, async () => {
            const sub = await pkc.getCommunity({ address: communityAddress });
            const postCid = sub.posts.pages.hot.comments[0].cid;

            const post = await pkc.getComment({ cid: postCid });
            const errors: PKCError[] = [];
            post.on("error", (err) => errors.push(err as PKCError));
            await post.update();
            await mockPostToHaveCommunityWithNoPostUpdates(post);

            await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => errors.length === 1, eventName: "error" });
            expect(post.updatingState).to.equal("failed");

            await post.stop();
            expect(post.state).to.equal("stopped");
            expect(post.updatingState).to.equal("stopped");

            expect(errors.length).to.equal(1);
            expect(errors[0].code).to.equal("ERR_COMMUNITY_HAS_NO_POST_UPDATES");
        });
    });
});

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe(`comment.update() emits errors for gateways that return content that does not correspond to their cids`, async () => {
        it(`comment.update() emit an error and stops updating loop if gateway responded with a CommentIpfs that's not derived from its CID - IPFS Gateway`, async () => {
            const gatewayUrl = "http://localhost:13415"; // This gateway responds with content that is not equivalent to its CID
            const pkc = await config.pkcInstancePromise({ pkcOptions: { ipfsGatewayUrls: [gatewayUrl] } });

            const cid = "QmUFu8fzuT1th3jJYgR4oRgGpw3sgRALr4nbenA4pyoCav"; // Gateway will respond with random content for this cid
            const createdComment = await pkc.createComment({ cid });

            const ipfsGatewayStates: string[] = [];
            const updatingStates: string[] = [];
            createdComment.on("updatingstatechange", () => updatingStates.push(createdComment.updatingState));
            const ipfsGatewayUrl = Object.keys(createdComment.clients.ipfsGateways)[0];
            createdComment.clients.ipfsGateways[ipfsGatewayUrl].on("statechange", (state) => ipfsGatewayStates.push(state));
            let updateHasBeenEmitted = false;
            createdComment.once("update", () => (updateHasBeenEmitted = true));
            await createdComment.update();

            const err = await new Promise<PKCError>((resolve) => createdComment.once("error", resolve as (err: unknown) => void));
            expect(err.code).to.equal("ERR_FAILED_TO_FETCH_COMMENT_IPFS_FROM_GATEWAYS");
            expect(err.details.gatewayToError[gatewayUrl].code).to.equal("ERR_CALCULATED_CID_DOES_NOT_MATCH");

            // should stop updating by itself because of the critical error

            expect(createdComment.state).to.equal("stopped");
            expect(createdComment.updatingState).to.equal("failed");
            expect(updatingStates).to.deep.equal(["fetching-ipfs", "failed"]);
            expect(ipfsGatewayStates).to.deep.equal(["fetching-ipfs", "stopped"]);
            expect(updateHasBeenEmitted).to.be.false;
            await pkc.destroy();
        });
    });
});

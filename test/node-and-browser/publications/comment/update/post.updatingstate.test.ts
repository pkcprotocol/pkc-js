import signers from "../../../../fixtures/signers.js";
import {
    publishRandomPost,
    mockPostToReturnSpecificCommentUpdate,
    createCommentUpdateWithInvalidSignature,
    mockCommentToNotUsePagesForUpdates,
    resolveWhenConditionIsTrue,
    describeSkipIfRpc,
    getAvailablePKCConfigsToTestAgainst,
    addStringToIpfs,
    createStaticCommunityRecordForComment
} from "../../../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKCError } from "../../../../../dist/node/pkc-error.js";
import type { Comment } from "../../../../../dist/node/publications/comment/comment.js";
import type { PKC } from "../../../../../dist/node/pkc/pkc.js";

const communityAddress = signers[0].address;

// Helper function to clean up state arrays by removing:
// 1. All "waiting-retry" entries
// 2. Adjacent duplicate entries (e.g., ["fetching-community-ipns", "fetching-community-ipns"] -> ["fetching-community-ipns"])
// 3. Repeating pairs of ["fetching-community-ipns", "fetching-community-ipfs"]
const cleanupStateArray = (states: string[]): string[] => {
    const filteredStates = [...states];

    // Remove standalone "waiting-retry" entries
    for (let i = 0; i < filteredStates.length; i++) {
        if (filteredStates[i] === "waiting-retry") {
            filteredStates.splice(i, 1);
            i--; // Adjust index after removing element
        }
    }

    // Remove adjacent duplicates
    for (let i = 0; i < filteredStates.length - 1; i++) {
        if (filteredStates[i] === filteredStates[i + 1]) {
            filteredStates.splice(i + 1, 1);
            i--; // Adjust index after removing element
        }
    }

    // Remove repeating ["fetching-community-ipns", "fetching-community-ipfs"] pairs
    const patternA = "fetching-community-ipns";
    const patternB = "fetching-community-ipfs";
    for (let i = 0; i <= filteredStates.length - 4; i++) {
        if (
            filteredStates[i] === patternA &&
            filteredStates[i + 1] === patternB &&
            filteredStates[i + 2] === patternA &&
            filteredStates[i + 3] === patternB
        ) {
            filteredStates.splice(i + 2, 2); // Remove the second pair
            i--; // Adjust index to re-check the current position after removal
        }
    }

    // Remove repeating ["fetching-community-ipns", "fetching-community-ipfs", "fetching-update-ipfs", "succeeded"] sequences
    const patternC = "fetching-update-ipfs";
    const patternD = "succeeded";
    for (let i = 0; i <= filteredStates.length - 8; i++) {
        // Need to check 8 elements for two consecutive patterns
        if (
            filteredStates[i] === patternA &&
            filteredStates[i + 1] === patternB &&
            filteredStates[i + 2] === patternC &&
            filteredStates[i + 3] === patternD &&
            filteredStates[i + 4] === patternA && // Start of the second sequence
            filteredStates[i + 5] === patternB &&
            filteredStates[i + 6] === patternC &&
            filteredStates[i + 7] === patternD
        ) {
            filteredStates.splice(i + 4, 4); // Remove the second sequence
            i--; // Adjust index to re-check the current position after removal
        }
    }

    return filteredStates;
};

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    describeSkipIfRpc.concurrent(`post.updatingState - ${config.name}`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it.sequential(`Updating states is in correct upon updating a post that's included in preloaded pages of community`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            const postCid = community.posts.pages.hot.comments.find(
                (comment: { author: { address: string } }) => !comment.author.address.includes(".")
            ).cid;
            const mockPost = await pkc.createComment({ cid: postCid });
            const recordedStates: string[] = [];
            mockPost.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            await mockPost.update();
            const expectedStates = [
                "fetching-ipfs",
                "succeeded",
                "fetching-community-ipns",
                "fetching-community-ipfs", // found CommentUpdate of post here
                "succeeded",
                "stopped"
            ];

            await mockPost.update();
            await resolveWhenConditionIsTrue({ toUpdate: mockPost, predicate: async () => typeof mockPost.updatedAt === "number" });
            await mockPost.stop();

            expect(mockPost._commentUpdateIpfsPath).to.not.exist;
            expect(recordedStates.slice(recordedStates.length - expectedStates.length)).to.deep.equal(expectedStates);
        });

        it(`updating states is in correct order upon updating a post with IPFS client using postUpdates`, async () => {
            const dedicatedPKC = await config.pkcInstancePromise();
            try {
                const community = await dedicatedPKC.getCommunity({ address: communityAddress });
                const postCid = community.posts.pages.hot.comments[0].cid;
                const mockPost = await dedicatedPKC.createComment({ cid: postCid });
                const expectedStates = [
                    "fetching-community-ipns",
                    "fetching-community-ipfs",
                    "fetching-update-ipfs",
                    "succeeded",
                    "stopped"
                ];
                const recordedStates: string[] = [];
                mockPost.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

                await mockPost.update();
                mockCommentToNotUsePagesForUpdates(mockPost); // we want to force it to fetch from the post updates
                await resolveWhenConditionIsTrue({ toUpdate: mockPost, predicate: async () => typeof mockPost.updatedAt === "number" });
                await mockPost.stop();

                expect(mockPost._commentUpdateIpfsPath).to.exist;
                expect(recordedStates.slice(recordedStates.length - expectedStates.length)).to.deep.equal(expectedStates);
            } finally {
                await dedicatedPKC.destroy();
            }
        });

        it(`updating state of post is set to failed if sub has an invalid Community record`, async () => {
            const pkc = await config.pkcInstancePromise({ pkcOptions: { resolveAuthorNames: false } }); // set resolve to false so it wouldn't show up in states
            try {
                const { commentCid, communityAddress: communityAddress } = await createStaticCommunityRecordForComment({
                    pkc: pkc,
                    invalidateCommunitySignature: true
                });

                const createdPost = await pkc.createComment({
                    cid: commentCid
                });
                expect(createdPost.content).to.be.undefined;
                expect(createdPost.updatedAt).to.be.undefined;

                const updatingStates: string[] = [];
                createdPost.on("updatingstatechange", () => updatingStates.push(createdPost.updatingState));

                const createErrorPromise = () =>
                    new Promise<void>((resolve) =>
                        createdPost.once("error", (err) => {
                            if ((err as PKCError).code === "ERR_COMMUNITY_SIGNATURE_IS_INVALID") resolve();
                        })
                    );

                await createdPost.update();

                await createErrorPromise();

                await createdPost.stop();
                expect(createdPost.updatedAt).to.be.undefined;

                const expectedUpdateStates = [
                    "fetching-ipfs", // fetching comment ipfs of post
                    "succeeded", // succeeded loading comment ipfs of post
                    "fetching-community-ipns", // fetching community ipns
                    "fetching-community-ipfs", // fetching community ipfs
                    "failed", // community ipfs record is invalid
                    "stopped" // called post.stop()
                ];
                expect(updatingStates).to.deep.equal(expectedUpdateStates);
            } finally {
                await pkc.destroy();
            }
        });

        it(`updating state is set to failed if we load an invalid CommentUpdate record from postUpdates`, async () => {
            const dedicatedPKC = await config.pkcInstancePromise();
            try {
                const community = await dedicatedPKC.getCommunity({ address: communityAddress });
                const commentUpdateWithInvalidSignatureJson = await createCommentUpdateWithInvalidSignature(
                    community.posts.pages.hot.comments[0].cid
                );
                const createdComment = await dedicatedPKC.createComment({
                    cid: commentUpdateWithInvalidSignatureJson.cid
                });

                const updatingStates: string[] = [];
                createdComment.on("updatingstatechange", () => updatingStates.push(createdComment.updatingState));

                const errors: PKCError[] = [];

                createdComment.on("error", (err) => errors.push(err as PKCError));

                await createdComment.update();

                await mockPostToReturnSpecificCommentUpdate(createdComment, JSON.stringify(commentUpdateWithInvalidSignatureJson));

                await resolveWhenConditionIsTrue({
                    toUpdate: createdComment,
                    predicate: async () => errors.length === 1,
                    eventName: "error"
                });

                await publishRandomPost({ communityAddress: communityAddress, pkc: dedicatedPKC }); // force community to publish a new update which will increase loading attempts
                await resolveWhenConditionIsTrue({
                    toUpdate: createdComment,
                    predicate: async () => errors.length >= 2,
                    eventName: "error"
                });

                await createdComment.stop();

                expect(createdComment.updatedAt).to.be.undefined; // should not accept the comment update

                expect(createdComment.raw.commentUpdate).to.be.undefined;

                for (const err of errors) {
                    expect(err.code).to.equal("ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID");
                }

                const expectedUpdateStates = [
                    "fetching-ipfs",
                    "succeeded",
                    "fetching-community-ipns",
                    "fetching-community-ipfs",
                    "fetching-update-ipfs",
                    "failed"
                ];
                expect(updatingStates.slice(0, expectedUpdateStates.length)).to.deep.equal(expectedUpdateStates);

                const restOfUpdatingStates = updatingStates.slice(expectedUpdateStates.length, updatingStates.length);
                for (let i = 0; i < restOfUpdatingStates.length; i += 2) {
                    if (
                        restOfUpdatingStates[i] === "fetching-community-ipns" &&
                        restOfUpdatingStates[i + 1] === "fetching-community-ipfs"
                    ) {
                        expect(restOfUpdatingStates[i + 2]).to.equal("fetching-update-ipfs"); // second attempt to load invalid CommentUpdate
                        expect(restOfUpdatingStates[i + 3]).to.equal("failed");
                    }
                }
                expect(updatingStates[updatingStates.length - 1]).to.equal("stopped");
            } finally {
                await dedicatedPKC.destroy();
            }
        });
    });
});

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describeSkipIfRpc.concurrent(`post.updatingState - ${config.name}`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        // Gateway invalid signature errors are silently retriable (no error event, no "failed" state)
        it(`updating state of post retries silently if gateway community has an invalid Community record`, async () => {
            const dedicatedPKC = await config.pkcInstancePromise();
            try {
                const { commentCid, communityAddress: communityAddress } = await createStaticCommunityRecordForComment({
                    pkc: dedicatedPKC,
                    invalidateCommunitySignature: true
                });
                const createdPost = await dedicatedPKC.createComment({ cid: commentCid });
                expect(createdPost.content).to.be.undefined;
                expect(createdPost.updatedAt).to.be.undefined;

                const recordedStates: string[] = [];
                createdPost.on("updatingstatechange", () => recordedStates.push(createdPost.updatingState));

                await createdPost.update();

                // Wait for the post to reach waiting-retry (silent retry for gateway signature error)
                await resolveWhenConditionIsTrue({
                    toUpdate: createdPost,
                    predicate: async () => recordedStates.includes("waiting-retry"),
                    eventName: "updatingstatechange"
                });

                await createdPost.stop();
                expect(createdPost.updatedAt).to.be.undefined;
                expect(createdPost.raw.commentUpdate).to.be.undefined;

                const expectedUpdateStates = [
                    "fetching-ipfs", // fetching comment ipfs of post
                    "succeeded", // succeeded loading comment ipfs of post
                    "fetching-community-ipns", // fetching community ipns from gateway
                    "waiting-retry", // community ipfs record has invalid signature, silently retrying
                    "stopped" // called post.stop()
                ];
                expect(recordedStates).to.deep.equal(expectedUpdateStates);
            } finally {
                await dedicatedPKC.destroy();
            }
        });

        it(`updating state is set to failed if we load an invalid CommentUpdate record from postUpdates`, async () => {
            const dedicatedPKC = await config.pkcInstancePromise();
            try {
                const community = await dedicatedPKC.getCommunity({ address: communityAddress });
                const commentUpdateWithInvalidSignatureJson = await createCommentUpdateWithInvalidSignature(
                    community.posts.pages.hot.comments[0].cid
                );
                const createdComment = await dedicatedPKC.createComment({
                    cid: commentUpdateWithInvalidSignatureJson.cid
                });

                const recordedStates: string[] = [];
                createdComment.on("updatingstatechange", () => recordedStates.push(createdComment.updatingState));

                const createErrorPromise = () =>
                    new Promise<void>((resolve) =>
                        createdComment.once("error", (err) => {
                            if (
                                (err as PKCError).details.gatewayToError["http://localhost:18080"].code ===
                                "ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID"
                            )
                                resolve();
                        })
                    );

                await createdComment.update();

                await mockPostToReturnSpecificCommentUpdate(createdComment, JSON.stringify(commentUpdateWithInvalidSignatureJson));

                await createErrorPromise();

                await publishRandomPost({ communityAddress: communityAddress, pkc: dedicatedPKC }); // force community to publish a new update which will increase loading attempts
                await createErrorPromise();

                await createdComment.stop();

                expect(createdComment.updatedAt).to.be.undefined; // should not accept the comment update

                const expectedUpdateStates = ["fetching-ipfs", "succeeded", "fetching-community-ipns", "fetching-update-ipfs", "failed"];
                expect(recordedStates.slice(0, expectedUpdateStates.length)).to.deep.equal(expectedUpdateStates);

                const restOfUpdatingStates = recordedStates.slice(expectedUpdateStates.length, recordedStates.length);
                for (let i = 0; i < restOfUpdatingStates.length; i += 2) {
                    if (
                        restOfUpdatingStates[i] === "fetching-community-ipns" &&
                        restOfUpdatingStates[i + 1] === "fetching-community-ipfs"
                    ) {
                        expect(restOfUpdatingStates[i + 2]).to.equal("fetching-update-ipfs"); // second attempt to load invalid CommentUpdate
                        expect(restOfUpdatingStates[i + 3]).to.equal("failed");
                    }
                }
                expect(recordedStates[recordedStates.length - 1]).to.equal("stopped");
            } finally {
                await dedicatedPKC.destroy();
            }
        });
        it(`Updating states is in correct upon updating a post that's included in preloaded pages of community`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            const postCid = community.posts.pages.hot.comments[0].cid;
            const mockPost = await pkc.createComment({ cid: postCid });
            const recordedStates: string[] = [];
            mockPost.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            await mockPost.update();
            const expectedStates = [
                "fetching-ipfs",
                "succeeded",
                "fetching-community-ipns", // found CommentUpdate of post here
                "succeeded",
                "stopped"
            ];

            await mockPost.update();
            await resolveWhenConditionIsTrue({ toUpdate: mockPost, predicate: async () => typeof mockPost.updatedAt === "number" });
            await mockPost.stop();

            expect(mockPost._commentUpdateIpfsPath).to.not.exist;
            expect(recordedStates.slice(recordedStates.length - expectedStates.length)).to.deep.equal(expectedStates);
        });

        it(`updating states is in correct order upon updating a post with gateway using postUpdates`, async () => {
            const dedicatedPKC = await config.pkcInstancePromise();
            try {
                const community = await dedicatedPKC.getCommunity({ address: communityAddress });
                const postCid = community.posts.pages.hot.comments[0].cid;
                const mockPost = await dedicatedPKC.createComment({ cid: postCid });
                const expectedStates = [
                    "fetching-ipfs",
                    "succeeded",
                    "fetching-community-ipns",
                    "fetching-update-ipfs",
                    "succeeded",
                    "stopped"
                ];
                const recordedStates: string[] = [];
                mockPost.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

                await mockPost.update();
                mockCommentToNotUsePagesForUpdates(mockPost);

                await resolveWhenConditionIsTrue({ toUpdate: mockPost, predicate: async () => typeof mockPost.updatedAt === "number" });
                await mockPost.stop();

                expect(mockPost._commentUpdateIpfsPath).to.exist;

                const filteredExpectedStates = cleanupStateArray(expectedStates);
                const filteredRecordedStates = cleanupStateArray(recordedStates);
                expect(filteredRecordedStates).to.deep.equal(filteredExpectedStates);
            } finally {
                await dedicatedPKC.destroy();
            }
        });
    });
});

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describeSkipIfRpc.concurrent(`post.updatingState - ${config.name}`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`post.updatingState defaults to stopped after pkc.createComment()`, async () => {
            const comment = await pkc.createComment({ cid: "QmUrxBiaphUt3K6qDs2JspQJAgm34sKQaa5YaRmyAWXN4D" });
            expect(comment.updatingState).to.equal("stopped");
        });

        it(`does not recurse when the post instance is already tracked as the updating instance`, async () => {
            const postCid = "QmUrxBiaphUt3K6qDs2JspQJAgm34sKQaa5YaRmyAWXN4D";
            const post = await pkc.createComment({ cid: postCid });
            const previousUpdatingEntry = pkc._updatingComments[postCid];

            // Mirror the bug scenario: the same instance is placed in _updatingComments before update()
            pkc._updatingComments[postCid] = post;

            try {
                await post.update(); // _updatingCommentInstance points to itself after this call
                const readUpdatingState = () => post.updatingState;

                expect(readUpdatingState).to.not.throw();
                expect(readUpdatingState()).to.equal("fetching-ipfs");
            } finally {
                await post.stop();
            }
        });

        it(`the order of state-event-statechange is correct when we get a new update from post`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            const postCid = community.posts.pages.hot.comments[0].cid;
            const mockPost = await pkc.createComment({ cid: postCid });
            expect(mockPost.raw.comment).to.be.undefined;
            expect(mockPost.raw.commentUpdate).to.be.undefined;
            expect(mockPost.updatedAt).to.be.undefined;
            const recordedStates: string[] = [];
            mockPost.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            const commentIpfsUpdate = new Promise<void>((resolve, reject) => {
                mockPost.once("update", () => {
                    if (mockPost.updatingState !== "succeeded") reject("updating state should be succeeded after getting comment ipfs");
                    if (recordedStates.length === 0) reject("should have emitted an event");
                    if (recordedStates[recordedStates.length - 1] === "succeeded") reject("should not emit an event just yet");
                    resolve();
                });
            });

            const commentUpdatePromise = new Promise<void>((resolve, reject) => {
                mockPost.on("update", () => {
                    if (!mockPost.updatedAt) return;
                    if (mockPost.updatingState !== "succeeded") reject("updating state should be succeeded after getting comment ipfs");
                    if (recordedStates.length === 0) reject("should have emitted an event");
                    // if (recordedStates[recordedStates.length - 1] === "succeeded") reject("should not emit an event just yet");
                    resolve();
                });
            });

            await mockPost.update();
            await commentIpfsUpdate;
            await commentUpdatePromise;

            await mockPost.stop();
        });

        it.sequential(`the order of state-event-statechange is correct when we get an unretriable error from post`, async () => {
            const cidOfInvalidJson = await addStringToIpfs("<html>something");
            const createdComment = await pkc.createComment({ cid: cidOfInvalidJson });

            const updatingStates: string[] = [];
            createdComment.on("updatingstatechange", () => updatingStates.push(createdComment.updatingState));
            const errors: PKCError[] = [];
            createdComment.on("error", (err) => errors.push(err as PKCError));

            const commentErrorPromise = new Promise<void>((resolve, reject) => {
                createdComment.once("error", (err) => {
                    if ((err as PKCError).code !== "ERR_INVALID_JSON") reject("error should be ERR_INVALID_JSON");
                    if (createdComment.updatingState !== "failed") reject("updating state should be failed after getting error");
                    if (updatingStates.length === 0) reject("should have emitted an event");
                    if (updatingStates[updatingStates.length - 1] === "failed") reject("should not emit an event just yet");
                    resolve();
                });
            });

            // should stop updating by itself because of the critical error

            await createdComment.update();
            await commentErrorPromise;

            expect(createdComment.depth).to.be.undefined; // Make sure it did not use the props from the invalid CommentIpfs
            expect(createdComment.state).to.equal("stopped");
            expect(createdComment.updatingState).to.equal("failed");
        });
    });
});

describe("comment.updatingState", async () => {
    // We're using Math CLI community because the default community may contain comments with ENS for author address
    // Which will change the expected states
    // We should probably add a test for state when a comment with ENS for author address is in pages

    it(`Add a test for updatingState with resolving-author-name`);
});

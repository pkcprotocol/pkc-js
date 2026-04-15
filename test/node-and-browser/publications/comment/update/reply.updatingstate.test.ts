import signers from "../../../../fixtures/signers.js";
import {
    resolveWhenConditionIsTrue,
    publishRandomReply,
    describeSkipIfRpc,
    getAvailablePKCConfigsToTestAgainst,
    publishRandomPost,
    createStaticCommunityRecordForComment
} from "../../../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKCError } from "../../../../../dist/node/pkc-error.js";
import type { CommentIpfsWithCidDefined } from "../../../../../dist/node/publications/comment/types.js";
import type { PKC } from "../../../../../dist/node/pkc/pkc.js";
// Helper type to access private properties for testing
type CommentClientsManagerWithInternals = {
    _parentFirstPageCidsAlreadyLoaded: Set<string>;
};

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

    // Remove ["fetching-community-ipns", "fetching-community-ipfs", "fetching-update-ipfs", "failed"] pattern
    const patternE = "failed";
    for (let i = 0; i <= filteredStates.length - 4; i++) {
        if (
            filteredStates[i] === patternA &&
            filteredStates[i + 1] === patternB &&
            filteredStates[i + 2] === patternC &&
            filteredStates[i + 3] === patternE
        ) {
            filteredStates.splice(i, 4); // Remove the entire pattern
            i--; // Adjust index to re-check the current position after removal
        }
    }

    return filteredStates;
};

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    describeSkipIfRpc.concurrent(`reply.updatingState - ${config.name}`, async () => {
        let replyCid: string;
        beforeAll(async () => {
            const tempPKC = await config.pkcInstancePromise();
            const community = await tempPKC.getCommunity({ address: communityAddress });
            const post = await publishRandomPost({ communityAddress: community.address, pkc: tempPKC });
            const reply = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, pkc: tempPKC });
            replyCid = reply.cid;
            await tempPKC.destroy();
        });

        it.sequential(`Updating states is in correct upon updating a reply that's included in preloaded pages of its parent`, async () => {
            const pkc = await config.pkcInstancePromise();
            try {
                const community = await pkc.getCommunity({ address: communityAddress });
                // we don't want domain name in author addrses so its resolving doesn't get included in expected states
                const postWithMostReplies = community.posts.pages.hot.comments.reduce((current, post) => {
                    if (!post.replies) {
                        return current;
                    }
                    if (!current || (post.replyCount ?? 0) > (current.replyCount ?? 0)) {
                        return post;
                    }
                    return current;
                }, undefined);
                const preloadedReplyCid = postWithMostReplies?.replies.pages.best.comments.find(
                    (reply) => !reply.author.address.includes(".")
                )?.cid;
                expect(preloadedReplyCid).to.be.a("string");
                const mockReply = await pkc.createComment({ cid: preloadedReplyCid });
                const expectedStates = [
                    "fetching-ipfs", // fetching comment ipfs of reply
                    "succeeded", // succeeded loading comment ipfs of reply
                    "fetching-community-ipns",
                    "fetching-community-ipfs", // found CommentUpdate of reply here
                    "succeeded",
                    "stopped"
                ];
                const recordedStates: string[] = [];
                mockReply.on("updatingstatechange", (newState) => recordedStates.push(newState));

                await mockReply.update();

                await resolveWhenConditionIsTrue({ toUpdate: mockReply, predicate: async () => typeof mockReply.updatedAt === "number" });
                const updatingMockReply = pkc._updatingComments[mockReply.cid];
                const clientsManager = updatingMockReply._clientsManager as unknown as CommentClientsManagerWithInternals;
                expect(clientsManager._parentFirstPageCidsAlreadyLoaded.size).to.equal(0);
                await mockReply.stop();

                expect(mockReply._commentUpdateIpfsPath).to.not.exist;
                const filteredExpectedStates = cleanupStateArray(expectedStates);
                const filteredRecordedStates = cleanupStateArray(recordedStates);
                expect(filteredRecordedStates).to.deep.equal(
                    filteredExpectedStates,
                    "recorded states: " + recordedStates.join(", ") + "Author is " + JSON.stringify(mockReply.author)
                );
            } finally {
                await pkc.destroy();
            }
        });
        it(`updating state of reply is set to failed if community has an invalid Community record`, async () => {
            const pkc = await config.pkcInstancePromise();
            try {
                const { commentCid: mockedReplyCid, communityAddress: communityAddress } = await createStaticCommunityRecordForComment({
                    invalidateCommunitySignature: true
                });

                const mockReply = await pkc.createComment({ cid: mockedReplyCid, communityAddress: communityAddress });

                const recordedStates: string[] = [];
                mockReply.on("updatingstatechange", () => recordedStates.push(mockReply.updatingState));

                const createErrorPromise = () =>
                    new Promise<void>((resolve) =>
                        mockReply.once("error", (err) => {
                            if ((err as PKCError).code === "ERR_COMMUNITY_SIGNATURE_IS_INVALID") resolve();
                        })
                    );
                await mockReply.update();

                await createErrorPromise();

                await mockReply.stop();

                const expectedUpdateStates = [
                    "fetching-ipfs", // fetching comment ipfs of reply
                    "succeeded", // succeeded loading comment ipfs of reply
                    "fetching-community-ipns", // fetching community ipns
                    "fetching-community-ipfs", // fetching community ipfs
                    "failed", // community ipfs record is invalid
                    "stopped" // called post.stop()
                ];
                const filteredExpectedStates = cleanupStateArray(expectedUpdateStates);
                const filteredRecordedStates = cleanupStateArray(recordedStates);
                expect(filteredRecordedStates).to.deep.equal(filteredExpectedStates);
            } finally {
                await pkc.destroy();
            }
        });
    });
});

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-ipfs-gateway"] }).map((config) => {
    describe.concurrent(`reply.updatingState - ${config.name}`, async () => {
        it(`updating state of reply is in correct order upon updating a reply that's included in preloaded pages of its parent`, async () => {
            const pkc = await config.pkcInstancePromise();
            try {
                const community = await pkc.getCommunity({ address: communityAddress });
                // we don't want domain name in author addrses so its resolving doesn't get included in expected states
                const replyCid = community.posts.pages.hot.comments.find((post) => post.replies && !post.author.address.includes("."))
                    .replies.pages.best.comments[0].cid;
                const mockReply = await pkc.createComment({ cid: replyCid });
                const expectedStates = [
                    "fetching-ipfs", // fetching comment ipfs of reply
                    "succeeded", // succeeded loading comment ipfs of reply
                    "fetching-community-ipns", // found CommentUpdate of reply here
                    "succeeded",
                    "stopped"
                ];
                const recordedStates: string[] = [];
                mockReply.on("updatingstatechange", (newState) => recordedStates.push(newState));

                await mockReply.update();

                await resolveWhenConditionIsTrue({ toUpdate: mockReply, predicate: async () => typeof mockReply.updatedAt === "number" });
                await mockReply.stop();

                expect(mockReply._commentUpdateIpfsPath).to.not.exist;
                const filteredExpectedStates = cleanupStateArray(expectedStates);
                const filteredRecordedStates = cleanupStateArray(recordedStates);
                expect(filteredRecordedStates).to.deep.equal(filteredExpectedStates);
            } finally {
                await pkc.destroy();
            }
        });

        // Gateway invalid signature errors are silently retriable (no error event, no "failed" state)
        it(`updating state of reply retries silently if gateway community has an invalid Community record`, async () => {
            const pkc = await config.pkcInstancePromise();
            try {
                const { commentCid: mockedReplyCid, communityAddress: communityAddress } = await createStaticCommunityRecordForComment({
                    pkc: pkc,
                    invalidateCommunitySignature: true,
                    commentOptions: {
                        content: `Mock reply content - ${Date.now()}`
                    }
                });

                const mockReply = await pkc.createComment({ cid: mockedReplyCid, communityAddress: communityAddress });
                const recordedStates: string[] = [];
                mockReply.on("updatingstatechange", () => recordedStates.push(mockReply.updatingState));

                await mockReply.update();

                // Wait for the reply to reach waiting-retry (silent retry for gateway signature error)
                await resolveWhenConditionIsTrue({
                    toUpdate: mockReply,
                    predicate: async () => recordedStates.includes("waiting-retry"),
                    eventName: "updatingstatechange"
                });

                await mockReply.stop();
                expect(mockReply.updatedAt).to.be.undefined;

                const expectedUpdateStates = [
                    "fetching-ipfs", // fetching comment ipfs of reply
                    "succeeded", // succeeded loading comment ipfs of reply
                    "fetching-community-ipns", // fetching community ipns from gateway
                    "waiting-retry", // community ipfs record has invalid signature, silently retrying
                    "stopped" // called post.stop()
                ];
                const filteredExpectedStates = cleanupStateArray(expectedUpdateStates);
                const filteredRecordedStates = cleanupStateArray(recordedStates);
                expect(filteredRecordedStates).to.deep.equal(filteredExpectedStates);
            } finally {
                await pkc.destroy();
            }
        });
    });
});

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describeSkipIfRpc.concurrent(`reply.updatingState - ${config.name}`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`the order of state-event-statechange is correct when we get a new update from reply`, async () => {
            const community = await pkc.getCommunity({ address: communityAddress });
            const replyCid = community.posts.pages.hot.comments.find((post: { replies?: unknown }) => post.replies).replies.pages.best
                .comments[0].cid;
            const mockReply = await pkc.createComment({ cid: replyCid });
            expect(mockReply.updatedAt).to.be.undefined;
            const recordedStates: string[] = [];
            mockReply.on("updatingstatechange", (newState: string) => recordedStates.push(newState));

            const commentIpfsUpdate = new Promise<void>((resolve, reject) => {
                mockReply.once("update", () => {
                    if (mockReply.updatingState !== "succeeded") reject("updating state should be succeeded after getting comment ipfs");
                    if (recordedStates.length === 0) reject("should have emitted an event");
                    if (recordedStates[recordedStates.length - 1] === "succeeded") reject("should not emit an event just yet");
                    resolve();
                });
            });

            const commentUpdatePromise = new Promise<void>((resolve, reject) => {
                mockReply.on("update", () => {
                    if (!mockReply.updatedAt) return;
                    if (mockReply.updatingState !== "succeeded") reject("updating state should be succeeded after getting comment ipfs");
                    if (recordedStates.length === 0) reject("should have emitted an event");
                    if (recordedStates[recordedStates.length - 1] === "succeeded") reject("should not emit an event just yet");
                    resolve();
                });
            });

            await mockReply.update();
            await commentIpfsUpdate;
            await commentUpdatePromise;

            await mockReply.stop();
        });
    });
});

import {
    createSubWithNoChallenge,
    getAvailablePKCConfigsToTestAgainst,
    mockPKC,
    publishCommentWithDepth,
    disablePreloadPagesOnSub,
    publishRandomReply,
    resolveWhenConditionIsTrue
} from "../../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../../helpers/conditional-tests.js";

import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC as PKCType } from "../../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../../dist/node/community/rpc-local-community.js";
import type { CommentUpdatingState, CommentIpfsWithCidDefined } from "../../../../../dist/node/publications/comment/types.js";

interface ReplyParentPagesTestContext {
    publisherPKC: PKCType;
    replyCid: string;
    cleanup: () => Promise<void>;
}

const pkcConfigs = getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true });
const replyDepthsToTest = [1, 2, 3, 5, 15, 30];

describeSkipIfRpc("reply.updatingState via parent pageCIDs (node)", () => {
    replyDepthsToTest.forEach((replyDepth) => {
        describe.concurrent(`reply depth ${replyDepth}`, () => {
            let context: ReplyParentPagesTestContext;

            beforeAll(async () => {
                // this hook times out sometimes
                context = await createReplyParentPagesTestEnvironment({ replyDepth });
            });

            afterAll(async () => {
                await context.cleanup();
            });

            pkcConfigs.forEach((config) => {
                it(`loads reply updates from parent pageCIDs and emits expected state transitions - ${config.name}`, async () => {
                    if (!context) throw new Error("Test context was not initialized");
                    const pkc = await config.pkcInstancePromise();

                    const recordedStates: CommentUpdatingState[] = [];
                    let reply: Comment | undefined;
                    try {
                        reply = await pkc.createComment({ cid: context.replyCid });

                        expect(reply.content).to.be.undefined;
                        expect(reply.updatedAt).to.be.undefined;

                        reply.on("updatingstatechange", (newState) => recordedStates.push(newState));

                        const commentUpdatePromise = new Promise<void>((resolve, reject) => {
                            reply!.on("update", () => {
                                if (!reply!.updatedAt) return;
                                if (reply!.updatingState !== "succeeded")
                                    reject("updating state should be succeeded after getting comment ipfs");
                                if (recordedStates.length === 0) reject("should have emitted an event");
                                if (recordedStates[recordedStates.length - 1] === "succeeded") reject("should not emit an event just yet");
                                resolve();
                            });
                        });

                        await reply.update();
                        expect(reply.content).to.be.undefined;
                        expect(reply.updatedAt).to.be.undefined;

                        await commentUpdatePromise;
                        await resolveWhenConditionIsTrue({
                            toUpdate: reply,
                            predicate: async () => typeof reply!.updatedAt === "number"
                        });

                        const updatingMockReply = pkc._updatingComments[reply.cid!];
                        expect(updatingMockReply).to.exist;
                        const numOfUpdates = recordedStates.filter((state) => state === "succeeded").length - 1;
                        expect(numOfUpdates).to.be.greaterThan(0);
                        // Access private property for test verification
                        const clientsManager = updatingMockReply._clientsManager as unknown as {
                            _parentFirstPageCidsAlreadyLoaded: Set<string>;
                        };
                        expect(clientsManager._parentFirstPageCidsAlreadyLoaded.size).to.be.greaterThanOrEqual(numOfUpdates);

                        await reply.stop();

                        const filteredRecordedStates = cleanupStateArray(recordedStates);
                        const expectedStates = getExpectedStatesForConfig(config.testConfigCode);
                        const trimmedRecordedStates = filteredRecordedStates.slice(0, expectedStates.length);
                        expect(trimmedRecordedStates).to.deep.equal(
                            expectedStates,
                            "recorded states: " + filteredRecordedStates.join(", ")
                        );
                        expect(filteredRecordedStates[filteredRecordedStates.length - 1]).to.equal("stopped");
                    } finally {
                        await reply?.stop();
                        await pkc.destroy();
                    }
                });
            });
        });
    });
});

describeSkipIfRpc.concurrent("reply.updatingState regression (node)", () => {
    pkcConfigs.forEach((config) => {
        it.concurrent(`does not recurse when reply is already the updating instance - ${config.name}`, async () => {
            const pkc = await config.pkcInstancePromise();
            const replyCid = "QmUrxBiaphUt3K6qDs2JspQJAgm34sKQaa5YaRmyAWXN4D";
            const reply = await pkc.createComment({ cid: replyCid });

            // Force the same instance to be treated as the updating instance to mirror the recursion bug
            pkc._updatingComments[replyCid] = reply;

            try {
                await reply.update(); // sets _updatingCommentInstance to itself

                const readUpdatingState = () => reply.updatingState;
                expect(readUpdatingState).to.not.throw();
                expect(readUpdatingState()).to.equal("fetching-ipfs");
            } finally {
                await reply.stop();
                await pkc.destroy();
            }
        });
    });
});

async function createReplyParentPagesTestEnvironment({ replyDepth }: { replyDepth: number }): Promise<ReplyParentPagesTestContext> {
    if (replyDepth === undefined || replyDepth === null) throw new Error("replyDepth is required");
    if (replyDepth < 1) throw new Error("replyDepth must be at least 1");

    const publisherPKC = await mockPKC();
    const community = (await createSubWithNoChallenge({}, publisherPKC)) as LocalCommunity | RpcLocalCommunity;

    try {
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        const reply = await publishCommentWithDepth({ depth: replyDepth, community });
        const parentComment = await publisherPKC.getComment({ cid: reply.parentCid! });

        await parentComment.update();
        await resolveWhenConditionIsTrue({
            toUpdate: parentComment,
            predicate: async () => typeof parentComment.updatedAt === "number"
        });

        const { cleanup: preloadCleanup } = disablePreloadPagesOnSub({ community: community as LocalCommunity });

        await publishRandomReply({ parentComment: parentComment as CommentIpfsWithCidDefined, pkc: publisherPKC }); // to force an update
        // below could timeout
        await resolveWhenConditionIsTrue({
            toUpdate: parentComment,
            predicate: async () => Object.keys(parentComment.replies.pageCids).length > 0
        });
        expect(community.posts.pages.hot.comments.length).to.equal(0);

        const cleanup = async () => {
            preloadCleanup();
            await community.delete();
            await publisherPKC.destroy();
        };

        return {
            publisherPKC,
            replyCid: reply.cid!,
            cleanup
        };
    } catch (error) {
        await community.delete();
        await publisherPKC.destroy();
        throw error;
    }
}

function getExpectedStatesForConfig(configCode: string): CommentUpdatingState[] {
    if (!configCode) throw new Error("pkc config code is required");
    const normalizedCode = configCode.toLowerCase();
    const base: CommentUpdatingState[] = ["fetching-ipfs", "succeeded"];

    if (normalizedCode === "remote-ipfs-gateway") {
        return cleanupStateArray([...base, "fetching-community-ipns", "fetching-update-ipfs", "succeeded", "stopped"]);
    }

    if (normalizedCode === "local-kubo-rpc") {
        return cleanupStateArray([...base, "fetching-update-ipfs", "succeeded", "stopped"]);
    }

    if (normalizedCode === "remote-libp2pjs") {
        return cleanupStateArray([
            ...base,
            "fetching-community-ipns",
            "fetching-community-ipfs",
            "fetching-update-ipfs",
            "succeeded",
            "stopped"
        ]);
    }

    // default (e.g. remote Kubo without datapath)
    return cleanupStateArray([
        ...base,
        "fetching-community-ipns",
        "fetching-community-ipfs",
        "fetching-update-ipfs",
        "succeeded",
        "stopped"
    ]);
}

const cleanupStateArray = (states: CommentUpdatingState[]): CommentUpdatingState[] => {
    const filteredStates = [...states];

    for (let i = 0; i < filteredStates.length; i++) {
        if (filteredStates[i] === "waiting-retry") {
            filteredStates.splice(i, 1);
            i--;
        }
    }

    for (let i = 0; i < filteredStates.length - 1; i++) {
        if (filteredStates[i] === filteredStates[i + 1]) {
            filteredStates.splice(i + 1, 1);
            i--;
        }
    }

    const patternA: CommentUpdatingState = "fetching-community-ipns";
    const patternB: CommentUpdatingState = "fetching-community-ipfs";
    for (let i = 0; i <= filteredStates.length - 4; i++) {
        if (
            filteredStates[i] === patternA &&
            filteredStates[i + 1] === patternB &&
            filteredStates[i + 2] === patternA &&
            filteredStates[i + 3] === patternB
        ) {
            filteredStates.splice(i + 2, 2);
            i--;
        }
    }

    const patternC: CommentUpdatingState = "fetching-update-ipfs";
    const patternD: CommentUpdatingState = "succeeded";
    for (let i = 0; i <= filteredStates.length - 4; i++) {
        if (
            filteredStates[i] === patternA &&
            filteredStates[i + 1] === patternB &&
            filteredStates[i + 2] === patternA &&
            filteredStates[i + 3] === patternC
        ) {
            filteredStates.splice(i + 2, 1);
            i--;
        }
    }
    for (let i = 0; i <= filteredStates.length - 8; i++) {
        if (
            filteredStates[i] === patternA &&
            filteredStates[i + 1] === patternB &&
            filteredStates[i + 2] === patternC &&
            filteredStates[i + 3] === patternD &&
            filteredStates[i + 4] === patternA &&
            filteredStates[i + 5] === patternB &&
            filteredStates[i + 6] === patternC &&
            filteredStates[i + 7] === patternD
        ) {
            filteredStates.splice(i + 4, 4);
            i--;
        }
    }

    const patternE: CommentUpdatingState = "failed";
    for (let i = 0; i <= filteredStates.length - 4; i++) {
        if (
            filteredStates[i] === patternA &&
            filteredStates[i + 1] === patternB &&
            filteredStates[i + 2] === patternC &&
            filteredStates[i + 3] === patternE
        ) {
            filteredStates.splice(i, 4);
            i--;
        }
    }

    return filteredStates;
};

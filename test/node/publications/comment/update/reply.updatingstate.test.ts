import {
    createSubWithNoChallenge,
    describeSkipIfRpc,
    getAvailablePlebbitConfigsToTestAgainst,
    mockPlebbit,
    publishCommentWithDepth,
    disablePreloadPagesOnSub,
    publishRandomReply,
    resolveWhenConditionIsTrue
} from "../../../../../dist/node/test/test-util.js";

import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit as PlebbitType } from "../../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../../dist/node/publications/comment/comment.js";
import type { LocalSubplebbit } from "../../../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { CommentUpdatingState, CommentIpfsWithCidDefined } from "../../../../../dist/node/publications/comment/types.js";

interface ReplyParentPagesTestContext {
    publisherPlebbit: PlebbitType;
    replyCid: string;
    cleanup: () => Promise<void>;
}

const plebbitConfigs = getAvailablePlebbitConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true });
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

            plebbitConfigs.forEach((config) => {
                it(`loads reply updates from parent pageCIDs and emits expected state transitions - ${config.name}`, async () => {
                    if (!context) throw new Error("Test context was not initialized");
                    const plebbit = await config.plebbitInstancePromise();

                    const recordedStates: CommentUpdatingState[] = [];
                    let reply: Comment | undefined;
                    try {
                        reply = await plebbit.createComment({ cid: context.replyCid });

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

                        const updatingMockReply = plebbit._updatingComments[reply.cid!];
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
                        await plebbit.destroy();
                    }
                });
            });
        });
    });
});

describeSkipIfRpc.concurrent("reply.updatingState regression (node)", () => {
    plebbitConfigs.forEach((config) => {
        it.concurrent(`does not recurse when reply is already the updating instance - ${config.name}`, async () => {
            const plebbit = await config.plebbitInstancePromise();
            const replyCid = "QmUrxBiaphUt3K6qDs2JspQJAgm34sKQaa5YaRmyAWXN4D";
            const reply = await plebbit.createComment({ cid: replyCid });

            // Force the same instance to be treated as the updating instance to mirror the recursion bug
            plebbit._updatingComments[replyCid] = reply;

            try {
                await reply.update(); // sets _updatingCommentInstance to itself

                const readUpdatingState = () => reply.updatingState;
                expect(readUpdatingState).to.not.throw();
                expect(readUpdatingState()).to.equal("fetching-ipfs");
            } finally {
                await reply.stop();
                await plebbit.destroy();
            }
        });
    });
});

async function createReplyParentPagesTestEnvironment({ replyDepth }: { replyDepth: number }): Promise<ReplyParentPagesTestContext> {
    if (replyDepth === undefined || replyDepth === null) throw new Error("replyDepth is required");
    if (replyDepth < 1) throw new Error("replyDepth must be at least 1");

    const publisherPlebbit = await mockPlebbit();
    const subplebbit = (await createSubWithNoChallenge({}, publisherPlebbit)) as LocalSubplebbit | RpcLocalSubplebbit;

    try {
        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        const reply = await publishCommentWithDepth({ depth: replyDepth, subplebbit });
        const parentComment = await publisherPlebbit.getComment({ cid: reply.parentCid! });

        await parentComment.update();
        await resolveWhenConditionIsTrue({
            toUpdate: parentComment,
            predicate: async () => typeof parentComment.updatedAt === "number"
        });

        const { cleanup: preloadCleanup } = disablePreloadPagesOnSub({ subplebbit: subplebbit as LocalSubplebbit });

        await publishRandomReply({ parentComment: parentComment as CommentIpfsWithCidDefined, plebbit: publisherPlebbit }); // to force an update
        // below could timeout
        await resolveWhenConditionIsTrue({
            toUpdate: parentComment,
            predicate: async () => Object.keys(parentComment.replies.pageCids).length > 0
        });
        expect(subplebbit.posts.pages.hot.comments.length).to.equal(0);

        const cleanup = async () => {
            preloadCleanup();
            await subplebbit.delete();
            await publisherPlebbit.destroy();
        };

        return {
            publisherPlebbit,
            replyCid: reply.cid!,
            cleanup
        };
    } catch (error) {
        await subplebbit.delete();
        await publisherPlebbit.destroy();
        throw error;
    }
}

function getExpectedStatesForConfig(configCode: string): CommentUpdatingState[] {
    if (!configCode) throw new Error("plebbit config code is required");
    const normalizedCode = configCode.toLowerCase();
    const base: CommentUpdatingState[] = ["fetching-ipfs", "succeeded"];

    if (normalizedCode === "remote-ipfs-gateway") {
        return cleanupStateArray([...base, "fetching-subplebbit-ipns", "fetching-update-ipfs", "succeeded", "stopped"]);
    }

    if (normalizedCode === "local-kubo-rpc") {
        return cleanupStateArray([...base, "fetching-update-ipfs", "succeeded", "stopped"]);
    }

    if (normalizedCode === "remote-libp2pjs") {
        return cleanupStateArray([
            ...base,
            "fetching-subplebbit-ipns",
            "fetching-subplebbit-ipfs",
            "fetching-update-ipfs",
            "succeeded",
            "stopped"
        ]);
    }

    // default (e.g. remote Kubo without datapath)
    return cleanupStateArray([
        ...base,
        "fetching-subplebbit-ipns",
        "fetching-subplebbit-ipfs",
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

    const patternA: CommentUpdatingState = "fetching-subplebbit-ipns";
    const patternB: CommentUpdatingState = "fetching-subplebbit-ipfs";
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

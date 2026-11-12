// Leak suite (#496): instances that stay updating must not grow per update they receive.
//
// The other loading scenarios create, update and stop an instance per iteration, so they catch what
// a stop() fails to release. A UI keeps a community and its open thread updating for hours instead,
// and every new community record or CommentUpdate replaces the previous one. Here a community hosted
// by a second PKC gets one vote per iteration on a fixed post (a new record and a new CommentUpdate,
// same page size), while a remote PKC keeps the community and the post updating. The walk covers the
// remote PKC and both instances, and the record each update replaced must be collectable.
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import {
    createSubWithNoChallenge,
    getAvailablePKCConfigsToTestAgainst,
    mockPKC,
    publishRandomPost,
    publishVote,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { measureRepeatedOperation } from "../../helpers/leak-detection.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

const ITERATIONS = 8;

// Skipped under RPC: the hosting community must live in this process's own PKC so that the remote
// PKC under test sees only arrivals this test causes. The RPC client's updating path is covered by
// remote-loading.leak.test.ts and the rpc-local-community scenarios.
describeSkipIfRpc("leak: long-lived updating instances", () => {
    let hostPkc: PKCType;
    let hostCommunity: LocalCommunity;
    let postCid: string;

    beforeAll(async () => {
        hostPkc = await mockPKC();
        hostCommunity = (await createSubWithNoChallenge({}, hostPkc)) as LocalCommunity;
        await hostCommunity.start();
        await resolveWhenConditionIsTrue({ toUpdate: hostCommunity, predicate: async () => typeof hostCommunity.updatedAt === "number" });
        const post = await publishRandomPost({ communityAddress: hostCommunity.address, pkc: hostPkc });
        postCid = post.cid!;
        await post.stop();
        await resolveWhenConditionIsTrue({ toUpdate: hostCommunity, predicate: async () => hostCommunity.lastPostCid === postCid });
    });

    afterAll(async () => {
        await hostCommunity?.delete();
        await hostPkc?.destroy();
    });

    const remoteConfigs = getAvailablePKCConfigsToTestAgainst({
        includeAllPossibleConfigOnEnv: true,
        includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs", "remote-ipfs-gateway"]
    });

    for (const config of remoteConfigs) {
        describe(config.name, () => {
            let remotePkc: PKCType;
            let remoteCommunity: RemoteCommunity;
            let remotePost: Comment;

            beforeAll(async () => {
                remotePkc = await config.pkcInstancePromise();
                remoteCommunity = await remotePkc.createCommunity({ address: hostCommunity.address });
                await remoteCommunity.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: remoteCommunity,
                    predicate: async () => remoteCommunity.lastPostCid === postCid
                });
                remotePost = await remotePkc.createComment({ cid: postCid });
                await remotePost.update();
                await resolveWhenConditionIsTrue({ toUpdate: remotePost, predicate: async () => typeof remotePost.updatedAt === "number" });
            });

            afterAll(async () => {
                await remotePost?.stop();
                await remoteCommunity?.stop();
                await remotePkc?.destroy();
            });

            it(`${ITERATIONS} community records and CommentUpdates received by instances that stay updating`, async () => {
                const result = await measureRepeatedOperation({
                    roots: () => ({ remotePkc, remoteCommunity, remotePost }),
                    iterations: ITERATIONS,
                    iteration: async () => {
                        const replacedRecord = remoteCommunity.raw.communityIpfs!;
                        const replacedCommentUpdate = remotePost.raw.commentUpdate!;
                        const upvotesBefore = remotePost.upvoteCount ?? 0;
                        const vote = await publishVote({
                            commentCid: postCid,
                            communityAddress: hostCommunity.address,
                            vote: 1,
                            pkc: hostPkc
                        });
                        await vote.stop();
                        await resolveWhenConditionIsTrue({
                            toUpdate: remotePost,
                            predicate: async () => (remotePost.upvoteCount ?? 0) > upvotesBefore
                        });
                        await resolveWhenConditionIsTrue({
                            toUpdate: remoteCommunity,
                            predicate: async () => remoteCommunity.raw.communityIpfs !== replacedRecord
                        });
                        return { replacedRecord, replacedCommentUpdate };
                    }
                });
                expect(result).toEqual({
                    instancesStillAlive: [],
                    containerGrowth: [],
                    processResourceGrowth: [],
                    abortSignalAnyOnLongLivedSources: []
                });
            });
        });
    }
});

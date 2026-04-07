import {
    mockPKC,
    createSubWithNoChallenge,
    publishWithExpectedResult,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    publishRandomPost,
    generateMockVote
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe.concurrent(`community.features.noDownvotes`, async () => {
    let pkc: PKC;
    let community: LocalCommunity | RpcLocalCommunity;
    let remotePKC: PKC;
    let postToVoteOn: Comment;

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        community = await createSubWithNoChallenge({}, pkc);

        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        postToVoteOn = await publishRandomPost({ communityAddress: community.address, pkc: remotePKC });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it.sequential(`Feature is updated correctly in community.features`, async () => {
        expect(community.features).to.be.undefined;
        await community.edit({ features: { ...community.features, noDownvotes: true } });
        expect(community.features?.noDownvotes).to.be.true;
        const remoteCommunity = await remotePKC.getCommunity({ address: community.address });
        await remoteCommunity.update();
        await resolveWhenConditionIsTrue({
            toUpdate: remoteCommunity,
            predicate: async () => remoteCommunity.features?.noDownvotes === true
        }); // that means we published a new update

        await remoteCommunity.stop();
        expect(remoteCommunity.features?.noDownvotes).to.be.true;
    });

    it(`Not allowed to publish downvotes if community.features.noDownvotes=true`, async () => {
        const downvote = await generateMockVote(postToVoteOn as CommentIpfsWithCidDefined, -1, remotePKC); // should be rejected

        await publishWithExpectedResult({
            publication: downvote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_NOT_ALLOWED_TO_PUBLISH_DOWNVOTES
        });
    });

    it(`Allowed to publish upvotes if community.features.noDownvotes=true`, async () => {
        const upvote = await generateMockVote(postToVoteOn as CommentIpfsWithCidDefined, 1, remotePKC); // should be accepted

        await publishWithExpectedResult({ publication: upvote, expectedChallengeSuccess: true });
    });
});

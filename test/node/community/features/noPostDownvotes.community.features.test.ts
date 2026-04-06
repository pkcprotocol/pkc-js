import {
    mockPKC,
    createSubWithNoChallenge,
    publishWithExpectedResult,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    publishRandomPost,
    generateMockVote,
    publishRandomReply
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe.concurrent(`subplebbit.features.noPostDownvotes`, async () => {
    let plebbit: PKC;
    let subplebbit: LocalCommunity | RpcLocalCommunity;
    let remotePKC: PKC;
    let postToVoteOn: Comment;

    beforeAll(async () => {
        plebbit = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);

        await subplebbit.edit({ features: { ...subplebbit.features, noPostDownvotes: true } });

        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        postToVoteOn = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: remotePKC });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePKC.destroy();
    });

    it(`Not allowed to publish downvotes to posts if subplebbit.features.noPostDownvotes=true`, async () => {
        const downvote = await generateMockVote(postToVoteOn as CommentIpfsWithCidDefined, -1, remotePKC); // should be rejected

        await publishWithExpectedResult({
            publication: downvote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_NOT_ALLOWED_TO_PUBLISH_POST_DOWNVOTES
        });
    });

    it(`Allowed to publish upvotes to posts if subplebbit.features.noPostDownvotes=true`, async () => {
        const upvote = await generateMockVote(postToVoteOn as CommentIpfsWithCidDefined, 1, remotePKC); // should be accepted

        await publishWithExpectedResult({ publication: upvote, expectedChallengeSuccess: true });
    });

    it(`Allowed to publish upvotes and downvotes to replies if subplebbit.noPostDownvotes=true`, async () => {
        const reply = await publishRandomReply({ parentComment: postToVoteOn as CommentIpfsWithCidDefined, plebbit: plebbit });

        const upvote = await generateMockVote(reply as CommentIpfsWithCidDefined, 1, remotePKC);
        const downvote = await generateMockVote(reply as CommentIpfsWithCidDefined, -1, remotePKC);

        await Promise.all(
            [upvote, downvote].map((vote) => publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true }))
        );
    });
});

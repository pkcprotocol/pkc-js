import {
    mockPlebbit,
    createSubWithNoChallenge,
    publishWithExpectedResult,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    publishRandomPost,
    generateMockVote,
    publishRandomReply
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe.concurrent(`subplebbit.features.noReplyUpvotes`, async () => {
    let plebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let remotePlebbit: Plebbit;
    let postToVoteOn: Comment;
    let replyToVoteOn: Comment;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);

        await subplebbit.edit({ features: { ...subplebbit.features, noReplyUpvotes: true } });

        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        postToVoteOn = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: remotePlebbit });

        replyToVoteOn = await publishRandomReply({ parentComment: postToVoteOn as CommentIpfsWithCidDefined, plebbit: remotePlebbit });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it(`Not allowed to publish upvotes to replies if subplebbit.features.noReplyUpvotes=true`, async () => {
        const upvote = await generateMockVote(replyToVoteOn as CommentIpfsWithCidDefined, 1, remotePlebbit); // should be rejected

        await publishWithExpectedResult({
            publication: upvote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_NOT_ALLOWED_TO_PUBLISH_REPLY_UPVOTES
        });
    });

    it(`Allowed to publish downvote to replies if subplebbit.features.noReplyUpvotes=true`, async () => {
        const downvote = await generateMockVote(postToVoteOn as CommentIpfsWithCidDefined, -1, remotePlebbit); // should be accepted

        await publishWithExpectedResult({ publication: downvote, expectedChallengeSuccess: true });
    });

    it(`Allowed to publish upvotes and downvotes to posts if subplebbit.noReplyUpvotes=true`, async () => {
        const upvote = await generateMockVote(postToVoteOn as CommentIpfsWithCidDefined, 1, remotePlebbit);
        const downvote = await generateMockVote(postToVoteOn as CommentIpfsWithCidDefined, -1, remotePlebbit);

        await Promise.all(
            [upvote, downvote].map((vote) => publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true }))
        );
    });
});

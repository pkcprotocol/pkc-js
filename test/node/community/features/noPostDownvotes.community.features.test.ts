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
import type { Plebbit } from "../../../../dist/node/pkc/pkc.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/community/rpc-local-community.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe.concurrent(`subplebbit.features.noPostDownvotes`, async () => {
    let plebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let remotePlebbit: Plebbit;
    let postToVoteOn: Comment;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);

        await subplebbit.edit({ features: { ...subplebbit.features, noPostDownvotes: true } });

        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        postToVoteOn = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: remotePlebbit });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it(`Not allowed to publish downvotes to posts if subplebbit.features.noPostDownvotes=true`, async () => {
        const downvote = await generateMockVote(postToVoteOn as CommentIpfsWithCidDefined, -1, remotePlebbit); // should be rejected

        await publishWithExpectedResult({
            publication: downvote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_NOT_ALLOWED_TO_PUBLISH_POST_DOWNVOTES
        });
    });

    it(`Allowed to publish upvotes to posts if subplebbit.features.noPostDownvotes=true`, async () => {
        const upvote = await generateMockVote(postToVoteOn as CommentIpfsWithCidDefined, 1, remotePlebbit); // should be accepted

        await publishWithExpectedResult({ publication: upvote, expectedChallengeSuccess: true });
    });

    it(`Allowed to publish upvotes and downvotes to replies if subplebbit.noPostDownvotes=true`, async () => {
        const reply = await publishRandomReply({ parentComment: postToVoteOn as CommentIpfsWithCidDefined, plebbit: plebbit });

        const upvote = await generateMockVote(reply as CommentIpfsWithCidDefined, 1, remotePlebbit);
        const downvote = await generateMockVote(reply as CommentIpfsWithCidDefined, -1, remotePlebbit);

        await Promise.all(
            [upvote, downvote].map((vote) => publishWithExpectedResult({ publication: vote, expectedChallengeSuccess: true }))
        );
    });
});

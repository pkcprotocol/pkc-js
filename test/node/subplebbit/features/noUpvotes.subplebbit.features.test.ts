import {
    mockPlebbit,
    createSubWithNoChallenge,
    publishWithExpectedResult,
    mockPlebbitNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue,
    publishRandomPost,
    generateMockVote
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

describe.concurrent(`subplebbit.features.noUpvotes`, async () => {
    let plebbit: Plebbit;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let remotePlebbit: Plebbit;
    let postToVoteOn: Comment;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        remotePlebbit = await mockPlebbitNoDataPathWithOnlyKuboClient();
        subplebbit = await createSubWithNoChallenge({}, plebbit);

        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        postToVoteOn = await publishRandomPost({ subplebbitAddress: subplebbit.address, plebbit: remotePlebbit });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
        await remotePlebbit.destroy();
    });

    it.sequential(`Feature is updated correctly in subplebbit.features`, async () => {
        expect(subplebbit.features).to.be.undefined;

        await subplebbit.edit({ features: { ...subplebbit.features, noUpvotes: true } });
        expect(subplebbit.features?.noUpvotes).to.be.true;
        const remoteSub = await remotePlebbit.getSubplebbit({ address: subplebbit.address });
        await remoteSub.update();
        await resolveWhenConditionIsTrue({ toUpdate: remoteSub, predicate: async () => remoteSub.features?.noUpvotes === true }); // that means we published a new update

        expect(remoteSub.features?.noUpvotes).to.be.true;
        await remoteSub.stop();
    });

    it(`Not allowed to publish upvotes if subplebbit.features.noUpvotes=true`, async () => {
        const upvote = await generateMockVote(postToVoteOn as CommentIpfsWithCidDefined, 1, remotePlebbit); // should be rejected

        await publishWithExpectedResult({
            publication: upvote,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_NOT_ALLOWED_TO_PUBLISH_UPVOTES
        });
    });

    it(`Allowed to publish downvotes if subplebbit.features.noUpvotes=true`, async () => {
        const downvote = await generateMockVote(postToVoteOn as CommentIpfsWithCidDefined, -1, remotePlebbit); // should be accepted

        await publishWithExpectedResult({ publication: downvote, expectedChallengeSuccess: true });
    });
});

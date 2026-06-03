// End-to-end coverage for challenge-supplied commentUpdate.reason on a REGULAR (non-pending,
// non-mod-queue) comment, and the precedence when a moderator later sets a reason.
//
// A challenge can return { success: true, commentUpdate: { reason } } (without pendingApproval).
// The reason is persisted (comments.challengeCommentUpdate) and must surface on the served regular
// CommentUpdate (via comment.update()), signed. When a moderator subsequently publishes a
// commentModeration with its own reason, the moderator reason must win (db-handler
// queryCalculatedCommentUpdate: moderatorReason?.reason ?? challengeReason). See issue #110 / PR #111.

import {
    mockPKC,
    mockGatewayPKC,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { SignerType } from "../../../../dist/node/signer/types.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { ChallengeResult } from "../../../../dist/node/community/types.js";

const CHALLENGE_REASON = "flagged by automated review";
const MOD_REASON = "reviewed by a human moderator";

// A challenge that succeeds immediately (no pendingApproval) while attaching a moderation reason.
const createReasonChallengeFactory = () => () => ({
    type: "text/plain" as const,
    getChallenge: async (): Promise<ChallengeResult> => {
        // ChallengeResult only types { success }; production challenges attach a commentUpdate. Widen
        // via a non-literal local so the extra optional field is structurally assignable.
        const result: ChallengeResult & { commentUpdate?: { reason: string } } = {
            success: true,
            commentUpdate: { reason: CHALLENGE_REASON }
        };
        return result;
    }
});

// LocalCommunity-only: registers an in-process challenge factory the RPC server can't see.
describeSkipIfRpc("challenge-supplied commentUpdate.reason on a regular comment", async () => {
    let pkc: PKCType;
    let remotePKC: PKCType;
    let community: LocalCommunity | RpcLocalCommunity;
    let modSigner: SignerType;

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockGatewayPKC();
        pkc.settings = { challenges: { "reason-challenge": createReasonChallengeFactory() } };

        community = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        community.setMaxListeners(100);
        modSigner = await pkc.createSigner();
        await community.edit({
            settings: {
                challenges: [
                    {
                        name: "reason-challenge",
                        // no pendingApproval: the comment publishes as a regular comment
                        exclude: [{ role: ["moderator", "admin", "owner"] }]
                    }
                ]
            },
            roles: { [modSigner.address]: { role: "moderator" } }
        });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it("serves the challenge reason on the regular commentUpdate, then a mod reason overrides it", async () => {
        // Published by a non-mod author, so the challenge runs and attaches the reason.
        const post = (await publishRandomPost({ communityAddress: community.address, pkc: remotePKC })) as Comment;

        await post.update();
        await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => typeof post.raw.commentUpdate?.reason === "string" });

        // The served regular CommentUpdate carries and signs the challenge-supplied reason.
        expect(post.raw.commentUpdate!.reason).to.equal(CHALLENGE_REASON);
        expect(post.raw.commentUpdate!.signature.signedPropertyNames).to.include("reason");

        // A moderator publishes its own reason; it must win over the challenge's.
        const commentMod = await remotePKC.createCommentModeration({
            commentModeration: { pinned: true, reason: MOD_REASON },
            commentCid: post.cid!,
            signer: modSigner,
            communityAddress: community.address
        });
        await publishWithExpectedResult({ publication: commentMod, expectedChallengeSuccess: true });

        await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => post.raw.commentUpdate?.reason === MOD_REASON });
        expect(post.raw.commentUpdate!.reason).to.equal(MOD_REASON);

        await post.stop();
    });
});

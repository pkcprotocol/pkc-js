// Reproduction for the production bug where a challenge (e.g. @bitsocial/ai-moderation-challenge)
// returns `{ success: true, commentUpdate: { reason } }` to attach a moderation reason to the
// pending-approval comment, but pkc-js never propagates it: the published
// DecryptedChallengeVerification.commentUpdate ends up with no `reason`.
//
// See @bitsocial/ai-moderation-challenge getSuccessResult():
//   if (!pendingApproval || !reason) return { success: true };
//   return { success: true, commentUpdate: { reason } };

import { mockPKC, mockGatewayPKC, publishCommentToModQueue, resolveWhenConditionIsTrue } from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { DecryptedChallengeVerificationMessageType } from "../../../../dist/node/pubsub-messages/types.js";
import type { ChallengeResult } from "../../../../dist/node/community/types.js";

const REASON_FROM_CHALLENGE = "AI moderation flagged this comment for manual review";

// A challenge that approves the publication into the pending-approval queue while attaching a
// moderation reason, exactly like @bitsocial/ai-moderation-challenge does on its "review" branch.
const createReasonChallengeFactory = () => () => ({
    type: "text/plain" as const,
    getChallenge: async (): Promise<ChallengeResult> => {
        // ChallengeResult currently only types { success }, but production challenges attach a
        // commentUpdate alongside it. Use a widened (non-literal) local so the extra optional field
        // is structurally assignable to the declared union without an excess-property error.
        const result: ChallengeResult & { commentUpdate?: { reason: string } } = {
            success: true,
            commentUpdate: { reason: REASON_FROM_CHALLENGE }
        };
        return result;
    }
});

// LocalCommunity-only: registers a custom in-process challenge factory on the local PKC, which the
// RPC server process cannot see.
describeSkipIfRpc("commentUpdate.reason from a challenge result", async () => {
    let pkc: PKCType;
    let remotePKC: PKCType;
    let community: LocalCommunity | RpcLocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockGatewayPKC();
        pkc.settings = { challenges: { "reason-challenge": createReasonChallengeFactory() } };

        community = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        community.setMaxListeners(100);
        await community.edit({
            settings: {
                challenges: [
                    {
                        name: "reason-challenge",
                        pendingApproval: true,
                        exclude: [{ role: ["moderator", "admin", "owner"] }]
                    }
                ]
            }
        });
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it("should include the challenge-supplied reason in the published commentUpdate", async () => {
        const { comment, challengeVerification } = await publishCommentToModQueue({
            community,
            pkc: remotePKC,
            commentProps: { challengeRequest: { challengeAnswers: ["x"] } }
        });

        const cv = challengeVerification as DecryptedChallengeVerificationMessageType;

        expect(comment.pendingApproval).to.be.true;
        expect(cv.commentUpdate!.pendingApproval).to.be.true;

        // The bug: reason returned by the challenge is dropped from the commentUpdate.
        expect(Object.keys(cv.commentUpdate!)).to.include("reason");
        expect((cv.commentUpdate as { reason?: string }).reason).to.equal(REASON_FROM_CHALLENGE);

        // And it must be signed, otherwise clients reject it as a forged field.
        expect(cv.commentUpdate!.signature.signedPropertyNames).to.include("reason");
    });
});

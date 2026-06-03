// Regression test: a challenge that returns { success: true, commentUpdate: { reason } } (as
// @bitsocial/ai-moderation-challenge does on its "review" branch) attaches a moderation reason to a
// pending-approval comment. The reason is correctly signed and delivered to the publisher in the
// live challengeverification, but it must ALSO appear in the stored pending-approval mod-queue page
// that mods fetch from community.modQueue.pageCids.pendingApproval. See issue #110.

import { mockPKC, mockGatewayPKC, publishCommentToModQueue, resolveWhenConditionIsTrue } from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { DecryptedChallengeVerificationMessageType } from "../../../../dist/node/pubsub-messages/types.js";
import type { ChallengeResult } from "../../../../dist/node/community/types.js";

const REASON_FROM_CHALLENGE = "fortune check is missing";

// A challenge that sends the comment to pending approval while attaching a moderation reason,
// exactly like @bitsocial/ai-moderation-challenge does on its "review" branch.
const createReasonChallengeFactory = () => () => ({
    type: "text/plain" as const,
    getChallenge: async (): Promise<ChallengeResult> => {
        // ChallengeResult only types { success }, but production challenges attach a commentUpdate.
        // Use a widened (non-literal) local so the extra optional field is structurally assignable to
        // the declared union without an excess-property error.
        const result: ChallengeResult & { commentUpdate?: { reason: string } } = {
            success: true,
            commentUpdate: { reason: REASON_FROM_CHALLENGE }
        };
        return result;
    }
});

// LocalCommunity-only: registers a custom in-process challenge factory on the local PKC, which the
// RPC server process cannot see.
describeSkipIfRpc("commentUpdate.reason from a challenge in the pending-approval mod-queue page", async () => {
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

    it("includes the challenge-supplied reason in both the live verification and the mod-queue page", async () => {
        const { comment, challengeVerification } = await publishCommentToModQueue({
            community,
            pkc: remotePKC,
            commentProps: { challengeRequest: { challengeAnswers: ["x"] } }
        });

        const cv = challengeVerification as DecryptedChallengeVerificationMessageType;

        // Sanity: the already-working live-verification path carries the signed reason.
        expect(comment.pendingApproval).to.be.true;
        expect(cv.commentUpdate!.pendingApproval).to.be.true;
        expect((cv.commentUpdate as { reason?: string }).reason).to.equal(REASON_FROM_CHALLENGE);

        // The bug: the regenerated pending-approval mod-queue page must also carry the signed reason.
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => Boolean(community.modQueue.pageCids?.pendingApproval)
        });
        const rawPage = JSON.parse((await pkc.fetchCid({ cid: community.modQueue.pageCids!.pendingApproval! })).content) as {
            comments: { comment: { cid?: string }; commentUpdate: { reason?: string; signature: { signedPropertyNames: string[] } } }[];
        };

        const pageEntry = rawPage.comments.find((c) => c.commentUpdate && c.comment);
        expect(pageEntry, "pending comment should be present in the mod-queue page").to.exist;
        expect(pageEntry!.commentUpdate.reason).to.equal(REASON_FROM_CHALLENGE);
        expect(pageEntry!.commentUpdate.signature.signedPropertyNames).to.include("reason");
    });
});

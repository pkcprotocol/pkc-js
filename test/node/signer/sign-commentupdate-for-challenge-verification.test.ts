import { describe, expect, it } from "vitest";
import { signCommentUpdateForChallengeVerification } from "../../../dist/node/signer/signatures.js";
import signers from "../../fixtures/signers.js";
import type { SignerType } from "../../../dist/node/signer/types.js";

// What the author actually receives after a successful challenge: the community signs the first
// commentUpdate with `signCommentUpdateForChallengeVerification`, encrypts {comment, commentUpdate}
// to the author's pubkey, and the author parses the decrypted JSON. For challenge-supplied extras
// (e.g. `reason`) to survive, sign-time has to include them in signedPropertyNames and the JSON
// roundtrip has to preserve them. These tests pin both sides.
describe("signCommentUpdateForChallengeVerification carries challenge-supplied extras", () => {
    const signer = (signers as SignerType[])[0];

    const baseUpdate = {
        author: { community: { postScore: 0, replyScore: 0 } },
        cid: "QmTestCidForChallengeVerification0000000000000000",
        protocolVersion: "1.0.0",
        pendingApproval: true
    };

    it("includes a challenge-supplied `reason` key in signature.signedPropertyNames", async () => {
        const updateWithReason = {
            ...baseUpdate,
            reason: "comment got sent to pending approval cause low spam-score confidence"
        };
        const signature = await signCommentUpdateForChallengeVerification({ update: updateWithReason, signer });

        expect(signature.signedPropertyNames).to.include("reason");
        expect(signature.signedPropertyNames).to.include("author");
        expect(signature.signedPropertyNames).to.include("cid");
        expect(signature.signedPropertyNames).to.include("pendingApproval");
    });

    it("includes arbitrary new keys (e.g. countryCode) in signedPropertyNames", async () => {
        const updateWithCountryCode = { ...baseUpdate, countryCode: "FR" };
        const signature = await signCommentUpdateForChallengeVerification({ update: updateWithCountryCode, signer });
        expect(signature.signedPropertyNames).to.include("countryCode");
    });

    it("base signedPropertyNames is stable when no extras are present", async () => {
        const signature = await signCommentUpdateForChallengeVerification({ update: baseUpdate, signer });
        expect(signature.signedPropertyNames).to.not.include("reason");
        expect(signature.signedPropertyNames).to.not.include("countryCode");
    });

    it("JSON roundtrip on {comment, commentUpdate: {reason}} preserves reason (matches decrypt path)", async () => {
        // Mirrors what storePublicationAndEncryptForChallengeVerification does: builds
        // {comment, commentUpdate}, deterministic-stringifies, encrypts. The author decrypts and
        // JSON.parses. Confirm the reason survives the stringify/parse pair.
        const updateWithReason = {
            ...baseUpdate,
            reason: "comment got sent to pending approval cause low spam-score confidence"
        };
        const signature = await signCommentUpdateForChallengeVerification({ update: updateWithReason, signer });
        const decryptedPayloadShape = {
            comment: { cid: "QmFakeCommentIpfsCid000000000000000000000000000" },
            commentUpdate: { ...updateWithReason, signature }
        };

        const roundtripped = JSON.parse(JSON.stringify(decryptedPayloadShape)) as {
            commentUpdate: { reason?: string; signature: { signedPropertyNames: string[] } };
        };

        expect(roundtripped.commentUpdate.reason).to.equal(
            "comment got sent to pending approval cause low spam-score confidence"
        );
        expect(roundtripped.commentUpdate.signature.signedPropertyNames).to.include("reason");
    });
});

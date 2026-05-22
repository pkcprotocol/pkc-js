import { CommentSignedPropertyNames, CommentUpdateChallengeReservedFieldNames } from "../../../../publications/comment/schema.js";
import { PKCError } from "../../../../pkc-error.js";
import type { ChallengeResult } from "../../../../community/types.js";

// Throws when a challenge result tries to set a key that the protocol owns.
// - comment.<key>: forbidden if key is in CommentSignedPropertyNames (would invalidate the author's
//   signature on CommentIpfs, since challenge fields are spread last into the IPFS-bound literal).
// - commentUpdate.<key>: forbidden if key is in CommentUpdateChallengeReservedFieldNames
//   (community-computed fields: counts, cid, signature, updatedAt, etc.).
export function validateChallengeResultExtras({
    challengeResult,
    challengeIndex
}: {
    challengeResult: ChallengeResult;
    challengeIndex: number;
}): void {
    if (!("success" in challengeResult) || challengeResult.success !== true) return;
    if (challengeResult.comment) {
        for (const key of Object.keys(challengeResult.comment)) {
            if ((CommentSignedPropertyNames as readonly string[]).includes(key)) {
                throw new PKCError("ERR_CHALLENGE_RESULT_OVERRIDES_COMMENT_SIGNED_FIELD", {
                    challengeIndex,
                    offendingKey: key
                });
            }
        }
    }
    if (challengeResult.commentUpdate) {
        for (const key of Object.keys(challengeResult.commentUpdate)) {
            if ((CommentUpdateChallengeReservedFieldNames as readonly string[]).includes(key)) {
                throw new PKCError("ERR_CHALLENGE_RESULT_OVERRIDES_RESERVED_COMMENT_UPDATE_FIELD", {
                    challengeIndex,
                    offendingKey: key
                });
            }
        }
    }
}

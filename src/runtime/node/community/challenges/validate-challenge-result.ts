import { CommentSignedPropertyNames, CommentUpdateChallengeReservedFieldNames } from "../../../../publications/comment/schema.js";
import { CommunityAuthorChallengeReservedFieldNames } from "../../../../schema/schema.js";
import { PKCError } from "../../../../pkc-error.js";
import type { ChallengeResult } from "../../../../community/types.js";

// Throws when a challenge result tries to set a key that the protocol owns.
// - comment.<key>: forbidden if key is in CommentSignedPropertyNames (would invalidate the author's
//   signature on CommentIpfs, since challenge fields are spread last into the IPFS-bound literal).
// - commentUpdate.<key>: forbidden if key is in CommentUpdateChallengeReservedFieldNames
//   (community-computed fields: counts, cid, signature, updatedAt, etc.).
// - commentUpdate.author.<key>: only `community` is permitted (rest of author is signed identity).
// - commentUpdate.author.community.<key>: forbidden if key is in CommunityAuthorChallengeReservedFieldNames
//   (computed scores/timestamps and mod-settable fields; mods own those via commentModeration).
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
        const author = (challengeResult.commentUpdate as { author?: unknown }).author;
        if (author !== undefined) {
            if (typeof author !== "object" || author === null || Array.isArray(author)) {
                throw new PKCError("ERR_CHALLENGE_RESULT_OVERRIDES_NON_COMMUNITY_AUTHOR_KEY", {
                    challengeIndex,
                    offendingKey: "author"
                });
            }
            for (const authorKey of Object.keys(author as Record<string, unknown>)) {
                if (authorKey !== "community") {
                    throw new PKCError("ERR_CHALLENGE_RESULT_OVERRIDES_NON_COMMUNITY_AUTHOR_KEY", {
                        challengeIndex,
                        offendingKey: `author.${authorKey}`
                    });
                }
            }
            const community = (author as { community?: unknown }).community;
            if (community !== undefined) {
                if (typeof community !== "object" || community === null || Array.isArray(community)) {
                    throw new PKCError("ERR_CHALLENGE_RESULT_OVERRIDES_RESERVED_COMMUNITY_AUTHOR_FIELD", {
                        challengeIndex,
                        offendingKey: "author.community"
                    });
                }
                for (const communityKey of Object.keys(community as Record<string, unknown>)) {
                    if ((CommunityAuthorChallengeReservedFieldNames as readonly string[]).includes(communityKey)) {
                        throw new PKCError("ERR_CHALLENGE_RESULT_OVERRIDES_RESERVED_COMMUNITY_AUTHOR_FIELD", {
                            challengeIndex,
                            offendingKey: `author.community.${communityKey}`
                        });
                    }
                }
            }
        }
    }
}

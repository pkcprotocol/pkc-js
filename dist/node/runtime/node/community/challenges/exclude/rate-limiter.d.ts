import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "../../../../../pubsub-messages/types.js";
import type { ChallengeResult, Exclude, CommunitySettings } from "../../../../../community/types.js";
declare const testRateLimit: (exclude: Exclude, request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor) => boolean;
declare const addToRateLimiter: (communityChallenges: NonNullable<CommunitySettings["challenges"]>, request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor, challengeSuccess: ChallengeResult["success"]) => void;
export { addToRateLimiter, testRateLimit };

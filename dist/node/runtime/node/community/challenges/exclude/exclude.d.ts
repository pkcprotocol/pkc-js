import type { Challenge, ChallengeResult, CommunityChallenge, CommunitySettings } from "../../../../../community/types.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "../../../../../pubsub-messages/types.js";
import { LocalCommunity } from "../../local-community.js";
import { PKC } from "../../../../../pkc/pkc.js";
declare const shouldExcludePublication: (communityChallenge: CommunityChallenge, request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor, community: LocalCommunity) => boolean;
declare const shouldExcludeChallengeSuccess: (communityChallenge: NonNullable<CommunitySettings["challenges"]>[0], communityChallengeIndex: number, challengeResults: (Challenge | ChallengeResult)[]) => boolean;
declare const shouldExcludeChallengeCommentCids: (communityChallenge: CommunityChallenge, challengeRequestMessage: DecryptedChallengeRequestMessageTypeWithCommunityAuthor, pkc: PKC) => Promise<boolean>;
export { shouldExcludeChallengeCommentCids, shouldExcludePublication, shouldExcludeChallengeSuccess };

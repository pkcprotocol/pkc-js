import type { ChallengeVerificationMessageType, DecryptedChallengeAnswer, DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "../../../../pubsub-messages/types.js";
import type { Challenge, ChallengeFileFactoryInput, CommunityChallenge, CommunityChallengeSetting } from "../../../../community/types.js";
import { LocalCommunity } from "../local-community.js";
type PendingChallenge = Challenge & {
    index: number;
};
export type GetChallengeAnswers = (challenges: Omit<Challenge, "verify">[]) => Promise<DecryptedChallengeAnswer["challengeAnswers"]>;
type ChallengeVerificationSuccess = {
    challengeSuccess: true;
    pendingApprovalSuccess: boolean;
};
type ChallengeVerificationPending = {
    pendingChallenges: PendingChallenge[];
    pendingApprovalSuccess: boolean;
};
type ChallengeVerificationFailure = {
    challengeSuccess: false;
    challengeErrors: NonNullable<ChallengeVerificationMessageType["challengeErrors"]>;
};
type PKCWithSettingsChallenges = {
    settings?: {
        challenges?: Record<string, ChallengeFileFactoryInput>;
    };
};
declare const pkcJsChallenges: Record<string, ChallengeFileFactoryInput>;
declare const getPendingChallengesOrChallengeVerification: (challengeRequestMessage: DecryptedChallengeRequestMessageTypeWithCommunityAuthor, community: LocalCommunity) => Promise<ChallengeVerificationSuccess | ChallengeVerificationPending | ChallengeVerificationFailure>;
declare const getChallengeVerificationFromChallengeAnswers: (pendingChallenges: PendingChallenge[], challengeAnswers: DecryptedChallengeAnswer["challengeAnswers"], community: LocalCommunity) => Promise<ChallengeVerificationSuccess | ChallengeVerificationFailure>;
declare const getChallengeVerification: (challengeRequestMessage: DecryptedChallengeRequestMessageTypeWithCommunityAuthor, community: LocalCommunity, getChallengeAnswers: GetChallengeAnswers) => Promise<Pick<ChallengeVerificationMessageType, "challengeErrors" | "challengeSuccess"> & {
    pendingApproval?: boolean;
}>;
declare const getCommunityChallengeFromCommunityChallengeSettings: (communityChallengeSettings: CommunityChallengeSetting, pkc?: PKCWithSettingsChallenges) => Promise<CommunityChallenge>;
export { pkcJsChallenges, getPendingChallengesOrChallengeVerification, getChallengeVerificationFromChallengeAnswers, getChallengeVerification, getCommunityChallengeFromCommunityChallengeSettings };

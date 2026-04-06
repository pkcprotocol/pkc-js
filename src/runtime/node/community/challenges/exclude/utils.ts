import type { CommunityIpfsType, CommunityRole, Exclude } from "../../../../../community/types.js";
import type { DecryptedChallengeRequestMessageTypeWithCommunityAuthor } from "../../../../../pubsub-messages/types.js";
import { isRequestPubsubPublicationOfPost, isRequestPubsubPublicationOfReply } from "../../../../../util.js";

// e.g. secondsToGoBack = 60 would return the timestamp 1 minute ago
const getTimestampSecondsAgo = (secondsToGoBack: number) => Math.round(Date.now() / 1000) - secondsToGoBack;

const testScore = (excludeScore: number | undefined, authorScore: number | undefined) =>
    excludeScore === undefined || excludeScore <= (authorScore || 0);

// firstCommentTimestamp value first needs to be put through Date.now() - firstCommentTimestamp
const testFirstCommentTimestamp = (excludeTime: number | undefined, authorFirstCommentTimestamp: number | undefined) =>
    excludeTime === undefined || getTimestampSecondsAgo(excludeTime) >= (authorFirstCommentTimestamp || Infinity);

const testRole = (excludeRole: CommunityRole["role"][], authorAddress: string, subplebbitRoles: CommunityIpfsType["roles"]) => {
    if (excludeRole === undefined) {
        return true; // No role exclusion rule, so this test passes
    }
    if (subplebbitRoles === undefined) {
        return false; // Can't verify roles, so assume user doesn't have excluded role
    }
    for (const roleName of excludeRole) {
        if (subplebbitRoles[authorAddress]?.role === roleName) {
            return true;
        }
    }
    return false;
};

const isVote = (request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor) => Boolean(request.vote);
const isReply = (request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor) => isRequestPubsubPublicationOfReply(request);
const isPost = (request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor) => isRequestPubsubPublicationOfPost(request);
const isCommentEdit = (request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor) => Boolean(request.commentEdit);
const isCommentModeration = (request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor) => Boolean(request.commentModeration);
const isCommunityEdit = (request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor) => Boolean(request.subplebbitEdit);

const testPublicationType = (
    excludePublicationType: Exclude["publicationType"] | undefined,
    request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor
) => {
    if (excludePublicationType === undefined) {
        return true;
    }
    if (excludePublicationType.post && isPost(request)) {
        return true;
    }
    if (excludePublicationType.reply && isReply(request)) {
        return true;
    }
    if (excludePublicationType.vote && isVote(request)) {
        return true;
    }
    if (excludePublicationType.commentEdit && isCommentEdit(request)) {
        return true;
    }
    if (excludePublicationType.commentModeration && isCommentModeration(request)) {
        return true;
    }
    if (excludePublicationType.communityEdit && isCommunityEdit(request)) {
        return true;
    }
    return false;
};

export {
    isVote,
    isReply,
    isPost,
    isCommentEdit,
    isCommentModeration,
    isCommunityEdit,
    testPublicationType,
    testScore,
    testFirstCommentTimestamp,
    testRole
};

import QuickLRU from "quick-lru";
import { isVote, isReply, isPost, isCommentEdit, isCommentModeration, isCommunityEdit, testPublicationType } from "./utils.js";
import type {
    DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
    PublicationWithCommunityAuthorFromDecryptedChallengeRequest
} from "../../../../../pubsub-messages/types.js";
import type { ChallengeResult, Exclude, CommunitySettings } from "../../../../../community/types.js";
import * as limiterCompat from "limiter-es6-compat";
import {
    derivePublicationFromChallengeRequest,
    isRequestPubsubPublicationOfPost,
    isRequestPubsubPublicationOfReply
} from "../../../../../util.js";

// Workaround for NodeNext moduleResolution compatibility
const { RateLimiter } = limiterCompat as any;
type RateLimiterInstance = InstanceType<typeof RateLimiter>;

type PublicationType = "post" | "reply" | "vote" | "commentEdit" | "commentModeration" | "communityEdit";
// each author could have 20+ rate limiters each if the community has
// several rate limit rules so keep a large cache
const rateLimiters = new QuickLRU<string, RateLimiterInstance>({ maxSize: 50000 });

const getPublicationType = (request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor): PublicationType | undefined =>
    isPost(request)
        ? "post"
        : isReply(request)
          ? "reply"
          : isVote(request)
            ? "vote"
            : isCommentEdit(request)
              ? "commentEdit"
              : isCommentModeration(request)
                ? "commentModeration"
                : isCommunityEdit(request)
                  ? "communityEdit"
                  : undefined;

const getRateLimiterName = (
    exclude: Exclude,
    publication: PublicationWithCommunityAuthorFromDecryptedChallengeRequest,
    publicationType: PublicationType,
    challengeSuccess: ChallengeResult["success"]
) => `${publication.author.address}-${exclude.rateLimit}-${publicationType}-${challengeSuccess}`;

const getOrCreateRateLimiter = (
    exclude: Exclude,
    publication: PublicationWithCommunityAuthorFromDecryptedChallengeRequest,
    publicationType: PublicationType,
    challengeSuccess: ChallengeResult["success"]
) => {
    if (typeof exclude.rateLimit !== "number") throw Error("Can't create a RateLimiter without exclude.rateLimit");
    const rateLimiterName = getRateLimiterName(exclude, publication, publicationType, challengeSuccess);
    let rateLimiter = rateLimiters.get(rateLimiterName);
    if (!rateLimiter) {
        rateLimiter = new RateLimiter({ tokensPerInterval: exclude.rateLimit, interval: "hour", fireImmediately: true });
        // @ts-ignore - adding name property for debugging
        rateLimiter.name = rateLimiterName; // add name for debugging
        rateLimiters.set(rateLimiterName, rateLimiter);
    }
    return rateLimiter;
};

const addFilteredRateLimiter = (
    exclude: Exclude,
    publication: PublicationWithCommunityAuthorFromDecryptedChallengeRequest,
    publicationType: PublicationType,
    challengeSuccess: ChallengeResult["success"],
    filteredRateLimiters: Record<string, RateLimiterInstance>
) => {
    filteredRateLimiters[getRateLimiterName(exclude, publication, publicationType, challengeSuccess)] = getOrCreateRateLimiter(
        exclude,
        publication,
        publicationType,
        challengeSuccess
    );
};

const getRateLimitersToTest = (
    exclude: Exclude,
    request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
    challengeSuccess: ChallengeResult["success"]
) => {
    // TODO I think we need to change this
    const publication = derivePublicationFromChallengeRequest(request);
    // get all rate limiters associated with the exclude (publication type and challengeSuccess true/false)
    const filteredRateLimiters: Record<string, RateLimiterInstance> = {};

    if (testPublicationType(exclude.publicationType, request)) {
        const publicationType = getPublicationType(request);
        if (publicationType) {
            addFilteredRateLimiter(exclude, publication, publicationType, challengeSuccess, filteredRateLimiters);
        }
    }

    return filteredRateLimiters;
};

const testRateLimit = (exclude: Exclude, request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor) => {
    // will come back here later

    if (exclude?.rateLimit === undefined || !testPublicationType(exclude.publicationType, request)) {
        // early exit based on exclude type and publication type
        return true;
    }

    // if rateLimitChallengeSuccess is undefined or true, only use {challengeSuccess: true} rate limiters
    let challengeSuccess = true;
    if (exclude.rateLimitChallengeSuccess === false) {
        challengeSuccess = false;
    }

    // check all the rate limiters that match the exclude and publication type
    const rateLimiters = getRateLimitersToTest(exclude, request, challengeSuccess);
    // if any of the matching rate limiter is out of tokens, test failed
    for (const rateLimiter of Object.values(rateLimiters)) {
        const tokensRemaining = rateLimiter.getTokensRemaining();
        // token per action is 1, so any value below 1 is invalid
        if (tokensRemaining < 1) return false;
    }
    return true;
};

const getRateLimitersToAddTo = (
    excludeArray: Exclude[],
    request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
    challengeSuccess: ChallengeResult["success"]
) => {
    // get all rate limiters associated with the exclude (publication type and challengeSuccess true/false)
    const filteredRateLimiters: Record<string, RateLimiterInstance> = {};
    const publication = derivePublicationFromChallengeRequest(request);

    for (const exclude of excludeArray) {
        if (exclude?.rateLimit === undefined) {
            continue;
        }
        const publicationType = getPublicationType(request);
        if (publicationType) {
            addFilteredRateLimiter(exclude, publication, publicationType, challengeSuccess, filteredRateLimiters);
        }
        if (request.commentEdit) {
            addFilteredRateLimiter(exclude, publication, "commentEdit", challengeSuccess, filteredRateLimiters);
        }
        if (request.commentModeration) {
            addFilteredRateLimiter(exclude, publication, "commentModeration", challengeSuccess, filteredRateLimiters);
        }
        if (request.communityEdit) {
            addFilteredRateLimiter(exclude, publication, "communityEdit", challengeSuccess, filteredRateLimiters);
        }
    }
    return filteredRateLimiters;
};

const addToRateLimiter = (
    communityChallenges: NonNullable<CommunitySettings["challenges"]>,
    request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
    challengeSuccess: ChallengeResult["success"]
) => {
    if (!communityChallenges) {
        // community has no challenges, no need to rate limit
        return;
    }
    if (!Array.isArray(communityChallenges)) {
        throw Error(`addToRateLimiter invalid argument communityChallenges '${communityChallenges}' not an array`);
    }

    if (typeof challengeSuccess !== "boolean") {
        throw Error(`addToRateLimiter invalid argument challengeSuccess '${challengeSuccess}' not a boolean`);
    }

    // get all exclude items from all community challenges
    const excludeArray = [];
    for (const communityChallenge of communityChallenges) {
        for (const exclude of communityChallenge?.exclude || []) {
            excludeArray.push(exclude);
        }
    }

    if (!excludeArray.length) {
        // no need to add to rate limiter if the community has no exclude rules in any challenges
        return;
    }

    const rateLimiters = getRateLimitersToAddTo(excludeArray, request, challengeSuccess);
    for (const rateLimiter of Object.values(rateLimiters)) {
        rateLimiter.tryRemoveTokens(1);
    }
};

export { addToRateLimiter, testRateLimit };

import Logger from "../../../../logger.js";
import { difference, intersection, isDeepEqual, keys } from "remeda";
import {
    contentContainsMarkdownAudio,
    contentContainsMarkdownImages,
    contentContainsMarkdownVideos,
    getErrorCodeFromMessage,
    isLinkOfAnimatedImage,
    isLinkOfAudio,
    isLinkOfImage,
    isLinkOfMedia,
    isLinkOfVideo,
    isLinkValid,
    isStringDomain,
    timestamp
} from "../../../../util.js";
import { PKCError } from "../../../../pkc-error.js";
import { messages } from "../../../../errors.js";
import { AuthorReservedFields } from "../../../../schema/schema.js";
import {
    ValidationResult,
    verifyCommentEdit,
    verifyCommentModeration,
    verifyCommentPubsubMessage,
    verifyCommunityEdit,
    verifyVote
} from "../../../../signer/signatures.js";
import { getPKCAddressFromPublicKey } from "../../../../signer/util.js";
import { getAuthorNameFromWire } from "../../../../publications/publication-author.js";
import { getCommunityNameFromWire, getCommunityPublicKeyFromWire } from "../../../../publications/publication-community.js";
import { CommentEditReservedFields } from "../../../../publications/comment-edit/schema.js";
import { CommentPubsubMessageReservedFields } from "../../../../publications/comment/schema.js";
import { CommentModerationReservedFields } from "../../../../publications/comment-moderation/schema.js";
import { CommunityEditPublicationPubsubReservedFields } from "../../../../publications/community-edit/schema.js";
import { CommunityIpfsSchema } from "../../../../community/schema.js";
import { VotePubsubReservedFields } from "../../../../publications/vote/schema.js";
import type { CommentModerationPubsubMessagePublication } from "../../../../publications/comment-moderation/types.js";
import type { CommunityRoleNameUnion, Flair } from "../../../../community/types.js";
import type {
    DecryptedChallengeRequestMessageType,
    PublicationFromDecryptedChallengeRequest,
    PublicationWithCommunityAuthorFromDecryptedChallengeRequest
} from "../../../../pubsub-messages/types.js";
import type { LocalCommunity } from "../local-community.js";
import { publishFailedChallengeVerification } from "./challenges.js";
import { communityIdentityPublicKey } from "./identity.js";

export function isFlairInAllowedList(flair: Flair, allowedFlairs: Flair[]): boolean {
    return allowedFlairs.some((allowed) => isDeepEqual(allowed, flair));
}

export async function isPublicationAuthorPartOfRoles(
    community: LocalCommunity,
    publication: Pick<CommentModerationPubsubMessagePublication, "author" | "signature">,
    rolesToCheckAgainst: CommunityRoleNameUnion[]
): Promise<boolean> {
    if (!community.roles) return false;
    // is the author of publication a moderator?
    const signerAddress = await getPKCAddressFromPublicKey(publication.signature.publicKey);
    if (rolesToCheckAgainst.includes(community.roles[signerAddress]?.role as CommunityRoleNameUnion)) return true;

    const authorName = getAuthorNameFromWire(publication.author);
    if (typeof authorName === "string") {
        if (rolesToCheckAgainst.includes(community.roles[authorName]?.role as CommunityRoleNameUnion)) return true;
        if (community._pkc.resolveAuthorNames && isStringDomain(authorName)) {
            const { resolvedAuthorName: resolvedSignerAddress } = await community._clientsManager.resolveAuthorNameIfNeeded({
                authorName,
                abortSignal: AbortSignal.timeout(community._pkc._timeouts["resolve-author-name"]),
                // Mod authority must reflect current state — bypass cache.
                cache: { maxAge: 0 }
            });
            if (resolvedSignerAddress !== signerAddress) return false;
            if (rolesToCheckAgainst.includes(community.roles[resolvedSignerAddress]?.role as CommunityRoleNameUnion)) return true;
        }
    }
    return false;
}

export async function respondWithErrorIfSignatureOfPublicationIsInvalid(
    community: LocalCommunity,
    request: DecryptedChallengeRequestMessageType
): Promise<void> {
    let validity: ValidationResult;
    if (request.comment)
        validity = await verifyCommentPubsubMessage({
            comment: request.comment,
            resolveAuthorNames: community._pkc.resolveAuthorNames,
            clientsManager: community._clientsManager
        });
    else if (request.commentEdit)
        validity = await verifyCommentEdit({
            edit: request.commentEdit,
            resolveAuthorNames: community._pkc.resolveAuthorNames,
            clientsManager: community._clientsManager
        });
    else if (request.vote)
        validity = await verifyVote({
            vote: request.vote,
            resolveAuthorNames: community._pkc.resolveAuthorNames,
            clientsManager: community._clientsManager
        });
    else if (request.commentModeration)
        validity = await verifyCommentModeration({
            moderation: request.commentModeration,
            resolveAuthorNames: community._pkc.resolveAuthorNames,
            clientsManager: community._clientsManager
        });
    else if (request.communityEdit)
        validity = await verifyCommunityEdit({
            communityEdit: request.communityEdit,
            resolveAuthorNames: community._pkc.resolveAuthorNames,
            clientsManager: community._clientsManager
        });
    else throw Error("Can't detect the type of publication");

    if (!validity.valid) {
        await publishFailedChallengeVerification(community, { reason: validity.reason }, request.challengeRequestId);
        throw new PKCError(getErrorCodeFromMessage(validity.reason), { request, validity });
    }
}

// Validates wire-format fields (rejecting deprecated names, ensuring community keys/name match, timestamp range, ban status).
async function checkWireFormatAndCommunityAuthor(
    community: LocalCommunity,
    publication: PublicationFromDecryptedChallengeRequest,
    authorCommunity?: PublicationWithCommunityAuthorFromDecryptedChallengeRequest["author"]["community"]
): Promise<messages | undefined> {
    // Reject deprecated old wire format fields
    if ("subplebbitAddress" in publication) return messages.ERR_PUBLICATION_USES_DEPRECATED_SUBPLEBBIT_ADDRESS;
    // reject run time field
    if ("communityAddress" in publication) return messages.ERR_PUBLICATION_USES_DEPRECATED_COMMUNITY_ADDRESS;

    // communityPublicKey must be present and match the key this community is addressed by. A publisher
    // sets it from the address it resolved, which on a delegated community is the anchor and never the
    // minter we sign with — comparing against signer.address here would reject every remote
    // publication. See docs/protocol/delegated-ipns.md.
    const pubCommunityPublicKey = getCommunityPublicKeyFromWire(publication as Record<string, unknown>);
    if (!pubCommunityPublicKey || pubCommunityPublicKey !== communityIdentityPublicKey(community))
        return messages.ERR_PUBLICATION_INVALID_COMMUNITY_PUBLIC_KEY;

    // communityName, if present, must match this community's address
    const pubCommunityName = getCommunityNameFromWire(publication as Record<string, unknown>);
    if (pubCommunityName && pubCommunityName !== community.address) return messages.ERR_PUBLICATION_INVALID_COMMUNITY_NAME;

    if (publication.timestamp <= timestamp() - 5 * 60 || publication.timestamp >= timestamp() + 5 * 60)
        return messages.ERR_PUBLICATION_TIMESTAMP_IS_NOT_IN_PROPER_RANGE;

    if (typeof authorCommunity?.banExpiresAt === "number" && authorCommunity.banExpiresAt > timestamp())
        return messages.ERR_AUTHOR_IS_BANNED;

    return undefined;
}

// Author identity checks: reserved fields, name-must-be-domain, name-resolution-matches-signer.
async function checkAuthorIdentity(
    community: LocalCommunity,
    publication: PublicationFromDecryptedChallengeRequest,
    log: Logger
): Promise<messages | undefined> {
    if (publication.author && intersection(keys(publication.author), AuthorReservedFields).length > 0)
        return messages.ERR_PUBLICATION_AUTHOR_HAS_RESERVED_FIELD;

    // Reject publications with non-domain author.name — author.name must be a domain or absent
    const authorName = getAuthorNameFromWire(publication.author);
    if (authorName && !isStringDomain(authorName)) {
        log("Rejecting publication: author.name is not a domain", authorName);
        return messages.ERR_AUTHOR_NAME_MUST_BE_A_DOMAIN;
    }

    // Reject publications with author domains that can't be resolved or don't match the signer
    // Use community._clientsManager (not community._pkc) so nameResolver state changes emit on the community's clients
    if (authorName && isStringDomain(authorName) && community._pkc.resolveAuthorNames) {
        let resolvedAddress: string | null;
        try {
            ({ resolvedAuthorName: resolvedAddress } = await community._clientsManager.resolveAuthorNameIfNeeded({
                authorName,
                abortSignal: AbortSignal.timeout(community._pkc._timeouts["resolve-author-name"]),
                // Incoming pub validation: 30m staleness window is acceptable; domain transfers are rare.
                cache: { maxAge: 1800 }
            }));
        } catch (e) {
            log("Rejecting publication with unresolvable author domain", authorName, e);
            return messages.ERR_FAILED_TO_RESOLVE_AUTHOR_DOMAIN;
        }
        if (resolvedAddress === null) {
            log("Rejecting publication: author domain could not be resolved", authorName);
            return messages.ERR_FAILED_TO_RESOLVE_AUTHOR_DOMAIN;
        }
        const signerAddress = await getPKCAddressFromPublicKey(publication.signature.publicKey);
        if (resolvedAddress !== signerAddress) {
            log("Rejecting publication: author domain resolves to different signer", authorName, resolvedAddress, signerAddress);
            return messages.ERR_AUTHOR_DOMAIN_RESOLVES_TO_DIFFERENT_SIGNER;
        }
    }
    return undefined;
}

// Parent/post lifecycle checks: comment/parent existence, mod flags (removed/deleted/locked/archived/pending/disapproved), and timestamp ordering.
async function checkParentAndPostState(
    community: LocalCommunity,
    request: DecryptedChallengeRequestMessageType,
    publication: PublicationFromDecryptedChallengeRequest
): Promise<messages | undefined> {
    if ("commentCid" in publication || "parentCid" in publication) {
        // vote or reply or commentEdit or commentModeration
        // not post though
        //@ts-expect-error
        const parentCid: string | undefined = publication.parentCid || publication.commentCid;

        if (typeof parentCid !== "string") return messages.ERR_COMMUNITY_PUBLICATION_PARENT_CID_NOT_DEFINED;

        const parent = community._dbHandler.queryComment(parentCid);
        if (!parent) return messages.ERR_PUBLICATION_PARENT_DOES_NOT_EXIST_IN_COMMUNITY;

        const parentFlags = community._dbHandler.queryCommentFlagsSetByMod(parentCid);

        if (parentFlags.removed && !request.commentModeration)
            // not allowed to vote or reply under removed comments
            return messages.ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_REMOVED;

        const isParentDeletedQueryRes = community._dbHandler.queryAuthorEditDeleted(parentCid);

        if (isParentDeletedQueryRes?.deleted && !request.commentModeration)
            return messages.ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_DELETED; // not allowed to vote or reply under deleted comments

        const postFlags = community._dbHandler.queryCommentFlagsSetByMod(parent.postCid);

        if (postFlags.removed && !request.commentModeration) return messages.ERR_COMMUNITY_PUBLICATION_POST_HAS_BEEN_REMOVED;

        const isPostDeletedQueryRes = community._dbHandler.queryAuthorEditDeleted(parent.postCid);

        if (isPostDeletedQueryRes?.deleted && !request.commentModeration) return messages.ERR_COMMUNITY_PUBLICATION_POST_HAS_BEEN_DELETED;

        if (postFlags.locked && !request.commentModeration) {
            // A locked post is closed to regular users, not to mods. Like Reddit, owners/admins/moderators
            // can still reply to (and edit their comments under) a locked post. Voting stays disabled for
            // everyone, mods included.
            const authorCanBypassLock =
                !request.vote && (await isPublicationAuthorPartOfRoles(community, publication, ["owner", "admin", "moderator"]));
            if (!authorCanBypassLock) return messages.ERR_COMMUNITY_PUBLICATION_POST_IS_LOCKED;
        }

        if (postFlags.archived && !request.commentModeration) return messages.ERR_COMMUNITY_PUBLICATION_POST_IS_ARCHIVED;

        if (parent.timestamp > publication.timestamp) return messages.ERR_COMMUNITY_COMMENT_TIMESTAMP_IS_EARLIER_THAN_PARENT;

        // if user publishes vote/reply/commentEdit under pending comment, it should fail
        if (parent.pendingApproval && !("commentModeration" in request) && !(request.commentEdit?.deleted === true))
            return messages.ERR_USER_PUBLISHED_UNDER_PENDING_COMMENT;

        const isCommentDisapproved = community._dbHandler._queryIsCommentApproved(parent);
        if (
            isCommentDisapproved &&
            !isCommentDisapproved.approved &&
            !("commentModeration" in request) &&
            !(request.commentEdit?.deleted === true)
        )
            return messages.ERR_USER_PUBLISHED_UNDER_DISAPPROVED_COMMENT;
    }
    return undefined;
}

// Comment-only validation: feature toggles (links, markdown, spoilers, nesting), flair allowlist, postCid integrity, quotedCid checks, duplicate signature.
async function checkCommentPublication(
    community: LocalCommunity,
    request: DecryptedChallengeRequestMessageType
): Promise<messages | undefined> {
    if (!request.comment) return undefined;
    const commentPublication = request.comment;
    if (intersection(keys(commentPublication), CommentPubsubMessageReservedFields).length > 0)
        return messages.ERR_COMMENT_HAS_RESERVED_FIELD;
    if (
        community.features?.requirePostLink &&
        !commentPublication.parentCid &&
        (!commentPublication.link || (!community.features?.requirePostLinkIsMedia && !isLinkValid(commentPublication.link)))
    )
        return messages.ERR_COMMENT_HAS_INVALID_LINK_FIELD;
    if (
        community.features?.requirePostLinkIsMedia &&
        commentPublication.link &&
        (!isLinkValid(commentPublication.link) || !isLinkOfMedia(commentPublication.link))
    )
        return messages.ERR_POST_LINK_IS_NOT_OF_MEDIA;
    if (
        community.features?.requireReplyLink &&
        commentPublication.parentCid &&
        (!commentPublication.link || (!community.features?.requireReplyLinkIsMedia && !isLinkValid(commentPublication.link)))
    )
        return messages.ERR_REPLY_HAS_INVALID_LINK_FIELD;
    if (
        community.features?.requireReplyLinkIsMedia &&
        commentPublication.parentCid &&
        commentPublication.link &&
        (!isLinkValid(commentPublication.link) || !isLinkOfMedia(commentPublication.link))
    )
        return messages.ERR_REPLY_LINK_IS_NOT_OF_MEDIA;

    if (community.features?.noMarkdownImages && commentPublication.content && contentContainsMarkdownImages(commentPublication.content))
        return messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_IMAGE;

    if (community.features?.noMarkdownVideos && commentPublication.content && contentContainsMarkdownVideos(commentPublication.content))
        return messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_VIDEO;

    if (community.features?.noMarkdownAudio && commentPublication.content && contentContainsMarkdownAudio(commentPublication.content))
        return messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_AUDIO;

    // noImages - block ALL comments with image links
    if (community.features?.noImages && commentPublication.link && isLinkOfImage(commentPublication.link))
        return messages.ERR_COMMENT_HAS_LINK_THAT_IS_IMAGE;

    // noVideos - block ALL comments with video links (including animated images like GIF/APNG)
    if (
        community.features?.noVideos &&
        commentPublication.link &&
        (isLinkOfVideo(commentPublication.link) || isLinkOfAnimatedImage(commentPublication.link))
    )
        return messages.ERR_COMMENT_HAS_LINK_THAT_IS_VIDEO;

    // noSpoilers - block ALL comments with spoiler=true
    if (community.features?.noSpoilers && commentPublication.spoiler === true) return messages.ERR_COMMENT_HAS_SPOILER_ENABLED;

    // noImageReplies - block only replies with image links
    if (
        community.features?.noImageReplies &&
        commentPublication.parentCid &&
        commentPublication.link &&
        isLinkOfImage(commentPublication.link)
    )
        return messages.ERR_REPLY_HAS_LINK_THAT_IS_IMAGE;

    // noVideoReplies - block only replies with video links (including animated images like GIF/APNG)
    if (
        community.features?.noVideoReplies &&
        commentPublication.parentCid &&
        commentPublication.link &&
        (isLinkOfVideo(commentPublication.link) || isLinkOfAnimatedImage(commentPublication.link))
    )
        return messages.ERR_REPLY_HAS_LINK_THAT_IS_VIDEO;

    // noReplyLinks - block all replies that have a link field set
    if (community.features?.noReplyLinks && commentPublication.parentCid && commentPublication.link) return messages.ERR_REPLY_HAS_LINK;

    // noAudio - block ALL comments with audio links
    if (community.features?.noAudio && commentPublication.link && isLinkOfAudio(commentPublication.link))
        return messages.ERR_COMMENT_HAS_LINK_THAT_IS_AUDIO;

    // noAudioReplies - block only replies with audio links
    if (
        community.features?.noAudioReplies &&
        commentPublication.parentCid &&
        commentPublication.link &&
        isLinkOfAudio(commentPublication.link)
    )
        return messages.ERR_REPLY_HAS_LINK_THAT_IS_AUDIO;

    // noSpoilerReplies - block only replies with spoiler=true
    if (community.features?.noSpoilerReplies && commentPublication.parentCid && commentPublication.spoiler === true)
        return messages.ERR_REPLY_HAS_SPOILER_ENABLED;

    // noNestedReplies - block replies with depth > 1 (replies to replies)
    if (community.features?.noNestedReplies && commentPublication.parentCid) {
        const parent = community._dbHandler.queryComment(commentPublication.parentCid);
        if (parent && parent.depth > 0) {
            return messages.ERR_NESTED_REPLIES_NOT_ALLOWED;
        }
    }

    // Post flairs validation (comment.flairs)
    if (commentPublication.flairs && commentPublication.flairs.length > 0) {
        if (!community.features?.postFlairs) {
            return messages.ERR_POST_FLAIRS_NOT_ALLOWED;
        }
        const allowedPostFlairs = community.flairs?.["post"] || [];
        for (const flair of commentPublication.flairs) {
            if (!isFlairInAllowedList(flair, allowedPostFlairs)) {
                return messages.ERR_POST_FLAIR_NOT_IN_ALLOWED_FLAIRS;
            }
        }
    }

    // requirePostFlairs - only for posts (depth=0)
    if (community.features?.requirePostFlairs && !commentPublication.parentCid) {
        if (!commentPublication.flairs || commentPublication.flairs.length === 0) {
            return messages.ERR_POST_FLAIRS_REQUIRED;
        }
    }

    // Author flairs validation (comment.author.flairs)
    if (commentPublication.author?.flairs && commentPublication.author.flairs.length > 0 && !community.features?.pseudonymityMode) {
        if (!community.features?.authorFlairs) {
            return messages.ERR_AUTHOR_FLAIRS_NOT_ALLOWED;
        }
        const allowedAuthorFlairs = community.flairs?.["author"] || [];
        for (const flair of commentPublication.author.flairs) {
            if (!isFlairInAllowedList(flair, allowedAuthorFlairs)) {
                return messages.ERR_AUTHOR_FLAIR_NOT_IN_ALLOWED_FLAIRS;
            }
        }
    }

    // requireAuthorFlairs - for all comments (posts and replies)
    if (community.features?.requireAuthorFlairs && !community.features?.pseudonymityMode) {
        if (!commentPublication.author?.flairs || commentPublication.author.flairs.length === 0) {
            return messages.ERR_AUTHOR_FLAIRS_REQUIRED;
        }
    }

    if (commentPublication.parentCid && !commentPublication.postCid) return messages.ERR_REPLY_HAS_NOT_DEFINED_POST_CID;

    if (commentPublication.parentCid) {
        // query parents, and make sure commentPublication.postCid is the final parent
        const parentsOfComment = community._dbHandler.queryParentsCids({ parentCid: commentPublication.parentCid });
        if (parentsOfComment[parentsOfComment.length - 1].cid !== commentPublication.postCid)
            return messages.ERR_REPLY_POST_CID_IS_NOT_PARENT_OF_REPLY;
    }

    // Validate quotedCids
    if (commentPublication.quotedCids && commentPublication.quotedCids.length > 0) {
        // Only replies can have quotedCids
        if (!commentPublication.parentCid) {
            return messages.ERR_POST_CANNOT_HAVE_QUOTED_CIDS;
        }

        const threadPostCid = commentPublication.postCid!; // postCid is always defined for replies

        for (const quotedCid of commentPublication.quotedCids) {
            // 1. Check existence
            const quotedComment = community._dbHandler.queryComment(quotedCid);
            if (!quotedComment) {
                return messages.ERR_QUOTED_CID_DOES_NOT_EXIST;
            }

            // 2. Check quoted comment is under the same post
            const quotedPostCid = quotedComment.depth === 0 ? quotedComment.cid : quotedComment.postCid;
            if (quotedPostCid !== threadPostCid) {
                return messages.ERR_QUOTED_CID_NOT_UNDER_POST;
            }

            // 3. Check not pending approval
            if (quotedComment.pendingApproval) {
                return messages.ERR_QUOTED_CID_IS_PENDING_APPROVAL;
            }
        }
    }

    const isCommentDuplicate = community._dbHandler.hasCommentWithSignatureEncoded(commentPublication.signature.signature);
    if (isCommentDuplicate) return messages.ERR_DUPLICATE_COMMENT;
    return undefined;
}

async function checkVotePublication(
    community: LocalCommunity,
    request: DecryptedChallengeRequestMessageType
): Promise<messages | undefined> {
    if (!request.vote) return undefined;
    const votePublication = request.vote;
    if (intersection(VotePubsubReservedFields, keys(votePublication)).length > 0) return messages.ERR_VOTE_HAS_RESERVED_FIELD;
    if (community.features?.noUpvotes && votePublication.vote === 1) return messages.ERR_NOT_ALLOWED_TO_PUBLISH_UPVOTES;
    if (community.features?.noDownvotes && votePublication.vote === -1) return messages.ERR_NOT_ALLOWED_TO_PUBLISH_DOWNVOTES;

    const commentToVoteOn = community._dbHandler.queryComment(request.vote.commentCid)!;

    if (community.features?.noPostDownvotes && commentToVoteOn!.depth === 0 && votePublication.vote === -1)
        return messages.ERR_NOT_ALLOWED_TO_PUBLISH_POST_DOWNVOTES;
    if (community.features?.noPostUpvotes && commentToVoteOn!.depth === 0 && votePublication.vote === 1)
        return messages.ERR_NOT_ALLOWED_TO_PUBLISH_POST_UPVOTES;

    if (community.features?.noReplyDownvotes && commentToVoteOn!.depth > 0 && votePublication.vote === -1)
        return messages.ERR_NOT_ALLOWED_TO_PUBLISH_REPLY_DOWNVOTES;
    if (community.features?.noReplyUpvotes && commentToVoteOn!.depth > 0 && votePublication.vote === 1)
        return messages.ERR_NOT_ALLOWED_TO_PUBLISH_REPLY_UPVOTES;

    const voteAuthorSignerAddress = await getPKCAddressFromPublicKey(votePublication.signature.publicKey);
    const previousVote = community._dbHandler.queryVote(commentToVoteOn!.cid, voteAuthorSignerAddress);
    if (!previousVote && votePublication.vote === 0) return messages.ERR_THERE_IS_NO_PREVIOUS_VOTE_TO_CANCEL;
    return undefined;
}

async function checkCommentModerationPublication(
    community: LocalCommunity,
    request: DecryptedChallengeRequestMessageType
): Promise<messages | undefined> {
    if (!request.commentModeration) return undefined;
    const commentModerationPublication = request.commentModeration;
    if (intersection(CommentModerationReservedFields, keys(commentModerationPublication)).length > 0)
        return messages.ERR_COMMENT_MODERATION_HAS_RESERVED_FIELD;

    const isAuthorMod = await isPublicationAuthorPartOfRoles(community, commentModerationPublication, ["owner", "moderator", "admin"]);

    if (!isAuthorMod) return messages.ERR_COMMENT_MODERATION_ATTEMPTED_WITHOUT_BEING_MODERATOR;

    const commentToBeEdited = community._dbHandler.queryComment(commentModerationPublication.commentCid); // We assume commentToBeEdited to be defined because we already tested for its existence above
    if (!commentToBeEdited) return messages.ERR_COMMENT_MODERATION_NO_COMMENT_TO_EDIT;

    if (isAuthorMod && commentModerationPublication.commentModeration.locked && commentToBeEdited.depth !== 0)
        return messages.ERR_COMMUNITY_COMMENT_MOD_CAN_NOT_LOCK_REPLY;
    if (isAuthorMod && commentModerationPublication.commentModeration.archived && commentToBeEdited.depth !== 0)
        return messages.ERR_COMMUNITY_COMMENT_MOD_CAN_NOT_ARCHIVE_REPLY;
    const commentModInDb = community._dbHandler.hasCommentModerationWithSignatureEncoded(commentModerationPublication.signature.signature);
    if (commentModInDb) return messages.ERR_DUPLICATE_COMMENT_MODERATION;
    if ("approved" in commentModerationPublication.commentModeration && !commentToBeEdited.pendingApproval)
        return messages.ERR_MOD_ATTEMPTING_TO_APPROVE_OR_DISAPPROVE_COMMENT_THAT_IS_NOT_PENDING;
    return undefined;
}

async function checkCommunityEditPublication(
    community: LocalCommunity,
    request: DecryptedChallengeRequestMessageType
): Promise<messages | undefined> {
    if (!request.communityEdit) return undefined;
    const communityEdit = request.communityEdit;
    if (intersection(CommunityEditPublicationPubsubReservedFields, keys(communityEdit)).length > 0)
        return messages.ERR_COMMUNITY_EDIT_HAS_RESERVED_FIELD;

    if (communityEdit.communityEdit.roles || communityEdit.communityEdit.address) {
        const isAuthorOwner = await isPublicationAuthorPartOfRoles(community, communityEdit, ["owner"]);
        if (!isAuthorOwner) return messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_OWNER_EXCLUSIVE_PROPS;
    }

    const isAuthorOwnerOrAdmin = await isPublicationAuthorPartOfRoles(community, communityEdit, ["owner", "admin"]);
    if (!isAuthorOwnerOrAdmin) {
        return messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_COMMUNITY_WITHOUT_BEING_OWNER_OR_ADMIN;
    }

    const allowedCommunityEditKeys = [...keys(CommunityIpfsSchema.shape), "address"] as string[];
    if (difference(keys(communityEdit.communityEdit), allowedCommunityEditKeys).length > 0) {
        // should only be allowed to modify public props from CommunityIpfs
        // shouldn't be able to modify settings for example
        return messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_NON_PUBLIC_PROPS;
    }
    return undefined;
}

async function checkCommentEditPublication(
    community: LocalCommunity,
    request: DecryptedChallengeRequestMessageType
): Promise<messages | undefined> {
    if (!request.commentEdit) return undefined;
    const commentEditPublication = request.commentEdit;
    if (intersection(CommentEditReservedFields, keys(commentEditPublication)).length > 0)
        return messages.ERR_COMMENT_EDIT_HAS_RESERVED_FIELD;

    const commentToBeEdited = community._dbHandler.queryComment(commentEditPublication.commentCid); // We assume commentToBeEdited to be defined because we already tested for its existence above
    if (!commentToBeEdited) return messages.ERR_COMMENT_EDIT_NO_COMMENT_TO_EDIT;

    const commentEditInDb = community._dbHandler.hasCommentEditWithSignatureEncoded(commentEditPublication.signature.signature);
    if (commentEditInDb) return messages.ERR_DUPLICATE_COMMENT_EDIT;

    const aliasSignerOfComment = community._dbHandler.queryPseudonymityAliasByCommentCid(commentToBeEdited.cid);
    if (aliasSignerOfComment) {
        const editSignedByOriginalAuthor = commentEditPublication.signature.publicKey === aliasSignerOfComment.originalAuthorPublicKey;
        if (!editSignedByOriginalAuthor) return messages.ERR_COMMENT_EDIT_CAN_NOT_EDIT_COMMENT_IF_NOT_ORIGINAL_AUTHOR;
    } else {
        const editSignedByOriginalAuthor = commentEditPublication.signature.publicKey === commentToBeEdited.signature.publicKey;

        if (!editSignedByOriginalAuthor) return messages.ERR_COMMENT_EDIT_CAN_NOT_EDIT_COMMENT_IF_NOT_ORIGINAL_AUTHOR;
    }

    // Validate markdown content restrictions for comment edits
    if (
        community.features?.noMarkdownImages &&
        commentEditPublication.content &&
        contentContainsMarkdownImages(commentEditPublication.content)
    )
        return messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_IMAGE;

    if (
        community.features?.noMarkdownVideos &&
        commentEditPublication.content &&
        contentContainsMarkdownVideos(commentEditPublication.content)
    )
        return messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_VIDEO;

    if (
        community.features?.noMarkdownAudio &&
        commentEditPublication.content &&
        contentContainsMarkdownAudio(commentEditPublication.content)
    )
        return messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_AUDIO;

    // noSpoilers - block ALL comment edits that set spoiler=true
    if (community.features?.noSpoilers && commentEditPublication.spoiler === true) return messages.ERR_COMMENT_HAS_SPOILER_ENABLED;

    // noSpoilerReplies - block only reply edits that set spoiler=true
    if (community.features?.noSpoilerReplies && commentToBeEdited.depth > 0 && commentEditPublication.spoiler === true)
        return messages.ERR_REPLY_HAS_SPOILER_ENABLED;

    // Post flairs validation for comment edits
    if (commentEditPublication.flairs && commentEditPublication.flairs.length > 0) {
        if (!community.features?.postFlairs) {
            return messages.ERR_POST_FLAIRS_NOT_ALLOWED;
        }
        const allowedPostFlairs = community.flairs?.["post"] || [];
        for (const flair of commentEditPublication.flairs) {
            if (!isFlairInAllowedList(flair, allowedPostFlairs)) {
                return messages.ERR_POST_FLAIR_NOT_IN_ALLOWED_FLAIRS;
            }
        }
    }
    return undefined;
}

export async function checkPublicationValidity(
    community: LocalCommunity,
    request: DecryptedChallengeRequestMessageType,
    publication: PublicationFromDecryptedChallengeRequest,
    authorCommunity?: PublicationWithCommunityAuthorFromDecryptedChallengeRequest["author"]["community"]
): Promise<messages | undefined> {
    const log = Logger("pkc-js:local-community:handleChallengeRequest:checkPublicationValidity");

    const wireResult = await checkWireFormatAndCommunityAuthor(community, publication, authorCommunity);
    if (wireResult) return wireResult;

    const authorResult = await checkAuthorIdentity(community, publication, log);
    if (authorResult) return authorResult;

    const parentResult = await checkParentAndPostState(community, request, publication);
    if (parentResult) return parentResult;

    // Reject publications if their size is over 40kb
    const publicationKilobyteSize = Buffer.byteLength(JSON.stringify(publication)) / 1000;
    if (publicationKilobyteSize > 40) return messages.ERR_REQUEST_PUBLICATION_OVER_ALLOWED_SIZE;

    const commentResult = await checkCommentPublication(community, request);
    if (commentResult) return commentResult;

    const voteResult = await checkVotePublication(community, request);
    if (voteResult) return voteResult;

    const modResult = await checkCommentModerationPublication(community, request);
    if (modResult) return modResult;

    const communityEditResult = await checkCommunityEditPublication(community, request);
    if (communityEditResult) return communityEditResult;

    const commentEditResult = await checkCommentEditPublication(community, request);
    if (commentEditResult) return commentEditResult;

    return undefined;
}

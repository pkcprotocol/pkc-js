import Logger from "../../../../logger.js";
import * as remeda from "remeda";
import { default as lodashDeepMerge } from "lodash.merge";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { calculateIpfsCidV0, isStringDomain, retryKuboIpfsAddAndProvide, timestamp } from "../../../../util.js";
import { PKCError } from "../../../../pkc-error.js";
import { signComment, signCommentEdit } from "../../../../signer/signatures.js";
import { getPKCAddressFromPublicKey } from "../../../../signer/util.js";
import { cleanWireAuthor, getAuthorNameFromWire } from "../../../../publications/publication-author.js";
import { getThumbnailPropsOfLink } from "../../util.js";
import {
    CommentEditPubsubMessagePublicationSchema,
    CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema
} from "../../../../publications/comment-edit/schema.js";
import { CommentIpfsSchema, CommentPubsubMessagePublicationSchema } from "../../../../publications/comment/schema.js";
import { CommentModerationPubsubMessagePublicationSchema } from "../../../../publications/comment-moderation/schema.js";
import { VotePubsubMessagePublicationSchema } from "../../../../publications/vote/schema.js";
import { addAllCidsUnderPurgedCommentToBeRemoved, rmUnneededMfsPaths } from "./cleanup.js";
import { isPublicationAuthorPartOfRoles } from "./publication-validation.js";
import type { CommentEditPubsubMessagePublication, CommentEditsTableRow } from "../../../../publications/comment-edit/types.js";
import type {
    CommentIpfsType,
    CommentPubsubMessagePublication,
    CommentsTableRow,
    CommentUpdateType,
    PostPubsubMessageWithCommunityAuthor,
    ReplyPubsubMessageWithCommunityAuthor
} from "../../../../publications/comment/types.js";
import type {
    CommentModerationPubsubMessagePublication,
    CommentModerationTableRow
} from "../../../../publications/comment-moderation/types.js";
import type { VotePubsubMessagePublication, VotesTableRow } from "../../../../publications/vote/types.js";
import type { CommunityEditPubsubMessagePublication } from "../../../../publications/community-edit/types.js";
import type { PseudonymityAliasRow } from "../db-handler-types.js";
import type { ChallengeRequestMessageType, DecryptedChallengeRequestMessageType } from "../../../../pubsub-messages/types.js";
import type { LocalCommunity } from "../local-community.js";

export function isPublicationReply(publication: CommentPubsubMessagePublication): publication is ReplyPubsubMessageWithCommunityAuthor {
    return Boolean(publication.parentCid);
}

export function isPublicationPost(publication: CommentPubsubMessagePublication): publication is PostPubsubMessageWithCommunityAuthor {
    return !publication.parentCid;
}

export async function calculateLinkProps(
    community: LocalCommunity,
    link: CommentPubsubMessagePublication["link"]
): Promise<Pick<CommentIpfsType, "thumbnailUrl" | "thumbnailUrlWidth" | "thumbnailUrlHeight"> | undefined> {
    if (!link || !community.settings?.fetchThumbnailUrls) return undefined;
    return getThumbnailPropsOfLink(link, community, community.settings.fetchThumbnailUrlsProxyUrl);
}

export async function calculateLatestPostProps(community: LocalCommunity): Promise<Pick<CommentIpfsType, "previousCid" | "depth">> {
    community._dbHandler.createTransaction();
    const previousCid = community._dbHandler.queryLatestPostCid()?.cid;
    community._dbHandler.commitTransaction();
    return { depth: 0, previousCid };
}

export async function calculateReplyProps(
    community: LocalCommunity,
    comment: CommentPubsubMessagePublication
): Promise<Pick<CommentIpfsType, "previousCid" | "depth" | "postCid">> {
    if (!comment.parentCid) throw Error("Reply has to have parentCid");

    community._dbHandler.createTransaction();
    const commentsUnderParent = community._dbHandler.queryCommentsUnderComment(comment.parentCid);
    const parent = community._dbHandler.queryComment(comment.parentCid);
    community._dbHandler.commitTransaction();

    if (!parent) throw Error("Failed to find parent of reply");

    return {
        depth: parent.depth + 1,
        postCid: parent.postCid,
        previousCid: commentsUnderParent[0]?.cid
    };
}

export async function resolveAliasPrivateKeyForCommentPublication(
    community: LocalCommunity,
    opts: {
        mode: PseudonymityAliasRow["mode"];
        originalAuthorPublicKey: PseudonymityAliasRow["originalAuthorPublicKey"];
        postCid?: string;
    }
): Promise<string> {
    if (opts.mode === "per-post") {
        // For a new post (no postCid yet), always generate a fresh alias; once stored the postCid will be used for reuse.
        if (opts.postCid) {
            const existing = community._dbHandler.queryPseudonymityAliasForPost(opts.originalAuthorPublicKey, opts.postCid);
            if (existing?.aliasPrivateKey) return existing.aliasPrivateKey;
        }
        return (await community._pkc.createSigner()).privateKey;
    } else if (opts.mode === "per-reply") {
        const signer = await community._pkc.createSigner();
        return signer.privateKey;
    } else if (opts.mode === "per-author") {
        const existing = community._dbHandler.queryPseudonymityAliasForAuthor(opts.originalAuthorPublicKey);
        if (existing?.aliasPrivateKey) return existing.aliasPrivateKey;
        const signer = await community._pkc.createSigner();
        return signer.privateKey;
    } else throw Error(`Unsupported pseudonymityMode (${opts.mode})`);
}

export async function prepareCommentWithAnonymity(
    community: LocalCommunity,
    originalComment: CommentPubsubMessagePublication
): Promise<{
    publication: CommentPubsubMessagePublication;
    anonymity?: {
        aliasPrivateKey: PseudonymityAliasRow["aliasPrivateKey"];
        originalAuthorPublicKey: PseudonymityAliasRow["originalAuthorPublicKey"];
        mode: PseudonymityAliasRow["mode"];
        originalComment: CommentPubsubMessagePublication;
    };
}> {
    const mode = community.features?.pseudonymityMode;
    if (!mode) return { publication: originalComment };

    // Mods (owner, admin, moderator) are never pseudonymized
    const isAuthorMod = await isPublicationAuthorPartOfRoles(community, originalComment, ["owner", "admin", "moderator"]);
    if (isAuthorMod) return { publication: originalComment };

    const originalAuthorPublicKey = originalComment.signature.publicKey;
    const postCid = originalComment.postCid;
    const aliasPrivateKey = await resolveAliasPrivateKeyForCommentPublication(community, {
        mode,
        originalAuthorPublicKey,
        postCid
    });
    const aliasSigner = await community._pkc.createSigner({ privateKey: aliasPrivateKey, type: "ed25519" });
    const displayName = originalComment.author?.displayName;
    const sanitizedAuthor = cleanWireAuthor(displayName !== undefined ? { displayName } : undefined);

    const anonymizedComment = remeda.clone(originalComment);

    if (sanitizedAuthor !== undefined) {
        anonymizedComment.author = sanitizedAuthor;
    } else {
        delete anonymizedComment.author;
    }
    anonymizedComment.signature = await signComment({
        comment: { ...anonymizedComment, signer: aliasSigner, communityAddress: community.address },
        pkc: community._pkc
    });

    return {
        publication: anonymizedComment,
        anonymity: {
            aliasPrivateKey,
            originalAuthorPublicKey,
            mode,
            originalComment
        }
    };
}

export async function prepareCommentEditWithAlias(community: LocalCommunity, originalEdit: CommentEditPubsubMessagePublication) {
    const aliasSignerOfComment = community._dbHandler.queryPseudonymityAliasByCommentCid(originalEdit.commentCid);
    if (!aliasSignerOfComment) return originalEdit;

    const aliasSigner = await community._pkc.createSigner({
        privateKey: aliasSignerOfComment.aliasPrivateKey,
        type: "ed25519"
    });
    const commentEditSignedByAlias = remeda.clone(originalEdit);
    delete commentEditSignedByAlias.author;
    commentEditSignedByAlias.signature = await signCommentEdit({
        edit: { ...commentEditSignedByAlias, signer: aliasSigner, communityAddress: community.address },
        pkc: community._pkc
    });

    return commentEditSignedByAlias;
}

export async function storeCommentEdit(
    community: LocalCommunity,
    commentEditRaw: CommentEditPubsubMessagePublication,
    challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
): Promise<undefined> {
    const log = Logger("pkc-js:local-community:storeCommentEdit");
    const strippedOutEditPublication = CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema.strip().parse(commentEditRaw); // we strip out here so we don't store any extra props in commentedits table
    strippedOutEditPublication.author = cleanWireAuthor(strippedOutEditPublication.author); // strip runtime-only author fields (address, publicKey, etc.)

    // Normalize to new wire format: ensure communityPublicKey/communityName for DB columns
    if (!strippedOutEditPublication.communityPublicKey) strippedOutEditPublication.communityPublicKey = community.signer.address;
    if (!strippedOutEditPublication.communityName && isStringDomain(community.address))
        strippedOutEditPublication.communityName = community.address;
    const commentToBeEdited = community._dbHandler.queryComment(commentEditRaw.commentCid); // We assume commentToBeEdited to be defined because we already tested for its existence above
    if (!commentToBeEdited) throw Error("The comment to edit doesn't exist"); // unlikely error to happen, but always a good idea to verify

    const editSignedByOriginalAuthor = commentEditRaw.signature.publicKey === commentToBeEdited.signature.publicKey;

    const authorSignerAddress = await getPKCAddressFromPublicKey(commentEditRaw.signature.publicKey);

    const editTableRow = <CommentEditsTableRow>{
        ...strippedOutEditPublication,
        isAuthorEdit: editSignedByOriginalAuthor,
        authorSignerAddress,
        insertedAt: timestamp()
    };

    const extraPropsInEdit = remeda
        .difference(remeda.keys.strict(commentEditRaw), remeda.keys.strict(CommentEditPubsubMessagePublicationSchema.shape))
        .filter((key) => (key as string) !== "communityAddress"); // communityAddress is excluded because it's been converted to communityPublicKey/communityName above
    if (extraPropsInEdit.length > 0) {
        log("Found extra props on CommentEdit", extraPropsInEdit, "Will be adding them to extraProps column");
        editTableRow.extraProps = remeda.pick(commentEditRaw, extraPropsInEdit);
    }

    const isEditDuplicate = community._dbHandler.hasCommentEditWithSignatureEncoded(editTableRow.signature.signature);
    if (isEditDuplicate) {
        throw new PKCError("ERR_DUPLICATE_COMMENT_EDIT", { editTableRow });
    }

    community._dbHandler.insertCommentEdits([editTableRow]);

    // If author is deleting a pending or disapproved comment, purge it immediately from the database
    if (commentEditRaw.deleted === true) {
        const isPending = commentToBeEdited.pendingApproval;
        const disapprovalResult = community._dbHandler._queryIsCommentApproved(commentToBeEdited);
        const isDisapproved = disapprovalResult && !disapprovalResult.approved;

        if (isPending || isDisapproved) {
            log("Author deleted a pending/disapproved comment, purging immediately", commentEditRaw.commentCid);
            community._dbHandler.purgeComment(commentEditRaw.commentCid);
            community._communityUpdateTrigger = true;
        }
    }
}

export async function storeCommentModeration(
    community: LocalCommunity,
    commentModRaw: CommentModerationPubsubMessagePublication,
    challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
): Promise<undefined> {
    const log = Logger("pkc-js:local-community:storeCommentModeration");
    const strippedOutModPublication = CommentModerationPubsubMessagePublicationSchema.strip().parse(commentModRaw); // we strip out here so we don't store any extra props in commentedits table
    strippedOutModPublication.author = cleanWireAuthor(strippedOutModPublication.author); // strip runtime-only author fields (address, publicKey, etc.)

    // Normalize to new wire format: ensure communityPublicKey/communityName for DB columns
    if (!strippedOutModPublication.communityPublicKey) strippedOutModPublication.communityPublicKey = community.signer.address;
    if (!strippedOutModPublication.communityName && isStringDomain(community.address))
        strippedOutModPublication.communityName = community.address;
    const commentToBeEdited = community._dbHandler.queryComment(commentModRaw.commentCid); // We assume commentToBeEdited to be defined because we already tested for its existence above
    if (!commentToBeEdited) throw Error("The comment to edit doesn't exist"); // unlikely error to happen, but always a good idea to verify

    const modSignerAddress = await getPKCAddressFromPublicKey(commentModRaw.signature.publicKey);

    // Determine the target author signer address and domain if this moderation affects the author (ban/flair)
    let targetAuthorSignerAddress: string | undefined;
    let targetAuthorDomain: string | undefined;
    if (strippedOutModPublication.commentModeration.author) {
        // Check if the comment was published with pseudonymity - if so, get the original author address/domain
        const aliasInfo = community._dbHandler.queryPseudonymityAliasByCommentCid(commentModRaw.commentCid);
        if (aliasInfo) {
            targetAuthorSignerAddress = await getPKCAddressFromPublicKey(aliasInfo.originalAuthorPublicKey);
            targetAuthorDomain = aliasInfo.originalAuthorName || undefined;
        } else {
            targetAuthorSignerAddress = commentToBeEdited.authorSignerAddress;
            targetAuthorDomain = getAuthorNameFromWire(commentToBeEdited.author);
        }
    }

    const modTableRow = <CommentModerationTableRow>{
        ...strippedOutModPublication,
        modSignerAddress,
        insertedAt: timestamp(),
        targetAuthorSignerAddress,
        targetAuthorDomain
    };

    const isCommentModDuplicate = community._dbHandler.hasCommentModerationWithSignatureEncoded(modTableRow.signature.signature);
    if (isCommentModDuplicate) {
        throw new PKCError("ERR_DUPLICATE_COMMENT_MODERATION", { modTableRow });
    }

    const extraPropsInMod = remeda
        .difference(remeda.keys.strict(commentModRaw), remeda.keys.strict(CommentModerationPubsubMessagePublicationSchema.shape))
        .filter((key) => (key as string) !== "communityAddress"); // communityAddress is excluded because it's been converted to communityPublicKey/communityName above
    if (extraPropsInMod.length > 0) {
        log("Found extra props on CommentModeration", extraPropsInMod, "Will be adding them to extraProps column");
        modTableRow.extraProps = remeda.pick(commentModRaw, extraPropsInMod);
    }

    if (modTableRow.commentModeration.purged) {
        log(
            "commentModeration.purged=true, and therefore will delete the post/comment and all its reply tree from the db as well as unpin the cids from ipfs",
            "comment cid is",
            modTableRow.commentCid
        );

        const commentToPurge = community._dbHandler.queryComment(modTableRow.commentCid);
        if (!commentToPurge) throw Error("Comment to purge not found");
        const purgedTableRows = community._dbHandler.purgeComment(modTableRow.commentCid);

        for (const purgedTableRow of purgedTableRows) await addAllCidsUnderPurgedCommentToBeRemoved(community, purgedTableRow);

        log("Purged comment", modTableRow.commentCid, "and its comment and comment update children", "out of DB and IPFS");

        await rmUnneededMfsPaths(community); // not sure if needed here
        if (community.updateCid) {
            // need to remove any update cids with reference to purged comment
            community._blocksToRm.push(community.updateCid);
            community._cidsToUnPin.add(community.updateCid);
        }
    } else if ("approved" in modTableRow.commentModeration) {
        if (modTableRow.commentModeration.approved) {
            log(
                "commentModeration.approved=true, and therefore move comment from pending approval and add it to IPFS",
                "comment cid is",
                modTableRow.commentCid
            );

            await community._addCommentRowToIPFS(
                commentToBeEdited,
                Logger("pkc-js:local-community:storeCommentModeration:_addCommentRowToIPFS")
            );
            community._dbHandler.approvePendingComment({ cid: modTableRow.commentCid });
        } else {
            const shouldPurgeDisapprovedComment = Object.keys(modTableRow.commentModeration).length === 1; // no other props were included, if so purge the comment
            log(
                "commentModeration.approved=false, and therefore this comment will be removed entirely from DB",
                "should we purge this comment? = ",
                shouldPurgeDisapprovedComment,
                "comment cid is",
                modTableRow.commentCid
            );
            if (shouldPurgeDisapprovedComment) community._dbHandler.purgeComment(modTableRow.commentCid);
            else community._dbHandler.removeCommentFromPendingApproval({ cid: modTableRow.commentCid });
        }
    }
    community._dbHandler.insertCommentModerations([modTableRow]);
    community._communityUpdateTrigger = true;
    log("Inserted comment moderation", "of comment", modTableRow.commentCid, "into db", "with props", modTableRow);
}

export async function storeVote(
    community: LocalCommunity,
    newVoteProps: VotePubsubMessagePublication,
    challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
) {
    const log = Logger("pkc-js:local-community:storeVote");

    const authorSignerAddress = await getPKCAddressFromPublicKey(newVoteProps.signature.publicKey);
    community._dbHandler.deleteVote(authorSignerAddress, newVoteProps.commentCid);
    const voteTableRow = <VotesTableRow>{
        ...remeda.pick(newVoteProps, ["vote", "commentCid", "protocolVersion", "timestamp"]),
        authorSignerAddress,
        insertedAt: timestamp()
    };
    const extraPropsInVote = remeda.difference(
        remeda.keys.strict(newVoteProps),
        remeda.keys.strict(VotePubsubMessagePublicationSchema.shape)
    );
    if (extraPropsInVote.length > 0) {
        log("Found extra props on Vote", extraPropsInVote, "Will be adding them to extraProps column");
        voteTableRow.extraProps = remeda.pick(newVoteProps, extraPropsInVote);
    }

    community._dbHandler.insertVotes([voteTableRow]);
    log("Inserted vote", "of comment", voteTableRow.commentCid, "into db", "with props", voteTableRow);
    return undefined;
}

export async function storeCommunityEditPublication(
    community: LocalCommunity,
    editProps: CommunityEditPubsubMessagePublication,
    challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
) {
    const log = Logger("pkc-js:local-community:storeCommunityEdit");

    const authorSignerAddress = await getPKCAddressFromPublicKey(editProps.signature.publicKey);
    const authorIdentity = getAuthorNameFromWire(editProps.author) || authorSignerAddress;
    log(
        "Received community edit",
        editProps.communityEdit,
        "from author",
        authorIdentity,
        "with signer address",
        authorSignerAddress,
        "Will be using these props to edit the community props"
    );

    const propsAfterEdit = remeda.pick(community, remeda.keys.strict(editProps.communityEdit));
    log("Current props from community edit (not edited yet)", propsAfterEdit);
    lodashDeepMerge(propsAfterEdit, editProps.communityEdit);
    await community.edit(propsAfterEdit);
    return undefined;
}

export async function storeComment(
    community: LocalCommunity,
    opts: {
        commentPubsub: CommentPubsubMessagePublication;
        pendingApproval?: boolean;
        pseudonymityMode?: PseudonymityAliasRow["mode"];
        originalCommentSignatureEncoded?: string;
    }
): Promise<{ comment: CommentIpfsType; cid: CommentUpdateType["cid"] }> {
    const { commentPubsub, pendingApproval, pseudonymityMode, originalCommentSignatureEncoded } = opts;
    const log = Logger("pkc-js:local-community:handleChallengeExchange:storeComment");

    const commentIpfs = <CommentIpfsType>{
        ...commentPubsub,
        ...(await calculateLinkProps(community, commentPubsub.link)),
        ...(isPublicationPost(commentPubsub) && (await calculateLatestPostProps(community))),
        ...(isPublicationReply(commentPubsub) && (await calculateReplyProps(community, commentPubsub))),
        ...(pseudonymityMode ? { pseudonymityMode } : {})
    };

    // Normalize to new wire format: ensure communityPublicKey/communityName, remove old communityAddress
    commentIpfs.communityPublicKey = community.signer.address;
    if (isStringDomain(community.address)) commentIpfs.communityName = community.address;
    delete (commentIpfs as Record<string, unknown>).communityAddress;

    // Strip runtime-only author fields (nameResolved, address, publicKey, etc.) before IPFS storage
    commentIpfs.author = cleanWireAuthor(commentIpfs.author);

    const ipfsClient = community._clientsManager.getDefaultKuboRpcClient();

    const file = pendingApproval
        ? undefined
        : await retryKuboIpfsAddAndProvide({
              ipfsClient: ipfsClient._client,
              log,
              content: deterministicStringify(commentIpfs),
              addOptions: { pin: true },
              provideOptions: { recursive: true },
              provideInBackground: false
          });

    const commentCid = file?.path || (await calculateIpfsCidV0(deterministicStringify(commentIpfs)));
    const postCid = commentIpfs.postCid || commentCid; // if postCid is not defined, then we're adding a post to IPFS, so its own cid is the postCid
    const authorSignerAddress = await getPKCAddressFromPublicKey(commentPubsub.signature.publicKey);

    const strippedOutCommentIpfs = CommentIpfsSchema.strip().parse(commentIpfs); // remove unknown props
    strippedOutCommentIpfs.author = cleanWireAuthor(strippedOutCommentIpfs.author); // strip runtime-only author fields (address, publicKey, etc.)

    const signaturesToCheck = Array.from(
        new Set(
            [commentPubsub.signature.signature, originalCommentSignatureEncoded].filter((sig): sig is string => typeof sig === "string")
        )
    );
    const isCommentDuplicate = signaturesToCheck.some((signatureEncoded) =>
        community._dbHandler.hasCommentWithSignatureEncoded(signatureEncoded)
    );
    if (isCommentDuplicate) {
        community._cidsToUnPin.add(commentCid);
        throw new PKCError("ERR_DUPLICATE_COMMENT", { file, commentIpfs, commentPubsub });
    }

    const commentRow = <CommentsTableRow>{
        ...strippedOutCommentIpfs,
        cid: commentCid,
        postCid,
        authorSignerAddress,
        insertedAt: timestamp(),
        pendingApproval
    };

    const unknownProps = remeda
        .difference(remeda.keys.strict(commentPubsub), remeda.keys.strict(CommentPubsubMessagePublicationSchema.shape))
        .filter((key) => (key as string) !== "communityAddress"); // communityAddress is excluded because it's been converted to communityPublicKey/communityName above

    if (unknownProps.length > 0) {
        log("Found extra props on Comment", unknownProps, "Will be adding them to extraProps column");
        commentRow.extraProps = remeda.pick(commentPubsub, unknownProps);
    }
    if (originalCommentSignatureEncoded) commentRow.originalCommentSignatureEncoded = originalCommentSignatureEncoded;

    // we may need to query comment and verify its signature
    community._dbHandler.createTransaction();
    try {
        if (!pendingApproval) {
            const { number, postNumber } = community._dbHandler.getNextCommentNumbers(commentRow.depth);
            commentRow.number = number;
            if (typeof postNumber === "number") commentRow.postNumber = postNumber;
        }
        community._dbHandler.insertComments([commentRow]);
        if (typeof community.settings?.maxPendingApprovalCount === "number")
            community._dbHandler.removeOldestPendingCommentIfWeHitMaxPendingCount(community.settings.maxPendingApprovalCount);
        community._dbHandler.commitTransaction();
    } catch (e) {
        community._dbHandler.rollbackTransaction();
        throw e;
    }
    log("Inserted comment", commentRow.cid, "into db", "with props", commentRow);

    return { comment: commentIpfs, cid: commentCid };
}

export async function storePublication(
    community: LocalCommunity,
    request: DecryptedChallengeRequestMessageType,
    pendingApproval?: boolean
) {
    if (request.vote) return storeVote(community, request.vote, request.challengeRequestId);
    else if (request.commentEdit) {
        const commentEditWithAlias = await prepareCommentEditWithAlias(community, request.commentEdit);
        return storeCommentEdit(community, commentEditWithAlias, request.challengeRequestId);
    } else if (request.commentModeration) return storeCommentModeration(community, request.commentModeration, request.challengeRequestId);
    else if (request.comment) {
        const originalCommentSignatureEncoded = request.comment.signature.signature;
        const { publication, anonymity } = await prepareCommentWithAnonymity(community, request.comment);
        const storedComment = await storeComment(community, {
            commentPubsub: publication,
            pendingApproval,
            pseudonymityMode: anonymity?.mode,
            originalCommentSignatureEncoded: anonymity ? originalCommentSignatureEncoded : undefined
        });

        if (anonymity)
            community._dbHandler.insertPseudonymityAliases([
                {
                    commentCid: storedComment.cid,
                    aliasPrivateKey: anonymity.aliasPrivateKey,
                    originalAuthorPublicKey: anonymity.originalAuthorPublicKey,
                    originalAuthorName: getAuthorNameFromWire(anonymity.originalComment.author) || null,
                    mode: anonymity.mode,
                    insertedAt: timestamp()
                }
            ]);

        return storedComment;
    } else if (request.communityEdit) return storeCommunityEditPublication(community, request.communityEdit, request.challengeRequestId);
    else throw Error("Don't know how to store this publication" + request);
}

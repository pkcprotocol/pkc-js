import { clone, difference, keys, pick } from "remeda";
import type { Logger } from "@pkcprotocol/pkc-logger";
import { default as lodashDeepMerge } from "lodash.merge";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { calculateIpfsCidV0, getErrorCodeFromMessage, isStringDomain, retryKuboIpfsAddAndProvide, timestamp } from "../../../../util.js";
import { PKCError } from "../../../../pkc-error.js";
import { _validateSignatureOfPKCRecord, signComment, signCommentEdit, verifyCommentIpfs } from "../../../../signer/signatures.js";
import { getPKCAddressFromPublicKey } from "../../../../signer/util.js";
import { cleanWireAuthor, getAuthorNameFromWire } from "../../../../publications/publication-author.js";
import { deriveCommentIpfsFromCommentTableRow, getThumbnailPropsOfLink } from "../../util.js";
import {
    CommentEditPubsubMessagePublicationSchema,
    CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema
} from "../../../../publications/comment-edit/schema.js";
import { CommentIpfsSchema } from "../../../../publications/comment/schema.js";
import { CommentModerationPubsubMessagePublicationSchema } from "../../../../publications/comment-moderation/schema.js";
import { VotePubsubMessagePublicationSchema } from "../../../../publications/vote/schema.js";
import { addAllCidsUnderPurgedCommentToBeRemoved, rmUnneededMfsPaths } from "./cleanup.js";
import { matchPublicationAuthorAgainstRoles } from "./publication-validation.js";
import { authorIdentityMatcherForRequest, createAuthorIdentityMatcher } from "./author-identity.js";
import type { AuthorIdentityMatcher } from "./author-identity.js";
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
import type { ChallengeResultAggregate } from "../challenges/index.js";
import { communityIdentityPublicKey } from "./identity.js";

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

export async function prepareCommentWithAnonymity({
    community,
    originalComment,
    authorIdentityMatcher = createAuthorIdentityMatcher({ community, publication: originalComment })
}: {
    community: LocalCommunity;
    originalComment: CommentPubsubMessagePublication;
    authorIdentityMatcher?: AuthorIdentityMatcher;
}): Promise<{
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
    const modMatch = await matchPublicationAuthorAgainstRoles({
        community,
        rolesToCheckAgainst: ["owner", "admin", "moderator"],
        authorIdentityMatcher
    });
    if (modMatch.matched) return { publication: originalComment };
    // A mod whose role key is a domain the node could not verify would otherwise be pseudonymized silently:
    // no error, the wrong outcome, and irreversible once the comment is stored under an alias. Refuse the
    // publication instead, so the author can retry once the community's resolver is working. Issue #353.
    if (modMatch.nameFailure)
        throw new PKCError(getErrorCodeFromMessage(modMatch.nameFailure.reason), {
            comment: originalComment,
            // The only place a nameFailure escapes as a throw rather than a returned `messages` value, so it
            // is the only place the resolver's own error can be carried along instead of dropped.
            nameFailureError: modMatch.nameFailure.error
        });

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

    const anonymizedComment = clone(originalComment);

    if (sanitizedAuthor !== undefined) {
        anonymizedComment.author = sanitizedAuthor;
    } else {
        delete anonymizedComment.author;
    }
    anonymizedComment.signature = await signComment({
        comment: { ...anonymizedComment, signer: aliasSigner, communityAddress: community.address },
        pkc: community._pkc,
        log: community._log
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
    const commentEditSignedByAlias = clone(originalEdit);
    delete commentEditSignedByAlias.author;
    commentEditSignedByAlias.signature = await signCommentEdit({
        edit: { ...commentEditSignedByAlias, signer: aliasSigner, communityAddress: community.address },
        pkc: community._pkc,
        log: community._log
    });

    return commentEditSignedByAlias;
}

// Issue #387. The community verifies an incoming publication as sent, then stores a row and later
// rebuilds the record from that row for the pages and the CommentUpdate. Anything that changes the
// signed bytes in between (an author object that cleanWireAuthor empties, a string SQLite cannot keep
// verbatim, a future normalisation) is only discovered when the community verifies its own next record
// before publishing it, and from then on every publish cycle fails: the board stops publishing. Known
// cases are rejected at validation with their own reason; these two gates run before the insert so
// any case nobody has named yet rejects that one publication instead of freezing the board. They run
// exactly what the readers run: the row rebuilt the way the pages rebuild it, hashed and verified the
// way a page is verified. The gates await, so they read the row back from a savepoint that is rolled
// back rather than from inside the insert transaction: a transaction held open across an await is
// joined, and can be rolled back, by every other exchange on the shared connection (issue #417).
async function assertStoredCommentIsVerbatim(opts: {
    community: LocalCommunity;
    commentRow: CommentsTableRow;
    commentCid: string;
    log: Logger;
}): Promise<void> {
    const { community, commentRow, commentCid, log } = opts;
    const storedRow = community._dbHandler.readBackWithoutStoring({
        write: () => community._dbHandler.insertComments([commentRow]),
        read: () => community._dbHandler.queryComment(commentCid)
    });
    if (!storedRow) throw Error(`Comment ${commentCid} could not be read back from the DB after inserting it`);
    const storedComment = deriveCommentIpfsFromCommentTableRow(storedRow);
    const storedCid = await calculateIpfsCidV0(deterministicStringify(storedComment)!);
    const storedValidity = await verifyCommentIpfs({
        comment: storedComment,
        calculatedCommentCid: commentCid,
        resolveAuthorNames: false,
        clientsManager: community._clientsManager
    });
    if (storedCid === commentCid && storedValidity.valid) return;
    community._cidsToUnPin.add(commentCid);
    const error = new PKCError("ERR_COMMUNITY_CANNOT_STORE_PUBLICATION_VERBATIM", {
        cid: commentCid,
        storedCid,
        storedValidity,
        storedComment
    });
    log.error(`Rejecting comment ${commentCid}: its stored copy hashes to ${storedCid} and verifies as`, storedValidity, error);
    throw error;
}

async function assertStoredAuthorEditIsVerbatim(opts: {
    community: LocalCommunity;
    editTableRow: CommentEditsTableRow;
    commentEditRaw: CommentEditPubsubMessagePublication;
    authorSignerAddress: string;
    log: Logger;
}): Promise<void> {
    const { community, editTableRow, commentEditRaw, authorSignerAddress, log } = opts;
    const storedEdit = community._dbHandler.readBackWithoutStoring({
        write: () => community._dbHandler.insertCommentEdits([editTableRow]),
        read: () => community._dbHandler.queryLatestAuthorEdit(commentEditRaw.commentCid, authorSignerAddress)
    });
    if (!storedEdit || storedEdit.signature.signature !== commentEditRaw.signature.signature)
        throw Error(`Edit of comment ${commentEditRaw.commentCid} could not be read back from the DB after inserting it`);
    // what verifyCommentUpdate runs on commentUpdate.edit
    const storedValidity = await _validateSignatureOfPKCRecord(storedEdit);
    if (storedValidity.valid) return;
    const error = new PKCError("ERR_COMMUNITY_CANNOT_STORE_PUBLICATION_VERBATIM", {
        commentCid: commentEditRaw.commentCid,
        storedValidity,
        storedEdit
    });
    log.error(`Rejecting edit of comment ${commentEditRaw.commentCid}: its stored copy verifies as`, storedValidity, error);
    throw error;
}

export async function storeCommentEdit(
    community: LocalCommunity,
    commentEditRaw: CommentEditPubsubMessagePublication,
    challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
): Promise<undefined> {
    const log = community._log;
    const strippedOutEditPublication = CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema.strip().parse(commentEditRaw); // we strip out here so we don't store any extra props in commentedits table
    strippedOutEditPublication.author = cleanWireAuthor(strippedOutEditPublication.author); // strip runtime-only author fields (address, publicKey, etc.)

    // Normalize to new wire format: ensure communityPublicKey/communityName for DB columns
    if (!strippedOutEditPublication.communityPublicKey)
        strippedOutEditPublication.communityPublicKey = communityIdentityPublicKey(community);
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

    const extraPropsInEdit = difference(keys(commentEditRaw), keys(CommentEditPubsubMessagePublicationSchema.shape)).filter(
        (key) => (key as string) !== "communityAddress"
    ); // communityAddress is excluded because it's been converted to communityPublicKey/communityName above
    if (extraPropsInEdit.length > 0) {
        log("storeCommentEdit: Found extra props on CommentEdit", extraPropsInEdit, "Will be adding them to extraProps column");
        editTableRow.extraProps = pick(commentEditRaw, extraPropsInEdit);
    }

    const isEditDuplicate = community._dbHandler.hasCommentEditWithSignatureEncoded(editTableRow.signature.signature);
    if (isEditDuplicate) {
        throw new PKCError("ERR_DUPLICATE_COMMENT_EDIT", { editTableRow });
    }

    if (editSignedByOriginalAuthor)
        await assertStoredAuthorEditIsVerbatim({ community, editTableRow, commentEditRaw, authorSignerAddress, log });
    community._dbHandler.insertCommentEdits([editTableRow]);

    // If author is deleting a pending or disapproved comment, purge it immediately from the database
    if (commentEditRaw.deleted === true) {
        const isPending = commentToBeEdited.pendingApproval;
        const disapprovalResult = community._dbHandler._queryIsCommentApproved(commentToBeEdited);
        const isDisapproved = disapprovalResult && !disapprovalResult.approved;

        if (isPending || isDisapproved) {
            log("storeCommentEdit: Author deleted a pending/disapproved comment, purging immediately", commentEditRaw.commentCid);
            community._dbHandler.purgeComment(commentEditRaw.commentCid);
        }
    }
    // Wake the publish loop on every edit, not only the purge above: the loop's wake-up check never looks
    // at commentEdits, and queryCommentsToBeUpdated only runs after the sleep (issue #334).
    community._communityUpdateTrigger = true;
}

export async function storeCommentModeration(
    community: LocalCommunity,
    commentModRaw: CommentModerationPubsubMessagePublication,
    challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
): Promise<undefined> {
    const log = community._log;
    const strippedOutModPublication = CommentModerationPubsubMessagePublicationSchema.strip().parse(commentModRaw); // we strip out here so we don't store any extra props in commentedits table
    strippedOutModPublication.author = cleanWireAuthor(strippedOutModPublication.author); // strip runtime-only author fields (address, publicKey, etc.)

    // Normalize to new wire format: ensure communityPublicKey/communityName for DB columns
    if (!strippedOutModPublication.communityPublicKey) strippedOutModPublication.communityPublicKey = communityIdentityPublicKey(community);
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

    const extraPropsInMod = difference(keys(commentModRaw), keys(CommentModerationPubsubMessagePublicationSchema.shape)).filter(
        (key) => (key as string) !== "communityAddress"
    ); // communityAddress is excluded because it's been converted to communityPublicKey/communityName above
    if (extraPropsInMod.length > 0) {
        log("storeCommentModeration: Found extra props on CommentModeration", extraPropsInMod, "Will be adding them to extraProps column");
        modTableRow.extraProps = pick(commentModRaw, extraPropsInMod);
    }

    if (modTableRow.commentModeration.purged) {
        log(
            "storeCommentModeration: commentModeration.purged=true, and therefore will delete the post/comment and all its reply tree from the db as well as unpin the cids from ipfs",
            "comment cid is",
            modTableRow.commentCid
        );

        const commentToPurge = community._dbHandler.queryComment(modTableRow.commentCid);
        if (!commentToPurge) throw Error("Comment to purge not found");

        // Every DB-side effect of the purge happens synchronously, before the MFS cleanup below can
        // throw, and the purge commits together with its moderation row (issue #420). No await may
        // sit inside the transaction (issue #417).
        community._dbHandler.createTransaction();
        let purgedTableRows: ReturnType<typeof community._dbHandler.purgeComment>;
        try {
            purgedTableRows = community._dbHandler.purgeComment(modTableRow.commentCid);
            community._dbHandler.insertCommentModerations([modTableRow]);
            community._dbHandler.commitTransaction();
        } catch (e) {
            community._dbHandler.rollbackTransaction();
            throw e;
        }

        for (const purgedTableRow of purgedTableRows) addAllCidsUnderPurgedCommentToBeRemoved(community, purgedTableRow);
        if (community.updateCid) {
            // need to remove any update cids with reference to purged comment
            community._blocksToRm.push(community.updateCid);
            community._cidsToUnPin.add(community.updateCid);
        }
        community._communityUpdateTrigger = true;

        log(
            "storeCommentModeration: Purged comment",
            modTableRow.commentCid,
            "and its comment and comment update children",
            "out of DB and IPFS"
        );

        // Best-effort: the purge is already committed, so a kubo hiccup (e.g. MFS lock contention with
        // repo gc) must not report it as failed. The paths stay in _mfsPathsToRemove and the publish
        // cycle that _communityUpdateTrigger starts retries them before building the record. A single attempt keeps a real ERR_TIMED_OUT_RM_MFS_FILE from holding the
        // moderator's challenge verification for several minutes of retries.
        try {
            await rmUnneededMfsPaths(community, { numOfRetries: 0 });
        } catch (e) {
            log.error(
                "storeCommentModeration: Failed to remove MFS paths of purged comment",
                modTableRow.commentCid,
                "the sync loop will retry",
                e
            );
        }
        return;
    } else if ("approved" in modTableRow.commentModeration) {
        if (modTableRow.commentModeration.approved) {
            log(
                "storeCommentModeration: commentModeration.approved=true, and therefore move comment from pending approval and add it to IPFS",
                "comment cid is",
                modTableRow.commentCid
            );

            await community._addCommentRowToIPFS(commentToBeEdited, log);
            community._dbHandler.approvePendingComment({ cid: modTableRow.commentCid });
        } else {
            const shouldPurgeDisapprovedComment = Object.keys(modTableRow.commentModeration).length === 1; // no other props were included, if so purge the comment
            log(
                "storeCommentModeration: commentModeration.approved=false, and therefore this comment will be removed entirely from DB",
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
    log("storeCommentModeration: Inserted comment moderation", "of comment", modTableRow.commentCid, "into db", "with props", modTableRow);
}

export async function storeVote(
    community: LocalCommunity,
    newVoteProps: VotePubsubMessagePublication,
    challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
) {
    const log = community._log;

    const authorSignerAddress = await getPKCAddressFromPublicKey(newVoteProps.signature.publicKey);
    community._dbHandler.deleteVote(authorSignerAddress, newVoteProps.commentCid);
    const voteTableRow = <VotesTableRow>{
        ...pick(newVoteProps, ["vote", "commentCid", "protocolVersion", "timestamp"]),
        authorSignerAddress,
        insertedAt: timestamp()
    };
    const extraPropsInVote = difference(keys(newVoteProps), keys(VotePubsubMessagePublicationSchema.shape));
    if (extraPropsInVote.length > 0) {
        log("storeVote: Found extra props on Vote", extraPropsInVote, "Will be adding them to extraProps column");
        voteTableRow.extraProps = pick(newVoteProps, extraPropsInVote);
    }

    community._dbHandler.insertVotes([voteTableRow]);
    // Wake the publish loop now instead of at the next publishInterval tick. queryCommentsToBeUpdated
    // does flag the comment on a fresh vote, but it only runs inside the sync, after the loop's sleep,
    // and the sleep's own wake-up check never looks at votes (issue #226).
    community._communityUpdateTrigger = true;
    log("storeVote: Inserted vote", "of comment", voteTableRow.commentCid, "into db", "with props", voteTableRow);
    return undefined;
}

export async function storeCommunityEditPublication(
    community: LocalCommunity,
    editProps: CommunityEditPubsubMessagePublication,
    challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
) {
    const log = community._log;

    const authorSignerAddress = await getPKCAddressFromPublicKey(editProps.signature.publicKey);
    const authorIdentity = getAuthorNameFromWire(editProps.author) || authorSignerAddress;
    log(
        "storeCommunityEdit: Received community edit",
        editProps.communityEdit,
        "from author",
        authorIdentity,
        "with signer address",
        authorSignerAddress,
        "Will be using these props to edit the community props"
    );

    const propsAfterEdit = pick(community, keys(editProps.communityEdit));
    log("storeCommunityEdit: Current props from community edit (not edited yet)", propsAfterEdit);
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
        challengeAggregate?: ChallengeResultAggregate;
    }
): Promise<{ comment: CommentIpfsType; cid: CommentUpdateType["cid"] }> {
    const { commentPubsub, pendingApproval, pseudonymityMode, originalCommentSignatureEncoded, challengeAggregate } = opts;
    const log = community._log;

    // aggregatedComment is spread LAST: any key collision with author-signed keys is already blocked
    // by validateChallengeResultExtras, so this only ever adds NEW top-level keys (e.g. countryCode)
    // to the IPFS bytes. Author signature stays valid because no signed key is mutated.
    const commentIpfs = <CommentIpfsType>{
        ...commentPubsub,
        ...(await calculateLinkProps(community, commentPubsub.link)),
        ...(isPublicationPost(commentPubsub) && (await calculateLatestPostProps(community))),
        ...(isPublicationReply(commentPubsub) && (await calculateReplyProps(community, commentPubsub))),
        ...(pseudonymityMode ? { pseudonymityMode } : {}),
        ...(challengeAggregate?.aggregatedComment ?? {})
    };

    // Normalize to new wire format: ensure communityPublicKey/communityName, remove old communityAddress
    // The anchor on a delegated community, so stored content survives a minter rotation: labelling it
    // with signer.address would name a key that no longer publishes the community. See
    // docs/protocol/delegated-ipns.md.
    commentIpfs.communityPublicKey = communityIdentityPublicKey(community);
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

    // Diff against the literal that was actually hashed into commentCid (commentIpfs), not
    // commentPubsub. Any non-schema key that reached the CID-bound bytes — including
    // challengeAggregate.aggregatedComment extras spread on top of commentPubsub above — must
    // round-trip through extraProps so deriveCommentIpfsFromCommentTableRow can reconstruct the
    // original CID for page generation.
    const unknownProps = difference(keys(commentIpfs), keys(CommentIpfsSchema.shape)).filter(
        (key) => (key as string) !== "communityAddress"
    ); // communityAddress is excluded because it's been converted to communityPublicKey/communityName above

    if (unknownProps.length > 0) {
        log("storeComment: Found extra props on Comment", unknownProps, "Will be adding them to extraProps column");
        commentRow.extraProps = pick(commentIpfs, unknownProps);
    }
    if (challengeAggregate?.aggregatedCommentUpdate && Object.keys(challengeAggregate.aggregatedCommentUpdate).length > 0) {
        commentRow.challengeCommentUpdate = challengeAggregate.aggregatedCommentUpdate;
    }
    if (originalCommentSignatureEncoded) commentRow.originalCommentSignatureEncoded = originalCommentSignatureEncoded;

    await assertStoredCommentIsVerbatim({ community, commentRow, commentCid, log });
    // Synchronous from here to the commit, so no other exchange can write inside this transaction (issue #417)
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
    // An approved comment wakes the publish loop through the lastPostCid/lastCommentCid change in
    // calculateLatestUpdateTrigger, but those queries exclude pending rows, and the mod-queue check
    // only runs after the loop's sleep. Wake it here so the queue page is published now (issue #335).
    if (pendingApproval) community._communityUpdateTrigger = true;
    log("storeComment: Inserted comment", commentRow.cid, "into db", "with props", commentRow);

    return { comment: commentIpfs, cid: commentCid };
}

// The key of the alias a comment would share with the author's other comments, or undefined when it
// gets a fresh alias regardless (per-reply, a new per-post post) or is not pseudonymized at all.
function pseudonymityAliasLockKey(community: LocalCommunity, comment: CommentPubsubMessagePublication): string | undefined {
    const mode = community.features?.pseudonymityMode;
    const originalAuthorPublicKey = comment.signature.publicKey;
    if (mode === "per-author") return `per-author:${originalAuthorPublicKey}`;
    if (mode === "per-post" && comment.postCid) return `per-post:${originalAuthorPublicKey}:${comment.postCid}`;
    return undefined;
}

async function withPseudonymityAliasLock<T>(community: LocalCommunity, key: string | undefined, fn: () => Promise<T>): Promise<T> {
    if (!key) return fn();
    const previous = community._pseudonymityAliasLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const tail = previous.then(() => current);
    community._pseudonymityAliasLocks.set(key, tail);
    // previous never rejects: every tail resolves once its store releases, whether the store succeeded or threw
    await previous;
    try {
        return await fn();
    } finally {
        release();
        // Only remove our own entry: a later store under the same key has already chained onto it
        if (community._pseudonymityAliasLocks.get(key) === tail) community._pseudonymityAliasLocks.delete(key);
    }
}

export async function storePublication({
    community,
    request,
    pendingApproval,
    challengeAggregate,
    // Shared across the challenge request when the caller has one, so the author's domain resolves once.
    // See issues #353 and #354.
    authorIdentityMatcher
}: {
    community: LocalCommunity;
    request: DecryptedChallengeRequestMessageType;
    pendingApproval?: boolean;
    challengeAggregate?: ChallengeResultAggregate;
    authorIdentityMatcher?: AuthorIdentityMatcher;
}) {
    if (request.vote) return storeVote(community, request.vote, request.challengeRequestId);
    else if (request.commentEdit) {
        const commentEditWithAlias = await prepareCommentEditWithAlias(community, request.commentEdit);
        return storeCommentEdit(community, commentEditWithAlias, request.challengeRequestId);
    } else if (request.commentModeration) return storeCommentModeration(community, request.commentModeration, request.challengeRequestId);
    else if (request.comment) {
        const originalComment = request.comment;
        const originalCommentSignatureEncoded = originalComment.signature.signature;
        // The alias lookup in prepareCommentWithAnonymity and the alias insert below are separated by
        // storeComment's awaits, so the whole span runs under the alias key's lock (issue #399).
        return withPseudonymityAliasLock(community, pseudonymityAliasLockKey(community, originalComment), async () => {
            const { publication, anonymity } = await prepareCommentWithAnonymity({
                community,
                originalComment,
                authorIdentityMatcher: authorIdentityMatcher ?? authorIdentityMatcherForRequest({ community, request })
            });
            const storedComment = await storeComment(community, {
                commentPubsub: publication,
                pendingApproval,
                pseudonymityMode: anonymity?.mode,
                originalCommentSignatureEncoded: anonymity ? originalCommentSignatureEncoded : undefined,
                challengeAggregate
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
        });
    } else if (request.communityEdit) return storeCommunityEditPublication(community, request.communityEdit, request.challengeRequestId);
    else throw Error("Don't know how to store this publication" + request);
}

import retry, { RetryOperation } from "retry";
import {
    createAbortError,
    deepMergeRuntimeFields,
    hideClassPrivateProps,
    isAbortError,
    retryKuboIpfsAdd,
    shortifyCid
} from "../../util.js";
import Publication from "../publication.js";
import { getCommunityAddressFromRecord } from "../publication-community.js";
import type { DecryptedChallengeVerification } from "../../pubsub-messages/types.js";
import type { AuthorWithOptionalCommentUpdateJson, PublicationTypeName } from "../../types.js";

import type { RepliesPagesTypeIpfs } from "../../pages/types.js";
import Logger from "../../logger.js";
import { Plebbit } from "../../plebbit/plebbit.js";
import { signComment, verifyCommentIpfs, verifyCommentPubsubMessage, verifyCommentUpdate } from "../../signer/signatures.js";
import assert from "assert";
import { FailedToFetchCommentIpfsFromGatewaysError, PlebbitError } from "../../plebbit-error.js";
import * as remeda from "remeda";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";

import type {
    CommentIpfsType,
    CommentIpfsWithCidPostCidDefined,
    CommentPubsubMessagePublication,
    CommentRawField,
    CommentRpcErrorToTransmit,
    CommentState,
    CommentUpdateForChallengeVerification,
    CommentUpdateType,
    CommentUpdatingState,
    CommentWithinRepliesPostsPageJson,
    CommentOptionsToSign,
    CreateCommentOptions,
    RpcCommentResultType,
    RpcCommentUpdateResultType
} from "./types.js";
import { RepliesPages } from "../../pages/pages.js";
import { findCommentInPageInstanceRecursively, parseRawPages } from "../../pages/util.js";
import { CommentIpfsSchema, CommentUpdateForChallengeVerificationSchema, CommentUpdateSchema } from "./schema.js";
import {
    parseRpcCommentEventWithPlebbitErrorIfItFails,
    parseRpcCommentUpdateEventWithPlebbitErrorIfItFails
} from "../../schema/schema-util.js";
import type { SignerType } from "../../signer/types.js";
import type { CreatePublicationOptions } from "../../types.js";
import { CommentClientsManager } from "./comment-client-manager.js";
import type { SubplebbitIpfsType } from "../../subplebbit/types.js";
import { CID } from "kubo-rpc-client";
import type { PublicationEventArgs, PublicationEvents } from "../types.js";
import { getAuthorDomainFromRuntime } from "../publication-author.js";
import { sha256 } from "js-sha256";
import {
    findStartedSubplebbit,
    findUpdatingComment,
    findUpdatingSubplebbit,
    listStartedSubplebbits,
    listUpdatingComments,
    listUpdatingSubplebbits,
    refreshTrackedCommentAliases,
    trackUpdatingComment,
    untrackUpdatingComment
} from "../../plebbit/tracked-instance-registry-util.js";

export class Comment
    extends Publication
    implements
        Partial<CommentUpdateForChallengeVerification>,
        CommentPubsubMessagePublication,
        Partial<CommentIpfsWithCidPostCidDefined>,
        Partial<Omit<CommentUpdateType, "replies">>
{
    // Only Comment props
    shortCid?: CommentWithinRepliesPostsPageJson["shortCid"];

    override clients!: CommentClientsManager["clients"];
    override author!: AuthorWithOptionalCommentUpdateJson;
    // public (CommentType)
    title?: CommentPubsubMessagePublication["title"];
    link?: CommentPubsubMessagePublication["link"];
    linkWidth?: CommentPubsubMessagePublication["linkWidth"];
    linkHeight?: CommentPubsubMessagePublication["linkHeight"];
    thumbnailUrl?: CommentIpfsType["thumbnailUrl"];
    thumbnailUrlWidth?: CommentIpfsType["thumbnailUrlWidth"];
    thumbnailUrlHeight?: CommentIpfsType["thumbnailUrlHeight"];
    cid?: CommentIpfsWithCidPostCidDefined["cid"];
    parentCid?: CommentIpfsType["parentCid"];
    quotedCids?: CommentPubsubMessagePublication["quotedCids"];
    content?: CommentPubsubMessagePublication["content"];
    // Props that get defined after challengeverification
    previousCid?: CommentIpfsType["previousCid"];
    depth?: CommentIpfsType["depth"];
    postCid?: CommentIpfsType["postCid"];
    pseudonymityMode?: CommentIpfsType["pseudonymityMode"];
    linkHtmlTagName?: CommentPubsubMessagePublication["linkHtmlTagName"];

    // CommentEdit and CommentUpdate props
    upvoteCount?: CommentUpdateType["upvoteCount"];
    downvoteCount?: CommentUpdateType["downvoteCount"];
    replyCount?: CommentUpdateType["replyCount"];
    childCount?: CommentUpdateType["childCount"];
    updatedAt?: CommentUpdateType["updatedAt"];
    replies!: RepliesPages;
    edit?: CommentUpdateType["edit"];
    flairs?: CommentPubsubMessagePublication["flairs"];
    deleted?: CommentWithinRepliesPostsPageJson["deleted"];
    spoiler?: CommentIpfsType["spoiler"];
    nsfw?: CommentIpfsType["nsfw"];
    pinned?: CommentUpdateType["pinned"];
    locked?: CommentUpdateType["locked"];
    archived?: CommentUpdateType["archived"];
    removed?: CommentUpdateType["removed"];
    reason?: CommentUpdateType["reason"];
    lastChildCid?: CommentUpdateType["lastChildCid"];
    lastReplyTimestamp?: CommentUpdateType["lastReplyTimestamp"];
    pendingApproval?: CommentUpdateForChallengeVerification["pendingApproval"];
    approved?: CommentUpdateType["approved"];
    number?: CommentUpdateType["number"];
    postNumber?: CommentUpdateType["postNumber"];

    override signature!: CommentPubsubMessagePublication["signature"];
    // updating states
    override state!: CommentState;
    private _updatingState!: CommentUpdatingState;

    // private
    override raw: CommentRawField = {};
    _commentUpdateIpfsPath?: string = undefined; // its IPFS path derived from subplebbit.postUpdates.
    _invalidCommentUpdateMfsPaths: Set<string> = new Set<string>();
    private _commentIpfsloadingOperation?: RetryOperation = undefined;
    override _clientsManager!: CommentClientsManager;
    private _updateRpcSubscriptionId?: number = undefined;
    private _stopAbortController?: AbortController = undefined;
    override challengeRequest?: CreateCommentOptions["challengeRequest"];

    private _communityForUpdating?: CommentClientsManager["_communityForUpdating"];

    private _postForUpdating?: CommentClientsManager["_postForUpdating"];

    _numOfListenersForUpdatingInstance = 0;

    _updatingCommentInstance?: { comment: Comment } & Pick<PublicationEvents, "error" | "updatingstatechange" | "update" | "statechange"> =
        undefined; // the comment instance we're mirroing
    constructor(plebbit: Plebbit) {
        super(plebbit);
        this._setUpdatingStateWithEmissionIfNewState("stopped");
        // these functions might get separated from their `this` when used
        this.publish = this.publish.bind(this);
        this.update = this.update.bind(this);
        this.stop = this.stop.bind(this);

        this.replies = new RepliesPages({
            pages: {},
            pageCids: {},
            plebbit: this._plebbit,
            subplebbit: { address: this.communityAddress },
            parentComment: this
        });

        hideClassPrivateProps(this);
    }

    override _initClients() {
        this._clientsManager = new CommentClientsManager(this);
        this.clients = this._clientsManager.clients;
    }

    _createStopAbortController() {
        if (!this._stopAbortController || this._stopAbortController.signal.aborted) this._stopAbortController = new AbortController();
        return this._stopAbortController;
    }

    _getStopAbortSignal() {
        return this._stopAbortController?.signal;
    }

    _isStopAbortRequested() {
        return Boolean(this._stopAbortController?.signal.aborted);
    }

    _abortStopOperations(reason: string) {
        if (!this._stopAbortController || this._stopAbortController.signal.aborted) return;
        this._stopAbortController.abort(createAbortError(reason));
    }

    _clearStopAbortController() {
        this._stopAbortController = undefined;
    }

    override _initUnsignedLocalProps<
        T extends {
            signer: SignerType;
            communityAddress: string;
            timestamp: number;
            protocolVersion: string;
            author?: Record<string, unknown>;
        }
    >(opts: { unsignedOptions: T; challengeRequest?: CreatePublicationOptions["challengeRequest"] }) {
        super._initUnsignedLocalProps(opts);
        const o = opts.unsignedOptions as unknown as CommentOptionsToSign;
        this.title = o.title;
        this.content = o.content;
        this.parentCid = o.parentCid;
        this.link = o.link;
        this.linkWidth = o.linkWidth;
        this.linkHeight = o.linkHeight;
        this.linkHtmlTagName = o.linkHtmlTagName;
        this.spoiler = o.spoiler;
        this.nsfw = o.nsfw;
        this.flairs = o.flairs;
        this.quotedCids = o.quotedCids;
    }

    _initLocalProps(props: {
        comment: CommentPubsubMessagePublication;
        signer?: SignerType;
        challengeRequest?: CreateCommentOptions["challengeRequest"];
    }) {
        this._initPubsubMessageProps(props.comment);
        this.challengeRequest = props.challengeRequest;
        this.signer = props.signer;
    }

    protected override async _signPublicationOptionsToPublish(
        cleanedPublication: unknown
    ): Promise<CommentPubsubMessagePublication["signature"]> {
        return signComment({ comment: cleanedPublication as CommentOptionsToSign, plebbit: this._plebbit });
    }

    _initPubsubMessageProps(props: CommentPubsubMessagePublication) {
        this.raw.pubsubMessageToPublish = props;
        this._initProps(props);
    }

    _initIpfsProps(props: CommentIpfsType) {
        const log = Logger("pkc-js:comment:_initIpfsProps");
        // we're loading remote CommentIpfs
        this.raw.comment = props;
        this._initProps(props);

        const unknownProps = remeda.difference(remeda.keys.strict(props), remeda.keys.strict(CommentIpfsSchema.shape));
        if (unknownProps.length > 0) {
            log("Found unknown props on loaded CommentIpfs", unknownProps, "Will set them on the Comment instance");
            Object.assign(this, remeda.pick(props, unknownProps));
        }
        this._setAuthorNameResolvedFromCache();
    }

    private _setAuthorNameResolvedFromCache() {
        const domain = getAuthorDomainFromRuntime(this.author);
        if (!domain) return; // no domain → nameResolved stays undefined
        const cached = this._plebbit._memCaches.nameResolvedCache.get(sha256(domain + this.signature.publicKey));
        if (typeof cached === "boolean") this.author.nameResolved = cached;
    }

    private _copyNameResolvedFromComment(sourceComment?: Pick<Comment, "author">) {
        if (typeof sourceComment?.author?.nameResolved === "boolean") this.author.nameResolved = sourceComment.author.nameResolved;
    }

    _resolveAuthorNamesInBackground() {
        if (!this._plebbit.resolveAuthorNames) return;

        // Collect comment's own author if nameResolved is not yet set
        const domain = getAuthorDomainFromRuntime(this.author);
        const ownAuthor =
            domain && typeof this.author.nameResolved !== "boolean"
                ? [{ authorName: domain, signaturePublicKey: this.signature.publicKey }]
                : [];

        // Collect page comment authors from replies that still need resolution
        const replyAuthors: Array<{ authorName: string; signaturePublicKey: string }> = [];
        if (this.replies?.pages) {
            for (const page of Object.values(this.replies.pages)) {
                if (!page) continue;
                for (const comment of page.comments) {
                    const commentDomain = getAuthorDomainFromRuntime(comment.author);
                    if (commentDomain && typeof comment.author.nameResolved !== "boolean") {
                        replyAuthors.push({ authorName: commentDomain, signaturePublicKey: comment.signature.publicKey });
                    }
                }
            }
        }

        if (ownAuthor.length === 0 && replyAuthors.length === 0) return;

        const previousNameResolved = this.author.nameResolved;
        const onResolved = () => {
            this._setAuthorNameResolvedFromCache();
            if (this.replies?.pages) {
                for (const page of Object.values(this.replies.pages)) {
                    if (page) this.replies._applyNameResolvedCacheToPage(page);
                }
            }
            // Only emit update if this comment's own author.nameResolved changed
            if (this.author.nameResolved !== previousNameResolved) {
                this.emit("update", this);
            }
        };
        const abortSignal = this._getStopAbortSignal();

        // Resolve comment's own author through this._clientsManager (triggers state changes on the comment)
        if (ownAuthor.length > 0) {
            this._clientsManager.resolveAuthorNamesInBackground({ authors: ownAuthor, onResolved, abortSignal });
        }
        // Resolve reply page authors through plebbit-level manager (no state changes on this comment)
        if (replyAuthors.length > 0) {
            this._plebbit._clientsManager.resolveAuthorNamesInBackground({ authors: replyAuthors, onResolved, abortSignal });
        }
    }

    _initProps(props: CommentIpfsType | CommentPubsubMessagePublication) {
        // Initializing CommentPubsubMessage
        super._initBaseRemoteProps(props);
        this.content = props.content;
        this.flairs = props.flairs;
        this.link = props.link;
        this.linkHeight = props.linkHeight;
        this.linkWidth = props.linkWidth;
        this.parentCid = props.parentCid;
        this.spoiler = props.spoiler;
        this.nsfw = props.nsfw;
        this.title = props.title;
        this.linkHtmlTagName = props.linkHtmlTagName;
        this.quotedCids = props.quotedCids;
        // Initializing Comment Ipfs props
        if ("depth" in props && typeof props.depth === "number") {
            this.depth = props.depth;
            const postCid = props.postCid ? props.postCid : this.cid && this.depth === 0 ? this.cid : undefined;
            if (!postCid) throw Error("There is no way to set comment.postCid");
            this.postCid = postCid;
            this.previousCid = props.previousCid;
            this.thumbnailUrl = props.thumbnailUrl;
            this.thumbnailUrlHeight = props.thumbnailUrlHeight;
            this.thumbnailUrlWidth = props.thumbnailUrlWidth;
            this.pseudonymityMode = props.pseudonymityMode;
        }
    }

    _initCommentUpdate(props: CommentUpdateType | CommentWithinRepliesPostsPageJson, subplebbit?: Pick<SubplebbitIpfsType, "signature">) {
        const log = Logger("pkc-js:comment:_initCommentUpdate");
        if ("depth" in props) {
            // CommentWithinPageJson — no extra setup needed
        } else {
            // CommentUpdate
            this.raw.commentUpdate = props;

            const unknownProps = remeda.difference(remeda.keys.strict(props), remeda.keys.strict(CommentUpdateSchema.shape));
            if (unknownProps.length > 0) {
                log("Found unknown props on CommentUpdate record", unknownProps, "Will set them on Comment instance");
                Object.assign(this, remeda.pick(props, unknownProps));
            }
        }

        this.upvoteCount = props.upvoteCount;
        this.downvoteCount = props.downvoteCount;
        this.replyCount = props.replyCount;
        this.childCount = props.childCount;
        this.updatedAt = props.updatedAt;
        this.deleted = props.edit?.deleted;
        this.pinned = props.pinned;
        this.locked = props.locked;
        this.archived = props.archived;
        this.removed = props.removed;
        this.reason = props.reason;
        this.edit = props.edit;
        this.protocolVersion = props.protocolVersion;

        // Merge props from original comment and CommentUpdate
        this.spoiler =
            typeof props.spoiler === "boolean"
                ? props.spoiler
                : typeof props.edit?.spoiler === "boolean"
                  ? props.edit?.spoiler
                  : this.spoiler;

        this.nsfw = typeof props.nsfw === "boolean" ? props.nsfw : typeof props.edit?.nsfw === "boolean" ? props.edit?.nsfw : this.nsfw;
        if (props.author) Object.assign(this.author, props.author);
        if (props.edit?.content) this.content = props.edit.content;
        // TODO flairs merging strategy will likely change — currently first-defined wins (mod > author edit > existing)
        this.flairs = props.flairs || props.edit?.flairs || this.flairs;
        this.author.flairs = props.author?.subplebbit?.flairs || props.edit?.author?.flairs || this.author?.flairs;
        this.lastChildCid = props.lastChildCid;
        this.lastReplyTimestamp = props.lastReplyTimestamp;

        this._updateRepliesPostsInstance(props.replies, subplebbit);
        if (typeof this.pendingApproval === "boolean" || "pendingApproval" in props)
            this.pendingApproval = Boolean("pendingApproval" in props && props.pendingApproval); // revert pendingApproval if we just received a CommentUpdate
        else if ("approved" in props && typeof props.approved === "boolean") {
            this.pendingApproval = false; // we received either a rejection or acceptance
        }
        this.approved = props.approved;
        this.number = props.number;
        this.postNumber = props.postNumber;
        this._setAuthorNameResolvedFromCache();
    }

    _updateRepliesPostsInstance(
        newReplies: CommentUpdateType["replies"] | CommentWithinRepliesPostsPageJson["replies"] | Pick<RepliesPagesTypeIpfs, "pageCids">,
        subplebbit?: Pick<SubplebbitIpfsType, "signature">
    ) {
        assert(this.cid, "Can't update comment.replies without comment.cid being defined");
        const log = Logger("pkc-js:comment:_updateRepliesPostsInstanceIfNeeded");
        const subplebbitSignature = subplebbit?.signature || this.replies._subplebbit.signature;
        const repliesCreationTimestamp = this.updatedAt;
        if (typeof repliesCreationTimestamp !== "number") throw Error("comment.updatedAt should be defined when updating replies");

        this.replies._subplebbit.signature = subplebbitSignature;
        const repliesSubplebbit = { address: this.communityAddress, signature: subplebbitSignature };
        if (!newReplies) {
            this.replies.resetPages();
        } else if (!("pages" in newReplies) && newReplies.pageCids) {
            // only pageCids is provided
            this.replies.updateProps({
                subplebbit: repliesSubplebbit,
                pageCids: newReplies.pageCids,
                pages: {}
            });
        } else if (!newReplies.pageCids && "pages" in newReplies && newReplies.pages) {
            // only pages is provided
            this.replies.updateProps({
                ...parseRawPages(newReplies),
                subplebbit: this.replies._subplebbit,
                pageCids: {}
            });
        } else if ("pages" in newReplies && newReplies.pages && "pageCids" in newReplies && newReplies.pageCids) {
            // both pageCids and pages are provided
            const shouldUpdateReplies = !remeda.isDeepEqual(this.replies.pageCids, newReplies.pageCids);

            if (shouldUpdateReplies) {
                log.trace(`Updating the props of comment instance (${this.cid}) replies`);
                const parsedPages = <Pick<RepliesPages, "pages"> & { pagesIpfs: RepliesPagesTypeIpfs | undefined }>(
                    parseRawPages(newReplies)
                );
                this.replies.updateProps({
                    ...parsedPages,
                    subplebbit: repliesSubplebbit,
                    pageCids: newReplies.pageCids
                });
            }
        }
    }

    private async _verifyChallengeVerificationCommentProps(
        decryptedVerification: DecryptedChallengeVerification
    ): Promise<PlebbitError | undefined> {
        const log = Logger("pkc-js:comment:publish:_verifyChallengeVerificationCommentProps");

        if (!this.raw.pubsubMessageToPublish) throw Error("comment._pubsubMsgToPublish should be defined at this point");
        // verify that the sub did not change any props that we published
        const keysToCompare = remeda.keys.strict(remeda.omit(this.raw.pubsubMessageToPublish, ["signature", "author"])); // we're omitting these two because that would fail because of anonymity features in subplebbit
        const pubsubMsgFromCommentIpfs = remeda.pick(decryptedVerification.comment, keysToCompare);
        const pubsubMsgFromPublishedPubsubMsg = remeda.pick(this.raw.pubsubMessageToPublish, keysToCompare);

        if (!remeda.isDeepEqual(pubsubMsgFromCommentIpfs, pubsubMsgFromPublishedPubsubMsg)) {
            const error = new PlebbitError("ERR_SUB_CHANGED_COMMENT_PUBSUB_PUBLICATION_PROPS", {
                pubsubMsgFromSub: pubsubMsgFromCommentIpfs,
                originalPubsubMsg: this.raw.pubsubMessageToPublish
            });
            log.error(error);
            this.emit("error", error);
            return error;
        }

        const calculatedCid = await calculateIpfsHash(JSON.stringify(decryptedVerification.comment));

        const postCid = decryptedVerification.comment.postCid || (decryptedVerification.comment.depth === 0 ? calculatedCid : undefined);

        if (!postCid) {
            throw Error(
                "Unable to calculate postCid after receiving challengeVerification for comment. This is either a critical error in plebbit-js or the sub did not include postCid in replies"
            );
        }

        const commentIpfsValidity = await verifyCommentIpfs({
            comment: decryptedVerification.comment,
            resolveAuthorNames: this._plebbit.resolveAuthorNames,
            clientsManager: this._clientsManager,
            calculatedCommentCid: calculatedCid
        });
        if (!commentIpfsValidity.valid) {
            const error = new PlebbitError("ERR_SUB_SENT_CHALLENGE_VERIFICATION_WITH_INVALID_COMMENT", {
                reason: commentIpfsValidity.reason,
                decryptedChallengeVerification: decryptedVerification
            });
            log.error(error);
            this.emit("error", error);
            return error;
        }
        const commentUpdateValidity = await verifyCommentUpdate({
            update: decryptedVerification.commentUpdate,
            clientsManager: this._clientsManager,
            comment: { ...decryptedVerification.comment, cid: calculatedCid, postCid },
            subplebbit: this._community!,
            resolveAuthorNames: this._plebbit.resolveAuthorNames,
            validateUpdateSignature: true,
            validatePages: true
        });
        if (!commentUpdateValidity.valid) {
            const error = new PlebbitError("ERR_SUB_SENT_CHALLENGE_VERIFICATION_WITH_INVALID_COMMENTUPDATE", {
                reason: commentUpdateValidity.reason,
                decryptedChallengeVerification: decryptedVerification
            });
            log.error(error);
            this.emit("error", error);
            return error;
        }

        if (calculatedCid !== decryptedVerification.commentUpdate.cid) {
            const error = new PlebbitError("ERR_SUB_SENT_CHALLENGE_VERIFICATION_WITH_INVALID_CID", {
                cidSentBySub: decryptedVerification.commentUpdate.cid,
                calculatedCid,
                decryptedChallengeVerification: decryptedVerification
            });
            log.error(error);
            this.emit("error", error);
            return error;
        }
    }

    private async _addOwnCommentToIpfsIfConnectedToIpfsClient(decryptedVerification: DecryptedChallengeVerification) {
        // Will add and pin our own comment to IPFS
        // only if we're connected to kubo or helia/libp2p

        const log = Logger("pkc-js:comment:publish:_addOwnCommentToIpfsIfConnectedToIpfsClient");
        if (!this.raw.comment) throw Error("comment.raw.commentIpfs should be defined after challenge verification");
        if (Object.keys(this._plebbit.clients.kuboRpcClients).length === 0) {
            log("No kubo rpc client found, will not add newly published comment", this.cid, "to ipfs");
            return;
        }
        if (decryptedVerification.commentUpdate.pendingApproval) {
            log("comment is pending approval, we're not gonna add it to IPFS node for now", this.cid);
            return;
        }
        if (decryptedVerification.comment.signature.publicKey !== this.raw.pubsubMessageToPublish?.signature?.publicKey) {
            log(
                "We received a CommentIpfs whose publicKey is different than the one we published. We're gonna assume it's annoymized and skip adding to IPFS"
            );
            return;
        }
        const kuboRpcClient = this._clientsManager.getDefaultKuboRpcClient();
        // use p-retry here, 3 times maybe?
        const addRes = await retryKuboIpfsAdd({
            ipfsClient: kuboRpcClient._client,
            log: Logger("pkc-js:comment:publish:_addOwnCommentToIpfsIfConnectedToIpfsClient"),
            content: JSON.stringify(this.raw.comment),
            options: { pin: true }
        });

        if (!addRes.cid.equals(CID.parse(decryptedVerification.commentUpdate.cid)))
            throw new PlebbitError("ERR_ADDED_COMMENT_IPFS_TO_IPFS_BUT_GOT_DIFFERENT_CID", {
                addedCidToIpfs: addRes.cid,
                expectedCidString: decryptedVerification.commentUpdate.cid,
                expectedCid: CID.parse(decryptedVerification.commentUpdate.cid)
            });
        else log("Added the file of comment ipfs", this.cid, "to IPFS network successfully");
    }

    _initCommentUpdateFromChallengeVerificationProps(commentUpdate: CommentUpdateForChallengeVerification) {
        this.raw.commentUpdateFromChallengeVerification = commentUpdate;
        if (commentUpdate.author) Object.assign(this.author, commentUpdate.author);
        this.protocolVersion = commentUpdate.protocolVersion;
        if ("pendingApproval" in commentUpdate) this.pendingApproval = commentUpdate.pendingApproval;
        else this.pendingApproval = false;
        this.number = commentUpdate.number;
        this.postNumber = commentUpdate.postNumber;
    }

    private async _updateCommentPropsFromDecryptedChallengeVerification(decryptedVerification: DecryptedChallengeVerification) {
        const log = Logger("pkc-js:comment:publish:_updateCommentPropsFromDecryptedChallengeVerification");

        this.setCid(decryptedVerification.commentUpdate.cid);
        this._initIpfsProps(decryptedVerification.comment);
        this._initCommentUpdateFromChallengeVerificationProps(decryptedVerification.commentUpdate);

        // handle extra props here
        const unknownProps = remeda.difference(
            remeda.keys.strict(decryptedVerification.commentUpdate),
            remeda.keys.strict(CommentUpdateForChallengeVerificationSchema.shape)
        );
        if (unknownProps.length > 0) {
            log("Found unknown props on decryptedVerification.commentUpdate record", unknownProps, "Will set them on Comment instance");
            Object.assign(this, remeda.pick(decryptedVerification.commentUpdate, unknownProps));
        }
        this.emit("update", this);
        this._resolveAuthorNamesInBackground();
    }

    protected override async _verifyDecryptedChallengeVerificationAndUpdateCommentProps(
        decryptedVerification: DecryptedChallengeVerification
    ) {
        // We're gonna update Comment instance with DecryptedChallengeVerification.{comment, commentUpdate}
        const log = Logger("pkc-js:comment:publish:_verifyDecryptedChallengeVerificationAndUpdateCommentProps");
        log(
            "Received update props from subplebbit after succcessful challenge exchange. Will attempt to validate if not connected to RPC",
            decryptedVerification
        );

        if (!this._plebbit._plebbitRpcClient) {
            // no need to validate if RPC
            const errorInVerificationProps = await this._verifyChallengeVerificationCommentProps(decryptedVerification);
            if (errorInVerificationProps) return;
        }

        await this._updateCommentPropsFromDecryptedChallengeVerification(decryptedVerification);

        // Add the comment to IPFS network in the background
        if (Object.keys(this._plebbit.clients.kuboRpcClients).length > 0 || Object.keys(this._plebbit.clients.libp2pJsClients).length > 0)
            this._addOwnCommentToIpfsIfConnectedToIpfsClient(decryptedVerification).catch((err) =>
                log.error(`Failed to add the file of comment ipfs`, this.cid, "to ipfs network due to error", err)
            );
    }

    override getType(): PublicationTypeName {
        return "comment";
    }

    setCid(newCid: string) {
        this.cid = newCid;
        this.shortCid = shortifyCid(this.cid);
        refreshTrackedCommentAliases(this._plebbit, this);
    }

    override setCommunityAddress(newCommunityAddress: string) {
        super.setCommunityAddress(newCommunityAddress);
        this.replies._subplebbit.address = newCommunityAddress;
    }

    private _isCommentIpfsErrorRetriable(err: PlebbitError | Error): boolean {
        if (!(err instanceof PlebbitError)) return false; // If it's not a recognizable error, then we throw to notify the user
        if (
            err.code === "ERR_COMMENT_IPFS_SIGNATURE_IS_INVALID" ||
            err.code === "ERR_INVALID_COMMENT_IPFS_SCHEMA" ||
            err.code === "ERR_CALCULATED_CID_DOES_NOT_MATCH" ||
            err.code === "ERR_OVER_DOWNLOAD_LIMIT" ||
            err.code === "ERR_INVALID_JSON" ||
            err.code === "ERR_COMMENT_IPFS_COMMUNITY_ADDRESS_MISMATCH"
        )
            return false; // These errors means there's a problem with the record itself, not the loading

        if (err instanceof FailedToFetchCommentIpfsFromGatewaysError) {
            // If all gateway errors are due to the ipfs record itself, then it's a non-retriable error
            for (const gatewayError of Object.values(err.details.gatewayToError))
                if (this._isCommentIpfsErrorRetriable(gatewayError)) return true; // if there's at least one gateway whose error is not due to the record
            return false; // if all gateways have issues with the record validity itself, then we stop fetching
        }

        return true;
    }

    private async _retryLoadingCommentIpfs(cid: string, log: Logger): Promise<CommentIpfsType | PlebbitError | Error> {
        return new Promise((resolve) => {
            this._commentIpfsloadingOperation!.attempt(async (curAttempt) => {
                if (this.raw.comment) return resolve(this.raw.comment);
                log.trace(`Retrying to load comment ipfs (${this.cid}) for the ${curAttempt}th time`);
                try {
                    const commentInPage = this._clientsManager._findCommentInPagesOfUpdatingCommentsOrSubplebbit();
                    if (commentInPage) {
                        resolve(commentInPage.comment);
                    } else {
                        this._setUpdatingStateWithEmissionIfNewState("fetching-ipfs");
                        const res = await this._clientsManager.fetchAndVerifyCommentCid(cid);
                        resolve(res);
                    }
                } catch (e) {
                    const error = <PlebbitError | Error>e;
                    if (error.name === "AbortError") return resolve(error);
                    if (error instanceof PlebbitError && error.details)
                        error.details = { ...error.details, commentCid: this.cid, retryCount: curAttempt };
                    if (this._isCommentIpfsErrorRetriable(<PlebbitError>error)) {
                        log.error(`Error on loading comment ipfs (${this.cid}) for the ${curAttempt}th time`, error);

                        this._changeCommentStateEmitEventEmitStateChangeEvent({
                            newUpdatingState: "waiting-retry",
                            event: { name: "error", args: [error] }
                        });

                        if (curAttempt === 1 && this.communityAddress) {
                            log("Failed the first time in loading comment", this.cid, "will try to load from subplebbit pages");
                            // if we fail for second time, start trying to find CommentIpfs using pages instead of comment.cid
                            await this._clientsManager._fetchCommentIpfsFromPages();
                        }

                        this._commentIpfsloadingOperation!.retry(<Error>e);
                    } else {
                        // a non retriable error
                        return resolve(<PlebbitError>e);
                    }
                }
            });
        });
    }

    async _attemptToFetchCommentIpfsIfNeeded(log: Logger) {
        if (this.cid && !this.raw.comment) {
            // User may have attempted to call plebbit.createComment({cid}).update
            const newCommentIpfsOrNonRetriableError = await this._retryLoadingCommentIpfs(this.cid, log); // Will keep retrying to load until comment.stop() is called

            if (newCommentIpfsOrNonRetriableError instanceof Error) {
                if (isAbortError(newCommentIpfsOrNonRetriableError) && (this.state === "stopped" || this._isStopAbortRequested())) return;
                // This is a non-retriable error, it should stop the comment from updating
                log.error(
                    `Encountered a non retriable error while loading CommentIpfs (${this.cid}), will stop the update loop`,
                    newCommentIpfsOrNonRetriableError
                );
                // We can't proceed with an invalid CommentIpfs, so we're stopping the update loop and emitting an error event for the user
                await this._stopUpdateLoop();
                this._changeCommentStateEmitEventEmitStateChangeEvent({
                    newUpdatingState: "failed",
                    newState: "stopped",
                    event: { name: "error", args: [newCommentIpfsOrNonRetriableError] }
                });
                return;
            } else {
                log(`Loaded the CommentIpfs props of cid (${this.cid}) correctly, updating the instance props`);
                this._initIpfsProps(newCommentIpfsOrNonRetriableError);
                this._changeCommentStateEmitEventEmitStateChangeEvent({
                    newUpdatingState: "succeeded",
                    event: { name: "update", args: [this] }
                });
                this._resolveAuthorNamesInBackground();
            }
        }
    }

    async _attemptInfintelyToLoadCommentIpfs() {
        const log = Logger("pkc-js:comment:update:attemptInfintelyToLoadCommentIpfs");

        this._commentIpfsloadingOperation = retry.operation({ forever: true, factor: 2 });
        await this._attemptToFetchCommentIpfsIfNeeded(log);
        await this._commentIpfsloadingOperation.stop();
    }

    async startCommentUpdateSubplebbitSubscription() {
        const log = Logger("pkc-js:comment:update:startCommentUpdateSubplebbitSubscription");
        if (this.state === "stopped") return; // we may have called stop() before reaching comment update subscription and after loading commentipfs
        if (this.depth === 0) {
            if (!this._communityForUpdating)
                this._communityForUpdating = await this._clientsManager._createSubInstanceWithStateTranslation();

            if (this.state !== "updating") return; // there are cases where stop() is called in parallel
            if (this._communityForUpdating.subplebbit.state === "stopped") {
                await this._communityForUpdating!.subplebbit.update(); // BUG: calling this resets this._communityForUpdating to undefined
            }
            if (this.state !== "updating") return; // there are cases where stop() is called in parallel
            if (this._communityForUpdating.subplebbit.raw.subplebbitIpfs)
                await this._communityForUpdating.update(this._communityForUpdating.subplebbit);
        } else {
            if (!this._postForUpdating) this._postForUpdating = await this._clientsManager._createPostInstanceWithStateTranslation();
            if (this.state !== "updating") return; // there are cases where stop() is called in parallel
            if (this._postForUpdating!.comment.state === "stopped") {
                await this._postForUpdating!.comment.update();
            }
            if (this.state !== "updating") return; // there are cases where stop() is called in parallel
            if (this._postForUpdating!.comment.raw.commentUpdate) await this._postForUpdating!.update(this._postForUpdating!.comment);
        }
    }

    async loadCommentIpfsAndStartCommentUpdateSubscription() {
        const log = Logger("pkc-js:update:loadCommentIpfsAndStartCommentUpdateSubscription");
        this._createStopAbortController();
        await this._attemptInfintelyToLoadCommentIpfs();
        if (!this.raw.comment) {
            if (this.state === "stopped" || this._isStopAbortRequested()) return;
            throw Error("Failed to load comment ipfs, user needs to check error event");
        }
        try {
            await this.startCommentUpdateSubplebbitSubscription(); // can only proceed if commentIpfs has been loaded successfully
        } catch (e) {
            if (isAbortError(e) && (this.state === "stopped" || this._isStopAbortRequested())) return;
            log.error("Failed to start comment update subscription to subplebbit", e);
        }
    }

    _setUpdatingStateNoEmission(newState: Comment["updatingState"]) {
        if (newState === this._updatingState) return;
        this._updatingState = newState;
    }

    get updatingState(): Comment["_updatingState"] {
        if (this._updatingCommentInstance) {
            const mirroredComment = this._updatingCommentInstance.comment;
            if (mirroredComment === this) return this._updatingState; // prevent self-mirroring recursion
            return mirroredComment.updatingState;
        }
        return this._updatingState;
    }

    _changeCommentStateEmitEventEmitStateChangeEvent<T extends keyof Omit<PublicationEvents, "statechange" | "updatingstatechange">>(opts: {
        event: { name: T; args: PublicationEventArgs<T> };
        newUpdatingState?: Comment["updatingState"];
        newState?: Comment["state"];
    }) {
        // this code block is only called on a comment whose update loop is already started
        // never called in a comment that's mirroring a comment with an update loop
        const shouldEmitStateChange = opts.newState && opts.newState !== this.state;
        const shouldEmitUpdatingStateChange = opts.newUpdatingState && opts.newUpdatingState !== this._updatingState;
        if (opts.newState) this._setStateNoEmission(opts.newState);
        if (opts.newUpdatingState) this._setUpdatingStateNoEmission(opts.newUpdatingState);

        this.emit(opts.event.name, ...opts.event.args);

        if (shouldEmitStateChange) this.emit("statechange", this.state);
        if (shouldEmitUpdatingStateChange) this.emit("updatingstatechange", this.updatingState);
    }

    _setUpdatingStateWithEmissionIfNewState(newState: Comment["updatingState"]) {
        if (newState === this._updatingState) return;
        this._updatingState = newState;
        this.emit("updatingstatechange", this._updatingState);
    }
    protected override _setRpcClientState(newState: Comment["clients"]["plebbitRpcClients"][""]["state"]) {
        const currentRpcUrl = remeda.keys.strict(this.clients.plebbitRpcClients)[0];
        if (newState === this.clients.plebbitRpcClients[currentRpcUrl].state) return;
        this.clients.plebbitRpcClients[currentRpcUrl].state = newState;
        this.clients.plebbitRpcClients[currentRpcUrl].emit("statechange", newState);
    }

    protected _updateRpcClientStateFromUpdatingState(updatingState: Comment["updatingState"]) {
        // We're deriving the the rpc state from publishing state

        const mapper: Record<Comment["updatingState"], Comment["clients"]["plebbitRpcClients"][number]["state"]> = {
            failed: "stopped",
            succeeded: "stopped",
            "fetching-ipfs": "fetching-ipfs",
            "waiting-retry": "stopped",
            "fetching-subplebbit-ipfs": "fetching-subplebbit-ipfs",
            "fetching-subplebbit-ipns": "fetching-subplebbit-ipns",
            "fetching-update-ipfs": "fetching-update-ipfs",
            "resolving-author-name": "resolving-author-name",
            "resolving-community-name": "resolving-community-name",
            stopped: "stopped"
        };

        const rpcState = mapper[updatingState] || updatingState; // in case rpc server transmits unknown prop, just use it as is

        this._setRpcClientState(rpcState);
    }

    private _isRetriableLoadingError(err: Error | PlebbitError) {
        // Critical Errors for now are:
        // Invalid signature of CommentIpfs
        // CommentUpdate will always be retried when a new sub update is loaded
        if (this.raw.comment)
            return true; // if we already loaded CommentIpfs, we should always retry loading CommentUpdate
        else return this._isCommentIpfsErrorRetriable(err);
    }

    private _handleCommentEventFromRpc(args: any) {
        const log = Logger("pkc-js:comment:_handleCommentEventFromRpc");
        let parsed: RpcCommentResultType;
        try {
            parsed = parseRpcCommentEventWithPlebbitErrorIfItFails(args.params.result);
        } catch (e) {
            log.error("Failed to parse the rpc comment event of", this.cid, e);
            this.emit("error", <PlebbitError>e);
            throw e;
        }
        log(`Received new CommentIpfs (${this.cid}) from RPC`);
        this._initIpfsProps(parsed.comment);
        if (parsed.runtimeFields) deepMergeRuntimeFields(this, parsed.runtimeFields);

        this.emit("update", this);
    }

    private _handleUpdateEventFromRpc(args: any) {
        const log = Logger("pkc-js:comment:_handleUpdateEventFromRpc");
        let parsed: RpcCommentUpdateResultType;
        try {
            parsed = parseRpcCommentUpdateEventWithPlebbitErrorIfItFails(args.params.result) as RpcCommentUpdateResultType;
        } catch (e) {
            log.error("Failed to parse the rpc update event of", this.cid, e);
            this.emit("error", <PlebbitError>e);
            throw e;
        }
        const newUpdate = parsed.commentUpdate;
        if ((this.updatedAt || 0) <= newUpdate.updatedAt) {
            log(`Received new CommentUpdate (${this.cid}) from RPC`);
            this._initCommentUpdate(newUpdate);
            if (parsed.runtimeFields) {
                this.raw.runtimeFieldsFromRpc = parsed.runtimeFields;
                deepMergeRuntimeFields(this, parsed.runtimeFields);
            }

            this.emit("update", this);
            this._resolveAuthorNamesInBackground();
        }
    }

    private _handleUpdatingStateChangeFromRpc(args: any) {
        const updateState: Comment["updatingState"] = args.params.result.state; // optimistic, rpc server could transmit an updating state that is not known to us
        this._setUpdatingStateWithEmissionIfNewState(updateState);
        this._updateRpcClientStateFromUpdatingState(updateState);
    }

    private _handleStateChangeFromRpc(args: any) {
        const commentState: Comment["state"] = args.params.result.state;
        this._setStateWithEmission(commentState);
    }

    private async _handleErrorEventFromRpc(args: any) {
        const log = Logger("pkc-js:comment:update:_handleErrorEventFromRpc");
        const err = <CommentRpcErrorToTransmit>args.params.result;
        log("Received 'error' event from RPC", err);
        if (err.details?.newUpdatingState) this._setUpdatingStateNoEmission(err.details.newUpdatingState);
        if (!this._isRetriableLoadingError(err)) {
            log.error("The RPC transmitted a non retriable error", "for comment", this.cid, "will clean up the subscription", err);
            this._changeCommentStateEmitEventEmitStateChangeEvent({
                newUpdatingState: "failed",
                newState: "stopped",
                event: { name: "error", args: [err] }
            });
            await this._stopUpdateLoop();
        } else this.emit("error", err);
    }

    private async _updateViaRpc() {
        const log = Logger("pkc-js:comment:update:_updateViaRpc");

        const rpcUrl = this._plebbit.plebbitRpcClientsOptions![0];
        if (!rpcUrl) throw Error("Failed to get rpc url");
        if (!this.cid) throw Error("Can't start updating comment without defining this.cid");
        try {
            this._updateRpcSubscriptionId = await this._plebbit._plebbitRpcClient!.commentUpdateSubscribe({
                cid: this.cid,
                raw: this.raw,
                communityAddress: this.communityAddress,
                parentCid: this.parentCid,
                postCid: this.postCid
            });
        } catch (e) {
            log.error("Failed to receive commentUpdate from RPC due to error", e);
            await this._stopUpdateLoop();
            this._setStateWithEmission("stopped");
            this._setUpdatingStateWithEmissionIfNewState("failed");
            throw e;
        }
        this._setStateWithEmission("updating");

        this._plebbit
            ._plebbitRpcClient!.getSubscription(this._updateRpcSubscriptionId)
            .on("update", this._handleUpdateEventFromRpc.bind(this))
            .on("comment", this._handleCommentEventFromRpc.bind(this))
            .on("updatingstatechange", this._handleUpdatingStateChangeFromRpc.bind(this))
            .on("statechange", this._handleStateChangeFromRpc.bind(this))
            .on("error", this._handleErrorEventFromRpc.bind(this));

        this._plebbit._plebbitRpcClient!.emitAllPendingMessages(this._updateRpcSubscriptionId);
    }

    _useUpdatePropsFromUpdatingStartedSubplebbitIfPossible() {
        if (!this.cid) throw Error("Need to have comment.cid defined");
        if (!this.communityAddress) {
            // try to find cid in all _updatingSubplebbits
            for (const updatingSubplebbit of [...listUpdatingSubplebbits(this._plebbit), ...listStartedSubplebbits(this._plebbit)]) {
                const commentInSubplebbitPosts = findCommentInPageInstanceRecursively(updatingSubplebbit.posts, this.cid);
                if (commentInSubplebbitPosts) {
                    const addr = getCommunityAddressFromRecord(commentInSubplebbitPosts.comment as unknown as Record<string, unknown>);
                    if (addr) this.setCommunityAddress(addr);
                    break;
                }
            }
            if (!this.communityAddress) return;
        }
        const updatingSubplebbitInstance =
            findUpdatingSubplebbit(this._plebbit, { address: this.communityAddress }) ||
            this._communityForUpdating?.subplebbit ||
            findStartedSubplebbit(this._plebbit, { address: this.communityAddress });
        if (updatingSubplebbitInstance?.raw?.subplebbitIpfs && this.cid) {
            const commentInSubplebbitPosts = findCommentInPageInstanceRecursively(updatingSubplebbitInstance.posts, this.cid);
            if (commentInSubplebbitPosts) {
                if (!this.raw.comment) {
                    this._initIpfsProps(commentInSubplebbitPosts.comment);
                    this.emit("update", this);
                    // Don't call _resolveAuthorNamesInBackground() here — this runs during createComment()
                    // before the stop abort controller exists. Resolution is handled by the update loop.
                }
                if ((this.updatedAt || 0) < commentInSubplebbitPosts.commentUpdate.updatedAt) {
                    this._initCommentUpdate(commentInSubplebbitPosts.commentUpdate, updatingSubplebbitInstance.raw.subplebbitIpfs);
                    this.emit("update", this);
                }
            }
        }
    }

    _useUpdatePropsFromUpdatingCommentIfPossible() {
        if (!this.cid) throw Error("should have cid at this point");
        const updatingCommentInstance = findUpdatingComment(this._plebbit, { cid: this.cid }) || this._updatingCommentInstance?.comment;
        if (updatingCommentInstance) {
            // TODO maybe we should just copy props with Object.assign? not sure
            if (!this.raw.comment && updatingCommentInstance.raw.comment) {
                this._initIpfsProps(updatingCommentInstance.raw.comment);
                this._copyNameResolvedFromComment(updatingCommentInstance);
                this.emit("update", this);
                // Don't call _resolveAuthorNamesInBackground() here — the updating instance already handles resolution.
                // This mirroring comment copies results via _copyNameResolvedFromComment.
            }
            if (updatingCommentInstance.raw.commentUpdate && (this.updatedAt || 0) < updatingCommentInstance.raw.commentUpdate.updatedAt) {
                this._initCommentUpdate(
                    updatingCommentInstance.raw.commentUpdate,
                    updatingCommentInstance._communityForUpdating?.subplebbit?.raw.subplebbitIpfs
                );
                this._commentUpdateIpfsPath = updatingCommentInstance._commentUpdateIpfsPath;
                this._copyNameResolvedFromComment(updatingCommentInstance);
                if (updatingCommentInstance.raw.runtimeFieldsFromRpc)
                    deepMergeRuntimeFields(this, updatingCommentInstance.raw.runtimeFieldsFromRpc);
                this.emit("update", this);
            }
            // Propagate nameResolved changes even when neither CommentIpfs nor CommentUpdate
            // triggered a copy — background resolution can complete between those events
            if (this.raw.comment) {
                const prevNameResolved = this.author.nameResolved;
                this._copyNameResolvedFromComment(updatingCommentInstance);
                if (this.author.nameResolved !== prevNameResolved) {
                    this.emit("update", this);
                }
            }
        } else {
            const ancestorAndUpdatingCids = [
                this.postCid,
                this.parentCid,
                ...listUpdatingComments(this._plebbit).map((comment) => comment.cid)
            ];
            for (const ancestorCid of ancestorAndUpdatingCids) {
                if (!ancestorCid) continue;
                const updatingCommentInstanceOfAncestor = findUpdatingComment(this._plebbit, { cid: ancestorCid });
                if (updatingCommentInstanceOfAncestor) {
                    const commentInAncestor = findCommentInPageInstanceRecursively(updatingCommentInstanceOfAncestor.replies, this.cid!);
                    if (commentInAncestor) {
                        if (!this.raw.comment) {
                            this._initIpfsProps(commentInAncestor.comment);
                            this.emit("update", this);
                        }
                        if ((this.updatedAt || 0) < commentInAncestor.commentUpdate.updatedAt) {
                            this._initCommentUpdate(
                                commentInAncestor.commentUpdate,
                                findUpdatingSubplebbit(this._plebbit, { address: this.communityAddress })?.raw?.subplebbitIpfs
                            );
                            this.emit("update", this);
                        }
                        break; // if we found it once we won't be finding it in other comments
                    }
                }
            }
        }
    }

    _useUpdatingCommentFromPlebbit(updatingCommentInstance: Comment) {
        if (updatingCommentInstance === this) return; // don't mirror to itself; prevents recursive events
        this._updatingCommentInstance = {
            comment: updatingCommentInstance,
            statechange: async (newState) => {
                if (newState === "stopped" && this.state === "updating")
                    // plebbit._updatingComments[this.cid].stop() has been called
                    await this.stop();
            },
            update: () => this._useUpdatePropsFromUpdatingCommentIfPossible(),
            updatingstatechange: (newState) => this.emit("updatingstatechange", newState),
            error: async (err) => {
                if (!this._isRetriableLoadingError(err)) {
                    this._changeCommentStateEmitEventEmitStateChangeEvent({
                        newUpdatingState: "failed",
                        newState: "stopped",
                        event: { name: "error", args: [err] }
                    });
                    await this._stopUpdateLoop();
                } else this.emit("error", err);
            }
        };

        updatingCommentInstance.on("update", this._updatingCommentInstance.update);
        updatingCommentInstance.on("error", this._updatingCommentInstance.error);
        updatingCommentInstance.on("updatingstatechange", this._updatingCommentInstance.updatingstatechange);
        updatingCommentInstance.on("statechange", this._updatingCommentInstance.statechange);

        const clientKeys = remeda.keys.strict(this.clients);
        for (const clientType of clientKeys)
            if (this.clients[clientType])
                for (const clientUrl of Object.keys(this.clients[clientType]))
                    this.clients[clientType][clientUrl].mirror(updatingCommentInstance.clients[clientType][clientUrl]);
        updatingCommentInstance._numOfListenersForUpdatingInstance++;
        this._useUpdatePropsFromUpdatingCommentIfPossible();
    }

    async _setUpNewUpdatingCommentInstance() {
        // create a new plebbit._updatingComments[this.cid]
        const log = Logger("pkc-js:comment:update:_setUpNewUpdatingCommentInstance");

        const updatingCommentInstance = await this._plebbit.createComment(this);

        trackUpdatingComment(this._plebbit, updatingCommentInstance);

        this._useUpdatingCommentFromPlebbit(updatingCommentInstance);
        updatingCommentInstance._setStateWithEmission("updating");

        if (this._plebbit._plebbitRpcClient) {
            await updatingCommentInstance._updateViaRpc();
        } else {
            updatingCommentInstance
                .loadCommentIpfsAndStartCommentUpdateSubscription()
                .catch((e) => log.error("Failed to update comment", e));
        }
    }

    async update() {
        const log = Logger("pkc-js:comment:update");
        if (this.state === "updating") return; // Do nothing if it's already updating

        if (!this.cid) throw Error("Can't call comment.update() without defining cid");
        this._setStateWithEmission("updating");

        const existingUpdatingComment = findUpdatingComment(this._plebbit, { cid: this.cid });
        if (existingUpdatingComment) {
            if (existingUpdatingComment === this) {
                // This instance is already tracked; start the update loop without mirroring to itself
                if (this._plebbit._plebbitRpcClient) {
                    await this._updateViaRpc();
                } else {
                    this.loadCommentIpfsAndStartCommentUpdateSubscription().catch((e) => log.error("Failed to update comment", e));
                }
            } else this._useUpdatingCommentFromPlebbit(existingUpdatingComment); // this comment instance will be mirroring this._plebbit._updatingComments[this.cid]
        } else await this._setUpNewUpdatingCommentInstance(); // Create a this._plebbit._updatingComments[this.cid], then mirror it

        if (this.raw.comment || this.raw.commentUpdate) this.emit("update", this);
    }

    private async _stopUpdateLoop() {
        const log = Logger("pkc-js:comment:update:_stopUpdateLoop");
        if (!this.cid) return;
        this._commentIpfsloadingOperation?.stop();
        if (this._updateRpcSubscriptionId) {
            try {
                await this._plebbit._plebbitRpcClient!.unsubscribe(this._updateRpcSubscriptionId);
            } catch (e) {
                log.error("Failed to unsubscribe from commentUpdate", e);
            }
            this._updateRpcSubscriptionId = undefined;
            this._setRpcClientState("stopped");
            untrackUpdatingComment(this._plebbit, this);
        }

        // what if it didn't have enough time to set up _communityForUpdating and _postForUpdating? These are defined after loading CommentIpfs

        if (
            !this._postForUpdating &&
            !this._communityForUpdating &&
            !this._updatingCommentInstance &&
            findUpdatingComment(this._plebbit, { cid: this.cid }) === this
        ) {
            // comment.stop got called before updating subplebbit or post instance was created
            untrackUpdatingComment(this._plebbit, this);
        }
        // clean up _communityForUpdating subscriptions
        if (this._communityForUpdating) {
            // this post instance is plebbit._updatingComments[cid] and it's updating

            await this._clientsManager.cleanUpUpdatingSubInstance();
            this._communityForUpdating = undefined;
            untrackUpdatingComment(this._plebbit, this);
            this._invalidCommentUpdateMfsPaths.clear();
        }

        if (this._postForUpdating) {
            // this reply instance is subscribed to an updating post
            await this._clientsManager.cleanUpUpdatingPostInstance();
            this._postForUpdating = undefined;
            untrackUpdatingComment(this._plebbit, this);
        }

        if (this._updatingCommentInstance) {
            // this post|reply instance is subscribed to plebbit._updatingComments[cid]

            this._updatingState = this._updatingCommentInstance.comment.updatingState; // need to capture the last updating state before stopping
            this._updatingCommentInstance.comment.removeListener("statechange", this._updatingCommentInstance.statechange);
            this._updatingCommentInstance.comment.removeListener("updatingstatechange", this._updatingCommentInstance.updatingstatechange);
            this._updatingCommentInstance.comment.removeListener("update", this._updatingCommentInstance.update);
            this._updatingCommentInstance.comment.removeListener("error", this._updatingCommentInstance.error);

            const clientKeys = remeda.keys.strict(this.clients);

            for (const clientType of clientKeys)
                if (this.clients[clientType])
                    for (const clientUrl of Object.keys(this.clients[clientType])) this.clients[clientType][clientUrl].unmirror();

            this._updatingCommentInstance.comment._numOfListenersForUpdatingInstance--;
            if (
                this._updatingCommentInstance.comment._numOfListenersForUpdatingInstance === 0 &&
                this._updatingCommentInstance.comment.state !== "stopped"
            ) {
                log("Cleaning up plebbit._updatingComments", this.cid, "There are no comments using it for updates");
                await this._updatingCommentInstance.comment.stop();
            } else if (
                this._updatingCommentInstance.comment._numOfListenersForUpdatingInstance === 0 &&
                this._updatingCommentInstance.comment.state === "stopped" &&
                findUpdatingComment(this._plebbit, { cid: this.cid }) === this._updatingCommentInstance.comment
            ) {
                // No listeners left and the updating comment is already stopped; remove the stale entry
                untrackUpdatingComment(this._plebbit, this._updatingCommentInstance.comment);
            }
            this._updatingCommentInstance = undefined;
        }
        this._clearStopAbortController();
    }

    override async stop() {
        this._abortStopOperations(
            `Aborting comment operations for ${this.cid || this.author?.address || "comment"} because comment.stop() was called`
        );
        if (this.state === "publishing") await super.stop();
        this._setStateWithEmission("stopped");
        await this._stopUpdateLoop();
        this.replies._stop();
        this._setUpdatingStateWithEmissionIfNewState("stopped");
    }

    protected override async _validateSignatureHook() {
        const stopAbortController = this._createStopAbortController();
        const commentObj = JSON.parse(JSON.stringify(this.raw.pubsubMessageToPublish!)); // Stringify so it resembles messages from pubsub
        try {
            const signatureValidity = await verifyCommentPubsubMessage({
                comment: commentObj,
                resolveAuthorNames: this._plebbit.resolveAuthorNames,
                clientsManager: this._clientsManager,
                abortSignal: stopAbortController.signal
            });
            if (!signatureValidity.valid) throw new PlebbitError("ERR_SIGNATURE_IS_INVALID", { signatureValidity });
        } finally {
            if (this.state !== "updating") this._clearStopAbortController();
        }
    }
}

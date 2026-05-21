import Logger from "../../../logger.js";
import { PKC } from "../../../pkc/pkc.js";
import type {
    Challenge,
    CreateNewLocalCommunityParsedOptions,
    InternalCommunityRecordBeforeFirstUpdateType,
    InternalCommunityRecordAfterFirstUpdateType,
    ParsedCommunityEditOptions,
    CommunityChallengeSetting,
    CommunityEditOptions,
    CommunityIpfsType,
    RpcInternalCommunityRecordBeforeFirstUpdateType,
    RpcInternalCommunityRecordAfterFirstUpdateType,
    CommunityUpdatingState,
    CommunityState,
    CommunityRoleNameUnion,
    CommunityEvents,
    Flair
} from "../../../community/types.js";
import { LRUCache } from "lru-cache";
import { PageGenerator } from "./page-generator.js";
import { DbHandler } from "./db-handler.js";
import { deriveDbReplies, deriveDbPosts, resolveDbPostsCidRefs } from "../util.js";
import type { PseudonymityAliasRow, PurgedCommentTableRows } from "./db-handler-types.js";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import {
    derivePublicationFromChallengeRequest,
    doesDomainAddressHaveCapitalLetter,
    genToArray,
    hideClassPrivateProps,
    ipnsNameToIpnsOverPubsubTopic,
    isLinkOfMedia,
    isLinkOfImage,
    isLinkOfVideo,
    isLinkOfAnimatedImage,
    isLinkValid,
    isStringDomain,
    pubsubTopicToDhtKey,
    timestamp,
    getErrorCodeFromMessage,
    removeMfsFilesSafely,
    removeBlocksFromKuboNode,
    writeKuboFilesWithTimeout,
    retryKuboIpfsAddAndProvide,
    retryKuboBlockPutPinAndProvidePubsubTopic,
    calculateIpfsCidV0,
    calculateStringSizeSameAsIpfsAddCidV0,
    getIpnsRecordInLocalKuboNode,
    contentContainsMarkdownImages,
    contentContainsMarkdownVideos,
    isLinkOfAudio,
    contentContainsMarkdownAudio,
    areEquivalentCommunityAddresses
} from "../../../util.js";
import { STORAGE_KEYS } from "../../../constants.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { PKCError } from "../../../pkc-error.js";

import type {
    ChallengeAnswerMessageType,
    ChallengeMessageType,
    ChallengeRequestMessageType,
    ChallengeVerificationMessageType,
    DecryptedChallenge,
    DecryptedChallengeAnswerMessageType,
    DecryptedChallengeRequest,
    DecryptedChallengeRequestMessageType,
    DecryptedChallengeVerificationMessageType,
    DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
    PublicationWithCommunityAuthorFromDecryptedChallengeRequest,
    PublicationFromDecryptedChallengeRequest,
    DecryptedChallengeVerification,
    DecryptedChallengeAnswer
} from "../../../pubsub-messages/types.js";

import type { IpfsHttpClientPubsubMessage } from "../../../types.js";
import {
    ValidationResult,
    cleanUpBeforePublishing,
    signChallengeMessage,
    signChallengeVerification,
    signComment,
    signCommentEdit,
    signCommentUpdate,
    signCommentUpdateForChallengeVerification,
    signCommunity,
    verifyChallengeAnswer,
    verifyChallengeRequest,
    verifyCommentEdit,
    verifyCommentModeration,
    verifyCommentUpdate,
    verifyCommunityEdit
} from "../../../signer/signatures.js";
import {
    calculateExpectedSignatureSize,
    calculateInlineRepliesBudget,
    deriveCommentIpfsFromCommentTableRow,
    getThumbnailPropsOfLink,
    importSignerIntoKuboNode,
    moveCommunityDbToDeletedDirectory
} from "../util.js";
import {
    SignerWithPublicKeyAddress,
    decryptEd25519AesGcmPublicKeyBuffer,
    verifyCommentIpfs,
    verifyCommentPubsubMessage,
    verifyCommunity,
    verifyVote
} from "../../../signer/index.js";
import { encryptEd25519AesGcmPublicKeyBuffer } from "../../../signer/encryption.js";
import { messages } from "../../../errors.js";
import { GetChallengeAnswers, getChallengeVerification, getCommunityChallengeFromCommunityChallengeSettings } from "./challenges/index.js";
import * as cborg from "cborg";
import env from "../../../version.js";
import { getIpfsKeyFromPrivateKey, getPKCAddressFromPublicKey, getPublicKeyFromPrivateKey } from "../../../signer/util.js";
import { RpcLocalCommunity } from "../../../community/rpc-local-community.js";
import * as remeda from "remeda";
import { buildRuntimeAuthor, cleanWireAuthor, getAuthorNameFromWire } from "../../../publications/publication-author.js";
import { getCommunityPublicKeyFromWire, getCommunityNameFromWire } from "../../../publications/publication-community.js";

import type {
    CommentEditOptionsToSign,
    CommentEditPubsubMessagePublication,
    CommentEditsTableRow
} from "../../../publications/comment-edit/types.js";
import {
    CommentEditPubsubMessagePublicationSchema,
    CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema,
    CommentEditReservedFields
} from "../../../publications/comment-edit/schema.js";
import type { VotePubsubMessagePublication, VotesTableRow } from "../../../publications/vote/types.js";
import type {
    CommentIpfsType,
    CommentOptionsToSign,
    CommentPubsubMessagePublication,
    CommentPubsubMessagPublicationSignature,
    CommentsTableRow,
    CommentUpdatesTableRowInsert,
    CommentUpdateType,
    DbRepliesFormat,
    DbRepliesSortEntry,
    DbPostsFormat,
    PostPubsubMessageWithCommunityAuthor,
    ReplyPubsubMessageWithCommunityAuthor
} from "../../../publications/comment/types.js";
import { CommunityIpfsSchema, CommunitySignedPropertyNames } from "../../../community/schema.js";
import {
    ChallengeAnswerMessageSchema,
    ChallengeMessageSchema,
    ChallengeRequestMessageSchema,
    ChallengeVerificationMessageSchema,
    DecryptedChallengeRequestPublicationSchema,
    DecryptedChallengeRequestSchema
} from "../../../pubsub-messages/schema.js";
import {
    parseDecryptedChallengeAnswerWithPKCErrorIfItFails,
    parseJsonWithPKCErrorIfFails,
    parseCommunityEditOptionsSchemaWithPKCErrorIfItFails,
    parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails
} from "../../../schema/schema-util.js";
import {
    CommentIpfsSchema,
    CommentPubsubMessageReservedFields,
    CommentPubsubMessagePublicationSchema
} from "../../../publications/comment/schema.js";
import { VotePubsubMessagePublicationSchema, VotePubsubReservedFields } from "../../../publications/vote/schema.js";
import { v4 as uuidV4 } from "uuid";
import { AuthorReservedFields } from "../../../schema/schema.js";
import {
    CommentModerationPubsubMessagePublicationSchema,
    CommentModerationReservedFields
} from "../../../publications/comment-moderation/schema.js";
import type {
    CommentModerationPubsubMessagePublication,
    CommentModerationTableRow
} from "../../../publications/comment-moderation/types.js";
import { CommunityEditPublicationPubsubReservedFields } from "../../../publications/community-edit/schema.js";
import type { CommunityEditPubsubMessagePublication } from "../../../publications/community-edit/types.js";
import { default as lodashDeepMerge } from "lodash.merge"; // Importing only the `merge` function
import { MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS } from "../../../community/community-client-manager.js";
import { RemoteCommunity } from "../../../community/remote-community.js";
import pLimit from "p-limit";
import { sha256 } from "js-sha256";
import { iterateOverPageCidsToFindAllCids } from "../../../pages/util.js";
import {
    findStartedCommunity,
    findCommunityInRegistry,
    findUpdatingCommunity,
    syncCommunityRegistryEntry,
    trackStartedCommunity,
    trackUpdatingCommunity,
    untrackStartedCommunity,
    untrackUpdatingCommunity
} from "../../../pkc/tracked-instance-registry-util.js";
import { processStartedCommunities } from "./local-community/registry.js";
import { AllPageCids } from "../../../pages/types.js";
import {
    CommentUpdateToWriteToDbAndPublishToIpfs,
    DUPLICATE_PUBLICATION_ERRORS,
    generateDefaultChallenges,
    isDefaultChallengeStructure
} from "./local-community/defaults.js";
import { listenToIncomingRequests, providePubsubTopicRoutingCidsIfNeeded } from "./local-community/pubsub.js";
import {
    addAllCidsUnderPurgedCommentToBeRemoved,
    cleanUpIpfsRepoRarely,
    purgeDisapprovedCommentsOlderThan,
    repinCommentUpdateIfNeeded,
    repinCommentsIPFSIfNeeded,
    rmUnneededMfsPaths,
    unpinStaleCids
} from "./local-community/cleanup.js";
import {
    adjustPostUpdatesBucketsIfNeeded,
    pubsubTopicWithfallback,
    syncPostUpdatesWithIpfs,
    updateCommentsThatNeedToBeUpdated
} from "./local-community/comment-updates.js";
import {
    edit as editCommunity,
    editPropsOnNotStartedCommunity,
    editPropsOnStartedCommunity,
    movePostUpdatesFolderToNewAddress,
    parseChallengesToEdit,
    parseRolesToEdit,
    validateNewAddressBeforeEditing
} from "./local-community/editing.js";
import {
    createNewLocalCommunityDb,
    getDbInternalState,
    importCommunitySignerIntoIpfsIfNeeded,
    initDbHandlerIfNeeded,
    initInternalCommunityAfterFirstUpdateNoMerge,
    initInternalCommunityBeforeFirstUpdateNoMerge,
    initNewLocalCommunityPropsNoMerge,
    initSignerProps,
    setChallengesToDefaultIfNotDefined,
    updateDbInternalState,
    updateInstancePropsWithStartedCommunityOrDb,
    updateInstanceStateWithDbState
} from "./local-community/db-state.js";
import { storePublication } from "./local-community/publication-store.js";
import {
    checkPublicationValidity,
    isFlairInAllowedList,
    isPublicationAuthorPartOfRoles,
    respondWithErrorIfSignatureOfPublicationIsInvalid
} from "./local-community/publication-validation.js";

// This is a sub we have locally in our pkc datapath, in a NodeJS environment
export class LocalCommunity extends RpcLocalCommunity implements CreateNewLocalCommunityParsedOptions {
    override signer!: SignerWithPublicKeyAddress;
    override raw: RpcLocalCommunity["raw"] = {};
    _postUpdatesBuckets = [86400, 604800, 2592000, 3153600000]; // 1 day, 1 week, 1 month, 100 years. Expecting to be sorted from smallest to largest

    _defaultCommunityChallenges: CommunityChallengeSetting[] = generateDefaultChallenges();

    // These caches below will be used to facilitate challenges exchange with authors, they will expire after 10 minutes
    // Most of the time they will be delete and cleaned up automatically
    private _challengeAnswerPromises!: LRUCache<string, Promise<DecryptedChallengeAnswer["challengeAnswers"]>>;
    private _challengeAnswerResolveReject!: LRUCache<
        string,
        { resolve: (answers: DecryptedChallengeAnswer["challengeAnswers"]) => void; reject: (error: Error) => void }
    >;
    private _ongoingChallengeExchanges!: LRUCache<string, boolean>;
    private _duplicatePublicationAttempts!: LRUCache<string, number>;
    private _challengeExchangesFromLocalPublishers: Record<string, boolean> = {}; // key is stringified challengeRequestId and value is true if the challenge exchange is ongoing

    _cidsToUnPin: Set<string> = new Set<string>();
    _mfsPathsToRemove: Set<string> = new Set<string>();
    _communityUpdateTrigger: boolean = false;
    private _combinedHashOfPendingCommentsCids: string = sha256("");

    _pageGenerator!: PageGenerator;
    _dbHandler!: DbHandler;
    private _stopHasBeenCalled: boolean; // we use this to track if community.stop() has been called after community.start() or community.update()
    private _publishLoopPromise?: Promise<void> = undefined;
    private _updateLoopPromise?: Promise<void> = undefined;
    private _updateLoopAbortController?: AbortController;
    private _firstUpdateAfterStart: boolean = true;
    _internalStateUpdateId: InternalCommunityRecordBeforeFirstUpdateType["_internalStateUpdateId"] = "";
    _lastPubsubTopicRoutingProvideAt?: number = undefined;
    private _mirroredStartedOrUpdatingCommunity?: { community: LocalCommunity } & Pick<
        CommunityEvents,
        | "error"
        | "updatingstatechange"
        | "update"
        | "statechange"
        | "startedstatechange"
        | "challengerequest"
        | "challengeverification"
        | "challenge"
        | "challengeanswer"
    > = undefined; // The pkc._startedCommunities we're subscribed to
    _pendingEditProps: Partial<ParsedCommunityEditOptions & { editId: string }>[] = [];
    _blocksToRm: string[] = [];
    _postsAllPageCids: AllPageCids | undefined = undefined;

    constructor(pkc: PKC) {
        super(pkc);
        this.handleChallengeExchange = this.handleChallengeExchange.bind(this);
        this._setState("stopped");
        this.started = false;
        this._stopHasBeenCalled = false;

        // need to make sure these props are undefined on the constructor level, so they wouldn't show while logging

        //@ts-expect-error
        this._pageGenerator = undefined;
        //@ts-expect-error
        this._challengeAnswerPromises = undefined;
        //@ts-expect-error
        this._challengeAnswerResolveReject = undefined;
        //@ts-expect-error
        this._ongoingChallengeExchanges = undefined;
        //@ts-expect-error
        this._duplicatePublicationAttempts = undefined;
        //@ts-expect-error
        this._internalStateUpdateId = undefined;

        //@ts-expect-error
        this._dbHandler = undefined;

        hideClassPrivateProps(this);
    }

    // This will be stored in DB and also shared between instances via _updateInstancePropsWithStartedCommunityOrDb.
    // Must NOT convert posts to CID-ref format here — that's only for DB storage (done in _updateDbInternalState).
    // CID-ref conversion strips preloaded page data which breaks reply CommentUpdate resolution
    // when other instances read the shared state.
    toJSONInternalAfterFirstUpdate(): InternalCommunityRecordAfterFirstUpdateType {
        const rpcJson = this.toJSONInternalRpcAfterFirstUpdate();
        return {
            ...rpcJson.community,
            ...remeda.omit(rpcJson.localCommunity, ["started", "startedState"]),
            updateCid: rpcJson.runtimeFields.updateCid,
            signer: remeda.pick(this.signer, ["privateKey", "type", "address", "shortAddress", "publicKey"]),
            _internalStateUpdateId: this._internalStateUpdateId,
            _cidsToUnPin: [...this._cidsToUnPin],
            _mfsPathsToRemove: [...this._mfsPathsToRemove],
            _pendingEditProps: this._pendingEditProps
        };
    }

    toJSONInternalBeforeFirstUpdate(): InternalCommunityRecordBeforeFirstUpdateType {
        const rpcJson = this.toJSONInternalRpcBeforeFirstUpdate();
        return {
            ...remeda.omit(rpcJson.localCommunity, ["started", "startedState"]),
            signer: remeda.pick(this.signer, ["privateKey", "type", "address", "shortAddress", "publicKey"]),
            _internalStateUpdateId: this._internalStateUpdateId,
            _pendingEditProps: this._pendingEditProps
        };
    }

    override toJSONInternalRpcAfterFirstUpdate(): RpcInternalCommunityRecordAfterFirstUpdateType {
        const base = super.toJSONInternalRpcAfterFirstUpdate();
        return {
            ...base,
            localCommunity: {
                ...base.localCommunity,
                signer: remeda.pick(this.signer, ["publicKey", "address", "shortAddress", "type"])
            }
        };
    }

    override toJSONInternalRpcBeforeFirstUpdate(): RpcInternalCommunityRecordBeforeFirstUpdateType {
        const base = super.toJSONInternalRpcBeforeFirstUpdate();
        return {
            localCommunity: {
                ...base.localCommunity,
                signer: remeda.pick(this.signer, ["publicKey", "address", "shortAddress", "type"])
            }
        };
    }

    async _updateStartedValue() {
        this.started = await this._dbHandler.isCommunityStartLocked(this.address);
    }

    async initNewLocalCommunityPropsNoMerge(newProps: CreateNewLocalCommunityParsedOptions) {
        return initNewLocalCommunityPropsNoMerge(this, newProps);
    }

    async initInternalCommunityAfterFirstUpdateNoMerge(newProps: InternalCommunityRecordAfterFirstUpdateType) {
        return initInternalCommunityAfterFirstUpdateNoMerge(this, newProps);
    }

    async initInternalCommunityBeforeFirstUpdateNoMerge(newProps: InternalCommunityRecordBeforeFirstUpdateType) {
        return initInternalCommunityBeforeFirstUpdateNoMerge(this, newProps);
    }

    async initDbHandlerIfNeeded() {
        return initDbHandlerIfNeeded(this);
    }

    private async _calculateNewPostUpdates(): Promise<CommunityIpfsType["postUpdates"]> {
        const postUpdates: CommunityIpfsType["postUpdates"] = {};
        const kuboRpcClient = this._clientsManager.getDefaultKuboRpcClient()._client;
        for (const timeBucket of this._postUpdatesBuckets) {
            try {
                const statRes = await kuboRpcClient.files.stat(`/${this.address}/postUpdates/${timeBucket}`);
                if (statRes.blocks !== 0) postUpdates[String(timeBucket)] = String(statRes.cid);
            } catch {}
        }
        if (remeda.isEmpty(postUpdates)) return undefined;
        return postUpdates;
    }

    private _calculateLatestUpdateTrigger() {
        const lastPublishTooOld = (this.updatedAt || 0) < timestamp() - 60 * 15; // Publish a community record every 15 minutes at least

        // these two checks below are for rare cases where a purged comments or post is not forcing community for a new update
        const lastPostCidChanged = this.lastPostCid !== this._dbHandler.queryLatestPostCid()?.cid;
        const lastCommentCidChanged = this.lastCommentCid !== this._dbHandler.queryLatestCommentCid()?.cid;

        this._communityUpdateTrigger =
            this._communityUpdateTrigger ||
            lastPublishTooOld ||
            this._pendingEditProps.length > 0 ||
            this._blocksToRm.length > 0 ||
            lastCommentCidChanged ||
            lastPostCidChanged; // we have at least one edit to include in new ipns
    }

    private _requireCommunityUpdateIfModQueueChanged() {
        const combinedHashOfAllQueuedComments = this._dbHandler.queryCombinedHashOfPendingComments();

        if (this._combinedHashOfPendingCommentsCids !== combinedHashOfAllQueuedComments) this._communityUpdateTrigger = true;
    }

    async _resolveIpnsAndLogIfPotentialProblematicSequence() {
        const log = Logger("pkc-js:local-community:_resolveIpnsAndLogIfPotentialProblematicSequence");
        if (!this.signer.ipnsKeyName) throw Error("IPNS key name is not defined");
        if (!this.updateCid) return;
        try {
            const ipnsCid = await this._clientsManager.resolveIpnsToCidP2P(this.signer.ipnsKeyName, { timeoutMs: 120000 });
            log.trace("Resolved community", this.address, "IPNS key", this.signer.ipnsKeyName, "to", ipnsCid);

            if (ipnsCid && this.updateCid && ipnsCid !== this.updateCid) {
                log.error(
                    "community",
                    this.address,
                    "IPNS key",
                    this.signer.ipnsKeyName,
                    "points to",
                    ipnsCid,
                    "but we expected it to point to",
                    this.updateCid,
                    "This could result an IPNS record with invalid sequence number"
                );
            }
        } catch (e) {
            log.trace("Failed to resolve community before publishing", this.address, "IPNS key", this.signer.ipnsKeyName, e);
        }
    }

    private async _addOldPageCidsToCidsToUnpin(
        curPages: CommentUpdateType["replies"] | CommunityIpfsType["posts"] | CommunityIpfsType["modQueue"],
        newPages: CommentUpdateType["replies"] | CommunityIpfsType["posts"] | CommunityIpfsType["modQueue"],
        addToBlockRm?: boolean
    ) {
        if (!curPages && !newPages) return;
        else if (curPages && !newPages) {
            // we had to reset our community pages, maybe because we purged all comments or changed community address
            const allPageCidsUnderCurPages = await iterateOverPageCidsToFindAllCids({
                pages: curPages,
                clientManager: this._clientsManager
            });
            allPageCidsUnderCurPages.forEach((cid) => {
                this._cidsToUnPin.add(cid);
                if (addToBlockRm) this._blocksToRm.push(cid);
            });
        } else if (curPages && newPages) {
            // need to find cids for both, and compare them and only keep ones in newPages
            const allPageCidsUnderCurPages = await iterateOverPageCidsToFindAllCids({
                pages: curPages,
                clientManager: this._clientsManager
            });
            const allPageCidsUnderNewPages = await iterateOverPageCidsToFindAllCids({
                pages: newPages,
                clientManager: this._clientsManager
            });
            const cidsToUnpin = remeda.difference(allPageCidsUnderCurPages, allPageCidsUnderNewPages);
            cidsToUnpin.forEach((cid) => {
                this._cidsToUnPin.add(cid);
                if (addToBlockRm) this._blocksToRm.push(cid);
            });
        }
    }

    private async updateCommunityIpnsIfNeeded(commentUpdateRowsToPublishToIpfs: CommentUpdateToWriteToDbAndPublishToIpfs[]) {
        const log = Logger("pkc-js:local-community:start:updateCommunityIpnsIfNeeded");

        this._calculateLatestUpdateTrigger();

        if (!this._communityUpdateTrigger) return; // No reason to update

        this._dbHandler.createTransaction();
        const latestPost = this._dbHandler.queryLatestPostCid();
        const latestComment = this._dbHandler.queryLatestCommentCid();
        this._dbHandler.commitTransaction();

        const stats = this._dbHandler.queryCommunityStats();

        if (commentUpdateRowsToPublishToIpfs.length > 0) {
            try {
                await syncPostUpdatesWithIpfs(this, commentUpdateRowsToPublishToIpfs);
            } catch (e) {
                const err = <Error>e;
                const isMfsTimeout =
                    err.message.includes("Timed out writing to MFS path") || err.message.includes("Timed out removing MFS paths");
                if (isMfsTimeout) {
                    // Workaround for ipfs/kubo#10842: deeply nested MFS paths hang, but rm of the community root is fast.
                    log.error(
                        `MFS sync stuck for community ${this.address} - auto-nuking /${this.address} and forcing a full republish. See https://github.com/ipfs/kubo/issues/10842 for upstream context.`
                    );
                    const kuboRpc = this._clientsManager.getDefaultKuboRpcClient();
                    try {
                        await kuboRpc._client.files.rm("/" + this.address, {
                            recursive: true,
                            //@ts-expect-error force is not in FilesRmOptions
                            force: true
                        });
                    } catch (rmErr) {
                        log.error(`Auto-nuke files.rm of /${this.address} failed:`, rmErr);
                    }
                    this._dbHandler.forceUpdateOnAllComments();
                }
                throw e;
            }
        }

        const newPostUpdates = await this._calculateNewPostUpdates();
        const newModQueue = await this._pageGenerator.generateModQueuePages();

        const kuboRpcClient = this._clientsManager.getDefaultKuboRpcClient();

        const statsCid = (
            await retryKuboIpfsAddAndProvide({
                ipfsClient: kuboRpcClient._client,
                log,
                content: deterministicStringify(stats),
                addOptions: { pin: true },
                provideOptions: { recursive: true },
                provideInBackground: true
            })
        ).path;
        if (this.statsCid && statsCid !== this.statsCid) this._cidsToUnPin.add(this.statsCid);

        const currentTimestamp = timestamp();
        const updatedAt = typeof this?.updatedAt === "number" && this.updatedAt >= currentTimestamp ? this.updatedAt + 1 : currentTimestamp;
        const editIdsToIncludeInNextUpdate = this._pendingEditProps.map((editProps) => editProps.editId);
        const pendingCommunityIpfsEditProps = Object.assign(
            {}, //@ts-expect-error
            ...this._pendingEditProps.map((editProps) => remeda.pick(editProps, remeda.keys.strict(CommunityIpfsSchema.shape)))
        );
        if (this._pendingEditProps.length > 0) log("Including edit props in next IPNS update", this._pendingEditProps);
        const newIpns: Omit<CommunityIpfsType, "signature"> = {
            ...cleanUpBeforePublishing({
                ...remeda.omit(this._toJSONIpfsBaseNoPosts(), ["signature"]),
                ...pendingCommunityIpfsEditProps,
                lastPostCid: latestPost?.cid,
                lastCommentCid: latestComment?.cid,
                statsCid,
                updatedAt,
                postUpdates: newPostUpdates,
                protocolVersion: env.PROTOCOL_VERSION
            })
        };

        const preloadedPostsPages = "hot";
        // Calculate size taken by community without posts and signature
        const communityWithoutPostsSignatureSize = Buffer.byteLength(JSON.stringify(newIpns), "utf8");

        // Calculate expected signature size
        const expectedSignatureSize = calculateExpectedSignatureSize(newIpns);

        // Calculate remaining space for posts
        const availablePostsSize =
            MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS - communityWithoutPostsSignatureSize - expectedSignatureSize - 1000;

        const generatedPosts = await this._pageGenerator.generateCommunityPosts(preloadedPostsPages, availablePostsSize);

        // posts should not be cleaned up because we want to make sure not to modify authors' posts

        // Extract allPageCids from generation result for DB CID-ref storage and unpinning
        const newPostsAllPageCids = generatedPosts && !("singlePreloadedPage" in generatedPosts) ? generatedPosts.allPageCids : undefined;

        if (generatedPosts) {
            if ("singlePreloadedPage" in generatedPosts) newIpns.posts = { pages: generatedPosts.singlePreloadedPage };
            else if (generatedPosts.pageCids) {
                // multiple pages
                newIpns.posts = {
                    pageCids: generatedPosts.pageCids,
                    pages: remeda.pick(generatedPosts.pages, [preloadedPostsPages])
                };
            }
        } else {
            await updateDbInternalState(this, { posts: undefined }); // make sure db resets posts as well
        }

        // Unpin old posts page CIDs using direct allPageCids comparison (no IPFS fetches needed)
        {
            const oldCids = new Set(this._postsAllPageCids ? Object.values(this._postsAllPageCids).flat() : []);
            const newCids = new Set(newPostsAllPageCids ? Object.values(newPostsAllPageCids).flat() : []);
            for (const cid of oldCids) {
                if (!newCids.has(cid)) this._cidsToUnPin.add(cid);
            }
        }
        this._postsAllPageCids = newPostsAllPageCids;

        if (newModQueue) {
            newIpns.modQueue = { pageCids: newModQueue.pageCids };
        } else {
            await updateDbInternalState(this, { modQueue: undefined });
            this.modQueue.resetPages();
        }

        const signature = await signCommunity({ community: newIpns, signer: this.signer });
        const newCommunityRecord = <CommunityIpfsType>{ ...newIpns, signature };

        await this._validateCommunitySizeSchemaAndSignatureBeforePublishing(newCommunityRecord);

        const contentToPublish = deterministicStringify(newCommunityRecord);
        const file = await retryKuboIpfsAddAndProvide({
            ipfsClient: kuboRpcClient._client,
            log,
            content: contentToPublish, // you need to do deterministic here or otherwise cids in commentUpdate.replies won't match up correctly
            addOptions: { pin: true },
            provideOptions: { recursive: true },
            provideInBackground: false
        });
        if (file.size > MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS) {
            throw new PKCError("ERR_LOCAL_COMMUNITY_RECORD_TOO_LARGE", {
                calculatedSizeOfNewCommunityRecord: file.size,
                maxSize: MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS,
                newCommunityRecord,
                address: this.address
            });
        }

        if (!this.signer.ipnsKeyName) throw Error("IPNS key name is not defined");
        // after kubo 0.40 implements fetching IPNS record from local blockstore, we don't need line below anymore
        if (this._firstUpdateAfterStart) await this._resolveIpnsAndLogIfPotentialProblematicSequence();
        const ttl = `${this._pkc.publishInterval * 3}ms`; // default publish interval is 20s, so default ttl is 60s
        const lastPublishedIpnsRecordData = <any | undefined>await this._dbHandler.keyvGet(STORAGE_KEYS[STORAGE_KEYS.LAST_IPNS_RECORD]);
        const decodedIpnsRecord: any | undefined = lastPublishedIpnsRecordData
            ? cborg.decode(new Uint8Array(Object.values(lastPublishedIpnsRecordData)))
            : undefined;
        const ipnsSequence: BigInt | undefined = decodedIpnsRecord ? BigInt(decodedIpnsRecord.sequence) + 1n : undefined;
        const publishRes = await kuboRpcClient._client.name.publish(file.path, {
            key: this.signer.ipnsKeyName,
            allowOffline: true,
            resolve: true,
            ttl
            // enable below line after kubo fixes their problems with fetching IPNS records from local blockstore
            // ...(ipnsSequence ? { sequence: ipnsSequence } : undefined)
        });
        log(
            `Published a new IPNS record for community(${this.address}) on IPNS (${publishRes.name}) that points to file (${publishRes.value}) with updatedAt (${newCommunityRecord.updatedAt}) and TTL (${ttl})`
        );

        this._clientsManager.updateKuboRpcState("stopped", kuboRpcClient.url);
        this._addOldPageCidsToCidsToUnpin(this.raw.communityIpfs?.modQueue, newIpns.modQueue).catch((err) =>
            log.error("Failed to add old page cids of community.modQueue to _cidsToUnpin", err)
        );
        await unpinStaleCids(this);
        if (this._blocksToRm.length > 0) {
            const removedBlocks = await removeBlocksFromKuboNode({
                ipfsClient: this._clientsManager.getDefaultKuboRpcClient()._client,
                log,
                cids: this._blocksToRm,
                options: { force: true }
            });
            log("Removed blocks", removedBlocks, "from kubo node");
            this._blocksToRm = this._blocksToRm.filter((blockCid) => !removedBlocks.includes(blockCid));
        }
        if (this.updateCid) this._cidsToUnPin.add(this.updateCid); // add old cid of community to be unpinned
        this.initCommunityIpfsPropsNoMerge(newCommunityRecord);
        this.updateCid = file.path;
        this._pendingEditProps = this._pendingEditProps.filter((editProps) => !editIdsToIncludeInNextUpdate.includes(editProps.editId));

        // Re-apply remaining pending edits to in-memory state.
        // initCommunityIpfsPropsNoMerge above overwrites all CommunityIpfs properties from the
        // published IPNS record. If edit() was called during the long IPNS publish await,
        // those edits are still in _pendingEditProps but their in-memory values were overwritten.
        if (this._pendingEditProps.length > 0) {
            const remainingEditProps = Object.assign(
                {}, //@ts-expect-error
                ...this._pendingEditProps.map((editProps) => remeda.pick(editProps, remeda.keys.strict(CommunityIpfsSchema.shape)))
            );
            Object.assign(this, remainingEditProps);
        }

        this._communityUpdateTrigger = false;
        this._firstUpdateAfterStart = false;

        try {
            // this call will fail if we have http routers + kubo 0.38 and earlier
            const ipnsRecord = await getIpnsRecordInLocalKuboNode(kuboRpcClient, this.signer.address);

            await this._dbHandler.keyvSet(STORAGE_KEYS[STORAGE_KEYS.LAST_IPNS_RECORD], cborg.encode(ipnsRecord));
        } catch (e) {
            log.trace(
                "Failed to update IPNS record in sqlite record, not a critical error and will most likely be fixed by kubo past 0.38",
                e
            );
        }

        this._combinedHashOfPendingCommentsCids = newModQueue?.combinedHashOfCids || sha256("");

        log.trace("Updated combined hash of pending comments to", this._combinedHashOfPendingCommentsCids);

        await updateDbInternalState(this, this.toJSONInternalAfterFirstUpdate());

        this._changeStateEmitEventEmitStateChangeEvent({
            newStartedState: "succeeded",
            event: { name: "update", args: [this] }
        });
    }

    private shouldResolveDomainForVerification() {
        return this.address.includes(".") && Math.random() < 0.005; // Resolving domain should be a rare process because default rpcs throttle if we resolve too much
    }

    private async _validateCommunitySizeSchemaAndSignatureBeforePublishing(recordToPublishRaw: CommunityIpfsType) {
        const log = Logger("pkc-js:local-community:_validateCommunitySchemaAndSignatureBeforePublishing");

        const stringifiedNewCommunityRecord = deterministicStringify(recordToPublishRaw);
        const calculatedSizeOfNewCommunityRecord = await calculateStringSizeSameAsIpfsAddCidV0(stringifiedNewCommunityRecord);

        // Check if the community record size is less than 1MB
        if (calculatedSizeOfNewCommunityRecord > MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS) {
            const error = new PKCError("ERR_LOCAL_COMMUNITY_RECORD_TOO_LARGE", {
                calculatedSizeOfNewCommunityRecord,
                maxSize: MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS,
                recordToPublishRaw,
                address: this.address
            });
            log.error(
                `Local community (${this.address}) produced a record that is too large (${calculatedSizeOfNewCommunityRecord.toFixed(2)} bytes). Maximum size is ${MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS} bytes.`,
                error
            );
            throw error;
        }

        const parseRes = CommunityIpfsSchema.safeParse(recordToPublishRaw);
        if (!parseRes.success) {
            const error = new PKCError("ERR_LOCAL_COMMUNITY_PRODUCED_INVALID_SCHEMA", {
                invalidRecord: recordToPublishRaw,
                err: parseRes.error
            });
            log.error(`Local community (${this.address}) produced an invalid CommunityIpfs schema`, error);
            throw error;
        }

        const verificationOpts = {
            community: recordToPublishRaw,
            communityIpnsName: this.signer.address,
            resolveAuthorNames: false,
            clientsManager: this._clientsManager,
            validatePages: true,
            cacheIfValid: false
        };
        try {
            const validation = await verifyCommunity(verificationOpts);
            if (!validation.valid) {
                throw new PKCError("ERR_LOCAL_COMMUNITY_PRODUCED_INVALID_SIGNATURE", {
                    validation,
                    verificationOpts
                });
            }
        } catch (e) {
            log.error(`Local community (${this.address}) produced an invalid signature`, e);
            throw e;
        }

        verificationOpts.community = JSON.parse(stringifiedNewCommunityRecord); // let's stringify and parse again to make sure we're not using any invalid data
        try {
            const validation = await verifyCommunity(verificationOpts);
            if (!validation.valid) {
                throw new PKCError("ERR_LOCAL_COMMUNITY_PRODUCED_INVALID_SIGNATURE", {
                    validation,
                    verificationOpts
                });
            }
        } catch (e) {
            log.error(
                `Local community (${this.address}) produced an invalid signature after stringifying and parsing again. This is a critical bug.`,
                e
            );
            throw e;
        }

        if (this.shouldResolveDomainForVerification()) {
            try {
                log(`Resolving domain ${this.address} to make sure it's the same as signer.address ${this.signer.address}`);
                await this._assertDomainResolvesCorrectly(this.address);
            } catch (e) {
                log.error(e);
                this.emit("error", e as PKCError);
            }
        }
    }

    private async _decryptOrRespondWithFailure(request: ChallengeRequestMessageType | ChallengeAnswerMessageType): Promise<string> {
        const log = Logger("pkc-js:local-community:_decryptOrRespondWithFailure");
        try {
            return await decryptEd25519AesGcmPublicKeyBuffer(request.encrypted, this.signer.privateKey, request.signature.publicKey);
        } catch (e) {
            log.error(`Failed to decrypt request (${request.challengeRequestId.toString()}) due to error`, e);
            await this._publishFailedChallengeVerification(
                { reason: messages.ERR_COMMUNITY_FAILED_TO_DECRYPT_PUBSUB_MSG },
                request.challengeRequestId
            );

            throw e;
        }
    }

    private async _publishChallenges(
        challenges: Omit<Challenge, "verify">[],
        request: DecryptedChallengeRequestMessageTypeWithCommunityAuthor
    ) {
        const log = Logger("pkc-js:local-community:_publishChallenges");
        const toEncryptChallenge = <DecryptedChallenge>{ challenges };
        const toSignChallenge: Omit<ChallengeMessageType, "signature"> = cleanUpBeforePublishing({
            type: "CHALLENGE",
            protocolVersion: env.PROTOCOL_VERSION,
            userAgent: this._pkc.userAgent,
            challengeRequestId: request.challengeRequestId,
            encrypted: await encryptEd25519AesGcmPublicKeyBuffer(
                deterministicStringify(toEncryptChallenge),
                this.signer.privateKey,
                request.signature.publicKey
            ),
            timestamp: timestamp()
        });

        const challengeMessage = <ChallengeMessageType>{
            ...toSignChallenge,
            signature: await signChallengeMessage({ challengeMessage: toSignChallenge, signer: this.signer })
        };
        const pubsubClient = this._clientsManager.getDefaultKuboPubsubClient();

        this._clientsManager.updateKuboRpcPubsubState("publishing-challenge", pubsubClient.url);

        // we only publish over pubsub if the challenge exchange is not ongoing for local publishers
        if (!this._challengeExchangesFromLocalPublishers[request.challengeRequestId.toString()])
            await this._clientsManager.pubsubPublish(pubsubTopicWithfallback(this), challengeMessage);
        log(
            `Community ${this.address} with pubsub topic ${pubsubTopicWithfallback(this)} published ${challengeMessage.type} over pubsub: `,
            remeda.pick(toSignChallenge, ["timestamp"]),
            toEncryptChallenge.challenges.map((challenge) => challenge.type)
        );
        this._clientsManager.updateKuboRpcPubsubState("waiting-challenge-answers", pubsubClient.url);
        this.emit("challenge", {
            ...challengeMessage,
            challenges
        });
    }

    async _publishFailedChallengeVerification(
        result: Pick<ChallengeVerificationMessageType, "challengeErrors" | "reason">,
        challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
    ) {
        // challengeSucess=false
        const log = Logger("pkc-js:local-community:_publishFailedChallengeVerification");

        const toSignVerification: Omit<ChallengeVerificationMessageType, "signature"> = cleanUpBeforePublishing({
            type: "CHALLENGEVERIFICATION",
            challengeRequestId: challengeRequestId,
            challengeSuccess: false,
            challengeErrors: result.challengeErrors,
            reason: result.reason,
            userAgent: this._pkc.userAgent,
            protocolVersion: env.PROTOCOL_VERSION,
            timestamp: timestamp()
        });

        const challengeVerification = <ChallengeVerificationMessageType>{
            ...toSignVerification,
            signature: await signChallengeVerification({ challengeVerification: toSignVerification, signer: this.signer })
        };

        const pubsubClient = this._clientsManager.getDefaultKuboPubsubClient();
        this._clientsManager.updateKuboRpcPubsubState("publishing-challenge-verification", pubsubClient.url);
        log(
            `Will publish ${challengeVerification.type} over pubsub topic ${pubsubTopicWithfallback(this)} on community ${this.address}:`,
            remeda.omit(toSignVerification, ["challengeRequestId"])
        );

        if (!this._challengeExchangesFromLocalPublishers[challengeRequestId.toString()])
            await this._clientsManager.pubsubPublish(pubsubTopicWithfallback(this), challengeVerification);
        this._clientsManager.updateKuboRpcPubsubState("waiting-challenge-requests", pubsubClient.url);

        this.emit("challengeverification", challengeVerification);
        this._ongoingChallengeExchanges.delete(challengeRequestId.toString());
        delete this._challengeExchangesFromLocalPublishers[challengeRequestId.toString()];
        this._cleanUpChallengeAnswerPromise(challengeRequestId.toString());
    }

    private async _publishIdempotentDuplicateVerification(
        request: DecryptedChallengeRequestMessageType,
        challengeRequestId: ChallengeRequestMessageType["challengeRequestId"],
        duplicateReason: string
    ) {
        const log = Logger("pkc-js:local-community:_publishIdempotentDuplicateVerification");

        let encrypted: ChallengeVerificationMessageType["encrypted"] | undefined;
        let toEncryptDecrypted: DecryptedChallengeVerification | undefined;

        // For comments, include the existing comment data in the encrypted response
        if (duplicateReason === messages.ERR_DUPLICATE_COMMENT && request.comment) {
            const existingComment = this._dbHandler.queryCommentBySignatureEncoded(request.comment.signature.signature);
            if (!existingComment) {
                return this._publishFailedChallengeVerification({ reason: duplicateReason }, challengeRequestId);
            }
            log("Returning idempotent success for duplicate comment", existingComment.cid);

            const authorSignerAddress = await getPKCAddressFromPublicKey(existingComment.signature.publicKey);
            const authorDomain = getAuthorNameFromWire(existingComment.author);
            const authorCommunity = this._dbHandler.queryCommunityAuthor(authorSignerAddress, authorDomain);
            if (!authorCommunity) {
                return this._publishFailedChallengeVerification({ reason: duplicateReason }, challengeRequestId);
            }
            const commentNumberPostNumber = this._dbHandler._assignNumbersForComment(existingComment.cid);

            const commentUpdateNoSig = <Omit<DecryptedChallengeVerification["commentUpdate"], "signature">>cleanUpBeforePublishing({
                author: { community: authorCommunity },
                cid: existingComment.cid,
                protocolVersion: env.PROTOCOL_VERSION,
                ...commentNumberPostNumber
            });
            const commentUpdate = <DecryptedChallengeVerification["commentUpdate"]>{
                ...commentUpdateNoSig,
                signature: await signCommentUpdateForChallengeVerification({
                    update: commentUpdateNoSig,
                    signer: this.signer
                })
            };
            const commentIpfs = CommentIpfsSchema.strip().parse(existingComment);
            toEncryptDecrypted = { comment: commentIpfs, commentUpdate };

            encrypted = await encryptEd25519AesGcmPublicKeyBuffer(
                deterministicStringify(toEncryptDecrypted),
                this.signer.privateKey,
                request.signature.publicKey
            );
        } else {
            // For edits/moderations: success has no encrypted data (same as normal success)
            log("Returning idempotent success for duplicate", duplicateReason);
        }

        const toSignMsg: Omit<ChallengeVerificationMessageType, "signature"> = cleanUpBeforePublishing({
            type: "CHALLENGEVERIFICATION",
            challengeRequestId,
            encrypted,
            challengeSuccess: true,
            reason: undefined,
            userAgent: this._pkc.userAgent,
            protocolVersion: env.PROTOCOL_VERSION,
            timestamp: timestamp()
        });
        const challengeVerification = <ChallengeVerificationMessageType>{
            ...toSignMsg,
            signature: await signChallengeVerification({ challengeVerification: toSignMsg, signer: this.signer })
        };

        const pubsubClient = this._clientsManager.getDefaultKuboPubsubClient();
        this._clientsManager.updateKuboRpcPubsubState("publishing-challenge-verification", pubsubClient.url);
        if (!this._challengeExchangesFromLocalPublishers[challengeRequestId.toString()])
            await this._clientsManager.pubsubPublish(pubsubTopicWithfallback(this), challengeVerification);
        this._clientsManager.updateKuboRpcPubsubState("waiting-challenge-requests", pubsubClient.url);

        const objectToEmit = <DecryptedChallengeVerificationMessageType>{ ...challengeVerification, ...toEncryptDecrypted };
        this.emit("challengeverification", objectToEmit);
        this._ongoingChallengeExchanges.delete(challengeRequestId.toString());
        delete this._challengeExchangesFromLocalPublishers[challengeRequestId.toString()];
        this._cleanUpChallengeAnswerPromise(challengeRequestId.toString());
    }

    private async _storePublicationAndEncryptForChallengeVerification(
        request: DecryptedChallengeRequestMessageType,
        pendingApproval?: boolean
    ): Promise<(DecryptedChallengeVerification & Required<Pick<DecryptedChallengeVerificationMessageType, "encrypted">>) | undefined> {
        const commentAfterAddingToIpfs = await storePublication(this, request, pendingApproval);
        if (!commentAfterAddingToIpfs) return undefined;
        const authorSignerAddress = await getPKCAddressFromPublicKey(commentAfterAddingToIpfs.comment.signature.publicKey);
        const authorDomain = getAuthorNameFromWire(commentAfterAddingToIpfs.comment.author);

        const authorCommunity = this._dbHandler.queryCommunityAuthor(authorSignerAddress, authorDomain);
        if (!authorCommunity) throw Error("author.community can never be undefined after adding a comment");
        const commentNumberPostNumber = this._dbHandler._assignNumbersForComment(commentAfterAddingToIpfs.cid);

        const commentUpdateOfVerificationNoSignature = <Omit<DecryptedChallengeVerification["commentUpdate"], "signature">>(
            cleanUpBeforePublishing({
                author: { community: authorCommunity },
                cid: commentAfterAddingToIpfs.cid,
                protocolVersion: env.PROTOCOL_VERSION,
                pendingApproval,
                ...commentNumberPostNumber
            })
        );
        const commentUpdate = <DecryptedChallengeVerification["commentUpdate"]>{
            ...commentUpdateOfVerificationNoSignature,
            signature: await signCommentUpdateForChallengeVerification({
                update: commentUpdateOfVerificationNoSignature,
                signer: this.signer
            })
        };

        const toEncrypt = <DecryptedChallengeVerification>{ comment: commentAfterAddingToIpfs.comment, commentUpdate };

        const encrypted = await encryptEd25519AesGcmPublicKeyBuffer(
            deterministicStringify(toEncrypt),
            this.signer.privateKey,
            request.signature.publicKey
        );

        return { ...toEncrypt, encrypted };
    }

    private async _publishChallengeVerification(
        challengeResult: Pick<ChallengeVerificationMessageType, "challengeErrors" | "challengeSuccess" | "reason">,
        request: DecryptedChallengeRequestMessageType,
        pendingApproval?: boolean
    ) {
        const log = Logger("pkc-js:local-community:_publishChallengeVerification");
        if (!challengeResult.challengeSuccess) return this._publishFailedChallengeVerification(challengeResult, request.challengeRequestId);
        else {
            // Challenge has passed, we store the publication (except if there's an issue with the publication)
            // call below could fail if the comment is duplicated
            let failureReason: string | undefined;
            let toEncrypt:
                | (DecryptedChallengeVerification & Required<Pick<DecryptedChallengeVerificationMessageType, "encrypted">>)
                | undefined;

            try {
                toEncrypt = await this._storePublicationAndEncryptForChallengeVerification(request, pendingApproval);
            } catch (e) {
                failureReason = (e as PKCError).message;
                log.error("Failed to store store Publication And Encrypt For ChallengeVerification", e);
            }

            const toSignMsg: Omit<ChallengeVerificationMessageType, "signature"> = cleanUpBeforePublishing({
                type: "CHALLENGEVERIFICATION",
                challengeRequestId: request.challengeRequestId,
                encrypted: toEncrypt?.encrypted, // could be undefined
                challengeErrors: challengeResult.challengeErrors,
                userAgent: this._pkc.userAgent,
                protocolVersion: env.PROTOCOL_VERSION,
                timestamp: timestamp(),
                ...(failureReason ? { reason: failureReason, challengeSuccess: false } : { challengeSuccess: true, reason: undefined })
            });
            const challengeVerification = <ChallengeVerificationMessageType>{
                ...toSignMsg,
                signature: await signChallengeVerification({ challengeVerification: toSignMsg, signer: this.signer })
            };

            const pubsubClient = this._clientsManager.getDefaultKuboPubsubClient();

            this._clientsManager.updateKuboRpcPubsubState("publishing-challenge-verification", pubsubClient.url);

            if (!this._challengeExchangesFromLocalPublishers[request.challengeRequestId.toString()])
                await this._clientsManager.pubsubPublish(pubsubTopicWithfallback(this), challengeVerification);

            this._clientsManager.updateKuboRpcPubsubState("waiting-challenge-requests", pubsubClient.url);

            const objectToEmit = <DecryptedChallengeVerificationMessageType>{ ...challengeVerification, ...toEncrypt };
            this.emit("challengeverification", objectToEmit);
            this._ongoingChallengeExchanges.delete(request.challengeRequestId.toString());
            delete this._challengeExchangesFromLocalPublishers[request.challengeRequestId.toString()];
            this._cleanUpChallengeAnswerPromise(request.challengeRequestId.toString());
            log.trace(
                `Published ${challengeVerification.type} over pubsub topic ${pubsubTopicWithfallback(this)}:`,
                remeda.omit(objectToEmit, ["signature", "encrypted", "challengeRequestId"])
            );
        }
    }

    private async _parseChallengeRequestPublicationOrRespondWithFailure(
        request: ChallengeRequestMessageType,
        decryptedRawString: string
    ): Promise<DecryptedChallengeRequest> {
        let decryptedJson: DecryptedChallengeRequest;
        try {
            decryptedJson = parseJsonWithPKCErrorIfFails(decryptedRawString);
        } catch (e) {
            await this._publishFailedChallengeVerification(
                { reason: messages.ERR_REQUEST_ENCRYPTED_IS_INVALID_JSON_AFTER_DECRYPTION },
                request.challengeRequestId
            );
            throw e;
        }

        const parseRes = DecryptedChallengeRequestSchema.loose().safeParse(decryptedJson);
        if (!parseRes.success) {
            await this._publishFailedChallengeVerification(
                { reason: messages.ERR_REQUEST_ENCRYPTED_HAS_INVALID_SCHEMA_AFTER_DECRYPTING },
                request.challengeRequestId
            );

            throw new PKCError("ERR_REQUEST_ENCRYPTED_HAS_INVALID_SCHEMA_AFTER_DECRYPTING", {
                decryptedJson,
                schemaError: parseRes.error
            });
        }

        return decryptedJson;
    }

    private _buildRuntimeChallengeRequestPublication({
        publication,
        authorCommunity
    }: {
        publication: PublicationFromDecryptedChallengeRequest;
        authorCommunity?: PublicationWithCommunityAuthorFromDecryptedChallengeRequest["author"]["community"];
    }): PublicationWithCommunityAuthorFromDecryptedChallengeRequest {
        return {
            ...publication,
            author: buildRuntimeAuthor({
                author: publication.author,
                signaturePublicKey: publication.signature.publicKey,
                community: authorCommunity
            })
        };
    }

    private _buildRuntimeChallengeRequest({
        request,
        authorCommunity
    }: {
        request: DecryptedChallengeRequestMessageType;
        authorCommunity?: PublicationWithCommunityAuthorFromDecryptedChallengeRequest["author"]["community"];
    }): DecryptedChallengeRequestMessageTypeWithCommunityAuthor {
        // This function needs to be updated everytime we add a new publication type
        const runtimeRequest = remeda.clone(request) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor;

        if (request.comment)
            runtimeRequest.comment = this._buildRuntimeChallengeRequestPublication({
                publication: request.comment,
                authorCommunity
            }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor["comment"];
        if (request.vote)
            runtimeRequest.vote = this._buildRuntimeChallengeRequestPublication({
                publication: request.vote,
                authorCommunity
            }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor["vote"];
        if (request.commentEdit)
            runtimeRequest.commentEdit = this._buildRuntimeChallengeRequestPublication({
                publication: request.commentEdit,
                authorCommunity
            }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor["commentEdit"];
        if (request.commentModeration)
            runtimeRequest.commentModeration = this._buildRuntimeChallengeRequestPublication({
                publication: request.commentModeration,
                authorCommunity
            }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor["commentModeration"];
        if (request.communityEdit)
            runtimeRequest.communityEdit = this._buildRuntimeChallengeRequestPublication({
                publication: request.communityEdit,
                authorCommunity
            }) as DecryptedChallengeRequestMessageTypeWithCommunityAuthor["communityEdit"];

        return runtimeRequest;
    }

    async handleChallengeRequest(request: ChallengeRequestMessageType, isLocalPublisher: boolean) {
        const log = Logger("pkc-js:local-community:handleChallengeRequest");

        if (this._ongoingChallengeExchanges.has(request.challengeRequestId.toString())) {
            log("Received a duplicate challenge request", request.challengeRequestId.toString());
            return; // This is a duplicate challenge request
        }
        if (isLocalPublisher) {
            // we need to mark the challenge exchange as ongoing for local publishers and skip publishing it over pubsub
            log("Marking challenge exchange as ongoing for local publisher");
            this._challengeExchangesFromLocalPublishers[request.challengeRequestId.toString()] = true;
        }
        this._ongoingChallengeExchanges.set(request.challengeRequestId.toString(), true);
        const requestSignatureValidation = await verifyChallengeRequest({ request, validateTimestampRange: true });
        if (!requestSignatureValidation.valid)
            throw new PKCError(getErrorCodeFromMessage(requestSignatureValidation.reason), {
                challengeRequest: remeda.omit(request, ["encrypted"])
            });

        const decryptedRawString = await this._decryptOrRespondWithFailure(request);

        const decryptedRequest = await this._parseChallengeRequestPublicationOrRespondWithFailure(request, decryptedRawString);

        const publicationFieldNames = remeda.keys.strict(DecryptedChallengeRequestPublicationSchema.shape);
        let publication: PublicationFromDecryptedChallengeRequest;
        try {
            publication = derivePublicationFromChallengeRequest(decryptedRequest);
        } catch {
            return this._publishFailedChallengeVerification(
                { reason: messages.ERR_CHALLENGE_REQUEST_ENCRYPTED_HAS_NO_PUBLICATION_AFTER_DECRYPTING },
                request.challengeRequestId
            );
        }
        let publicationCount = 0;
        publicationFieldNames.forEach((pubField) => {
            if (pubField in decryptedRequest) publicationCount++;
        });
        if (publicationCount > 1)
            return this._publishFailedChallengeVerification(
                { reason: messages.ERR_CHALLENGE_REQUEST_ENCRYPTED_HAS_MULTIPLE_PUBLICATIONS_AFTER_DECRYPTING },
                request.challengeRequestId
            );

        // Reject deprecated wire format fields early, before signature verification
        // (these fields are never in signedPropertyNames and would otherwise fail with a generic error)
        if ("subplebbitAddress" in publication) {
            return this._publishFailedChallengeVerification(
                { reason: messages.ERR_PUBLICATION_USES_DEPRECATED_SUBPLEBBIT_ADDRESS },
                request.challengeRequestId
            );
        }
        if ("communityAddress" in publication) {
            return this._publishFailedChallengeVerification(
                { reason: messages.ERR_PUBLICATION_USES_DEPRECATED_COMMUNITY_ADDRESS },
                request.challengeRequestId
            );
        }

        const authorSignerAddress = await getPKCAddressFromPublicKey(publication.signature.publicKey);
        const authorDomain = getAuthorNameFromWire(publication.author);

        // Check publication props validity
        const communityAuthor = this._dbHandler.queryCommunityAuthor(authorSignerAddress, authorDomain);
        const decryptedRequestMsg = <DecryptedChallengeRequestMessageType>{ ...request, ...decryptedRequest };
        const decryptedRequestWithCommunityAuthor = this._buildRuntimeChallengeRequest({
            request: decryptedRequestMsg,
            authorCommunity: communityAuthor
        });

        try {
            await respondWithErrorIfSignatureOfPublicationIsInvalid(this, decryptedRequestMsg); // This function will throw an error if signature is invalid
        } catch (e) {
            log.error(
                "Signature of challengerequest.publication is invalid, emitting an error event and aborting the challenge exchange",
                e
            );
            this.emit("challengerequest", decryptedRequestWithCommunityAuthor);
            return;
        }

        log.trace("Received a valid challenge request", decryptedRequestWithCommunityAuthor);

        this.emit("challengerequest", decryptedRequestWithCommunityAuthor);

        const publicationInvalidityReason = await checkPublicationValidity(this, decryptedRequestMsg, publication, communityAuthor);
        if (publicationInvalidityReason) {
            if (DUPLICATE_PUBLICATION_ERRORS.has(publicationInvalidityReason)) {
                const sig = publication.signature.signature;
                const attempts = (this._duplicatePublicationAttempts.get(sig) || 0) + 1;
                this._duplicatePublicationAttempts.set(sig, attempts);
                if (attempts <= 1) {
                    return this._publishIdempotentDuplicateVerification(
                        decryptedRequestMsg,
                        request.challengeRequestId,
                        publicationInvalidityReason
                    );
                }
            }
            return this._publishFailedChallengeVerification({ reason: publicationInvalidityReason }, request.challengeRequestId);
        }

        const answerPromiseKey = decryptedRequestWithCommunityAuthor.challengeRequestId.toString();
        const getChallengeAnswers: GetChallengeAnswers = async (challenges) => {
            // ...get challenge answers from user. e.g.:
            // step 1. community publishes challenge pubsub message with `challenges` provided in argument of `getChallengeAnswers`
            // step 2. community waits for challenge answer pubsub message with `challengeAnswers` and then returns `challengeAnswers`
            await this._publishChallenges(challenges, decryptedRequestWithCommunityAuthor);
            const challengeAnswerPromise = new Promise<DecryptedChallengeAnswer["challengeAnswers"]>((resolve, reject) =>
                this._challengeAnswerResolveReject.set(answerPromiseKey, { resolve, reject })
            );
            this._challengeAnswerPromises.set(answerPromiseKey, challengeAnswerPromise);
            const challengeAnswers = await this._challengeAnswerPromises.get(answerPromiseKey);
            if (!challengeAnswers) throw Error("Failed to retrieve challenge answers from promise. This is a critical error");
            this._cleanUpChallengeAnswerPromise(answerPromiseKey);
            return challengeAnswers;
        };
        // NOTE: we try to get challenge verification immediately after receiving challenge request
        // because some challenges are automatic and skip the challenge message
        let challengeVerification: Awaited<ReturnType<typeof getChallengeVerification>> & { reason?: string };
        try {
            challengeVerification = await getChallengeVerification({
                challengeRequestMessage: decryptedRequestWithCommunityAuthor,
                community: this,
                getChallengeAnswers
            });
        } catch (e) {
            // getChallengeVerification will throw if one of the getChallenge function throws, which indicates a bug with the challenge script
            // notify the community owner that that one of his challenge is misconfigured via an error event
            log.error("getChallenge failed, the community owner needs to check the challenge code. The error is: ", e);
            this.emit("error", <PKCError>e);

            // notify the author that his publication wasn't published because the community is misconfigured
            challengeVerification = {
                challengeSuccess: false,
                reason: `One of the community challenges is misconfigured: ${(<Error>e).message}`
            };
        }

        await this._publishChallengeVerification(challengeVerification, decryptedRequestMsg, challengeVerification.pendingApproval);
    }

    private _cleanUpChallengeAnswerPromise(challengeRequestIdString: string) {
        this._challengeAnswerPromises.delete(challengeRequestIdString);
        this._challengeAnswerResolveReject.delete(challengeRequestIdString);
        delete this._challengeExchangesFromLocalPublishers[challengeRequestIdString];
    }

    private async _parseChallengeAnswerOrRespondWithFailure(challengeAnswer: ChallengeAnswerMessageType, decryptedRawString: string) {
        let parsedJson: any;

        try {
            parsedJson = parseJsonWithPKCErrorIfFails(decryptedRawString);
        } catch (e) {
            await this._publishFailedChallengeVerification(
                { reason: messages.ERR_CHALLENGE_ANSWER_IS_INVALID_JSON },
                challengeAnswer.challengeRequestId
            );
            throw e;
        }

        try {
            return parseDecryptedChallengeAnswerWithPKCErrorIfItFails(parsedJson);
        } catch (e) {
            await this._publishFailedChallengeVerification(
                { reason: messages.ERR_CHALLENGE_ANSWER_IS_INVALID_SCHEMA },
                challengeAnswer.challengeRequestId
            );
            throw e;
        }
    }

    async handleChallengeAnswer(challengeAnswer: ChallengeAnswerMessageType) {
        const log = Logger("pkc-js:local-community:handleChallengeAnswer");

        if (!this._ongoingChallengeExchanges.has(challengeAnswer.challengeRequestId.toString()))
            // Respond with error to answers without challenge request
            return this._publishFailedChallengeVerification(
                { reason: messages.ERR_CHALLENGE_ANSWER_WITH_NO_CHALLENGE_REQUEST },
                challengeAnswer.challengeRequestId
            );
        const answerSignatureValidation = await verifyChallengeAnswer({ answer: challengeAnswer, validateTimestampRange: true });

        if (!answerSignatureValidation.valid) {
            this._cleanUpChallengeAnswerPromise(challengeAnswer.challengeRequestId.toString());
            this._ongoingChallengeExchanges.delete(challengeAnswer.challengeRequestId.toString());
            delete this._challengeExchangesFromLocalPublishers[challengeAnswer.challengeRequestId.toString()];
            throw new PKCError(getErrorCodeFromMessage(answerSignatureValidation.reason), { challengeAnswer });
        }

        const decryptedRawString = await this._decryptOrRespondWithFailure(challengeAnswer);

        const decryptedAnswers = await this._parseChallengeAnswerOrRespondWithFailure(challengeAnswer, decryptedRawString);

        const decryptedChallengeAnswerPubsubMessage = <DecryptedChallengeAnswerMessageType>{ ...challengeAnswer, ...decryptedAnswers };

        this.emit("challengeanswer", decryptedChallengeAnswerPubsubMessage);

        const challengeAnswerPromise = this._challengeAnswerResolveReject.get(challengeAnswer.challengeRequestId.toString());

        if (!challengeAnswerPromise)
            throw Error("The challenge answer promise is undefined, there is an issue with challenge. This is a critical error");

        challengeAnswerPromise.resolve(decryptedChallengeAnswerPubsubMessage.challengeAnswers);
    }

    async handleChallengeExchange(pubsubMsg: IpfsHttpClientPubsubMessage) {
        const log = Logger("pkc-js:local-community:handleChallengeExchange");

        const timeReceived = timestamp();

        const pubsubKilobyteSize = Buffer.byteLength(pubsubMsg.data) / 1000;
        if (pubsubKilobyteSize > 80) {
            log.error(`Received a pubsub message at (${timeReceived}) with size of ${pubsubKilobyteSize}. Silently dropping it`);
            return;
        }

        let decodedMsg: any;

        try {
            decodedMsg = cborg.decode(pubsubMsg.data);
        } catch (e) {
            log.error(`Failed to decode pubsub message received at (${timeReceived})`, (<Error>e).toString());
            return;
        }

        const pubsubSchemas = [
            ChallengeRequestMessageSchema.loose(),
            ChallengeMessageSchema.loose(),
            ChallengeAnswerMessageSchema.loose(),
            ChallengeVerificationMessageSchema.loose()
        ];

        let parsedPubsubMsg:
            | ChallengeRequestMessageType
            | ChallengeMessageType
            | ChallengeAnswerMessageType
            | ChallengeVerificationMessageType
            | undefined;
        for (const pubsubSchema of pubsubSchemas) {
            const parseRes = pubsubSchema.safeParse(decodedMsg);
            if (parseRes.success) {
                parsedPubsubMsg = parseRes.data;
                break;
            }
        }

        if (!parsedPubsubMsg) {
            log.error(`Failed to parse the schema of pubsub message received at (${timeReceived})`, decodedMsg);
            return;
        }

        if (parsedPubsubMsg.type === "CHALLENGE" || parsedPubsubMsg.type === "CHALLENGEVERIFICATION") {
            log.trace(
                `Received a pubsub message that is not meant to by processed by the community - ${parsedPubsubMsg.type}. Will ignore it`
            );
            return;
        } else if (parsedPubsubMsg.type === "CHALLENGEREQUEST") {
            try {
                await this.handleChallengeRequest(parsedPubsubMsg, false);
            } catch (e) {
                log.error(`Failed to process challenge request message received at (${timeReceived})`, e);
                this._dbHandler.rollbackTransaction();
            }
        } else if (parsedPubsubMsg.type === "CHALLENGEANSWER") {
            try {
                await this.handleChallengeAnswer(parsedPubsubMsg);
            } catch (e) {
                log.error(`Failed to process challenge answer message received at (${timeReceived})`, e);
                this._dbHandler.rollbackTransaction();
            }
        }
    }

    async _addCommentRowToIPFS(unpinnedCommentRow: CommentsTableRow, log: Logger) {
        const ipfsClient = this._clientsManager.getDefaultKuboRpcClient();

        const finalCommentIpfsJson = deriveCommentIpfsFromCommentTableRow(unpinnedCommentRow);
        const commentIpfsContent = deterministicStringify(finalCommentIpfsJson);
        const contentHash: string = await calculateIpfsHash(commentIpfsContent);
        if (contentHash !== unpinnedCommentRow.cid) {
            throw Error("Unable to recreate the CommentIpfs. This is a critical error");
        }

        const addRes = await retryKuboIpfsAddAndProvide({
            ipfsClient: ipfsClient._client,
            log,
            content: commentIpfsContent,
            addOptions: { pin: true },
            provideOptions: { recursive: true },
            provideInBackground: false
        });
        if (addRes.path !== unpinnedCommentRow.cid) throw Error("Unable to recreate the CommentIpfs. This is a critical error");
        log.trace("Pinned comment", unpinnedCommentRow.cid, "of community", this.address, "to IPFS node");
    }

    private async syncIpnsWithDb() {
        const log = Logger("pkc-js:local-community:sync");

        const kuboRpc = this._clientsManager.getDefaultKuboRpcClient();
        try {
            await listenToIncomingRequests(this);
            await providePubsubTopicRoutingCidsIfNeeded(this);
            await adjustPostUpdatesBucketsIfNeeded(this);
            this._setStartedStateWithEmission("publishing-ipns");
            this._clientsManager.updateKuboRpcState("publishing-ipns", kuboRpc.url);
            await purgeDisapprovedCommentsOlderThan(this);
            const commentUpdateRows = await updateCommentsThatNeedToBeUpdated(this);
            this._requireCommunityUpdateIfModQueueChanged();
            await this.updateCommunityIpnsIfNeeded(commentUpdateRows);
            await cleanUpIpfsRepoRarely(this);
        } catch (e) {
            //@ts-expect-error
            e.details = { ...e.details, communityAddress: this.address };
            const errorTyped = <Error>e;
            this._setStartedStateWithEmission("failed");
            this._clientsManager.updateKuboRpcState("stopped", kuboRpc.url);

            log.error(
                `Failed to sync community`,
                this.address,
                `due to error,`,
                errorTyped,
                "Error.message",
                errorTyped.message,
                "Error keys",
                Object.keys(errorTyped)
            );

            throw e;
        }
    }

    async _assertDomainResolvesCorrectly(newAddressAsDomain: string) {
        if (isStringDomain(newAddressAsDomain)) {
            const resolvedIpnsFromNewDomain = await this._clientsManager.resolveCommunityNameIfNeeded({
                communityName: newAddressAsDomain,
                // Admin domain edits don't need second-fresh data.
                cache: { maxAge: 600 }
            });
            if (resolvedIpnsFromNewDomain !== this.signer.address)
                throw new PKCError("ERR_DOMAIN_COMMUNITY_ADDRESS_TXT_RECORD_POINT_TO_DIFFERENT_ADDRESS", {
                    currentCommunityAddress: this.address,
                    newAddressAsDomain,
                    resolvedIpnsFromNewDomain,
                    signerAddress: this.signer.address,
                    started: this.started
                });
        }
    }

    private async _publishLoop(syncIntervalMs: number) {
        const log = Logger("pkc-js:local-community:_publishLoop");
        // we need to continue the loop if there's at least one pending edit

        const shouldStopPublishLoop = () => {
            return this.state !== "started" || (this._stopHasBeenCalled && this._pendingEditProps.length === 0);
        };

        const waitUntilNextSync = async () => {
            const doneWithLoopTime = Date.now();
            await new Promise((resolve) => {
                const checkInterval = setInterval(() => {
                    const syncIntervalMsPassedSinceDoneWithLoop = Date.now() - doneWithLoopTime >= syncIntervalMs;
                    this._calculateLatestUpdateTrigger(); // will update this._communityUpdateTrigger
                    if (this._communityUpdateTrigger || shouldStopPublishLoop() || syncIntervalMsPassedSinceDoneWithLoop) {
                        clearInterval(checkInterval);
                        resolve(1);
                    }
                }, 100);
            });
        };

        while (!shouldStopPublishLoop()) {
            try {
                await this.syncIpnsWithDb();
            } catch (e) {
                this.emit("error", e as Error);
            } finally {
                await waitUntilNextSync();
            }
        }
        log("Stopping the publishing loop of community", this.address);
    }

    private async _initBeforeStarting() {
        this.protocolVersion = env.PROTOCOL_VERSION;
        if (!this.signer?.address) throw new PKCError("ERR_COMMUNITY_SIGNER_NOT_DEFINED");
        if (!this._challengeAnswerPromises)
            this._challengeAnswerPromises = new LRUCache<string, Promise<DecryptedChallengeAnswer["challengeAnswers"]>>({
                max: 1000,
                ttl: 600000
            });
        if (!this._challengeAnswerResolveReject)
            this._challengeAnswerResolveReject = new LRUCache<
                string,
                { resolve: (answers: DecryptedChallengeAnswer["challengeAnswers"]) => void; reject: (error: Error) => void }
            >({
                max: 1000,
                ttl: 600000
            });
        if (!this._ongoingChallengeExchanges)
            this._ongoingChallengeExchanges = new LRUCache<string, boolean>({
                max: 1000,
                ttl: 600000
            });
        if (!this._duplicatePublicationAttempts)
            this._duplicatePublicationAttempts = new LRUCache<string, number>({
                max: 1000,
                ttl: 600000
            });
        await this._dbHandler.initDbIfNeeded();
    }

    override async edit(newCommunityOptions: CommunityEditOptions): Promise<typeof this> {
        return (await editCommunity(this, newCommunityOptions)) as typeof this;
    }

    override async start() {
        const log = Logger("pkc-js:local-community:start");
        if (this.state === "updating") throw new PKCError("ERR_NEED_TO_STOP_UPDATING_COMMUNITY_BEFORE_STARTING", { address: this.address });
        this._stopHasBeenCalled = false;
        this._firstUpdateAfterStart = true;
        if (!this._clientsManager.getDefaultKuboRpcClientOrHelia())
            throw Error("You need to define an IPFS client in your pkc instance to be able to start a local community");
        await this.initDbHandlerIfNeeded();
        await this._updateStartedValue();
        if (
            this.started ||
            findStartedCommunity(this._pkc, { publicKey: this.publicKey, name: this.name }) ||
            findCommunityInRegistry(processStartedCommunities, { publicKey: this.publicKey, name: this.name })
        )
            throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED", { address: this.address });
        try {
            await this._initBeforeStarting();
            // update started value twice because it could be started prior lockCommunityStart
            this._setState("started");
            await this._updateStartedValue();
            await this._dbHandler.lockCommunityStart(); // Will throw if community is locked already
            trackStartedCommunity(this._pkc, this);
            syncCommunityRegistryEntry(processStartedCommunities, this);
            await this._updateStartedValue();
            await this._dbHandler.initDbIfNeeded();
            await this._dbHandler.createOrMigrateTablesIfNeeded();
            await updateInstanceStateWithDbState(this); // sync in-memory state after potential migration

            await setChallengesToDefaultIfNotDefined(this, log);
            // Import community keys onto ipfs node
            await importCommunitySignerIntoIpfsIfNeeded(this);
            await providePubsubTopicRoutingCidsIfNeeded(this, true);

            this._communityUpdateTrigger = true;
            this._setStartedStateWithEmission("publishing-ipns");
            await repinCommentsIPFSIfNeeded(this);
            await repinCommentUpdateIfNeeded(this);
            await listenToIncomingRequests(this);
            this.challenges = await Promise.all(
                this.settings.challenges!.map(
                    async (cs) =>
                        (await getCommunityChallengeFromCommunityChallengeSettings({ communityChallengeSettings: cs, pkc: this._pkc }))
                            .communityChallenge
                )
            ); // make sure community.challenges is using latest props from settings.challenges
        } catch (e) {
            await this.stop(); // Make sure to reset the community state
            //@ts-expect-error
            e.details = { ...e.details, communityAddress: this.address };
            throw e;
        }

        this._publishLoopPromise = this._publishLoop(this._pkc.publishInterval).catch((err) => {
            log.error(err);
            this.emit("error", err);
        });
    }

    private async _initMirroringStartedOrUpdatingCommunity(startedCommunity: LocalCommunity) {
        const updatingStateChangeListener = (newState: CommunityUpdatingState) => {
            this._setUpdatingStateWithEventEmissionIfNewState(newState);
        };

        const startedStateChangeListener = (newState: LocalCommunity["startedState"]) => {
            this._setStartedStateWithEmission(newState);
            updatingStateChangeListener(newState);
        };

        const updateListener = async (updatedCommunity: RemoteCommunity) => {
            const startedCommunity = updatedCommunity as LocalCommunity;
            if (startedCommunity.updateCid)
                await this.initInternalCommunityAfterFirstUpdateNoMerge(startedCommunity.toJSONInternalAfterFirstUpdate());
            else await this.initInternalCommunityBeforeFirstUpdateNoMerge(startedCommunity.toJSONInternalBeforeFirstUpdate());
            this.started = startedCommunity.started;
            this.emit("update", this);
        };
        const stateChangeListener = async (newState: CommunityState) => {
            // pkc._startedCommunities[address].stop() has been called, we need to stop mirroring
            // or pkc._updatingCommunities[address].stop(), we need to stop mirroring
            if (newState === "stopped") await this._cleanUpMirroredStartedOrUpdatingCommunity();
        };
        this._mirroredStartedOrUpdatingCommunity = {
            community: startedCommunity,
            updatingstatechange: updatingStateChangeListener,
            update: updateListener,
            statechange: stateChangeListener,
            startedstatechange: startedStateChangeListener,
            error: (err: PKCError | Error) => this.emit("error", err),
            challengerequest: (challengeRequest) => this.emit("challengerequest", challengeRequest),
            challengeverification: (challengeVerification) => this.emit("challengeverification", challengeVerification),
            challengeanswer: (challengeAnswer) => this.emit("challengeanswer", challengeAnswer),
            challenge: (challenge) => this.emit("challenge", challenge)
        };

        this._mirroredStartedOrUpdatingCommunity.community.on("update", this._mirroredStartedOrUpdatingCommunity.update);
        this._mirroredStartedOrUpdatingCommunity.community.on(
            "startedstatechange",
            this._mirroredStartedOrUpdatingCommunity.startedstatechange
        );
        this._mirroredStartedOrUpdatingCommunity.community.on(
            "updatingstatechange",
            this._mirroredStartedOrUpdatingCommunity.updatingstatechange
        );
        this._mirroredStartedOrUpdatingCommunity.community.on("statechange", this._mirroredStartedOrUpdatingCommunity.statechange);
        this._mirroredStartedOrUpdatingCommunity.community.on("error", this._mirroredStartedOrUpdatingCommunity.error);
        this._mirroredStartedOrUpdatingCommunity.community.on(
            "challengerequest",
            this._mirroredStartedOrUpdatingCommunity.challengerequest
        );
        this._mirroredStartedOrUpdatingCommunity.community.on(
            "challengeverification",
            this._mirroredStartedOrUpdatingCommunity.challengeverification
        );
        this._mirroredStartedOrUpdatingCommunity.community.on("challengeanswer", this._mirroredStartedOrUpdatingCommunity.challengeanswer);
        this._mirroredStartedOrUpdatingCommunity.community.on("challenge", this._mirroredStartedOrUpdatingCommunity.challenge);

        const clientKeys = remeda.keys.strict(this.clients);
        for (const clientType of clientKeys)
            if (this.clients[clientType])
                for (const clientUrl of Object.keys(this.clients[clientType]))
                    if (clientUrl in this._mirroredStartedOrUpdatingCommunity.community.clients[clientType])
                        this.clients[clientType][clientUrl].mirror(
                            this._mirroredStartedOrUpdatingCommunity.community.clients[clientType][clientUrl]
                        );
        if (startedCommunity.updateCid)
            await this.initInternalCommunityAfterFirstUpdateNoMerge(startedCommunity.toJSONInternalAfterFirstUpdate());
        else await this.initInternalCommunityBeforeFirstUpdateNoMerge(startedCommunity.toJSONInternalBeforeFirstUpdate());
        this.emit("update", this);
    }

    private async _cleanUpMirroredStartedOrUpdatingCommunity() {
        if (!this._mirroredStartedOrUpdatingCommunity) return;
        this._mirroredStartedOrUpdatingCommunity.community.removeListener("update", this._mirroredStartedOrUpdatingCommunity.update);
        this._mirroredStartedOrUpdatingCommunity.community.removeListener(
            "updatingstatechange",
            this._mirroredStartedOrUpdatingCommunity.updatingstatechange
        );

        this._mirroredStartedOrUpdatingCommunity.community.removeListener(
            "startedstatechange",
            this._mirroredStartedOrUpdatingCommunity.startedstatechange
        );
        this._mirroredStartedOrUpdatingCommunity.community.removeListener(
            "statechange",
            this._mirroredStartedOrUpdatingCommunity.statechange
        );
        this._mirroredStartedOrUpdatingCommunity.community.removeListener("error", this._mirroredStartedOrUpdatingCommunity.error);
        this._mirroredStartedOrUpdatingCommunity.community.removeListener(
            "challengerequest",
            this._mirroredStartedOrUpdatingCommunity.challengerequest
        );
        this._mirroredStartedOrUpdatingCommunity.community.removeListener(
            "challengeverification",
            this._mirroredStartedOrUpdatingCommunity.challengeverification
        );
        this._mirroredStartedOrUpdatingCommunity.community.removeListener(
            "challengeanswer",
            this._mirroredStartedOrUpdatingCommunity.challengeanswer
        );
        this._mirroredStartedOrUpdatingCommunity.community.removeListener("challenge", this._mirroredStartedOrUpdatingCommunity.challenge);

        const clientKeys = remeda.keys.strict(this.clients);

        for (const clientType of clientKeys)
            if (this.clients[clientType])
                for (const clientUrl of Object.keys(this.clients[clientType])) this.clients[clientType][clientUrl].unmirror();

        this._mirroredStartedOrUpdatingCommunity = undefined;
    }

    private async _updateOnce() {
        const log = Logger("pkc-js:local-community:_updateOnce");
        await this.initDbHandlerIfNeeded();
        await this._updateStartedValue();
        const startedCommunity = <LocalCommunity | undefined>(
            (findStartedCommunity(this._pkc, { publicKey: this.publicKey, name: this.name }) ||
                findCommunityInRegistry(processStartedCommunities, { publicKey: this.publicKey, name: this.name }))
        );
        if (this._mirroredStartedOrUpdatingCommunity)
            return; // we're already mirroring a started or updating community
        else if (startedCommunity) {
            // let's mirror the started community in this process
            await this._initMirroringStartedOrUpdatingCommunity(startedCommunity);
            untrackUpdatingCommunity(this._pkc, this);
            return;
        } else {
            const updatingCommunity = findUpdatingCommunity(this._pkc, { publicKey: this.publicKey, name: this.name });
            if (updatingCommunity instanceof LocalCommunity && updatingCommunity !== this) {
                // different instance is updating, let's mirror it
                await this._initMirroringStartedOrUpdatingCommunity(updatingCommunity as LocalCommunity);
                return;
            }
            // this community is not started or updated anywhere, but maybe another process will call edit() on it
            trackUpdatingCommunity(this._pkc, this);
            const oldUpdateId = remeda.clone(this._internalStateUpdateId);
            await updateInstancePropsWithStartedCommunityOrDb(this); // will update this instance props with DB
            if (this._internalStateUpdateId !== oldUpdateId) {
                log(
                    `Local Community (${this.address}) received a new update from db with updatedAt (${this.updatedAt}). Will emit an update event`
                );

                this._changeStateEmitEventEmitStateChangeEvent({
                    event: { name: "update", args: [this] },
                    newUpdatingState: "succeeded"
                });
            }
        }
    }

    private async _updateLoop() {
        const log = Logger("pkc-js:local-community:update:_updateLoop");
        while (this.state === "updating" && !this._stopHasBeenCalled) {
            try {
                await this._updateOnce();
            } catch (e) {
                log.error("Error in update loop", e);
                this.emit("error", e as PKCError | Error);
            } finally {
                await new Promise<void>((resolve) => {
                    if (this._updateLoopAbortController?.signal.aborted) return resolve();
                    const timer = setTimeout(resolve, this._pkc.updateInterval);
                    this._updateLoopAbortController?.signal.addEventListener(
                        "abort",
                        () => {
                            clearTimeout(timer);
                            resolve();
                        },
                        { once: true }
                    );
                });
            }
        }
    }

    override async update() {
        if (this.state === "started") throw new PKCError("ERR_COMMUNITY_ALREADY_STARTED", { address: this.address });
        if (this.state === "updating") return;
        this._stopHasBeenCalled = false;
        this._setState("updating");

        try {
            await this._updateOnce();
        } catch (e) {
            this.emit("error", e as PKCError | Error);
        }
        this._updateLoopAbortController = new AbortController();
        this._updateLoopPromise = this._updateLoop();
    }

    override async stop() {
        const log = Logger("pkc-js:local-community:stop");
        this._stopHasBeenCalled = true;
        if (this._updateLoopAbortController) {
            this._updateLoopAbortController.abort();
        }
        this.posts._stop();

        if (this.state === "started") {
            log("Stopping running community", this.address);
            try {
                await this._clientsManager.pubsubUnsubscribe(pubsubTopicWithfallback(this), this.handleChallengeExchange);
            } catch (e) {
                log.error("Failed to unsubscribe from challenge exchange pubsub when stopping community", e);
            }
            if (this._publishLoopPromise) {
                try {
                    await this._publishLoopPromise;
                } catch (e) {
                    log.error(`Failed to stop community publish loop`, e);
                }
                this._publishLoopPromise = undefined;
            }

            try {
                await unpinStaleCids(this);
            } catch (e) {
                log.error("Failed to unpin stale cids and remove mfs paths before stopping", e);
            }

            try {
                await updateDbInternalState(
                    this,
                    this.updateCid ? this.toJSONInternalAfterFirstUpdate() : this.toJSONInternalBeforeFirstUpdate()
                );
            } catch (e) {
                log.error("Failed to update db internal state before stopping", e);
            }

            try {
                await this._dbHandler.unlockCommunityStart();
            } catch (e) {
                log.error(`Failed to unlock start lock on community (${this.address})`, e);
            }
            const kuboRpcClient = this._clientsManager.getDefaultKuboRpcClient();
            const pubsubClient = this._clientsManager.getDefaultKuboPubsubClient();

            this._setStartedStateWithEmission("stopped");
            untrackStartedCommunity(this._pkc, this);
            processStartedCommunities.untrack(this);
            this._duplicatePublicationAttempts?.clear();
            await this._dbHandler.rollbackAllTransactions();
            await this._dbHandler.unlockCommunityState();
            await this._updateStartedValue();
            this._clientsManager.updateKuboRpcState("stopped", kuboRpcClient.url);
            this._clientsManager.updateKuboRpcPubsubState("stopped", pubsubClient.url);
            if (this._dbHandler) this._dbHandler.destoryConnection();
            log(`Stopped the running of local community (${this.address})`);
            this._setState("stopped");
        } else if (this.state === "updating") {
            if (this._updateLoopPromise) {
                await this._updateLoopPromise;
                this._updateLoopPromise = undefined;
            }
            this._updateLoopAbortController = undefined;
            if (this._dbHandler) this._dbHandler.destoryConnection();
            if (this._mirroredStartedOrUpdatingCommunity) await this._cleanUpMirroredStartedOrUpdatingCommunity();
            if (findUpdatingCommunity(this._pkc, { publicKey: this.publicKey, name: this.name }) === this)
                untrackUpdatingCommunity(this._pkc, this);
            this._setUpdatingStateWithEventEmissionIfNewState("stopped");
            log(`Stopped the updating of local community (${this.address})`);
            this._setState("stopped");
        }
    }

    override async delete() {
        const log = Logger("pkc-js:local-community:delete");
        log.trace(`Attempting to stop the community (${this.address}) before deleting, if needed`);

        const startedCommunity = <LocalCommunity | undefined>(
            (findStartedCommunity(this._pkc, { publicKey: this.publicKey, name: this.name }) ||
                findCommunityInRegistry(processStartedCommunities, { publicKey: this.publicKey, name: this.name }))
        );
        if (startedCommunity && startedCommunity !== this) {
            await startedCommunity.delete();
            await this.stop();
            return;
        }

        if (this.state === "updating" || this.state === "started") await this.stop();

        const kuboClient = this._clientsManager.getDefaultKuboRpcClient();
        if (!kuboClient) throw Error("Ipfs client is not defined");

        if (typeof this.signer?.ipnsKeyName === "string")
            // Key may not exist on ipfs node
            try {
                await kuboClient._client.key.rm(this.signer.ipnsKeyName);
            } catch (e) {
                log.error("Failed to delete ipns key", this.signer.ipnsKeyName, e);
            }

        try {
            await removeMfsFilesSafely({ kuboRpcClient: kuboClient, paths: ["/" + this.address], log });
        } catch (e) {
            log.error("Failed to delete community mfs folder", "/" + this.address, e);
        }
        // sceneario 1: we call delete() on a community that is not started or updating
        // scenario 2: we call delete() on a community that is updating
        // scenario 3: we call delete() on a community that is started
        // scenario 4: we call delete() on a community that is not started, but the same community is started in pkc._startedCommunities[address]

        try {
            await this._addOldPageCidsToCidsToUnpin(this.raw?.communityIpfs?.posts, undefined);
        } catch (e) {
            log.error("Failed to add old page cids from community.posts to be unpinned", e);
        }
        if (this.ipnsPubsubTopicRoutingCid) this._cidsToUnPin.add(this.ipnsPubsubTopicRoutingCid);
        if (this.pubsubTopicRoutingCid) this._cidsToUnPin.add(this.pubsubTopicRoutingCid);
        try {
            await this.initDbHandlerIfNeeded();
            await this._dbHandler.initDbIfNeeded();
            const cidsAndReplies = this._dbHandler.queryAllCommentCidsAndTheirReplies();
            for (const comment of cidsAndReplies) {
                this._cidsToUnPin.add(comment.cid);
                for (const pageCid of comment.allPageCids) {
                    this._cidsToUnPin.add(pageCid);
                }
            }
        } catch (e) {
            log.error("Failed to query all cids under this community to delete them", e);
        }
        if (this.updateCid) this._cidsToUnPin.add(this.updateCid);
        if (this.statsCid) this._cidsToUnPin.add(this.statsCid);

        try {
            await unpinStaleCids(this);
        } catch (e) {
            log.error("Failed to unpin stale cids before deleting", e);
        }

        try {
            await updateDbInternalState(
                this,
                typeof this.updatedAt === "number" ? this.toJSONInternalAfterFirstUpdate() : this.toJSONInternalBeforeFirstUpdate()
            );
        } catch (e) {
            log.error("Failed to update db internal state before deleting", e);
        } finally {
            this._dbHandler.destoryConnection();
        }

        await moveCommunityDbToDeletedDirectory(this.address, this._pkc);

        log(`Deleted community (${this.address}) successfully`);
    }
}

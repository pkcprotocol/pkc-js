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
import {
    buildRuntimeAuthor,
    cleanWireAuthor,
    getAuthorDomainFromWire,
    getAuthorNameFromWire
} from "../../../publications/publication-author.js";
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
import { TrackedInstanceRegistry } from "../../../pkc/tracked-instance-registry.js";
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

type CommentUpdateToWriteToDbAndPublishToIpfs = {
    newCommentUpdate: CommentUpdateType;
    newCommentUpdateToWriteToDb: CommentUpdatesTableRowInsert;
    localMfsPath: string | undefined;
    pendingApproval: CommentsTableRow["pendingApproval"];
};
const processStartedCommunities = new TrackedInstanceRegistry<LocalCommunity>(); // A global registry on process level to track started communities

const DUPLICATE_PUBLICATION_ERRORS = new Set([
    messages.ERR_DUPLICATE_COMMENT,
    messages.ERR_DUPLICATE_COMMENT_EDIT,
    messages.ERR_DUPLICATE_COMMENT_MODERATION
]);

// This is a sub we have locally in our pkc datapath, in a NodeJS environment
export class LocalCommunity extends RpcLocalCommunity implements CreateNewLocalCommunityParsedOptions {
    override signer!: SignerWithPublicKeyAddress;
    override raw: RpcLocalCommunity["raw"] = {};
    private _postUpdatesBuckets = [86400, 604800, 2592000, 3153600000]; // 1 day, 1 week, 1 month, 100 years. Expecting to be sorted from smallest to largest

    private static _defaultChallengeQuestionText =
        "What is the answer to this community's challenge? (check community.settings.challenges to see the answer, or set your own challenge)";

    static _generateDefaultChallenges(answer?: string): CommunityChallengeSetting[] {
        return [
            {
                name: "question",
                options: {
                    question: LocalCommunity._defaultChallengeQuestionText,
                    answer: answer ?? uuidV4()
                }
            }
        ];
    }

    static _isDefaultChallengeStructure(challenges: CommunityChallengeSetting[] | undefined): boolean {
        if (!challenges || challenges.length !== 1) return false;
        const c = challenges[0];
        return (
            c.name === "question" &&
            c.options?.question === LocalCommunity._defaultChallengeQuestionText &&
            typeof c.options?.answer === "string" &&
            c.options.answer.length > 0
        );
    }

    _defaultCommunityChallenges: CommunityChallengeSetting[] = LocalCommunity._generateDefaultChallenges();

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
    private _communityUpdateTrigger: boolean = false;
    private _combinedHashOfPendingCommentsCids: string = sha256("");

    private _pageGenerator!: PageGenerator;
    _dbHandler!: DbHandler;
    private _stopHasBeenCalled: boolean; // we use this to track if community.stop() has been called after community.start() or community.update()
    private _publishLoopPromise?: Promise<void> = undefined;
    private _updateLoopPromise?: Promise<void> = undefined;
    private _updateLoopAbortController?: AbortController;
    private _firstUpdateAfterStart: boolean = true;
    private _internalStateUpdateId: InternalCommunityRecordBeforeFirstUpdateType["_internalStateUpdateId"] = "";
    private _lastPubsubTopicRoutingProvideAt?: number = undefined;
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
    private _pendingEditProps: Partial<ParsedCommunityEditOptions & { editId: string }>[] = [];
    _blocksToRm: string[] = [];

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

    // This will be stored in DB
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

    private async _updateStartedValue() {
        this.started = await this._dbHandler.isCommunityStartLocked(this.address);
    }

    async initNewLocalCommunityPropsNoMerge(newProps: CreateNewLocalCommunityParsedOptions) {
        await this._initSignerProps(newProps.signer);
        this.title = newProps.title;
        this.description = newProps.description;
        this.setAddress(newProps.address);
        this.pubsubTopic = newProps.pubsubTopic;
        this.roles = newProps.roles;
        this.features = newProps.features;
        this.suggested = newProps.suggested;
        this.rules = newProps.rules;
        this.flairs = newProps.flairs;
        if (newProps.settings) this.settings = newProps.settings;
    }

    async initInternalCommunityAfterFirstUpdateNoMerge(newProps: InternalCommunityRecordAfterFirstUpdateType) {
        const keysOfCommunityIpfs = <(keyof CommunityIpfsType)[]>[...CommunitySignedPropertyNames, "signature"];
        this.initRpcInternalCommunityAfterFirstUpdateNoMerge({
            community: remeda.pick(newProps, keysOfCommunityIpfs) as CommunityIpfsType,
            localCommunity: {
                signer: remeda.pick(newProps.signer as SignerWithPublicKeyAddress, ["publicKey", "address", "shortAddress", "type"]),
                settings: newProps.settings,
                _usingDefaultChallenge: newProps._usingDefaultChallenge,
                address: newProps.address,
                started: this.started,
                startedState: this.startedState
            },
            runtimeFields: { updateCid: newProps.updateCid }
        });
        await this._initSignerProps(newProps.signer);
        this._internalStateUpdateId = newProps._internalStateUpdateId;
        if (Array.isArray(newProps._cidsToUnPin)) newProps._cidsToUnPin.forEach((cid) => this._cidsToUnPin.add(cid));
        if (Array.isArray(newProps._mfsPathsToRemove)) newProps._mfsPathsToRemove.forEach((path) => this._mfsPathsToRemove.add(path));
        this._updateIpnsPubsubPropsIfNeeded(newProps);
        if (processStartedCommunities.has(this)) syncCommunityRegistryEntry(processStartedCommunities, this);
        if (this.updateCid) this.raw.localCommunity = this.toJSONInternalRpcAfterFirstUpdate();
    }

    async initInternalCommunityBeforeFirstUpdateNoMerge(newProps: InternalCommunityRecordBeforeFirstUpdateType) {
        this.initRpcInternalCommunityBeforeFirstUpdateNoMerge({
            localCommunity: {
                ...remeda.omit(newProps, ["signer", "_internalStateUpdateId", "_pendingEditProps"]),
                signer: remeda.pick(newProps.signer as SignerWithPublicKeyAddress, ["publicKey", "address", "shortAddress", "type"]),
                started: this.started,
                startedState: this.startedState
            }
        });
        await this._initSignerProps(newProps.signer);
        this._internalStateUpdateId = newProps._internalStateUpdateId;
        this._updateIpnsPubsubPropsIfNeeded(newProps);
        this.ipnsName = newProps.signer.address;
        this.ipnsPubsubTopic = ipnsNameToIpnsOverPubsubTopic(this.ipnsName);
        this.ipnsPubsubTopicRoutingCid = pubsubTopicToDhtKey(this.ipnsPubsubTopic);
        if (processStartedCommunities.has(this)) syncCommunityRegistryEntry(processStartedCommunities, this);
        this.raw.localCommunity = this.toJSONInternalRpcBeforeFirstUpdate();
    }

    private async initDbHandlerIfNeeded() {
        if (!this._dbHandler) {
            this._dbHandler = new DbHandler(this);
            await this._dbHandler.initDbConfigIfNeeded();
            this._pageGenerator = new PageGenerator(this);
        }
    }

    async _updateInstancePropsWithStartedCommunityOrDb() {
        // if it's started in the same pkc instance, we will load it from the started community instance
        // if it's started in another process, we will throw an error
        // if community is not started, load the InternalCommunity props from the local db

        const log = Logger("pkc-js:local-community:_updateInstancePropsWithStartedCommunityOrDb");
        const startedCommunity = <LocalCommunity | undefined>(
            (findStartedCommunity(this._pkc, { publicKey: this.publicKey, name: this.name }) ||
                findCommunityInRegistry(processStartedCommunities, { publicKey: this.publicKey, name: this.name }))
        );
        if (startedCommunity) {
            log("Loading local community", this.address, "from started community instance");
            if (startedCommunity.updatedAt)
                await this.initInternalCommunityAfterFirstUpdateNoMerge(startedCommunity.toJSONInternalAfterFirstUpdate());
            else await this.initInternalCommunityBeforeFirstUpdateNoMerge(startedCommunity.toJSONInternalBeforeFirstUpdate());
            this.started = true;
        } else {
            await this.initDbHandlerIfNeeded();
            try {
                await this._updateStartedValue();

                const communityDbExists = this._dbHandler.communityDbExists();
                if (!communityDbExists)
                    throw new PKCError("CAN_NOT_LOAD_LOCAL_COMMUNITY_IF_DB_DOES_NOT_EXIST", {
                        address: this.address,
                        dataPath: this._pkc.dataPath
                    });

                const dbConfig = this.state === "updating" ? { readonly: true } : undefined;
                await this._dbHandler.initDbIfNeeded(dbConfig);

                await this._updateInstanceStateWithDbState(); // Load InternalCommunity from DB here
                if (!this.signer) throw new PKCError("ERR_LOCAL_COMMUNITY_HAS_NO_SIGNER_IN_INTERNAL_STATE", { address: this.address });

                await this._updateStartedValue();
                log("Loaded local community", this.address, "from db");
            } catch (e) {
                throw e;
            } finally {
                this._dbHandler.destoryConnection(); // Need to destory connection so process wouldn't hang
            }
        }

        // need to validate schema of Community IPFS
        if (this.raw.communityIpfs)
            try {
                parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(this.raw.communityIpfs);
            } catch (e) {
                if (e instanceof Error) {
                    log(
                        "Local community",
                        this.address,
                        "has an invalid communityIpfs schema from DB, clearing for re-generation after migration:",
                        e.message
                    );
                    this.raw.communityIpfs = undefined;
                }
            }
    }
    private async _importCommunitySignerIntoIpfsIfNeeded() {
        if (!this.signer.ipnsKeyName) throw Error("community.signer.ipnsKeyName is not defined");
        if (!this.signer.ipfsKey) throw Error("community.signer.ipfsKey is not defined");

        await importSignerIntoKuboNode(this.signer.ipnsKeyName, this.signer.ipfsKey, {
            url: this._pkc.kuboRpcClientsOptions![0].url!.toString(),
            headers: this._pkc.kuboRpcClientsOptions![0].headers
        });
    }

    async _updateDbInternalState(
        props: Partial<InternalCommunityRecordBeforeFirstUpdateType | InternalCommunityRecordAfterFirstUpdateType>
    ): Promise<InternalCommunityRecordBeforeFirstUpdateType | InternalCommunityRecordAfterFirstUpdateType> {
        const log = Logger("pkc-js:local-community:_updateDbInternalState");
        if (remeda.isEmpty(props)) throw Error("props to update DB internal state should not be empty");
        await this._dbHandler.initDbIfNeeded();

        props._internalStateUpdateId = uuidV4();
        let lockedIt = false;
        try {
            await this._dbHandler.lockCommunityState();
            lockedIt = true;
            const internalStateBefore = await this._getDbInternalState(false);
            const mergedInternalState = { ...internalStateBefore, ...props };
            await this._dbHandler.keyvSet(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY], mergedInternalState);
            this._internalStateUpdateId = props._internalStateUpdateId;
            log.trace("Updated community", this.address, "internal state in db with new props", Object.keys(props));
            if (this.updateCid && this.raw.communityIpfs) {
                this.raw.localCommunity = this.toJSONInternalRpcAfterFirstUpdate();
            } else if (this.settings) {
                this.raw.localCommunity = this.toJSONInternalRpcBeforeFirstUpdate();
            }
            return mergedInternalState as InternalCommunityRecordBeforeFirstUpdateType | InternalCommunityRecordAfterFirstUpdateType;
        } catch (e) {
            log.error("Failed to update community", this.address, "internal state in db with new props", Object.keys(props), e);
            throw e;
        } finally {
            if (lockedIt) await this._dbHandler.unlockCommunityState();
        }
    }

    private async _getDbInternalState(
        lock: boolean
    ): Promise<InternalCommunityRecordAfterFirstUpdateType | InternalCommunityRecordBeforeFirstUpdateType> {
        const log = Logger("pkc-js:local-community:_getDbInternalState");
        if (!this._dbHandler.keyvHas(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY]))
            throw new PKCError("ERR_COMMUNITY_HAS_NO_INTERNAL_STATE", { address: this.address, dataPath: this._pkc.dataPath });
        let lockedIt = false;
        try {
            if (lock) {
                await this._dbHandler.lockCommunityState();
                lockedIt = true;
            }
            const internalState = await this._dbHandler.keyvGet(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY]);
            if (!internalState)
                throw new PKCError("ERR_COMMUNITY_HAS_NO_INTERNAL_STATE", { address: this.address, dataPath: this._pkc.dataPath });
            return internalState as InternalCommunityRecordAfterFirstUpdateType | InternalCommunityRecordBeforeFirstUpdateType;
        } catch (e) {
            log.error("Failed to get community", this.address, "internal state from db", e);
            throw e;
        } finally {
            if (lockedIt) await this._dbHandler.unlockCommunityState();
        }
    }

    private async _updateInstanceStateWithDbState() {
        const currentDbState = await this._getDbInternalState(false);

        if ("updatedAt" in currentDbState) {
            await this.initInternalCommunityAfterFirstUpdateNoMerge(currentDbState);
        } else await this.initInternalCommunityBeforeFirstUpdateNoMerge(currentDbState);
    }

    async _setChallengesToDefaultIfNotDefined(log: Logger) {
        if (
            this._usingDefaultChallenge !== false &&
            (!this.settings?.challenges || LocalCommunity._isDefaultChallengeStructure(this.settings?.challenges))
        )
            this._usingDefaultChallenge = true;

        if (this._usingDefaultChallenge) {
            const currentAnswer = this.settings?.challenges?.[0]?.options?.answer;
            if (currentAnswer && LocalCommunity._isDefaultChallengeStructure(this._defaultCommunityChallenges)) {
                // Preserve the existing per-community random answer in the template
                this._defaultCommunityChallenges = LocalCommunity._generateDefaultChallenges(currentAnswer);
            }

            if (!remeda.isDeepEqual(this.settings?.challenges, this._defaultCommunityChallenges)) {
                await this.edit({ settings: { ...this.settings, challenges: this._defaultCommunityChallenges } });
                // edit() recalculates _usingDefaultChallenge via _isDefaultChallengeStructure,
                // which may return false for non-standard defaults (e.g. []).
                // Re-assert true since we know this is still a default-driven upgrade.
                this._usingDefaultChallenge = true;
                log(
                    `Upgraded default challenge for community (${this.address})`,
                    this._defaultCommunityChallenges[0]?.options?.answer
                        ? `with answer: ${this._defaultCommunityChallenges[0].options!.answer}`
                        : `to ${this._defaultCommunityChallenges.length} challenge(s)`
                );
            }
        }
    }

    async _createNewLocalCommunityDb() {
        // We're creating a totally new community here with a new db
        // This function should be called only once per community
        const log = Logger("pkc-js:local-community:_createNewLocalCommunityDb");
        await this.initDbHandlerIfNeeded();
        await this._dbHandler.initDbIfNeeded({ fileMustExist: false });
        await this._dbHandler.createOrMigrateTablesIfNeeded();
        await this._initSignerProps(this.signer); // init this.encryption as well

        if (!this.pubsubTopic) this.pubsubTopic = remeda.clone(this.signer.address);
        if (typeof this.createdAt !== "number") this.createdAt = timestamp();
        if (!this.protocolVersion) this.protocolVersion = env.PROTOCOL_VERSION;
        if (!this.settings?.maxPendingApprovalCount) this.settings = { ...this.settings, maxPendingApprovalCount: 500 };
        if (!this.settings?.challenges) {
            this.settings = { ...this.settings, challenges: this._defaultCommunityChallenges };
            this._usingDefaultChallenge = true;
            log(
                `Generated default challenge for community (${this.address}) with answer:`,
                this._defaultCommunityChallenges[0].options!.answer
            );
        }
        if (typeof this.settings?.purgeDisapprovedCommentsOlderThan !== "number") {
            this.settings = { ...this.settings, purgeDisapprovedCommentsOlderThan: 1.21e6 }; // two weeks
        }

        this.challenges = await Promise.all(
            this.settings.challenges!.map((cs) => getCommunityChallengeFromCommunityChallengeSettings(cs, this._pkc))
        );

        if (this._dbHandler.keyvHas(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY])) throw Error("Internal state exists already");

        await this._dbHandler.keyvSet(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_COMMUNITY], this.toJSONInternalBeforeFirstUpdate());

        await this._updateStartedValue();

        this._dbHandler.destoryConnection(); // Need to destory connection so process wouldn't hang
        this._updateIpnsPubsubPropsIfNeeded({
            ...this.toJSONInternalBeforeFirstUpdate(), //@ts-expect-error
            signature: { publicKey: this.signer.publicKey }
        });
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

        if (commentUpdateRowsToPublishToIpfs.length > 0) await this._syncPostUpdatesWithIpfs(commentUpdateRowsToPublishToIpfs);

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
            await this._updateDbInternalState({ posts: undefined }); // make sure db resets posts as well
            // TODO make sure to capture this.posts cids to unpin
        }

        this._addOldPageCidsToCidsToUnpin(this.raw.communityIpfs?.posts, newIpns.posts).catch((err) =>
            log.error("Failed to add old page cids of community.posts to _cidsToUnpin", err)
        );

        if (newModQueue) {
            newIpns.modQueue = { pageCids: newModQueue.pageCids };
        } else {
            await this._updateDbInternalState({ modQueue: undefined });
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
        await this._unpinStaleCids();
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

        await this._updateDbInternalState(this.toJSONInternalAfterFirstUpdate());

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

    private async storeCommentEdit(
        commentEditRaw: CommentEditPubsubMessagePublication,
        challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
    ): Promise<undefined> {
        const log = Logger("pkc-js:local-community:storeCommentEdit");
        const strippedOutEditPublication = CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema.strip().parse(commentEditRaw); // we strip out here so we don't store any extra props in commentedits table
        strippedOutEditPublication.author = cleanWireAuthor(strippedOutEditPublication.author); // strip runtime-only author fields (address, publicKey, etc.)

        // Normalize to new wire format: ensure communityPublicKey/communityName for DB columns
        if (!strippedOutEditPublication.communityPublicKey) strippedOutEditPublication.communityPublicKey = this.signer.address;
        if (!strippedOutEditPublication.communityName && isStringDomain(this.address))
            strippedOutEditPublication.communityName = this.address;
        const commentToBeEdited = this._dbHandler.queryComment(commentEditRaw.commentCid); // We assume commentToBeEdited to be defined because we already tested for its existence above
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

        const isEditDuplicate = this._dbHandler.hasCommentEditWithSignatureEncoded(editTableRow.signature.signature);
        if (isEditDuplicate) {
            throw new PKCError("ERR_DUPLICATE_COMMENT_EDIT", { editTableRow });
        }

        this._dbHandler.insertCommentEdits([editTableRow]);

        // If author is deleting a pending or disapproved comment, purge it immediately from the database
        if (commentEditRaw.deleted === true) {
            const isPending = commentToBeEdited.pendingApproval;
            const disapprovalResult = this._dbHandler._queryIsCommentApproved(commentToBeEdited);
            const isDisapproved = disapprovalResult && !disapprovalResult.approved;

            if (isPending || isDisapproved) {
                log("Author deleted a pending/disapproved comment, purging immediately", commentEditRaw.commentCid);
                this._dbHandler.purgeComment(commentEditRaw.commentCid);
                this._communityUpdateTrigger = true;
            }
        }
    }

    private async storeCommentModeration(
        commentModRaw: CommentModerationPubsubMessagePublication,
        challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
    ): Promise<undefined> {
        const log = Logger("pkc-js:local-community:storeCommentModeration");
        const strippedOutModPublication = CommentModerationPubsubMessagePublicationSchema.strip().parse(commentModRaw); // we strip out here so we don't store any extra props in commentedits table
        strippedOutModPublication.author = cleanWireAuthor(strippedOutModPublication.author); // strip runtime-only author fields (address, publicKey, etc.)

        // Normalize to new wire format: ensure communityPublicKey/communityName for DB columns
        if (!strippedOutModPublication.communityPublicKey) strippedOutModPublication.communityPublicKey = this.signer.address;
        if (!strippedOutModPublication.communityName && isStringDomain(this.address))
            strippedOutModPublication.communityName = this.address;
        const commentToBeEdited = this._dbHandler.queryComment(commentModRaw.commentCid); // We assume commentToBeEdited to be defined because we already tested for its existence above
        if (!commentToBeEdited) throw Error("The comment to edit doesn't exist"); // unlikely error to happen, but always a good idea to verify

        const modSignerAddress = await getPKCAddressFromPublicKey(commentModRaw.signature.publicKey);

        // Determine the target author signer address and domain if this moderation affects the author (ban/flair)
        let targetAuthorSignerAddress: string | undefined;
        let targetAuthorDomain: string | undefined;
        if (strippedOutModPublication.commentModeration.author) {
            // Check if the comment was published with pseudonymity - if so, get the original author address/domain
            const aliasInfo = this._dbHandler.queryPseudonymityAliasByCommentCid(commentModRaw.commentCid);
            if (aliasInfo) {
                targetAuthorSignerAddress = await getPKCAddressFromPublicKey(aliasInfo.originalAuthorSignerPublicKey);
                targetAuthorDomain = aliasInfo.originalAuthorDomain || undefined;
            } else {
                targetAuthorSignerAddress = commentToBeEdited.authorSignerAddress;
                targetAuthorDomain = getAuthorDomainFromWire(commentToBeEdited.author);
            }
        }

        const modTableRow = <CommentModerationTableRow>{
            ...strippedOutModPublication,
            modSignerAddress,
            insertedAt: timestamp(),
            targetAuthorSignerAddress,
            targetAuthorDomain
        };

        const isCommentModDuplicate = this._dbHandler.hasCommentModerationWithSignatureEncoded(modTableRow.signature.signature);
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

            const commentToPurge = this._dbHandler.queryComment(modTableRow.commentCid);
            if (!commentToPurge) throw Error("Comment to purge not found");
            const purgedTableRows = this._dbHandler.purgeComment(modTableRow.commentCid);

            for (const purgedTableRow of purgedTableRows) await this._addAllCidsUnderPurgedCommentToBeRemoved(purgedTableRow);

            log("Purged comment", modTableRow.commentCid, "and its comment and comment update children", "out of DB and IPFS");

            await this._rmUnneededMfsPaths(); // not sure if needed here
            if (this.updateCid) {
                // need to remove any update cids with reference to purged comment
                this._blocksToRm.push(this.updateCid);
                this._cidsToUnPin.add(this.updateCid);
            }
        } else if ("approved" in modTableRow.commentModeration) {
            if (modTableRow.commentModeration.approved) {
                log(
                    "commentModeration.approved=true, and therefore move comment from pending approval and add it to IPFS",
                    "comment cid is",
                    modTableRow.commentCid
                );

                await this._addCommentRowToIPFS(
                    commentToBeEdited,
                    Logger("pkc-js:local-community:storeCommentModeration:_addCommentRowToIPFS")
                );
                this._dbHandler.approvePendingComment({ cid: modTableRow.commentCid });
            } else {
                const shouldPurgeDisapprovedComment = Object.keys(modTableRow.commentModeration).length === 1; // no other props were included, if so purge the comment
                log(
                    "commentModeration.approved=false, and therefore this comment will be removed entirely from DB",
                    "should we purge this comment? = ",
                    shouldPurgeDisapprovedComment,
                    "comment cid is",
                    modTableRow.commentCid
                );
                if (shouldPurgeDisapprovedComment) this._dbHandler.purgeComment(modTableRow.commentCid);
                else this._dbHandler.removeCommentFromPendingApproval({ cid: modTableRow.commentCid });
            }
        }
        this._dbHandler.insertCommentModerations([modTableRow]);
        this._communityUpdateTrigger = true;
        log("Inserted comment moderation", "of comment", modTableRow.commentCid, "into db", "with props", modTableRow);
    }

    private async storeVote(
        newVoteProps: VotePubsubMessagePublication,
        challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
    ) {
        const log = Logger("pkc-js:local-community:storeVote");

        const authorSignerAddress = await getPKCAddressFromPublicKey(newVoteProps.signature.publicKey);
        this._dbHandler.deleteVote(authorSignerAddress, newVoteProps.commentCid);
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

        this._dbHandler.insertVotes([voteTableRow]);
        log("Inserted vote", "of comment", voteTableRow.commentCid, "into db", "with props", voteTableRow);
        return undefined;
    }

    private async storeCommunityEditPublication(
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

        const propsAfterEdit = remeda.pick(this, remeda.keys.strict(editProps.communityEdit));
        log("Current props from community edit (not edited yet)", propsAfterEdit);
        lodashDeepMerge(propsAfterEdit, editProps.communityEdit);
        await this.edit(propsAfterEdit);
        return undefined;
    }

    private isPublicationReply(publication: CommentPubsubMessagePublication): publication is ReplyPubsubMessageWithCommunityAuthor {
        return Boolean(publication.parentCid);
    }

    private isPublicationPost(publication: CommentPubsubMessagePublication): publication is PostPubsubMessageWithCommunityAuthor {
        return !publication.parentCid;
    }

    private async _calculateLinkProps(
        link: CommentPubsubMessagePublication["link"]
    ): Promise<Pick<CommentIpfsType, "thumbnailUrl" | "thumbnailUrlWidth" | "thumbnailUrlHeight"> | undefined> {
        if (!link || !this.settings?.fetchThumbnailUrls) return undefined;
        return getThumbnailPropsOfLink(link, this, this.settings.fetchThumbnailUrlsProxyUrl);
    }

    private async _calculateLatestPostProps(): Promise<Pick<CommentIpfsType, "previousCid" | "depth">> {
        this._dbHandler.createTransaction();
        const previousCid = this._dbHandler.queryLatestPostCid()?.cid;
        this._dbHandler.commitTransaction();
        return { depth: 0, previousCid };
    }

    private async _calculateReplyProps(
        comment: CommentPubsubMessagePublication
    ): Promise<Pick<CommentIpfsType, "previousCid" | "depth" | "postCid">> {
        if (!comment.parentCid) throw Error("Reply has to have parentCid");

        this._dbHandler.createTransaction();
        const commentsUnderParent = this._dbHandler.queryCommentsUnderComment(comment.parentCid);
        const parent = this._dbHandler.queryComment(comment.parentCid);
        this._dbHandler.commitTransaction();

        if (!parent) throw Error("Failed to find parent of reply");

        return {
            depth: parent.depth + 1,
            postCid: parent.postCid,
            previousCid: commentsUnderParent[0]?.cid
        };
    }

    private async _resolveAliasPrivateKeyForCommentPublication(opts: {
        mode: PseudonymityAliasRow["mode"];
        originalAuthorSignerPublicKey: PseudonymityAliasRow["originalAuthorSignerPublicKey"];
        postCid?: string;
    }): Promise<string> {
        if (opts.mode === "per-post") {
            // For a new post (no postCid yet), always generate a fresh alias; once stored the postCid will be used for reuse.
            if (opts.postCid) {
                const existing = this._dbHandler.queryPseudonymityAliasForPost(opts.originalAuthorSignerPublicKey, opts.postCid);
                if (existing?.aliasPrivateKey) return existing.aliasPrivateKey;
            }
            return (await this._pkc.createSigner()).privateKey;
        } else if (opts.mode === "per-reply") {
            const signer = await this._pkc.createSigner();
            return signer.privateKey;
        } else if (opts.mode === "per-author") {
            const existing = this._dbHandler.queryPseudonymityAliasForAuthor(opts.originalAuthorSignerPublicKey);
            if (existing?.aliasPrivateKey) return existing.aliasPrivateKey;
            const signer = await this._pkc.createSigner();
            return signer.privateKey;
        } else throw Error(`Unsupported pseudonymityMode (${opts.mode})`);
    }

    private async _prepareCommentWithAnonymity(originalComment: CommentPubsubMessagePublication): Promise<{
        publication: CommentPubsubMessagePublication;
        anonymity?: {
            aliasPrivateKey: PseudonymityAliasRow["aliasPrivateKey"];
            originalAuthorSignerPublicKey: PseudonymityAliasRow["originalAuthorSignerPublicKey"];
            mode: PseudonymityAliasRow["mode"];
            originalComment: CommentPubsubMessagePublication;
        };
    }> {
        const mode = this.features?.pseudonymityMode;
        if (!mode) return { publication: originalComment };

        // Mods (owner, admin, moderator) are never pseudonymized
        const isAuthorMod = await this._isPublicationAuthorPartOfRoles(originalComment, ["owner", "admin", "moderator"]);
        if (isAuthorMod) return { publication: originalComment };

        const originalAuthorSignerPublicKey = originalComment.signature.publicKey;
        const postCid = originalComment.postCid;
        const aliasPrivateKey = await this._resolveAliasPrivateKeyForCommentPublication({
            mode,
            originalAuthorSignerPublicKey,
            postCid
        });
        const aliasSigner = await this._pkc.createSigner({ privateKey: aliasPrivateKey, type: "ed25519" });
        const displayName = originalComment.author?.displayName;
        const sanitizedAuthor = cleanWireAuthor(displayName !== undefined ? { displayName } : undefined);

        const anonymizedComment = remeda.clone(originalComment);

        if (sanitizedAuthor !== undefined) {
            anonymizedComment.author = sanitizedAuthor;
        } else {
            delete anonymizedComment.author;
        }
        anonymizedComment.signature = await signComment({
            comment: { ...anonymizedComment, signer: aliasSigner, communityAddress: this.address },
            pkc: this._pkc
        });

        return {
            publication: anonymizedComment,
            anonymity: {
                aliasPrivateKey,
                originalAuthorSignerPublicKey,
                mode,
                originalComment
            }
        };
    }

    private async _prepareCommentEditWithAlias(originalEdit: CommentEditPubsubMessagePublication) {
        const aliasSignerOfComment = this._dbHandler.queryPseudonymityAliasByCommentCid(originalEdit.commentCid);
        if (!aliasSignerOfComment) return originalEdit;

        const aliasSigner = await this._pkc.createSigner({
            privateKey: aliasSignerOfComment.aliasPrivateKey,
            type: "ed25519"
        });
        const commentEditSignedByAlias = remeda.clone(originalEdit);
        delete commentEditSignedByAlias.author;
        commentEditSignedByAlias.signature = await signCommentEdit({
            edit: { ...commentEditSignedByAlias, signer: aliasSigner, communityAddress: this.address },
            pkc: this._pkc
        });

        return commentEditSignedByAlias;
    }

    private async storeComment(opts: {
        commentPubsub: CommentPubsubMessagePublication;
        pendingApproval?: boolean;
        pseudonymityMode?: PseudonymityAliasRow["mode"];
        originalCommentSignatureEncoded?: string;
    }): Promise<{ comment: CommentIpfsType; cid: CommentUpdateType["cid"] }> {
        const { commentPubsub, pendingApproval, pseudonymityMode, originalCommentSignatureEncoded } = opts;
        const log = Logger("pkc-js:local-community:handleChallengeExchange:storeComment");

        const commentIpfs = <CommentIpfsType>{
            ...commentPubsub,
            ...(await this._calculateLinkProps(commentPubsub.link)),
            ...(this.isPublicationPost(commentPubsub) && (await this._calculateLatestPostProps())),
            ...(this.isPublicationReply(commentPubsub) && (await this._calculateReplyProps(commentPubsub))),
            ...(pseudonymityMode ? { pseudonymityMode } : {})
        };

        // Normalize to new wire format: ensure communityPublicKey/communityName, remove old communityAddress
        commentIpfs.communityPublicKey = this.signer.address;
        if (isStringDomain(this.address)) commentIpfs.communityName = this.address;
        delete (commentIpfs as Record<string, unknown>).communityAddress;

        // Strip runtime-only author fields (nameResolved, address, publicKey, etc.) before IPFS storage
        commentIpfs.author = cleanWireAuthor(commentIpfs.author);

        const ipfsClient = this._clientsManager.getDefaultKuboRpcClient();

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
            this._dbHandler.hasCommentWithSignatureEncoded(signatureEncoded)
        );
        if (isCommentDuplicate) {
            this._cidsToUnPin.add(commentCid);
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
        this._dbHandler.createTransaction();
        try {
            if (!pendingApproval) {
                const { number, postNumber } = this._dbHandler.getNextCommentNumbers(commentRow.depth);
                commentRow.number = number;
                if (typeof postNumber === "number") commentRow.postNumber = postNumber;
            }
            this._dbHandler.insertComments([commentRow]);
            if (typeof this.settings?.maxPendingApprovalCount === "number")
                this._dbHandler.removeOldestPendingCommentIfWeHitMaxPendingCount(this.settings.maxPendingApprovalCount);
            this._dbHandler.commitTransaction();
        } catch (e) {
            this._dbHandler.rollbackTransaction();
            throw e;
        }
        log("Inserted comment", commentRow.cid, "into db", "with props", commentRow);

        return { comment: commentIpfs, cid: commentCid };
    }

    private async storePublication(request: DecryptedChallengeRequestMessageType, pendingApproval?: boolean) {
        if (request.vote) return this.storeVote(request.vote, request.challengeRequestId);
        else if (request.commentEdit) {
            const commentEditWithAlias = await this._prepareCommentEditWithAlias(request.commentEdit);
            return this.storeCommentEdit(commentEditWithAlias, request.challengeRequestId);
        } else if (request.commentModeration) return this.storeCommentModeration(request.commentModeration, request.challengeRequestId);
        else if (request.comment) {
            const originalCommentSignatureEncoded = request.comment.signature.signature;
            const { publication, anonymity } = await this._prepareCommentWithAnonymity(request.comment);
            const storedComment = await this.storeComment({
                commentPubsub: publication,
                pendingApproval,
                pseudonymityMode: anonymity?.mode,
                originalCommentSignatureEncoded: anonymity ? originalCommentSignatureEncoded : undefined
            });

            if (anonymity)
                this._dbHandler.insertPseudonymityAliases([
                    {
                        commentCid: storedComment.cid,
                        aliasPrivateKey: anonymity.aliasPrivateKey,
                        originalAuthorSignerPublicKey: anonymity.originalAuthorSignerPublicKey,
                        originalAuthorDomain: getAuthorDomainFromWire(anonymity.originalComment.author) || null,
                        mode: anonymity.mode,
                        insertedAt: timestamp()
                    }
                ]);

            return storedComment;
        } else if (request.communityEdit) return this.storeCommunityEditPublication(request.communityEdit, request.challengeRequestId);
        else throw Error("Don't know how to store this publication" + request);
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

    private async _respondWithErrorIfSignatureOfPublicationIsInvalid(request: DecryptedChallengeRequestMessageType): Promise<void> {
        let validity: ValidationResult;
        if (request.comment)
            validity = await verifyCommentPubsubMessage({
                comment: request.comment,
                resolveAuthorNames: this._pkc.resolveAuthorNames,
                clientsManager: this._clientsManager
            });
        else if (request.commentEdit)
            validity = await verifyCommentEdit({
                edit: request.commentEdit,
                resolveAuthorNames: this._pkc.resolveAuthorNames,
                clientsManager: this._clientsManager
            });
        else if (request.vote)
            validity = await verifyVote({
                vote: request.vote,
                resolveAuthorNames: this._pkc.resolveAuthorNames,
                clientsManager: this._clientsManager
            });
        else if (request.commentModeration)
            validity = await verifyCommentModeration({
                moderation: request.commentModeration,
                resolveAuthorNames: this._pkc.resolveAuthorNames,
                clientsManager: this._clientsManager
            });
        else if (request.communityEdit)
            validity = await verifyCommunityEdit({
                communityEdit: request.communityEdit,
                resolveAuthorNames: this._pkc.resolveAuthorNames,
                clientsManager: this._clientsManager
            });
        else throw Error("Can't detect the type of publication");

        if (!validity.valid) {
            await this._publishFailedChallengeVerification({ reason: validity.reason }, request.challengeRequestId);
            throw new PKCError(getErrorCodeFromMessage(validity.reason), { request, validity });
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
            await this._clientsManager.pubsubPublish(this.pubsubTopicWithfallback(), challengeMessage);
        log(
            `Community ${this.address} with pubsub topic ${this.pubsubTopicWithfallback()} published ${challengeMessage.type} over pubsub: `,
            remeda.pick(toSignChallenge, ["timestamp"]),
            toEncryptChallenge.challenges.map((challenge) => challenge.type)
        );
        this._clientsManager.updateKuboRpcPubsubState("waiting-challenge-answers", pubsubClient.url);
        this.emit("challenge", {
            ...challengeMessage,
            challenges
        });
    }

    private async _publishFailedChallengeVerification(
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
            `Will publish ${challengeVerification.type} over pubsub topic ${this.pubsubTopicWithfallback()} on community ${this.address}:`,
            remeda.omit(toSignVerification, ["challengeRequestId"])
        );

        if (!this._challengeExchangesFromLocalPublishers[challengeRequestId.toString()])
            await this._clientsManager.pubsubPublish(this.pubsubTopicWithfallback(), challengeVerification);
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
            const authorDomain = getAuthorDomainFromWire(existingComment.author);
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
            await this._clientsManager.pubsubPublish(this.pubsubTopicWithfallback(), challengeVerification);
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
        const commentAfterAddingToIpfs = await this.storePublication(request, pendingApproval);
        if (!commentAfterAddingToIpfs) return undefined;
        const authorSignerAddress = await getPKCAddressFromPublicKey(commentAfterAddingToIpfs.comment.signature.publicKey);
        const authorDomain = getAuthorDomainFromWire(commentAfterAddingToIpfs.comment.author);

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
                await this._clientsManager.pubsubPublish(this.pubsubTopicWithfallback(), challengeVerification);

            this._clientsManager.updateKuboRpcPubsubState("waiting-challenge-requests", pubsubClient.url);

            const objectToEmit = <DecryptedChallengeVerificationMessageType>{ ...challengeVerification, ...toEncrypt };
            this.emit("challengeverification", objectToEmit);
            this._ongoingChallengeExchanges.delete(request.challengeRequestId.toString());
            delete this._challengeExchangesFromLocalPublishers[request.challengeRequestId.toString()];
            this._cleanUpChallengeAnswerPromise(request.challengeRequestId.toString());
            log.trace(
                `Published ${challengeVerification.type} over pubsub topic ${this.pubsubTopicWithfallback()}:`,
                remeda.omit(objectToEmit, ["signature", "encrypted", "challengeRequestId"])
            );
        }
    }

    private async _isPublicationAuthorPartOfRoles(
        publication: Pick<CommentModerationPubsubMessagePublication, "author" | "signature">,
        rolesToCheckAgainst: CommunityRoleNameUnion[]
    ): Promise<boolean> {
        if (!this.roles) return false;
        // is the author of publication a moderator?
        const signerAddress = await getPKCAddressFromPublicKey(publication.signature.publicKey);
        if (rolesToCheckAgainst.includes(this.roles[signerAddress]?.role as CommunityRoleNameUnion)) return true;

        const authorName = getAuthorNameFromWire(publication.author);
        if (typeof authorName === "string") {
            if (rolesToCheckAgainst.includes(this.roles[authorName]?.role as CommunityRoleNameUnion)) return true;
            if (this._pkc.resolveAuthorNames && isStringDomain(authorName)) {
                const resolvedSignerAddress = await this._pkc.resolveAuthorName({ address: authorName });
                if (resolvedSignerAddress !== signerAddress) return false;
                if (rolesToCheckAgainst.includes(this.roles[resolvedSignerAddress]?.role as CommunityRoleNameUnion)) return true;
            }
        }
        return false;
    }

    private async _checkPublicationValidity(
        request: DecryptedChallengeRequestMessageType,
        publication: PublicationFromDecryptedChallengeRequest,
        authorCommunity?: PublicationWithCommunityAuthorFromDecryptedChallengeRequest["author"]["community"]
    ): Promise<messages | undefined> {
        const log = Logger("pkc-js:local-community:handleChallengeRequest:checkPublicationValidity");

        // Reject deprecated old wire format fields
        if ("subplebbitAddress" in publication) return messages.ERR_PUBLICATION_USES_DEPRECATED_SUBPLEBBIT_ADDRESS;
        if ("communityAddress" in publication) return messages.ERR_PUBLICATION_USES_DEPRECATED_COMMUNITY_ADDRESS;

        // communityPublicKey must be present and match this community's IPNS key
        const pubCommunityPublicKey = getCommunityPublicKeyFromWire(publication as Record<string, unknown>);
        if (!pubCommunityPublicKey || pubCommunityPublicKey !== this.signer.address)
            return messages.ERR_PUBLICATION_INVALID_COMMUNITY_PUBLIC_KEY;

        // communityName, if present, must match this community's address
        const pubCommunityName = getCommunityNameFromWire(publication as Record<string, unknown>);
        if (pubCommunityName && pubCommunityName !== this.address) return messages.ERR_PUBLICATION_INVALID_COMMUNITY_NAME;

        if (publication.timestamp <= timestamp() - 5 * 60 || publication.timestamp >= timestamp() + 5 * 60)
            return messages.ERR_PUBLICATION_TIMESTAMP_IS_NOT_IN_PROPER_RANGE;

        if (typeof authorCommunity?.banExpiresAt === "number" && authorCommunity.banExpiresAt > timestamp())
            return messages.ERR_AUTHOR_IS_BANNED;

        if (publication.author && remeda.intersection(remeda.keys.strict(publication.author), AuthorReservedFields).length > 0)
            return messages.ERR_PUBLICATION_AUTHOR_HAS_RESERVED_FIELD;

        // Reject publications with non-domain author.name — author.name must be a domain or absent
        const authorName = getAuthorNameFromWire(publication.author);
        if (authorName && !isStringDomain(authorName)) {
            log("Rejecting publication: author.name is not a domain", authorName);
            return messages.ERR_AUTHOR_NAME_MUST_BE_A_DOMAIN;
        }

        // Reject publications with author domains that can't be resolved or don't match the signer
        if (authorName && isStringDomain(authorName) && this._pkc.resolveAuthorNames) {
            let resolvedAddress: string | null;
            try {
                resolvedAddress = await this._clientsManager.resolveAuthorNameIfNeeded({ authorAddress: authorName });
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

        if ("commentCid" in publication || "parentCid" in publication) {
            // vote or reply or commentEdit or commentModeration
            // not post though
            //@ts-expect-error
            const parentCid: string | undefined = publication.parentCid || publication.commentCid;

            if (typeof parentCid !== "string") return messages.ERR_COMMUNITY_PUBLICATION_PARENT_CID_NOT_DEFINED;

            const parent = this._dbHandler.queryComment(parentCid);
            if (!parent) return messages.ERR_PUBLICATION_PARENT_DOES_NOT_EXIST_IN_COMMUNITY;

            const parentFlags = this._dbHandler.queryCommentFlagsSetByMod(parentCid);

            if (parentFlags.removed && !request.commentModeration)
                // not allowed to vote or reply under removed comments
                return messages.ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_REMOVED;

            const isParentDeletedQueryRes = this._dbHandler.queryAuthorEditDeleted(parentCid);

            if (isParentDeletedQueryRes?.deleted && !request.commentModeration)
                return messages.ERR_COMMUNITY_PUBLICATION_PARENT_HAS_BEEN_DELETED; // not allowed to vote or reply under deleted comments

            const postFlags = this._dbHandler.queryCommentFlagsSetByMod(parent.postCid);

            if (postFlags.removed && !request.commentModeration) return messages.ERR_COMMUNITY_PUBLICATION_POST_HAS_BEEN_REMOVED;

            const isPostDeletedQueryRes = this._dbHandler.queryAuthorEditDeleted(parent.postCid);

            if (isPostDeletedQueryRes?.deleted && !request.commentModeration)
                return messages.ERR_COMMUNITY_PUBLICATION_POST_HAS_BEEN_DELETED;

            if (postFlags.locked && !request.commentModeration) return messages.ERR_COMMUNITY_PUBLICATION_POST_IS_LOCKED;

            if (postFlags.archived && !request.commentModeration) return messages.ERR_COMMUNITY_PUBLICATION_POST_IS_ARCHIVED;

            if (parent.timestamp > publication.timestamp) return messages.ERR_COMMUNITY_COMMENT_TIMESTAMP_IS_EARLIER_THAN_PARENT;

            // if user publishes vote/reply/commentEdit under pending comment, it should fail
            if (parent.pendingApproval && !("commentModeration" in request) && !(request.commentEdit?.deleted === true))
                return messages.ERR_USER_PUBLISHED_UNDER_PENDING_COMMENT;

            const isCommentDisapproved = this._dbHandler._queryIsCommentApproved(parent);
            if (
                isCommentDisapproved &&
                !isCommentDisapproved.approved &&
                !("commentModeration" in request) &&
                !(request.commentEdit?.deleted === true)
            )
                return messages.ERR_USER_PUBLISHED_UNDER_DISAPPROVED_COMMENT;
        }

        // Reject publications if their size is over 40kb
        const publicationKilobyteSize = Buffer.byteLength(JSON.stringify(publication)) / 1000;

        if (publicationKilobyteSize > 40) return messages.ERR_REQUEST_PUBLICATION_OVER_ALLOWED_SIZE;

        if (request.comment) {
            const commentPublication = request.comment;
            if (remeda.intersection(remeda.keys.strict(commentPublication), CommentPubsubMessageReservedFields).length > 0)
                return messages.ERR_COMMENT_HAS_RESERVED_FIELD;
            if (
                this.features?.requirePostLink &&
                !commentPublication.parentCid &&
                (!commentPublication.link || (!this.features?.requirePostLinkIsMedia && !isLinkValid(commentPublication.link)))
            )
                return messages.ERR_COMMENT_HAS_INVALID_LINK_FIELD;
            if (
                this.features?.requirePostLinkIsMedia &&
                commentPublication.link &&
                (!isLinkValid(commentPublication.link) || !isLinkOfMedia(commentPublication.link))
            )
                return messages.ERR_POST_LINK_IS_NOT_OF_MEDIA;
            if (
                this.features?.requireReplyLink &&
                commentPublication.parentCid &&
                (!commentPublication.link || (!this.features?.requireReplyLinkIsMedia && !isLinkValid(commentPublication.link)))
            )
                return messages.ERR_REPLY_HAS_INVALID_LINK_FIELD;
            if (
                this.features?.requireReplyLinkIsMedia &&
                commentPublication.parentCid &&
                commentPublication.link &&
                (!isLinkValid(commentPublication.link) || !isLinkOfMedia(commentPublication.link))
            )
                return messages.ERR_REPLY_LINK_IS_NOT_OF_MEDIA;

            if (this.features?.noMarkdownImages && commentPublication.content && contentContainsMarkdownImages(commentPublication.content))
                return messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_IMAGE;

            if (this.features?.noMarkdownVideos && commentPublication.content && contentContainsMarkdownVideos(commentPublication.content))
                return messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_VIDEO;

            if (this.features?.noMarkdownAudio && commentPublication.content && contentContainsMarkdownAudio(commentPublication.content))
                return messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_AUDIO;

            // noImages - block ALL comments with image links
            if (this.features?.noImages && commentPublication.link && isLinkOfImage(commentPublication.link))
                return messages.ERR_COMMENT_HAS_LINK_THAT_IS_IMAGE;

            // noVideos - block ALL comments with video links (including animated images like GIF/APNG)
            if (
                this.features?.noVideos &&
                commentPublication.link &&
                (isLinkOfVideo(commentPublication.link) || isLinkOfAnimatedImage(commentPublication.link))
            )
                return messages.ERR_COMMENT_HAS_LINK_THAT_IS_VIDEO;

            // noSpoilers - block ALL comments with spoiler=true
            if (this.features?.noSpoilers && commentPublication.spoiler === true) return messages.ERR_COMMENT_HAS_SPOILER_ENABLED;

            // noImageReplies - block only replies with image links
            if (
                this.features?.noImageReplies &&
                commentPublication.parentCid &&
                commentPublication.link &&
                isLinkOfImage(commentPublication.link)
            )
                return messages.ERR_REPLY_HAS_LINK_THAT_IS_IMAGE;

            // noVideoReplies - block only replies with video links (including animated images like GIF/APNG)
            if (
                this.features?.noVideoReplies &&
                commentPublication.parentCid &&
                commentPublication.link &&
                (isLinkOfVideo(commentPublication.link) || isLinkOfAnimatedImage(commentPublication.link))
            )
                return messages.ERR_REPLY_HAS_LINK_THAT_IS_VIDEO;

            // noAudio - block ALL comments with audio links
            if (this.features?.noAudio && commentPublication.link && isLinkOfAudio(commentPublication.link))
                return messages.ERR_COMMENT_HAS_LINK_THAT_IS_AUDIO;

            // noAudioReplies - block only replies with audio links
            if (
                this.features?.noAudioReplies &&
                commentPublication.parentCid &&
                commentPublication.link &&
                isLinkOfAudio(commentPublication.link)
            )
                return messages.ERR_REPLY_HAS_LINK_THAT_IS_AUDIO;

            // noSpoilerReplies - block only replies with spoiler=true
            if (this.features?.noSpoilerReplies && commentPublication.parentCid && commentPublication.spoiler === true)
                return messages.ERR_REPLY_HAS_SPOILER_ENABLED;

            // noNestedReplies - block replies with depth > 1 (replies to replies)
            if (this.features?.noNestedReplies && commentPublication.parentCid) {
                const parent = this._dbHandler.queryComment(commentPublication.parentCid);
                if (parent && parent.depth > 0) {
                    return messages.ERR_NESTED_REPLIES_NOT_ALLOWED;
                }
            }

            // Post flairs validation (comment.flairs)
            if (commentPublication.flairs && commentPublication.flairs.length > 0) {
                if (!this.features?.postFlairs) {
                    return messages.ERR_POST_FLAIRS_NOT_ALLOWED;
                }
                const allowedPostFlairs = this.flairs?.["post"] || [];
                for (const flair of commentPublication.flairs) {
                    if (!this._isFlairInAllowedList(flair, allowedPostFlairs)) {
                        return messages.ERR_POST_FLAIR_NOT_IN_ALLOWED_FLAIRS;
                    }
                }
            }

            // requirePostFlairs - only for posts (depth=0)
            if (this.features?.requirePostFlairs && !commentPublication.parentCid) {
                if (!commentPublication.flairs || commentPublication.flairs.length === 0) {
                    return messages.ERR_POST_FLAIRS_REQUIRED;
                }
            }

            // Author flairs validation (comment.author.flairs)
            if (commentPublication.author?.flairs && commentPublication.author.flairs.length > 0 && !this.features?.pseudonymityMode) {
                if (!this.features?.authorFlairs) {
                    return messages.ERR_AUTHOR_FLAIRS_NOT_ALLOWED;
                }
                const allowedAuthorFlairs = this.flairs?.["author"] || [];
                for (const flair of commentPublication.author.flairs) {
                    if (!this._isFlairInAllowedList(flair, allowedAuthorFlairs)) {
                        return messages.ERR_AUTHOR_FLAIR_NOT_IN_ALLOWED_FLAIRS;
                    }
                }
            }

            // requireAuthorFlairs - for all comments (posts and replies)
            if (this.features?.requireAuthorFlairs && !this.features?.pseudonymityMode) {
                if (!commentPublication.author?.flairs || commentPublication.author.flairs.length === 0) {
                    return messages.ERR_AUTHOR_FLAIRS_REQUIRED;
                }
            }

            if (commentPublication.parentCid && !commentPublication.postCid) return messages.ERR_REPLY_HAS_NOT_DEFINED_POST_CID;

            if (commentPublication.parentCid) {
                // query parents, and make sure commentPublication.postCid is the final parent
                const parentsOfComment = this._dbHandler.queryParentsCids({ parentCid: commentPublication.parentCid });
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
                    const quotedComment = this._dbHandler.queryComment(quotedCid);
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

            const isCommentDuplicate = this._dbHandler.hasCommentWithSignatureEncoded(commentPublication.signature.signature);
            if (isCommentDuplicate) return messages.ERR_DUPLICATE_COMMENT;
        } else if (request.vote) {
            const votePublication = request.vote;
            if (remeda.intersection(VotePubsubReservedFields, remeda.keys.strict(votePublication)).length > 0)
                return messages.ERR_VOTE_HAS_RESERVED_FIELD;
            if (this.features?.noUpvotes && votePublication.vote === 1) return messages.ERR_NOT_ALLOWED_TO_PUBLISH_UPVOTES;
            if (this.features?.noDownvotes && votePublication.vote === -1) return messages.ERR_NOT_ALLOWED_TO_PUBLISH_DOWNVOTES;

            const commentToVoteOn = this._dbHandler.queryComment(request.vote.commentCid)!;

            if (this.features?.noPostDownvotes && commentToVoteOn!.depth === 0 && votePublication.vote === -1)
                return messages.ERR_NOT_ALLOWED_TO_PUBLISH_POST_DOWNVOTES;
            if (this.features?.noPostUpvotes && commentToVoteOn!.depth === 0 && votePublication.vote === 1)
                return messages.ERR_NOT_ALLOWED_TO_PUBLISH_POST_UPVOTES;

            if (this.features?.noReplyDownvotes && commentToVoteOn!.depth > 0 && votePublication.vote === -1)
                return messages.ERR_NOT_ALLOWED_TO_PUBLISH_REPLY_DOWNVOTES;
            if (this.features?.noReplyUpvotes && commentToVoteOn!.depth > 0 && votePublication.vote === 1)
                return messages.ERR_NOT_ALLOWED_TO_PUBLISH_REPLY_UPVOTES;

            const voteAuthorSignerAddress = await getPKCAddressFromPublicKey(votePublication.signature.publicKey);
            const previousVote = this._dbHandler.queryVote(commentToVoteOn!.cid, voteAuthorSignerAddress);
            if (!previousVote && votePublication.vote === 0) return messages.ERR_THERE_IS_NO_PREVIOUS_VOTE_TO_CANCEL;
        } else if (request.commentModeration) {
            const commentModerationPublication = request.commentModeration;
            if (remeda.intersection(CommentModerationReservedFields, remeda.keys.strict(commentModerationPublication)).length > 0)
                return messages.ERR_COMMENT_MODERATION_HAS_RESERVED_FIELD;

            const isAuthorMod = await this._isPublicationAuthorPartOfRoles(commentModerationPublication, ["owner", "moderator", "admin"]);

            if (!isAuthorMod) return messages.ERR_COMMENT_MODERATION_ATTEMPTED_WITHOUT_BEING_MODERATOR;

            const commentToBeEdited = this._dbHandler.queryComment(commentModerationPublication.commentCid); // We assume commentToBeEdited to be defined because we already tested for its existence above
            if (!commentToBeEdited) return messages.ERR_COMMENT_MODERATION_NO_COMMENT_TO_EDIT;

            if (isAuthorMod && commentModerationPublication.commentModeration.locked && commentToBeEdited.depth !== 0)
                return messages.ERR_COMMUNITY_COMMENT_MOD_CAN_NOT_LOCK_REPLY;
            if (isAuthorMod && commentModerationPublication.commentModeration.archived && commentToBeEdited.depth !== 0)
                return messages.ERR_COMMUNITY_COMMENT_MOD_CAN_NOT_ARCHIVE_REPLY;
            const commentModInDb = this._dbHandler.hasCommentModerationWithSignatureEncoded(
                commentModerationPublication.signature.signature
            );
            if (commentModInDb) return messages.ERR_DUPLICATE_COMMENT_MODERATION;
            if ("approved" in commentModerationPublication.commentModeration && !commentToBeEdited.pendingApproval)
                return messages.ERR_MOD_ATTEMPTING_TO_APPROVE_OR_DISAPPROVE_COMMENT_THAT_IS_NOT_PENDING;
        } else if (request.communityEdit) {
            const communityEdit = request.communityEdit;
            if (remeda.intersection(CommunityEditPublicationPubsubReservedFields, remeda.keys.strict(communityEdit)).length > 0)
                return messages.ERR_COMMUNITY_EDIT_HAS_RESERVED_FIELD;

            if (communityEdit.communityEdit.roles || communityEdit.communityEdit.address) {
                const isAuthorOwner = await this._isPublicationAuthorPartOfRoles(communityEdit, ["owner"]);
                if (!isAuthorOwner) return messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_OWNER_EXCLUSIVE_PROPS;
            }

            const isAuthorOwnerOrAdmin = await this._isPublicationAuthorPartOfRoles(communityEdit, ["owner", "admin"]);
            if (!isAuthorOwnerOrAdmin) {
                return messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_MODIFY_COMMUNITY_WITHOUT_BEING_OWNER_OR_ADMIN;
            }

            const allowedCommunityEditKeys = [...remeda.keys.strict(CommunityIpfsSchema.shape), "address"] as string[];
            if (remeda.difference(remeda.keys.strict(communityEdit.communityEdit), allowedCommunityEditKeys).length > 0) {
                // should only be allowed to modify public props from CommunityIpfs
                // shouldn't be able to modify settings for example
                return messages.ERR_COMMUNITY_EDIT_ATTEMPTED_TO_NON_PUBLIC_PROPS;
            }
        } else if (request.commentEdit) {
            const commentEditPublication = request.commentEdit;
            if (remeda.intersection(CommentEditReservedFields, remeda.keys.strict(commentEditPublication)).length > 0)
                return messages.ERR_COMMENT_EDIT_HAS_RESERVED_FIELD;

            const commentToBeEdited = this._dbHandler.queryComment(commentEditPublication.commentCid); // We assume commentToBeEdited to be defined because we already tested for its existence above
            if (!commentToBeEdited) return messages.ERR_COMMENT_EDIT_NO_COMMENT_TO_EDIT;

            const commentEditInDb = this._dbHandler.hasCommentEditWithSignatureEncoded(commentEditPublication.signature.signature);
            if (commentEditInDb) return messages.ERR_DUPLICATE_COMMENT_EDIT;

            const aliasSignerOfComment = this._dbHandler.queryPseudonymityAliasByCommentCid(commentToBeEdited.cid);
            if (aliasSignerOfComment) {
                const editSignedByOriginalAuthor =
                    commentEditPublication.signature.publicKey === aliasSignerOfComment.originalAuthorSignerPublicKey;
                if (!editSignedByOriginalAuthor) return messages.ERR_COMMENT_EDIT_CAN_NOT_EDIT_COMMENT_IF_NOT_ORIGINAL_AUTHOR;
            } else {
                const editSignedByOriginalAuthor = commentEditPublication.signature.publicKey === commentToBeEdited.signature.publicKey;

                if (!editSignedByOriginalAuthor) return messages.ERR_COMMENT_EDIT_CAN_NOT_EDIT_COMMENT_IF_NOT_ORIGINAL_AUTHOR;
            }

            // Validate markdown content restrictions for comment edits
            if (
                this.features?.noMarkdownImages &&
                commentEditPublication.content &&
                contentContainsMarkdownImages(commentEditPublication.content)
            )
                return messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_IMAGE;

            if (
                this.features?.noMarkdownVideos &&
                commentEditPublication.content &&
                contentContainsMarkdownVideos(commentEditPublication.content)
            )
                return messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_VIDEO;

            if (
                this.features?.noMarkdownAudio &&
                commentEditPublication.content &&
                contentContainsMarkdownAudio(commentEditPublication.content)
            )
                return messages.ERR_COMMENT_CONTENT_CONTAINS_MARKDOWN_AUDIO;

            // noSpoilers - block ALL comment edits that set spoiler=true
            if (this.features?.noSpoilers && commentEditPublication.spoiler === true) return messages.ERR_COMMENT_HAS_SPOILER_ENABLED;

            // noSpoilerReplies - block only reply edits that set spoiler=true
            if (this.features?.noSpoilerReplies && commentToBeEdited.depth > 0 && commentEditPublication.spoiler === true)
                return messages.ERR_REPLY_HAS_SPOILER_ENABLED;

            // Post flairs validation for comment edits
            if (commentEditPublication.flairs && commentEditPublication.flairs.length > 0) {
                if (!this.features?.postFlairs) {
                    return messages.ERR_POST_FLAIRS_NOT_ALLOWED;
                }
                const allowedPostFlairs = this.flairs?.["post"] || [];
                for (const flair of commentEditPublication.flairs) {
                    if (!this._isFlairInAllowedList(flair, allowedPostFlairs)) {
                        return messages.ERR_POST_FLAIR_NOT_IN_ALLOWED_FLAIRS;
                    }
                }
            }
        }

        return undefined;
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
        const authorDomain = getAuthorDomainFromWire(publication.author);

        // Check publication props validity
        const communityAuthor = this._dbHandler.queryCommunityAuthor(authorSignerAddress, authorDomain);
        const decryptedRequestMsg = <DecryptedChallengeRequestMessageType>{ ...request, ...decryptedRequest };
        const decryptedRequestWithCommunityAuthor = this._buildRuntimeChallengeRequest({
            request: decryptedRequestMsg,
            authorCommunity: communityAuthor
        });

        try {
            await this._respondWithErrorIfSignatureOfPublicationIsInvalid(decryptedRequestMsg); // This function will throw an error if signature is invalid
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

        const publicationInvalidityReason = await this._checkPublicationValidity(decryptedRequestMsg, publication, communityAuthor);
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
            challengeVerification = await getChallengeVerification(decryptedRequestWithCommunityAuthor, this, getChallengeAnswers);
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

    private _isFlairInAllowedList(flair: Flair, allowedFlairs: Flair[]): boolean {
        return allowedFlairs.some((allowed) => remeda.isDeepEqual(allowed, flair));
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

    private async handleChallengeExchange(pubsubMsg: IpfsHttpClientPubsubMessage) {
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

    private _calculateLocalMfsPathForCommentUpdate(postDbComment: Pick<CommentsTableRow, "cid">, timestampRange: number) {
        // TODO Can optimize the call below by only asking for timestamp field
        return ["/" + this.address, "postUpdates", timestampRange, postDbComment.cid, "update"].join("/");
    }

    private async _calculateNewCommentUpdate(comment: CommentsTableRow): Promise<CommentUpdateToWriteToDbAndPublishToIpfs> {
        const log = Logger("pkc-js:local-community:_calculateNewCommentUpdate");

        // If we're here that means we're gonna calculate the new update and publish it
        log.trace(`Attempting to calculate new CommentUpdate for comment (${comment.cid}) on community`, this.address);

        // This comment will have the local new CommentUpdate, which we will publish to IPFS fiels
        // It includes new author.community as well as updated values in CommentUpdate (except for replies field)
        const storedCommentUpdate = this._dbHandler.queryStoredCommentUpdate(comment);
        const authorDomain = getAuthorDomainFromWire(comment.author);
        const calculatedCommentUpdate = this._dbHandler.queryCalculatedCommentUpdate({ comment, authorDomain });
        log.trace(
            "Calculated comment update for comment",
            comment.cid,
            "on community",
            this.address,
            "with reply count",
            calculatedCommentUpdate.replyCount
        );

        const currentTimestamp = timestamp();

        const newUpdatedAt =
            typeof storedCommentUpdate?.updatedAt === "number" && storedCommentUpdate.updatedAt >= currentTimestamp
                ? storedCommentUpdate.updatedAt + 1
                : currentTimestamp;

        const commentUpdatePriorToSigning: Omit<CommentUpdateType, "signature"> = {
            ...cleanUpBeforePublishing({
                ...calculatedCommentUpdate,
                updatedAt: newUpdatedAt,
                protocolVersion: env.PROTOCOL_VERSION
            })
        };

        const preloadedRepliesPages = "best";
        const inlineRepliesBudget = calculateInlineRepliesBudget({
            comment,
            commentUpdateWithoutReplies: commentUpdatePriorToSigning
        });
        const adjustedPreloadedRepliesPageSizeBytes = Math.max(inlineRepliesBudget, 1);

        const generatedRepliesPages =
            comment.depth === 0
                ? await this._pageGenerator.generatePostPages(comment, preloadedRepliesPages, adjustedPreloadedRepliesPageSizeBytes)
                : await this._pageGenerator.generateReplyPages(comment, preloadedRepliesPages, adjustedPreloadedRepliesPageSizeBytes);

        // we have to make sure not clean up submissions of authors by calling cleanUpBeforePublishing
        if (generatedRepliesPages) {
            if ("singlePreloadedPage" in generatedRepliesPages)
                commentUpdatePriorToSigning.replies = { pages: generatedRepliesPages.singlePreloadedPage };
            else if (generatedRepliesPages.pageCids) {
                commentUpdatePriorToSigning.replies = {
                    pageCids: generatedRepliesPages.pageCids,
                    pages: remeda.pick(generatedRepliesPages.pages, [preloadedRepliesPages])
                };
            }
        }

        this._addOldPageCidsToCidsToUnpin(storedCommentUpdate?.replies, commentUpdatePriorToSigning.replies).catch((err) =>
            log.error("Failed to add old page cids of comment.replies to _cidsToUnpin", err)
        );

        const newCommentUpdate: CommentUpdateType = {
            ...commentUpdatePriorToSigning,
            signature: await signCommentUpdate({ update: commentUpdatePriorToSigning, signer: this.signer })
        };

        await this._validateCommentUpdateSignature(newCommentUpdate, comment, log);

        const newPostUpdateBucket =
            comment.depth === 0 ? this._postUpdatesBuckets.find((bucket) => timestamp() - bucket <= comment.timestamp) : undefined;
        const newLocalMfsPath =
            typeof newPostUpdateBucket === "number" ? this._calculateLocalMfsPathForCommentUpdate(comment, newPostUpdateBucket) : undefined;

        if (
            storedCommentUpdate?.postUpdatesBucket &&
            newLocalMfsPath &&
            newPostUpdateBucket &&
            storedCommentUpdate.postUpdatesBucket !== newPostUpdateBucket
        ) {
            const oldPostUpdates = this._calculateLocalMfsPathForCommentUpdate(comment, storedCommentUpdate.postUpdatesBucket).replace(
                "/update",
                ""
            );
            this._mfsPathsToRemove.add(oldPostUpdates);
        }
        const newCommentUpdateDbRecord = <CommentUpdatesTableRowInsert>{
            ...newCommentUpdate,
            postUpdatesBucket: newPostUpdateBucket,
            publishedToPostUpdatesMFS: false,

            insertedAt: timestamp()
        };
        if (!generatedRepliesPages) newCommentUpdateDbRecord.replies = undefined;
        return {
            newCommentUpdate,
            newCommentUpdateToWriteToDb: newCommentUpdateDbRecord,
            localMfsPath: newLocalMfsPath,
            pendingApproval: comment.pendingApproval
        };
    }

    private async _validateCommentUpdateSignature(newCommentUpdate: CommentUpdateType, comment: CommentsTableRow, log: Logger) {
        // This function should be deleted at some point, once the protocol ossifies
        const verificationOpts = {
            update: newCommentUpdate,
            resolveAuthorNames: false,
            clientsManager: this._clientsManager,
            community: this,
            comment,
            validatePages: this._pkc.validatePages,
            validateUpdateSignature: true
        };
        const validation = await verifyCommentUpdate(verificationOpts);
        if (!validation.valid) {
            log.error(`CommentUpdate (${comment.cid}) signature is invalid due to (${validation.reason}). This is a critical error`);
            throw new PKCError("ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID", { validation, verificationOpts });
        }
    }

    private async _listenToIncomingRequests() {
        const log = Logger("pkc-js:local-community:sync:_listenToIncomingRequests");
        // Make sure community listens to pubsub topic
        // Code below is to handle in case the ipfs node restarted and the subscription got lost or something
        const pubsubClient = this._clientsManager.getDefaultKuboPubsubClient();
        const subscribedTopics = await pubsubClient._client.pubsub.ls();
        if (!subscribedTopics.includes(this.pubsubTopicWithfallback())) {
            await this._clientsManager.pubsubUnsubscribe(this.pubsubTopicWithfallback(), this.handleChallengeExchange); // Make sure it's not hanging
            await this._clientsManager.pubsubSubscribe(this.pubsubTopicWithfallback(), this.handleChallengeExchange);
            this._clientsManager.updateKuboRpcPubsubState("waiting-challenge-requests", pubsubClient.url);
            log(`Waiting for publications on pubsub topic (${this.pubsubTopicWithfallback()})`);
        }
    }

    private async _movePostUpdatesFolderToNewAddress(oldAddress: string, newAddress: string) {
        const log = Logger("pkc-js:local-community:_movePostUpdatesFolderToNewAddress");
        const kuboRpc = this._clientsManager.getDefaultKuboRpcClient();
        try {
            await kuboRpc._client.files.mv(`/${oldAddress}`, `/${newAddress}`); // Could throw
        } catch (e) {
            if (e instanceof Error && e.message !== "file does not exist") {
                log.error("Failed to move directory of post updates in MFS", this.address, e);
                throw e; // A critical error
            }
        }
    }

    private async _updateCommentsThatNeedToBeUpdated(): Promise<CommentUpdateToWriteToDbAndPublishToIpfs[]> {
        const log = Logger(`pkc-js:local-community:_updateCommentsThatNeedToBeUpdated`);

        // Get all comments that need to be updated
        const commentsToUpdate = this._dbHandler.queryCommentsToBeUpdated();

        if (commentsToUpdate.length === 0) return [];

        this._communityUpdateTrigger = true;
        log(`Will update ${commentsToUpdate.length} comments in this update loop for community (${this.address})`);

        // Group by postCid
        const commentsByPostCid = remeda.groupBy.strict(commentsToUpdate, (x) => x.postCid);
        const allCommentUpdateRows: CommentUpdateToWriteToDbAndPublishToIpfs[] = [];

        // Process different post trees in parallel
        const postLimit = pLimit(10); // Process up to 10 post trees concurrently

        const postProcessingPromises = Object.entries(commentsByPostCid).map(([postCid, commentsForPost]) =>
            postLimit(async () => {
                try {
                    // Group by depth
                    const commentsByDepth = remeda.groupBy.strict(commentsForPost, (x) => x.depth);
                    const depthsKeySorted = remeda.keys.strict(commentsByDepth).sort((a, b) => Number(b) - Number(a)); // Sort depths from highest to lowest

                    const postUpdateRows: CommentUpdateToWriteToDbAndPublishToIpfs[] = [];

                    // Process each depth level in sequence within this post tree
                    for (const depthKey of depthsKeySorted) {
                        const commentsAtDepth = commentsByDepth[depthKey];

                        // Process all comments at this depth in parallel
                        const depthLimit = pLimit(50);

                        // Calculate updates for all comments at this depth in parallel
                        const depthUpdatePromises = commentsAtDepth.map((comment) =>
                            depthLimit(async () => await this._calculateNewCommentUpdate(comment))
                        );

                        // Wait for all comments at this depth to be calculated
                        const depthResults = await Promise.all(depthUpdatePromises);

                        // Batch write all updates for this depth to the database
                        this._dbHandler.upsertCommentUpdates(depthResults.map((r) => r.newCommentUpdateToWriteToDb));

                        // Add to our results
                        postUpdateRows.push(...depthResults);
                    }

                    return postUpdateRows;
                } catch (error) {
                    log.error(`Failed to process post tree ${postCid}:`, error);
                    throw error;
                }
            })
        );

        // Wait for all post trees to be processed
        const postResults = await Promise.all(postProcessingPromises);

        // Collect all results
        for (const result of postResults) {
            allCommentUpdateRows.push(...result);
        }

        return allCommentUpdateRows;
    }

    private async _addCommentRowToIPFS(unpinnedCommentRow: CommentsTableRow, log: Logger) {
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

    private async _repinCommentsIPFSIfNeeded() {
        const log = Logger("pkc-js:local-community:start:_repinCommentsIPFSIfNeeded");
        const latestCommentCid = this._dbHandler.queryLatestCommentCid(); // latest comment ordered by id
        if (!latestCommentCid) return;
        const kuboRpcOrHelia = this._clientsManager.getDefaultKuboRpcClient();
        try {
            await genToArray(kuboRpcOrHelia._client.pin.ls({ paths: latestCommentCid.cid }));
            return; // the comment is already pinned, we assume the rest of the comments are so too
        } catch (e) {
            if (!(<Error>e).message.includes("is not pinned")) throw e;
        }

        log("The latest comment is not pinned in the ipfs node, pkc-js will repin all existing comment ipfs for community", this.address);

        // latestCommentCid should be the last in unpinnedCommentsFromDb array, in case we throw an error on a comment before it, it does not get pinned
        const unpinnedCommentsFromDb = this._dbHandler.queryAllCommentsOrderedByIdAsc(); // we assume all comments are unpinned if latest comment is not pinned

        // In the _repinCommentIpfs method:
        const limit = pLimit(50);
        const pinningPromises = unpinnedCommentsFromDb.map((unpinnedCommentRow) =>
            limit(async () => {
                if (unpinnedCommentRow.pendingApproval) return; // we don't pin comments waiting to get approved
                await this._addCommentRowToIPFS(
                    unpinnedCommentRow,
                    Logger("pkc-js:local-community:start:_repinCommentsIPFSIfNeeded:_addCommentRowToIPFS")
                );
            })
        );

        await Promise.all(pinningPromises);

        this._dbHandler.forceUpdateOnAllComments(); // force pkc-js to republish all comment updates

        log(`${unpinnedCommentsFromDb.length} comments' IPFS have been repinned`);
    }

    private async _unpinStaleCids() {
        const log = Logger("pkc-js:local-community:sync:unpinStaleCids");

        if (this._cidsToUnPin.size > 0) {
            const sizeBefore = this._cidsToUnPin.size;

            // Create a concurrency limiter with a limit of 50
            const limit = pLimit(50);

            const kuboRpc = this._clientsManager.getDefaultKuboRpcClient();
            // Process all unpinning in parallel with concurrency limit
            await Promise.all(
                Array.from(this._cidsToUnPin.values()).map((cid) =>
                    limit(async () => {
                        try {
                            await kuboRpc._client.pin.rm(cid, { recursive: true });
                            this._cidsToUnPin.delete(cid);
                        } catch (e) {
                            const error = <Error>e;
                            if (error.message.startsWith("not pinned")) {
                                this._cidsToUnPin.delete(cid);
                            } else {
                                log.trace("Failed to unpin cid", cid, "on community", this.address, "due to error", error);
                            }
                        }
                    })
                )
            );

            log(`unpinned ${sizeBefore - this._cidsToUnPin.size} stale cids from ipfs node for community (${this.address})`);
        }
    }

    private async _rmUnneededMfsPaths(): Promise<string[]> {
        const log = Logger("pkc-js:local-community:sync:_rmUnneededMfsPaths");

        if (this._mfsPathsToRemove.size > 0) {
            const toDeleteMfsPaths = Array.from(this._mfsPathsToRemove.values());
            const kuboRpc = this._clientsManager.getDefaultKuboRpcClient();
            try {
                await removeMfsFilesSafely({
                    kuboRpcClient: kuboRpc,
                    paths: toDeleteMfsPaths,
                    log
                });
                toDeleteMfsPaths.forEach((path) => this._mfsPathsToRemove.delete(path));
                return toDeleteMfsPaths;
            } catch (e) {
                const error = <Error>e;
                if (error.message.includes("file does not exist"))
                    return toDeleteMfsPaths; // file does not exist, we can return the paths that were not deleted
                else {
                    log.error("Failed to remove paths from MFS", toDeleteMfsPaths, e);
                    throw error;
                }
            }
        } else return [];
    }
    private pubsubTopicWithfallback() {
        return this.pubsubTopic || this.address;
    }

    private async _repinCommentUpdateIfNeeded() {
        const log = Logger("pkc-js:start:_repinCommentUpdateIfNeeded");

        // iterating on all comment updates is not efficient, we should figure out a better way
        // Most of the time we run this function, the comment updates are already written to ipfs rpeo
        const kuboRpc = this._clientsManager.getDefaultKuboRpcClient();
        try {
            await kuboRpc._client.files.stat(`/${this.address}`, { hash: true });
            return; // if the directory of this community exists, we assume all the comment updates are there
        } catch (e) {
            if (!(<Error>e).message.includes("file does not exist")) throw e;
        }

        // community has no comment updates, we can return
        if (!this.lastCommentCid) return;

        log(`CommentUpdate directory`, this.address, "will republish all comment updates");

        this._dbHandler.forceUpdateOnAllComments(); // pkc-js will recalculate and publish all comment updates
    }

    private async _syncPostUpdatesWithIpfs(commentUpdateRowsToPublishToIpfs: CommentUpdateToWriteToDbAndPublishToIpfs[]) {
        const log = Logger("pkc-js:local-community:sync:_syncPostUpdatesFilesystemWithIpfs");

        const postUpdatesDirectory = `/${this.address}`;
        const commentUpdatesWithLocalPath = commentUpdateRowsToPublishToIpfs.filter(
            (row): row is CommentUpdateToWriteToDbAndPublishToIpfs & { localMfsPath: string } => typeof row.localMfsPath === "string"
        );

        if (commentUpdatesWithLocalPath.length === 0)
            throw Error("No comment updates of posts to publish to postUpdates directory. This is a critical bug");

        const kuboRpc = this._clientsManager.getDefaultKuboRpcClient();
        const removedMfsPaths: string[] = await this._rmUnneededMfsPaths();
        let postUpdatesDirectoryCid: Awaited<ReturnType<typeof kuboRpc._client.files.flush>> | undefined;

        const BATCH_SIZE = 50;
        for (let index = 0; index < commentUpdatesWithLocalPath.length; index += BATCH_SIZE) {
            const batch = commentUpdatesWithLocalPath.slice(index, index + BATCH_SIZE);

            await Promise.all(
                batch.map(async (row) => {
                    const { localMfsPath, newCommentUpdate } = row;
                    const content = deterministicStringify(newCommentUpdate);

                    await writeKuboFilesWithTimeout({
                        ipfsClient: kuboRpc._client,
                        log,
                        path: localMfsPath,
                        content,
                        options: {
                            create: true,
                            truncate: true,
                            parents: true,
                            flush: false
                        }
                    });

                    removedMfsPaths.push(localMfsPath);
                })
            );

            postUpdatesDirectoryCid = await kuboRpc._client.files.flush(postUpdatesDirectory);
        }

        const postUpdatesDirectoryCidString = postUpdatesDirectoryCid?.toString();
        log(
            "Community",
            this.address,
            "Synced",
            commentUpdatesWithLocalPath.length,
            "post CommentUpdates",
            "with MFS postUpdates directory",
            postUpdatesDirectoryCidString
        );
        this._dbHandler.markCommentsAsPublishedToPostUpdates(commentUpdateRowsToPublishToIpfs.map((row) => row.newCommentUpdate.cid));
    }

    private async _adjustPostUpdatesBucketsIfNeeded() {
        if (!this.postUpdates) return;
        // Look for posts whose buckets should be changed

        const log = Logger("pkc-js:local-community:start:_adjustPostUpdatesBucketsIfNeeded");
        const postsWithOutdatedPostUpdateBucket = this._dbHandler.queryPostsWithOutdatedBuckets(this._postUpdatesBuckets);
        if (postsWithOutdatedPostUpdateBucket.length === 0) return;

        this._dbHandler.forceUpdateOnAllCommentsWithCid(postsWithOutdatedPostUpdateBucket.map((post) => post.cid));

        log(`Found ${postsWithOutdatedPostUpdateBucket.length} posts with outdated buckets and forced their updates`);
    }

    private async _cleanUpIpfsRepoRarely(force = false) {
        const log = Logger("pkc-js:local-community:syncIpnsWithDb:_cleanUpIpfsRepoRarely");
        if (Math.random() < 0.00001 || force) {
            let gcCids = 0;
            const kuboRpc = this._clientsManager.getDefaultKuboRpcClient();

            try {
                for await (const res of kuboRpc._client.repo.gc({ quiet: true })) {
                    if (res.cid) gcCids++;
                    else log.error("Failed to GC ipfs repo due to error", res.err);
                }
            } catch (e) {
                log.error("Failed to GC ipfs repo due to error", e);
            }

            log("GC cleaned", gcCids, "cids out of the IPFS node");
        }
    }

    private async _providePubsubTopicRoutingCidsIfNeeded(force = false) {
        const log = Logger("pkc-js:local-community:_providePubsubTopicRoutingCidsIfNeeded");
        const reprovideIntervalMs = 6 * 60 * 60 * 1000;
        const now = Date.now();
        if (!force && this._lastPubsubTopicRoutingProvideAt && now - this._lastPubsubTopicRoutingProvideAt < reprovideIntervalMs) return;

        const pubsubTopic = this.pubsubTopicWithfallback();
        const topics = [pubsubTopic, this.ipnsPubsubTopic].filter((topic): topic is string => typeof topic === "string");
        if (topics.length === 0) return;

        this._lastPubsubTopicRoutingProvideAt = now;
        const kuboRpcClient = this._clientsManager.getDefaultKuboRpcClient()._client;
        for (const topic of topics) {
            try {
                await retryKuboBlockPutPinAndProvidePubsubTopic({
                    ipfsClient: kuboRpcClient,
                    log,
                    pubsubTopic: topic
                });
            } catch (error) {
                log.error("Failed to reprovide pubsub topic routing block", { topic, error });
            }
        }
    }

    async _addAllCidsUnderPurgedCommentToBeRemoved(purgedCommentAndCommentUpdate: PurgedCommentTableRows) {
        const log = Logger("pkc-js:_addAllCidsUnderPurgedCommentToBeRemoved");
        this._cidsToUnPin.add(purgedCommentAndCommentUpdate.commentTableRow.cid);
        this._blocksToRm.push(purgedCommentAndCommentUpdate.commentTableRow.cid);
        if (typeof purgedCommentAndCommentUpdate.commentUpdateTableRow?.postUpdatesBucket === "number") {
            const localCommentUpdatePath = this._calculateLocalMfsPathForCommentUpdate(
                purgedCommentAndCommentUpdate.commentTableRow,
                purgedCommentAndCommentUpdate.commentUpdateTableRow?.postUpdatesBucket
            );
            this._mfsPathsToRemove.add(localCommentUpdatePath);
        }
        if (purgedCommentAndCommentUpdate?.commentUpdateTableRow?.replies)
            await this._addOldPageCidsToCidsToUnpin(purgedCommentAndCommentUpdate?.commentUpdateTableRow?.replies, undefined, true).catch(
                (err) => log.error("Failed to add purged page cids to be unpinned and removed", err)
            );
    }

    private async _purgeDisapprovedCommentsOlderThan() {
        if (typeof this.settings?.purgeDisapprovedCommentsOlderThan !== "number") return;

        const log = Logger("pkc-js:local-community:_purgeDisapprovedCommentsOlderThan");
        const purgedComments = this._dbHandler.purgeDisapprovedCommentsOlderThan(this.settings.purgeDisapprovedCommentsOlderThan);

        if (!purgedComments || purgedComments.length === 0) return;

        log(
            "Purged disapproved comments",
            purgedComments,
            "because retention time has passed and it's time to purge them from DB and pages"
        );

        // need to clear out any commentUpdate.postUpdatesBucket
        // need to clear out any comment.cid
        // need to clear out any commentUpdate.replies

        for (const purgedComment of purgedComments)
            for (const purgedCommentAndCommentUpdate of purgedComment.purgedTableRows)
                await this._addAllCidsUnderPurgedCommentToBeRemoved(purgedCommentAndCommentUpdate);

        if (this._mfsPathsToRemove.size > 0) await this._rmUnneededMfsPaths();
        if (this.updateCid) {
            this._blocksToRm.push(this.updateCid); // we need to remove current updateCid which references purged comments
            this._cidsToUnPin.add(this.updateCid);
        }
    }

    private async syncIpnsWithDb() {
        const log = Logger("pkc-js:local-community:sync");

        const kuboRpc = this._clientsManager.getDefaultKuboRpcClient();
        try {
            await this._listenToIncomingRequests();
            await this._providePubsubTopicRoutingCidsIfNeeded();
            await this._adjustPostUpdatesBucketsIfNeeded();
            this._setStartedStateWithEmission("publishing-ipns");
            this._clientsManager.updateKuboRpcState("publishing-ipns", kuboRpc.url);
            await this._purgeDisapprovedCommentsOlderThan();
            const commentUpdateRows = await this._updateCommentsThatNeedToBeUpdated();
            this._requireCommunityUpdateIfModQueueChanged();
            await this.updateCommunityIpnsIfNeeded(commentUpdateRows);
            await this._cleanUpIpfsRepoRarely();
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

    private async _assertDomainResolvesCorrectly(newAddressAsDomain: string) {
        if (isStringDomain(newAddressAsDomain)) {
            const resolvedIpnsFromNewDomain = await this._clientsManager.resolveCommunityNameIfNeeded({
                communityAddress: newAddressAsDomain
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

    private async _initSignerProps(newSignerProps: InternalCommunityRecordBeforeFirstUpdateType["signer"]) {
        this.signer = new SignerWithPublicKeyAddress(newSignerProps);
        if (!this.signer?.ipfsKey?.byteLength || this.signer?.ipfsKey?.byteLength <= 0)
            this.signer.ipfsKey = new Uint8Array(await getIpfsKeyFromPrivateKey(this.signer.privateKey));
        if (!this.signer.ipnsKeyName) this.signer.ipnsKeyName = this.signer.address;
        if (!this.signer.publicKey) this.signer.publicKey = await getPublicKeyFromPrivateKey(this.signer.privateKey);

        this.encryption = {
            type: "ed25519-aes-gcm",
            publicKey: this.signer.publicKey
        };
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

    private async _parseRolesToEdit(
        newRawRoles: NonNullable<CommunityEditOptions["roles"]>
    ): Promise<NonNullable<InternalCommunityRecordAfterFirstUpdateType["roles"]>> {
        for (const [roleAddress, roleValue] of Object.entries(newRawRoles)) {
            if (roleValue === undefined || roleValue === null) continue; // skip removals
            if (isStringDomain(roleAddress)) {
                let resolved: string | null;
                try {
                    resolved = await this._clientsManager.resolveAuthorNameIfNeeded({ authorAddress: roleAddress });
                } catch {
                    resolved = null;
                }
                if (!resolved) throw new PKCError("ERR_ROLE_ADDRESS_DOMAIN_COULD_NOT_BE_RESOLVED", { roleAddress });
            }
        }
        return <NonNullable<CommunityIpfsType["roles"]>>remeda.omitBy(newRawRoles, (val, key) => val === undefined || val === null);
    }

    private async _parseChallengesToEdit(
        newChallengeSettings: NonNullable<NonNullable<CommunityEditOptions["settings"]>["challenges"]>
    ): Promise<NonNullable<Pick<InternalCommunityRecordAfterFirstUpdateType, "challenges" | "_usingDefaultChallenge">>> {
        return {
            challenges: await Promise.all(
                newChallengeSettings.map((cs) => getCommunityChallengeFromCommunityChallengeSettings(cs, this._pkc))
            ),
            _usingDefaultChallenge: LocalCommunity._isDefaultChallengeStructure(newChallengeSettings)
        };
    }

    async _validateNewAddressBeforeEditing(newAddress: string, log: Logger) {
        if (doesDomainAddressHaveCapitalLetter(newAddress))
            throw new PKCError("ERR_COMMUNITY_NAME_HAS_CAPITAL_LETTER", { communityAddress: newAddress });
        // Check if any existing community (other than this one) already has an equivalent address
        // This handles both exact matches and .eth/.bso alias equivalence
        const existingEquivalent = this._pkc.communities.find(
            (existing) => areEquivalentCommunityAddresses(existing, newAddress) && !areEquivalentCommunityAddresses(existing, this.address)
        );
        if (existingEquivalent)
            throw new PKCError("ERR_COMMUNITY_OWNER_ATTEMPTED_EDIT_NEW_ADDRESS_THAT_ALREADY_EXISTS", {
                currentCommunityAddress: this.address,
                newCommunityAddress: newAddress,
                currentSubs: this._pkc.communities
            });
        this._assertDomainResolvesCorrectly(newAddress).catch((err: PKCError) => {
            log.error(err);
            this.emit("error", err);
        });
    }

    async _editPropsOnStartedCommunity(parsedEditOptions: ParsedCommunityEditOptions): Promise<typeof this> {
        // 'this' is the started community with state="started"
        // this._pkc._startedCommunities[this.address] === this
        const log = Logger("pkc-js:local-community:start:editPropsOnStartedCommunity");
        const oldAddress = remeda.clone(this.address);
        if (typeof parsedEditOptions.address === "string" && this.address !== parsedEditOptions.address) {
            await this._validateNewAddressBeforeEditing(parsedEditOptions.address, log);

            log(`Attempting to edit community.address from ${oldAddress} to ${parsedEditOptions.address}. We will stop community first`);
            await this.stop();
            await this._dbHandler.changeDbFilename(oldAddress, parsedEditOptions.address);
            this.setAddress(parsedEditOptions.address);
            await this._dbHandler.initDbIfNeeded();
            await this.start();
            await this._movePostUpdatesFolderToNewAddress(oldAddress, parsedEditOptions.address);
        }

        const uniqueEditId = sha256(deterministicStringify(parsedEditOptions));
        this._pendingEditProps.push({ ...parsedEditOptions, editId: uniqueEditId });

        if (this.updateCid)
            await this.initInternalCommunityAfterFirstUpdateNoMerge({
                ...this.toJSONInternalAfterFirstUpdate(),
                ...parsedEditOptions,
                _internalStateUpdateId: uniqueEditId
            });
        else
            await this.initInternalCommunityBeforeFirstUpdateNoMerge({
                ...this.toJSONInternalBeforeFirstUpdate(),
                ...parsedEditOptions,
                _internalStateUpdateId: uniqueEditId
            });
        this._communityUpdateTrigger = true;
        log(
            `Community (${this.address}) props (${remeda.keys.strict(parsedEditOptions)}) has been edited. Will be including edited props in next update: `,
            remeda.pick(this, remeda.keys.strict(parsedEditOptions))
        );
        this.emit("update", this);
        if (this.address !== oldAddress) {
            trackStartedCommunity(this._pkc, this);
            syncCommunityRegistryEntry(processStartedCommunities, this);
        }
        return this;
    }

    async _editPropsOnNotStartedCommunity(parsedEditOptions: ParsedCommunityEditOptions): Promise<typeof this> {
        // sceneario 3, the community is not running anywhere, we need to edit the db and update this instance
        const log = Logger("pkc-js:local-community:edit:editPropsOnNotStartedCommunity");
        const oldAddress = remeda.clone(this.address);
        await this.initDbHandlerIfNeeded();
        await this._dbHandler.initDbIfNeeded();
        if (typeof parsedEditOptions.address === "string" && this.address !== parsedEditOptions.address) {
            await this._validateNewAddressBeforeEditing(parsedEditOptions.address, log);

            log(`Attempting to edit community.address from ${oldAddress} to ${parsedEditOptions.address}`);

            // in this sceneario we're editing a community that's not started anywhere
            log("will rename the community", this.address, "db in edit() because the community is not being ran anywhere else");
            await this._movePostUpdatesFolderToNewAddress(this.address, parsedEditOptions.address);
            this._dbHandler.destoryConnection();
            await this._dbHandler.changeDbFilename(this.address, parsedEditOptions.address);
            await this._dbHandler.initDbIfNeeded();
            this.setAddress(parsedEditOptions.address);
        }
        const mergedInternalState = await this._updateDbInternalState(parsedEditOptions);

        if ("updatedAt" in mergedInternalState && mergedInternalState.updatedAt)
            await this.initInternalCommunityAfterFirstUpdateNoMerge(mergedInternalState);
        else await this.initInternalCommunityBeforeFirstUpdateNoMerge(mergedInternalState);
        await this._dbHandler.destoryConnection();
        this.emit("update", this);
        return this;
    }

    override async edit(newCommunityOptions: CommunityEditOptions): Promise<typeof this> {
        // scenearios
        // 1 - calling edit() on a community instance that's not running, but the it's started in pkc._startedCommunities (should edit the started community)
        // 2 - calling edit() on a community that's started in another process (should throw)
        // 3 - calling edit() on a community that's not started (should load db and edit it)
        // 4 - calling edit() on the community that's started (should edit the started community)

        const startedCommunity = <LocalCommunity | undefined>(
            (findStartedCommunity(this._pkc, { publicKey: this.publicKey, name: this.name }) ||
                findCommunityInRegistry(processStartedCommunities, { publicKey: this.publicKey, name: this.name }))
        );
        if (startedCommunity && this.state !== "started") {
            // sceneario 1
            const editRes = await startedCommunity.edit(newCommunityOptions);

            this.setAddress(editRes.address); // need to force an update of the address for this instance
            await this._updateInstancePropsWithStartedCommunityOrDb();
            return this;
        }

        await this.initDbHandlerIfNeeded();
        await this._updateStartedValue();
        if (this.started && this.state !== "started") {
            // sceneario 2
            this._dbHandler.destoryConnection();
            throw new PKCError("ERR_CAN_NOT_EDIT_A_LOCAL_COMMUNITY_THAT_IS_ALREADY_STARTED_IN_ANOTHER_PROCESS", {
                address: this.address,
                dataPath: this._pkc.dataPath
            });
        }

        const parsedEditOptions = parseCommunityEditOptionsSchemaWithPKCErrorIfItFails(newCommunityOptions);

        // Convert backward-compat address → name for wire format when address is a domain
        const editWithDerivedName =
            typeof parsedEditOptions.address === "string" && isStringDomain(parsedEditOptions.address)
                ? { ...parsedEditOptions, name: parsedEditOptions.address }
                : parsedEditOptions;

        const newInternalProps = <Pick<InternalCommunityRecordAfterFirstUpdateType, "roles" | "challenges" | "_usingDefaultChallenge">>{
            ...(editWithDerivedName.roles ? { roles: await this._parseRolesToEdit(editWithDerivedName.roles) } : undefined),
            ...(editWithDerivedName?.settings?.challenges
                ? await this._parseChallengesToEdit(editWithDerivedName.settings.challenges)
                : undefined)
        };

        const newProps = <ParsedCommunityEditOptions>{
            ...remeda.omit(editWithDerivedName, ["roles"]), // we omit here to make tsc shut up
            ...newInternalProps
        };

        if (!this.started && !startedCommunity) {
            // sceneario 3
            return this._editPropsOnNotStartedCommunity(newProps);
        }

        if (findStartedCommunity(this._pkc, { publicKey: this.publicKey, name: this.name }) === this) {
            // sceneario 4
            return this._editPropsOnStartedCommunity(newProps);
        }
        throw new Error("Can't edit a community that's started in another process");
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
            await this._updateInstanceStateWithDbState(); // sync in-memory state after potential migration

            await this._setChallengesToDefaultIfNotDefined(log);
            // Import community keys onto ipfs node
            await this._importCommunitySignerIntoIpfsIfNeeded();
            await this._providePubsubTopicRoutingCidsIfNeeded(true);

            this._communityUpdateTrigger = true;
            this._setStartedStateWithEmission("publishing-ipns");
            await this._repinCommentsIPFSIfNeeded();
            await this._repinCommentUpdateIfNeeded();
            await this._listenToIncomingRequests();
            this.challenges = await Promise.all(
                this.settings.challenges!.map((cs) => getCommunityChallengeFromCommunityChallengeSettings(cs, this._pkc))
            ); // make sure community.challenges is using latest props from settings.challenges
        } catch (e) {
            await this.stop(); // Make sure to reset the community state
            //@ts-expect-error
            e.details = { ...e.details, subAddress: this.address };
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
            await this._updateInstancePropsWithStartedCommunityOrDb(); // will update this instance props with DB
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
                await this._clientsManager.pubsubUnsubscribe(this.pubsubTopicWithfallback(), this.handleChallengeExchange);
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
                await this._unpinStaleCids();
            } catch (e) {
                log.error("Failed to unpin stale cids and remove mfs paths before stopping", e);
            }

            try {
                await this._updateDbInternalState(
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
            cidsAndReplies.forEach((comment) => this._cidsToUnPin.add(comment.cid));
            await Promise.all(
                cidsAndReplies
                    .filter((comment) => comment.replies)
                    .map(async (commentWithReplies) => {
                        await this._addOldPageCidsToCidsToUnpin(commentWithReplies.replies, undefined);
                    })
            );
        } catch (e) {
            log.error("Failed to query all cids under this community to delete them", e);
        }
        if (this.updateCid) this._cidsToUnPin.add(this.updateCid);
        if (this.statsCid) this._cidsToUnPin.add(this.statsCid);

        try {
            await this._unpinStaleCids();
        } catch (e) {
            log.error("Failed to unpin stale cids before deleting", e);
        }

        try {
            await this._updateDbInternalState(
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

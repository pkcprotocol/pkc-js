import Logger from "@plebbit/plebbit-logger";
import { Plebbit } from "../../../plebbit/plebbit.js";
import type {
    Challenge,
    CreateNewLocalSubplebbitParsedOptions,
    InternalSubplebbitRecordBeforeFirstUpdateType,
    InternalSubplebbitRecordAfterFirstUpdateType,
    ParsedSubplebbitEditOptions,
    SubplebbitChallengeSetting,
    SubplebbitEditOptions,
    SubplebbitIpfsType,
    RpcInternalSubplebbitRecordBeforeFirstUpdateType,
    RpcInternalSubplebbitRecordAfterFirstUpdateType,
    SubplebbitUpdatingState,
    SubplebbitState,
    SubplebbitRoleNameUnion,
    SubplebbitEvents,
    Flair
} from "../../../subplebbit/types.js";
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
    throwWithErrorCode,
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
    areEquivalentSubplebbitAddresses
} from "../../../util.js";
import { STORAGE_KEYS } from "../../../constants.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { PlebbitError } from "../../../plebbit-error.js";

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
    DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor,
    PublicationWithSubplebbitAuthorFromDecryptedChallengeRequest,
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
    signSubplebbit,
    verifyChallengeAnswer,
    verifyChallengeRequest,
    verifyCommentEdit,
    verifyCommentModeration,
    verifyCommentUpdate,
    verifySubplebbitEdit
} from "../../../signer/signatures.js";
import {
    calculateExpectedSignatureSize,
    calculateInlineRepliesBudget,
    deriveCommentIpfsFromCommentTableRow,
    getThumbnailPropsOfLink,
    importSignerIntoKuboNode,
    moveSubplebbitDbToDeletedDirectory
} from "../util.js";
import {
    SignerWithPublicKeyAddress,
    decryptEd25519AesGcmPublicKeyBuffer,
    verifyCommentIpfs,
    verifyCommentPubsubMessage,
    verifySubplebbit,
    verifyVote
} from "../../../signer/index.js";
import { encryptEd25519AesGcmPublicKeyBuffer } from "../../../signer/encryption.js";
import { messages } from "../../../errors.js";
import {
    GetChallengeAnswers,
    getChallengeVerification,
    getSubplebbitChallengeFromSubplebbitChallengeSettings
} from "./challenges/index.js";
import * as cborg from "cborg";
import env from "../../../version.js";
import { getIpfsKeyFromPrivateKey, getPlebbitAddressFromPublicKey, getPublicKeyFromPrivateKey } from "../../../signer/util.js";
import { RpcLocalSubplebbit } from "../../../subplebbit/rpc-local-subplebbit.js";
import * as remeda from "remeda";

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
    PostPubsubMessageWithSubplebbitAuthor,
    ReplyPubsubMessageWithSubplebbitAuthor
} from "../../../publications/comment/types.js";
import { SubplebbitIpfsSchema } from "../../../subplebbit/schema.js";
import {
    ChallengeAnswerMessageSchema,
    ChallengeMessageSchema,
    ChallengeRequestMessageSchema,
    ChallengeVerificationMessageSchema,
    DecryptedChallengeRequestPublicationSchema,
    DecryptedChallengeRequestSchema
} from "../../../pubsub-messages/schema.js";
import {
    parseDecryptedChallengeAnswerWithPlebbitErrorIfItFails,
    parseJsonWithPlebbitErrorIfFails,
    parseSubplebbitEditOptionsSchemaWithPlebbitErrorIfItFails,
    parseSubplebbitIpfsSchemaPassthroughWithPlebbitErrorIfItFails
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
import { SubplebbitEditPublicationPubsubReservedFields } from "../../../publications/subplebbit-edit/schema.js";
import type { SubplebbitEditPubsubMessagePublication } from "../../../publications/subplebbit-edit/types.js";
import { default as lodashDeepMerge } from "lodash.merge"; // Importing only the `merge` function
import { MAX_FILE_SIZE_BYTES_FOR_SUBPLEBBIT_IPFS } from "../../../subplebbit/subplebbit-client-manager.js";
import { RemoteSubplebbit } from "../../../subplebbit/remote-subplebbit.js";
import pLimit from "p-limit";
import { sha256 } from "js-sha256";
import { iterateOverPageCidsToFindAllCids } from "../../../pages/util.js";

type CommentUpdateToWriteToDbAndPublishToIpfs = {
    newCommentUpdate: CommentUpdateType;
    newCommentUpdateToWriteToDb: CommentUpdatesTableRowInsert;
    localMfsPath: string | undefined;
    pendingApproval: CommentsTableRow["pendingApproval"];
};
const _startedSubplebbits: Record<string, LocalSubplebbit> = {}; // A global record on process level to track started subplebbits

// This is a sub we have locally in our plebbit datapath, in a NodeJS environment
export class LocalSubplebbit extends RpcLocalSubplebbit implements CreateNewLocalSubplebbitParsedOptions {
    override signer!: SignerWithPublicKeyAddress;
    private _postUpdatesBuckets = [86400, 604800, 2592000, 3153600000]; // 1 day, 1 week, 1 month, 100 years. Expecting to be sorted from smallest to largest

    private _defaultSubplebbitChallenges: SubplebbitChallengeSetting[] = [
        {
            name: "publication-match",
            options: {
                matches: JSON.stringify([{ propertyName: "author.address", regexp: "\\.(sol|eth|bso)$" }]),
                error: "Posting in this community requires a username (author address) that ends with .bso, .sol, or .eth. Go to the settings to set your username."
            },
            exclude: [
                { role: ["moderator", "admin", "owner"] },
                {
                    firstCommentTimestamp: 60 * 60 * 24 * 30,
                    postScore: 3,
                    rateLimit: 2,
                    replyScore: 0
                },
                { challenges: [1] },
                { challenges: [2] }
            ]
        },
        {
            name: "whitelist",
            options: {
                urls: "https://raw.githubusercontent.com/plebbit/lists/refs/heads/master/whitelist-challenge.json",
                error: "Or posting in this community requires being whitelisted. Go to https://t.me/plebbit and ask to be whitelisted. Or"
            },
            exclude: [{ challenges: [0] }, { challenges: [2] }]
        },
        {
            name: "mintpass",
            options: {
                contractAddress: "0xcb60e1dd6944dfc94920e28a277a51a06e9f20d2",
                chainTicker: "eth",
                rpcUrl: "https://sepolia.base.org"
            },
            exclude: [{ challenges: [0] }, { challenges: [1] }]
        }
    ];

    // These caches below will be used to facilitate challenges exchange with authors, they will expire after 10 minutes
    // Most of the time they will be delete and cleaned up automatically
    private _challengeAnswerPromises!: LRUCache<string, Promise<DecryptedChallengeAnswer["challengeAnswers"]>>;
    private _challengeAnswerResolveReject!: LRUCache<
        string,
        { resolve: (answers: DecryptedChallengeAnswer["challengeAnswers"]) => void; reject: (error: Error) => void }
    >;
    private _ongoingChallengeExchanges!: LRUCache<string, boolean>;
    private _challengeExchangesFromLocalPublishers: Record<string, boolean> = {}; // key is stringified challengeRequestId and value is true if the challenge exchange is ongoing

    _cidsToUnPin: Set<string> = new Set<string>();
    _mfsPathsToRemove: Set<string> = new Set<string>();
    private _subplebbitUpdateTrigger: boolean = false;
    private _combinedHashOfPendingCommentsCids: string = sha256("");

    private _pageGenerator!: PageGenerator;
    _dbHandler!: DbHandler;
    private _stopHasBeenCalled: boolean; // we use this to track if sub.stop() has been called after sub.start() or sub.update()
    private _publishLoopPromise?: Promise<void> = undefined;
    private _updateLoopPromise?: Promise<void> = undefined;
    private _updateLoopAbortController?: AbortController;
    private _firstUpdateAfterStart: boolean = true;
    private _internalStateUpdateId: InternalSubplebbitRecordBeforeFirstUpdateType["_internalStateUpdateId"] = "";
    private _lastPubsubTopicRoutingProvideAt?: number = undefined;
    private _mirroredStartedOrUpdatingSubplebbit?: { subplebbit: LocalSubplebbit } & Pick<
        SubplebbitEvents,
        | "error"
        | "updatingstatechange"
        | "update"
        | "statechange"
        | "startedstatechange"
        | "challengerequest"
        | "challengeverification"
        | "challenge"
        | "challengeanswer"
    > = undefined; // The plebbit._startedSubplebbits we're subscribed to
    private _pendingEditProps: Partial<ParsedSubplebbitEditOptions & { editId: string }>[] = [];
    _blocksToRm: string[] = [];

    constructor(plebbit: Plebbit) {
        super(plebbit);
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
        this._internalStateUpdateId = undefined;

        //@ts-expect-error
        this._dbHandler = undefined;

        hideClassPrivateProps(this);
    }

    // This will be stored in DB
    toJSONInternalAfterFirstUpdate(): InternalSubplebbitRecordAfterFirstUpdateType {
        return {
            ...remeda.omit(this.toJSONInternalRpcAfterFirstUpdate(), ["started"]),
            signer: remeda.pick(this.signer, ["privateKey", "type", "address", "shortAddress", "publicKey"]),
            _internalStateUpdateId: this._internalStateUpdateId,
            _cidsToUnPin: [...this._cidsToUnPin],
            _mfsPathsToRemove: [...this._mfsPathsToRemove],
            _pendingEditProps: this._pendingEditProps
        };
    }

    toJSONInternalBeforeFirstUpdate(): InternalSubplebbitRecordBeforeFirstUpdateType {
        return {
            ...remeda.omit(this.toJSONInternalRpcBeforeFirstUpdate(), ["started"]),
            signer: remeda.pick(this.signer, ["privateKey", "type", "address", "shortAddress", "publicKey"]),
            _internalStateUpdateId: this._internalStateUpdateId,
            _pendingEditProps: this._pendingEditProps
        };
    }

    override toJSONInternalRpcAfterFirstUpdate(): RpcInternalSubplebbitRecordAfterFirstUpdateType {
        return {
            ...super.toJSONInternalRpcAfterFirstUpdate(),
            signer: remeda.pick(this.signer, ["publicKey", "address", "shortAddress", "type"])
        };
    }

    override toJSONInternalRpcBeforeFirstUpdate(): RpcInternalSubplebbitRecordBeforeFirstUpdateType {
        return {
            ...super.toJSONInternalRpcBeforeFirstUpdate(),
            signer: remeda.pick(this.signer, ["publicKey", "address", "shortAddress", "type"])
        };
    }

    private async _updateStartedValue() {
        this.started = await this._dbHandler.isSubStartLocked(this.address);
    }

    async initNewLocalSubPropsNoMerge(newProps: CreateNewLocalSubplebbitParsedOptions) {
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

    async initInternalSubplebbitAfterFirstUpdateNoMerge(newProps: InternalSubplebbitRecordAfterFirstUpdateType) {
        this.initRpcInternalSubplebbitAfterFirstUpdateNoMerge({
            ...newProps,
            started: this.started,
            startedState: this.startedState
        });
        await this._initSignerProps(newProps.signer);
        this._internalStateUpdateId = newProps._internalStateUpdateId;
        if (Array.isArray(newProps._cidsToUnPin)) newProps._cidsToUnPin.forEach((cid) => this._cidsToUnPin.add(cid));
        if (Array.isArray(newProps._mfsPathsToRemove)) newProps._mfsPathsToRemove.forEach((path) => this._mfsPathsToRemove.add(path));
        this._updateIpnsPubsubPropsIfNeeded(newProps);
    }

    async initInternalSubplebbitBeforeFirstUpdateNoMerge(newProps: InternalSubplebbitRecordBeforeFirstUpdateType) {
        this.initRpcInternalSubplebbitBeforeFirstUpdateNoMerge({
            ...newProps,
            started: this.started,
            startedState: this.startedState
        });
        await this._initSignerProps(newProps.signer);
        this._internalStateUpdateId = newProps._internalStateUpdateId;
        this._updateIpnsPubsubPropsIfNeeded(newProps);
        this.ipnsName = newProps.signer.address;
        this.ipnsPubsubTopic = ipnsNameToIpnsOverPubsubTopic(this.ipnsName);
        this.ipnsPubsubTopicRoutingCid = pubsubTopicToDhtKey(this.ipnsPubsubTopic);
    }

    private async initDbHandlerIfNeeded() {
        if (!this._dbHandler) {
            this._dbHandler = new DbHandler(this);
            await this._dbHandler.initDbConfigIfNeeded();
            this._pageGenerator = new PageGenerator(this);
        }
    }

    async _updateInstancePropsWithStartedSubOrDb() {
        // if it's started in the same plebbit instance, we will load it from the started subplebbit instance
        // if it's started in another process, we will throw an error
        // if sub is not started, load the InternalSubplebbit props from the local db

        const log = Logger("plebbit-js:local-subplebbit:_updateInstancePropsWithStartedSubOrDb");
        const startedSubplebbit = (this._plebbit._startedSubplebbits[this.address] || _startedSubplebbits[this.address]) as
            | LocalSubplebbit
            | undefined;
        if (startedSubplebbit) {
            log("Loading local subplebbit", this.address, "from started subplebbit instance");
            if (startedSubplebbit.updatedAt)
                await this.initInternalSubplebbitAfterFirstUpdateNoMerge(startedSubplebbit.toJSONInternalAfterFirstUpdate());
            else await this.initInternalSubplebbitBeforeFirstUpdateNoMerge(startedSubplebbit.toJSONInternalBeforeFirstUpdate());
            this.started = true;
        } else {
            await this.initDbHandlerIfNeeded();
            try {
                await this._updateStartedValue();

                const subDbExists = this._dbHandler.subDbExists();
                if (!subDbExists)
                    throw new PlebbitError("CAN_NOT_LOAD_LOCAL_SUBPLEBBIT_IF_DB_DOES_NOT_EXIST", {
                        address: this.address,
                        dataPath: this._plebbit.dataPath
                    });

                const dbConfig = this.state === "updating" ? { readonly: true } : undefined;
                await this._dbHandler.initDbIfNeeded(dbConfig);

                await this._updateInstanceStateWithDbState(); // Load InternalSubplebbit from DB here
                if (!this.signer) throw new PlebbitError("ERR_LOCAL_SUB_HAS_NO_SIGNER_IN_INTERNAL_STATE", { address: this.address });

                await this._updateStartedValue();
                log("Loaded local subplebbit", this.address, "from db");
            } catch (e) {
                throw e;
            } finally {
                this._dbHandler.destoryConnection(); // Need to destory connection so process wouldn't hang
            }
        }

        // need to validate schema of Subplebbit IPFS
        if (this.raw.subplebbitIpfs)
            try {
                parseSubplebbitIpfsSchemaPassthroughWithPlebbitErrorIfItFails(this.raw.subplebbitIpfs);
            } catch (e) {
                if (e instanceof Error) {
                    e.message = "Local subplebbit" + this.address + " has an invalid schema: " + e.message;
                    throw e;
                }
            }
    }
    private async _importSubplebbitSignerIntoIpfsIfNeeded() {
        if (!this.signer.ipnsKeyName) throw Error("subplebbit.signer.ipnsKeyName is not defined");
        if (!this.signer.ipfsKey) throw Error("subplebbit.signer.ipfsKey is not defined");

        await importSignerIntoKuboNode(this.signer.ipnsKeyName, this.signer.ipfsKey, {
            url: this._plebbit.kuboRpcClientsOptions![0].url!.toString(),
            headers: this._plebbit.kuboRpcClientsOptions![0].headers
        });
    }

    async _updateDbInternalState(
        props: Partial<InternalSubplebbitRecordBeforeFirstUpdateType | InternalSubplebbitRecordAfterFirstUpdateType>
    ): Promise<InternalSubplebbitRecordBeforeFirstUpdateType | InternalSubplebbitRecordAfterFirstUpdateType> {
        const log = Logger("plebbit-js:local-subplebbit:_updateDbInternalState");
        if (remeda.isEmpty(props)) throw Error("props to update DB internal state should not be empty");
        await this._dbHandler.initDbIfNeeded();

        props._internalStateUpdateId = uuidV4();
        let lockedIt = false;
        try {
            await this._dbHandler.lockSubState();
            lockedIt = true;
            const internalStateBefore = await this._getDbInternalState(false);
            const mergedInternalState = { ...internalStateBefore, ...props };
            await this._dbHandler.keyvSet(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_SUBPLEBBIT], mergedInternalState);
            this._internalStateUpdateId = props._internalStateUpdateId;
            log.trace("Updated sub", this.address, "internal state in db with new props", Object.keys(props));
            return mergedInternalState as InternalSubplebbitRecordBeforeFirstUpdateType | InternalSubplebbitRecordAfterFirstUpdateType;
        } catch (e) {
            log.error("Failed to update sub", this.address, "internal state in db with new props", Object.keys(props), e);
            throw e;
        } finally {
            if (lockedIt) await this._dbHandler.unlockSubState();
        }
    }

    private async _getDbInternalState(
        lock: boolean
    ): Promise<InternalSubplebbitRecordAfterFirstUpdateType | InternalSubplebbitRecordBeforeFirstUpdateType> {
        const log = Logger("plebbit-js:local-subplebbit:_getDbInternalState");
        if (!this._dbHandler.keyvHas(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_SUBPLEBBIT]))
            throw new PlebbitError("ERR_SUB_HAS_NO_INTERNAL_STATE", { address: this.address, dataPath: this._plebbit.dataPath });
        let lockedIt = false;
        try {
            if (lock) {
                await this._dbHandler.lockSubState();
                lockedIt = true;
            }
            const internalState = await this._dbHandler.keyvGet(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_SUBPLEBBIT]);
            if (!internalState)
                throw new PlebbitError("ERR_SUB_HAS_NO_INTERNAL_STATE", { address: this.address, dataPath: this._plebbit.dataPath });
            return internalState as InternalSubplebbitRecordAfterFirstUpdateType | InternalSubplebbitRecordBeforeFirstUpdateType;
        } catch (e) {
            log.error("Failed to get sub", this.address, "internal state from db", e);
            throw e;
        } finally {
            if (lockedIt) await this._dbHandler.unlockSubState();
        }
    }

    private async _updateInstanceStateWithDbState() {
        const currentDbState = await this._getDbInternalState(false);

        if ("updatedAt" in currentDbState) {
            await this.initInternalSubplebbitAfterFirstUpdateNoMerge(currentDbState);
        } else await this.initInternalSubplebbitBeforeFirstUpdateNoMerge(currentDbState);
    }

    async _setChallengesToDefaultIfNotDefined(log: Logger) {
        if (
            this._usingDefaultChallenge !== false &&
            (!this.settings?.challenges || remeda.isDeepEqual(this.settings?.challenges, this._defaultSubplebbitChallenges))
        )
            this._usingDefaultChallenge = true;
        if (this._usingDefaultChallenge && !remeda.isDeepEqual(this.settings?.challenges, this._defaultSubplebbitChallenges)) {
            await this.edit({ settings: { ...this.settings, challenges: this._defaultSubplebbitChallenges } });
            log(`Defaulted the challenges of subplebbit (${this.address}) to`, this._defaultSubplebbitChallenges);
        }
    }

    async _createNewLocalSubDb() {
        // We're creating a totally new subplebbit here with a new db
        // This function should be called only once per sub
        const log = Logger("plebbit-js:local-subplebbit:_createNewLocalSubDb");
        await this.initDbHandlerIfNeeded();
        await this._dbHandler.initDbIfNeeded({ fileMustExist: false });
        await this._dbHandler.createOrMigrateTablesIfNeeded();
        await this._initSignerProps(this.signer); // init this.encryption as well

        if (!this.pubsubTopic) this.pubsubTopic = remeda.clone(this.signer.address);
        if (typeof this.createdAt !== "number") this.createdAt = timestamp();
        if (!this.protocolVersion) this.protocolVersion = env.PROTOCOL_VERSION;
        if (!this.settings?.maxPendingApprovalCount) this.settings = { ...this.settings, maxPendingApprovalCount: 500 };
        if (!this.settings?.challenges) {
            this.settings = { ...this.settings, challenges: this._defaultSubplebbitChallenges };
            this._usingDefaultChallenge = true;
            log(`Defaulted the challenges of subplebbit (${this.address}) to`, this._defaultSubplebbitChallenges);
        }
        if (typeof this.settings?.purgeDisapprovedCommentsOlderThan !== "number") {
            this.settings = { ...this.settings, purgeDisapprovedCommentsOlderThan: 1.21e6 }; // two weeks
        }

        this.challenges = await Promise.all(
            this.settings.challenges!.map((cs) => getSubplebbitChallengeFromSubplebbitChallengeSettings(cs, this._plebbit))
        );

        if (this._dbHandler.keyvHas(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_SUBPLEBBIT])) throw Error("Internal state exists already");

        await this._dbHandler.keyvSet(STORAGE_KEYS[STORAGE_KEYS.INTERNAL_SUBPLEBBIT], this.toJSONInternalBeforeFirstUpdate());

        await this._updateStartedValue();

        this._dbHandler.destoryConnection(); // Need to destory connection so process wouldn't hang
        this._updateIpnsPubsubPropsIfNeeded({
            ...this.toJSONInternalBeforeFirstUpdate(), //@ts-expect-error
            signature: { publicKey: this.signer.publicKey }
        });
    }

    private async _calculateNewPostUpdates(): Promise<SubplebbitIpfsType["postUpdates"]> {
        const postUpdates: SubplebbitIpfsType["postUpdates"] = {};
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
        const lastPublishTooOld = (this.updatedAt || 0) < timestamp() - 60 * 15; // Publish a subplebbit record every 15 minutes at least

        // these two checks below are for rare cases where a purged comments or post is not forcing sub for a new update
        const lastPostCidChanged = this.lastPostCid !== this._dbHandler.queryLatestPostCid()?.cid;
        const lastCommentCidChanged = this.lastCommentCid !== this._dbHandler.queryLatestCommentCid()?.cid;

        this._subplebbitUpdateTrigger =
            this._subplebbitUpdateTrigger ||
            lastPublishTooOld ||
            this._pendingEditProps.length > 0 ||
            this._blocksToRm.length > 0 ||
            lastCommentCidChanged ||
            lastPostCidChanged; // we have at least one edit to include in new ipns
    }

    private _requireSubplebbitUpdateIfModQueueChanged() {
        const combinedHashOfAllQueuedComments = this._dbHandler.queryCombinedHashOfPendingComments();

        if (this._combinedHashOfPendingCommentsCids !== combinedHashOfAllQueuedComments) this._subplebbitUpdateTrigger = true;
    }

    async _resolveIpnsAndLogIfPotentialProblematicSequence() {
        const log = Logger("plebbit-js:local-subplebbit:_resolveIpnsAndLogIfPotentialProblematicSequence");
        if (!this.signer.ipnsKeyName) throw Error("IPNS key name is not defined");
        if (!this.updateCid) return;
        try {
            const ipnsCid = await this._clientsManager.resolveIpnsToCidP2P(this.signer.ipnsKeyName, { timeoutMs: 120000 });
            log.trace("Resolved sub", this.address, "IPNS key", this.signer.ipnsKeyName, "to", ipnsCid);

            if (ipnsCid && this.updateCid && ipnsCid !== this.updateCid) {
                log.error(
                    "subplebbit",
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
            log.trace("Failed to resolve subplebbit before publishing", this.address, "IPNS key", this.signer.ipnsKeyName, e);
        }
    }

    private async _addOldPageCidsToCidsToUnpin(
        curPages: CommentUpdateType["replies"] | SubplebbitIpfsType["posts"] | SubplebbitIpfsType["modQueue"],
        newPages: CommentUpdateType["replies"] | SubplebbitIpfsType["posts"] | SubplebbitIpfsType["modQueue"],
        addToBlockRm?: boolean
    ) {
        if (!curPages && !newPages) return;
        else if (curPages && !newPages) {
            // we had to reset our sub pages, maybe because we purged all comments or changed subplebbit address
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

    private async updateSubplebbitIpnsIfNeeded(commentUpdateRowsToPublishToIpfs: CommentUpdateToWriteToDbAndPublishToIpfs[]) {
        const log = Logger("plebbit-js:local-subplebbit:start:updateSubplebbitIpnsIfNeeded");

        this._calculateLatestUpdateTrigger();

        if (!this._subplebbitUpdateTrigger) return; // No reason to update

        this._dbHandler.createTransaction();
        const latestPost = this._dbHandler.queryLatestPostCid();
        const latestComment = this._dbHandler.queryLatestCommentCid();
        this._dbHandler.commitTransaction();

        const stats = this._dbHandler.querySubplebbitStats();

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
        const pendingSubplebbitIpfsEditProps = Object.assign(
            {}, //@ts-expect-error
            ...this._pendingEditProps.map((editProps) => remeda.pick(editProps, remeda.keys.strict(SubplebbitIpfsSchema.shape)))
        );
        if (this._pendingEditProps.length > 0) log("Including edit props in next IPNS update", this._pendingEditProps);
        const newIpns: Omit<SubplebbitIpfsType, "signature"> = {
            ...cleanUpBeforePublishing({
                ...remeda.omit(this._toJSONIpfsBaseNoPosts(), ["signature"]),
                ...pendingSubplebbitIpfsEditProps,
                lastPostCid: latestPost?.cid,
                lastCommentCid: latestComment?.cid,
                statsCid,
                updatedAt,
                postUpdates: newPostUpdates,
                protocolVersion: env.PROTOCOL_VERSION
            })
        };

        const preloadedPostsPages = "hot";
        // Calculate size taken by subplebbit without posts and signature
        const subplebbitWithoutPostsSignatureSize = Buffer.byteLength(JSON.stringify(newIpns), "utf8");

        // Calculate expected signature size
        const expectedSignatureSize = calculateExpectedSignatureSize(newIpns);

        // Calculate remaining space for posts
        const availablePostsSize =
            MAX_FILE_SIZE_BYTES_FOR_SUBPLEBBIT_IPFS - subplebbitWithoutPostsSignatureSize - expectedSignatureSize - 1000;

        const generatedPosts = await this._pageGenerator.generateSubplebbitPosts(preloadedPostsPages, availablePostsSize);

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

        this._addOldPageCidsToCidsToUnpin(this.raw.subplebbitIpfs?.posts, newIpns.posts).catch((err) =>
            log.error("Failed to add old page cids of subplebbit.posts to _cidsToUnpin", err)
        );

        if (newModQueue) {
            newIpns.modQueue = { pageCids: newModQueue.pageCids };
        } else {
            await this._updateDbInternalState({ modQueue: undefined });
            this.modQueue.resetPages();
        }

        const signature = await signSubplebbit({ subplebbit: newIpns, signer: this.signer });
        const newSubplebbitRecord = <SubplebbitIpfsType>{ ...newIpns, signature };

        await this._validateSubSizeSchemaAndSignatureBeforePublishing(newSubplebbitRecord);

        const contentToPublish = deterministicStringify(newSubplebbitRecord);
        const file = await retryKuboIpfsAddAndProvide({
            ipfsClient: kuboRpcClient._client,
            log,
            content: contentToPublish, // you need to do deterministic here or otherwise cids in commentUpdate.replies won't match up correctly
            addOptions: { pin: true },
            provideOptions: { recursive: true },
            provideInBackground: false
        });
        log(
            `Published subplebbit record. Kubo CID: ${file.path}. updatedAt: ${newSubplebbitRecord.updatedAt}. ` +
                `Content length: ${contentToPublish.length}`
        );
        if (file.size > MAX_FILE_SIZE_BYTES_FOR_SUBPLEBBIT_IPFS) {
            throw new PlebbitError("ERR_LOCAL_SUBPLEBBIT_RECORD_TOO_LARGE", {
                calculatedSizeOfNewSubplebbitRecord: file.size,
                maxSize: MAX_FILE_SIZE_BYTES_FOR_SUBPLEBBIT_IPFS,
                newSubplebbitRecord,
                address: this.address
            });
        }

        if (!this.signer.ipnsKeyName) throw Error("IPNS key name is not defined");
        // after kubo 0.40 implements fetching IPNS record from local blockstore, we don't need line below anymore
        if (this._firstUpdateAfterStart) await this._resolveIpnsAndLogIfPotentialProblematicSequence();
        const ttl = `${this._plebbit.publishInterval * 3}ms`; // default publish interval is 20s, so default ttl is 60s
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
            `Published a new IPNS record for sub(${this.address}) on IPNS (${publishRes.name}) that points to file (${publishRes.value}) with updatedAt (${newSubplebbitRecord.updatedAt}) and TTL (${ttl})`
        );

        this._clientsManager.updateKuboRpcState("stopped", kuboRpcClient.url);
        this._addOldPageCidsToCidsToUnpin(this.raw.subplebbitIpfs?.modQueue, newIpns.modQueue).catch((err) =>
            log.error("Failed to add old page cids of subplebbit.modQueue to _cidsToUnpin", err)
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
        if (this.updateCid) this._cidsToUnPin.add(this.updateCid); // add old cid of subplebbit to be unpinned
        this.initSubplebbitIpfsPropsNoMerge(newSubplebbitRecord);
        this.updateCid = file.path;
        this._pendingEditProps = this._pendingEditProps.filter((editProps) => !editIdsToIncludeInNextUpdate.includes(editProps.editId));

        // Re-apply remaining pending edits to in-memory state.
        // initSubplebbitIpfsPropsNoMerge above overwrites all SubplebbitIpfs properties from the
        // published IPNS record. If edit() was called during the long IPNS publish await,
        // those edits are still in _pendingEditProps but their in-memory values were overwritten.
        if (this._pendingEditProps.length > 0) {
            const remainingEditProps = Object.assign(
                {}, //@ts-expect-error
                ...this._pendingEditProps.map((editProps) => remeda.pick(editProps, remeda.keys.strict(SubplebbitIpfsSchema.shape)))
            );
            Object.assign(this, remainingEditProps);
        }

        this._subplebbitUpdateTrigger = false;
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

    private async _validateSubSizeSchemaAndSignatureBeforePublishing(recordToPublishRaw: SubplebbitIpfsType) {
        const log = Logger("plebbit-js:local-subplebbit:_validateSubSchemaAndSignatureBeforePublishing");

        const stringifiedNewSubplebbitRecord = deterministicStringify(recordToPublishRaw);
        const calculatedSizeOfNewSubplebbitRecord = await calculateStringSizeSameAsIpfsAddCidV0(stringifiedNewSubplebbitRecord);

        // Check if the subplebbit record size is less than 1MB
        if (calculatedSizeOfNewSubplebbitRecord > MAX_FILE_SIZE_BYTES_FOR_SUBPLEBBIT_IPFS) {
            const error = new PlebbitError("ERR_LOCAL_SUBPLEBBIT_RECORD_TOO_LARGE", {
                calculatedSizeOfNewSubplebbitRecord,
                maxSize: MAX_FILE_SIZE_BYTES_FOR_SUBPLEBBIT_IPFS,
                recordToPublishRaw,
                address: this.address
            });
            log.error(
                `Local subplebbit (${this.address}) produced a record that is too large (${calculatedSizeOfNewSubplebbitRecord.toFixed(2)} bytes). Maximum size is ${MAX_FILE_SIZE_BYTES_FOR_SUBPLEBBIT_IPFS} bytes.`,
                error
            );
            throw error;
        }

        const parseRes = SubplebbitIpfsSchema.safeParse(recordToPublishRaw);
        if (!parseRes.success) {
            const error = new PlebbitError("ERR_LOCAL_SUBPLEBIT_PRODUCED_INVALID_SCHEMA", {
                invalidRecord: recordToPublishRaw,
                err: parseRes.error
            });
            log.error(`Local subplebbit (${this.address}) produced an invalid SubplebbitIpfs schema`, error);
            throw error;
        }

        const verificationOpts = {
            subplebbit: recordToPublishRaw,
            subplebbitIpnsName: this.signer.address,
            resolveAuthorNames: false,
            clientsManager: this._clientsManager,
            overrideAuthorAddressIfInvalid: false,
            validatePages: true,
            cacheIfValid: false
        };
        try {
            const validation = await verifySubplebbit(verificationOpts);
            if (!validation.valid) {
                throwWithErrorCode("ERR_LOCAL_SUBPLEBBIT_PRODUCED_INVALID_SIGNATURE", {
                    validation,
                    verificationOpts
                });
            }
        } catch (e) {
            log.error(`Local subplebbit (${this.address}) produced an invalid signature`, e);
            throw e;
        }

        verificationOpts.subplebbit = JSON.parse(stringifiedNewSubplebbitRecord); // let's stringify and parse again to make sure we're not using any invalid data
        try {
            const validation = await verifySubplebbit(verificationOpts);
            if (!validation.valid) {
                throwWithErrorCode("ERR_LOCAL_SUBPLEBBIT_PRODUCED_INVALID_SIGNATURE", {
                    validation,
                    verificationOpts
                });
            }
        } catch (e) {
            log.error(
                `Local subplebbit (${this.address}) produced an invalid signature after stringifying and parsing again. This is a critical bug.`,
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
                this.emit("error", e as PlebbitError);
            }
        }
    }

    private async storeCommentEdit(
        commentEditRaw: CommentEditPubsubMessagePublication,
        challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
    ): Promise<undefined> {
        const log = Logger("plebbit-js:local-subplebbit:storeCommentEdit");
        const strippedOutEditPublication = CommentEditPubsubMessagePublicationWithFlexibleAuthorSchema.strip().parse(commentEditRaw); // we strip out here so we don't store any extra props in commentedits table
        const commentToBeEdited = this._dbHandler.queryComment(commentEditRaw.commentCid); // We assume commentToBeEdited to be defined because we already tested for its existence above
        if (!commentToBeEdited) throw Error("The comment to edit doesn't exist"); // unlikely error to happen, but always a good idea to verify
        const editSignedByOriginalAuthor = commentEditRaw.signature.publicKey === commentToBeEdited.signature.publicKey;

        const authorSignerAddress = await getPlebbitAddressFromPublicKey(commentEditRaw.signature.publicKey);

        const editTableRow = <CommentEditsTableRow>{
            ...strippedOutEditPublication,
            isAuthorEdit: editSignedByOriginalAuthor,
            authorSignerAddress,
            insertedAt: timestamp()
        };

        const extraPropsInEdit = remeda.difference(
            remeda.keys.strict(commentEditRaw),
            remeda.keys.strict(CommentEditPubsubMessagePublicationSchema.shape)
        );
        if (extraPropsInEdit.length > 0) {
            log("Found extra props on CommentEdit", extraPropsInEdit, "Will be adding them to extraProps column");
            editTableRow.extraProps = remeda.pick(commentEditRaw, extraPropsInEdit);
        }

        const isEditDuplicate = this._dbHandler.hasCommentEditWithSignatureEncoded(editTableRow.signature.signature);
        if (isEditDuplicate) {
            throw new PlebbitError("ERR_DUPLICATE_COMMENT_EDIT", { editTableRow });
        }

        this._dbHandler.insertCommentEdits([editTableRow]);
    }

    private async storeCommentModeration(
        commentModRaw: CommentModerationPubsubMessagePublication,
        challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
    ): Promise<undefined> {
        const log = Logger("plebbit-js:local-subplebbit:storeCommentModeration");
        const strippedOutModPublication = CommentModerationPubsubMessagePublicationSchema.strip().parse(commentModRaw); // we strip out here so we don't store any extra props in commentedits table
        const commentToBeEdited = this._dbHandler.queryComment(commentModRaw.commentCid); // We assume commentToBeEdited to be defined because we already tested for its existence above
        if (!commentToBeEdited) throw Error("The comment to edit doesn't exist"); // unlikely error to happen, but always a good idea to verify

        const modSignerAddress = await getPlebbitAddressFromPublicKey(commentModRaw.signature.publicKey);

        // Determine the target author signer address and domain if this moderation affects the author (ban/flair)
        let targetAuthorSignerAddress: string | undefined;
        let targetAuthorDomain: string | undefined;
        if (strippedOutModPublication.commentModeration.author) {
            // Check if the comment was published with pseudonymity - if so, get the original author address/domain
            const aliasInfo = this._dbHandler.queryPseudonymityAliasByCommentCid(commentModRaw.commentCid);
            if (aliasInfo) {
                targetAuthorSignerAddress = await getPlebbitAddressFromPublicKey(aliasInfo.originalAuthorSignerPublicKey);
                targetAuthorDomain = aliasInfo.originalAuthorDomain || undefined;
            } else {
                targetAuthorSignerAddress = commentToBeEdited.authorSignerAddress;
                // Check if the comment author used a domain address
                if (isStringDomain(commentToBeEdited.author.address)) {
                    targetAuthorDomain = commentToBeEdited.author.address;
                }
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
            throw new PlebbitError("ERR_DUPLICATE_COMMENT_MODERATION", { modTableRow });
        }

        const extraPropsInMod = remeda.difference(
            remeda.keys.strict(commentModRaw),
            remeda.keys.strict(CommentModerationPubsubMessagePublicationSchema.shape)
        );
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
                    Logger("plebbit-js:local-subplebbit:storeCommentModeration:_addCommentRowToIPFS")
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
        this._subplebbitUpdateTrigger = true;
        this._dbHandler.insertCommentModerations([modTableRow]);
        log("Inserted comment moderation", "of comment", modTableRow.commentCid, "into db", "with props", modTableRow);
    }

    private async storeVote(
        newVoteProps: VotePubsubMessagePublication,
        challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
    ) {
        const log = Logger("plebbit-js:local-subplebbit:storeVote");

        const authorSignerAddress = await getPlebbitAddressFromPublicKey(newVoteProps.signature.publicKey);
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

    private async storeSubplebbitEditPublication(
        editProps: SubplebbitEditPubsubMessagePublication,
        challengeRequestId: ChallengeRequestMessageType["challengeRequestId"]
    ) {
        const log = Logger("plebbit-js:local-subplebbit:storeSubplebbitEdit");

        const authorSignerAddress = await getPlebbitAddressFromPublicKey(editProps.signature.publicKey);
        log(
            "Received subplebbit edit",
            editProps.subplebbitEdit,
            "from author",
            editProps.author.address,
            "with signer address",
            authorSignerAddress,
            "Will be using these props to edit the sub props"
        );

        const propsAfterEdit = remeda.pick(this, remeda.keys.strict(editProps.subplebbitEdit));
        log("Current props from sub edit (not edited yet)", propsAfterEdit);
        lodashDeepMerge(propsAfterEdit, editProps.subplebbitEdit);
        await this.edit(propsAfterEdit);
        return undefined;
    }

    private isPublicationReply(publication: CommentPubsubMessagePublication): publication is ReplyPubsubMessageWithSubplebbitAuthor {
        return Boolean(publication.parentCid);
    }

    private isPublicationPost(publication: CommentPubsubMessagePublication): publication is PostPubsubMessageWithSubplebbitAuthor {
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
            return (await this._plebbit.createSigner()).privateKey;
        } else if (opts.mode === "per-reply") {
            const signer = await this._plebbit.createSigner();
            return signer.privateKey;
        } else if (opts.mode === "per-author") {
            const existing = this._dbHandler.queryPseudonymityAliasForAuthor(opts.originalAuthorSignerPublicKey);
            if (existing?.aliasPrivateKey) return existing.aliasPrivateKey;
            const signer = await this._plebbit.createSigner();
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
        const aliasSigner = await this._plebbit.createSigner({ privateKey: aliasPrivateKey, type: "ed25519" });
        const displayName = originalComment.author?.displayName;
        const sanitizedAuthor = {
            address: aliasSigner.address,
            ...(displayName !== undefined ? { displayName } : {})
        } as CommentPubsubMessagePublication["author"];

        const anonymizedComment = remeda.clone(originalComment);

        anonymizedComment.author = sanitizedAuthor;
        anonymizedComment.signature = await signComment({ comment: { ...anonymizedComment, signer: aliasSigner }, plebbit: this._plebbit });

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

        const aliasSigner = await this._plebbit.createSigner({
            privateKey: aliasSignerOfComment.aliasPrivateKey,
            type: "ed25519"
        });
        const commentEditSignedByAlias = remeda.clone(originalEdit);
        commentEditSignedByAlias.author = { address: aliasSigner.address };
        commentEditSignedByAlias.signature = await signCommentEdit({
            edit: { ...commentEditSignedByAlias, signer: aliasSigner },
            plebbit: this._plebbit
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
        const log = Logger("plebbit-js:local-subplebbit:handleChallengeExchange:storeComment");

        const commentIpfs = <CommentIpfsType>{
            ...commentPubsub,
            ...(await this._calculateLinkProps(commentPubsub.link)),
            ...(this.isPublicationPost(commentPubsub) && (await this._calculateLatestPostProps())),
            ...(this.isPublicationReply(commentPubsub) && (await this._calculateReplyProps(commentPubsub))),
            ...(pseudonymityMode ? { pseudonymityMode } : {})
        };

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
        const authorSignerAddress = await getPlebbitAddressFromPublicKey(commentPubsub.signature.publicKey);

        const strippedOutCommentIpfs = CommentIpfsSchema.strip().parse(commentIpfs); // remove unknown props

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
            throw new PlebbitError("ERR_DUPLICATE_COMMENT", { file, commentIpfs, commentPubsub });
        }

        const commentRow = <CommentsTableRow>{
            ...strippedOutCommentIpfs,
            cid: commentCid,
            postCid,
            authorSignerAddress,
            insertedAt: timestamp(),
            pendingApproval
        };

        const unknownProps = remeda.difference(
            remeda.keys.strict(commentPubsub),
            remeda.keys.strict(CommentPubsubMessagePublicationSchema.shape)
        );

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
                        originalAuthorDomain: isStringDomain(anonymity.originalComment.author.address)
                            ? anonymity.originalComment.author.address
                            : null,
                        mode: anonymity.mode,
                        insertedAt: timestamp()
                    }
                ]);

            return storedComment;
        } else if (request.subplebbitEdit) return this.storeSubplebbitEditPublication(request.subplebbitEdit, request.challengeRequestId);
        else throw Error("Don't know how to store this publication" + request);
    }

    private async _decryptOrRespondWithFailure(request: ChallengeRequestMessageType | ChallengeAnswerMessageType): Promise<string> {
        const log = Logger("plebbit-js:local-subplebbit:_decryptOrRespondWithFailure");
        try {
            return await decryptEd25519AesGcmPublicKeyBuffer(request.encrypted, this.signer.privateKey, request.signature.publicKey);
        } catch (e) {
            log.error(`Failed to decrypt request (${request.challengeRequestId.toString()}) due to error`, e);
            await this._publishFailedChallengeVerification(
                { reason: messages.ERR_SUB_FAILED_TO_DECRYPT_PUBSUB_MSG },
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
                resolveAuthorNames: this._plebbit.resolveAuthorNames,
                clientsManager: this._clientsManager,
                overrideAuthorAddressIfInvalid: false
            });
        else if (request.commentEdit)
            validity = await verifyCommentEdit({
                edit: request.commentEdit,
                resolveAuthorNames: this._plebbit.resolveAuthorNames,
                clientsManager: this._clientsManager,
                overrideAuthorAddressIfInvalid: false
            });
        else if (request.vote)
            validity = await verifyVote({
                vote: request.vote,
                resolveAuthorNames: this._plebbit.resolveAuthorNames,
                clientsManager: this._clientsManager,
                overrideAuthorAddressIfInvalid: false
            });
        else if (request.commentModeration)
            validity = await verifyCommentModeration({
                moderation: request.commentModeration,
                resolveAuthorNames: this._plebbit.resolveAuthorNames,
                clientsManager: this._clientsManager,
                overrideAuthorAddressIfInvalid: false
            });
        else if (request.subplebbitEdit)
            validity = await verifySubplebbitEdit({
                subplebbitEdit: request.subplebbitEdit,
                resolveAuthorNames: this._plebbit.resolveAuthorNames,
                clientsManager: this._clientsManager,
                overrideAuthorAddressIfInvalid: false
            });
        else throw Error("Can't detect the type of publication");

        if (!validity.valid) {
            await this._publishFailedChallengeVerification({ reason: validity.reason }, request.challengeRequestId);
            throwWithErrorCode(getErrorCodeFromMessage(validity.reason), { request, validity });
        }
    }

    private async _publishChallenges(
        challenges: Omit<Challenge, "verify">[],
        request: DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor
    ) {
        const log = Logger("plebbit-js:local-subplebbit:_publishChallenges");
        const toEncryptChallenge = <DecryptedChallenge>{ challenges };
        const toSignChallenge: Omit<ChallengeMessageType, "signature"> = cleanUpBeforePublishing({
            type: "CHALLENGE",
            protocolVersion: env.PROTOCOL_VERSION,
            userAgent: this._plebbit.userAgent,
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
            `Subplebbit ${this.address} with pubsub topic ${this.pubsubTopicWithfallback()} published ${challengeMessage.type} over pubsub: `,
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
        const log = Logger("plebbit-js:local-subplebbit:_publishFailedChallengeVerification");

        const toSignVerification: Omit<ChallengeVerificationMessageType, "signature"> = cleanUpBeforePublishing({
            type: "CHALLENGEVERIFICATION",
            challengeRequestId: challengeRequestId,
            challengeSuccess: false,
            challengeErrors: result.challengeErrors,
            reason: result.reason,
            userAgent: this._plebbit.userAgent,
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
            `Will publish ${challengeVerification.type} over pubsub topic ${this.pubsubTopicWithfallback()} on subplebbit ${this.address}:`,
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

    private async _storePublicationAndEncryptForChallengeVerification(
        request: DecryptedChallengeRequestMessageType,
        pendingApproval?: boolean
    ): Promise<(DecryptedChallengeVerification & Required<Pick<DecryptedChallengeVerificationMessageType, "encrypted">>) | undefined> {
        const commentAfterAddingToIpfs = await this.storePublication(request, pendingApproval);
        if (!commentAfterAddingToIpfs) return undefined;
        const authorSignerAddress = await getPlebbitAddressFromPublicKey(commentAfterAddingToIpfs.comment.signature.publicKey);
        const authorDomain = isStringDomain(commentAfterAddingToIpfs.comment.author.address)
            ? commentAfterAddingToIpfs.comment.author.address
            : undefined;

        const authorSubplebbit = this._dbHandler.querySubplebbitAuthor(authorSignerAddress, authorDomain);
        if (!authorSubplebbit) throw Error("author.subplebbit can never be undefined after adding a comment");
        const commentNumberPostNumber = this._dbHandler._assignNumbersForComment(commentAfterAddingToIpfs.cid);

        const commentUpdateOfVerificationNoSignature = <Omit<DecryptedChallengeVerification["commentUpdate"], "signature">>(
            cleanUpBeforePublishing({
                author: { subplebbit: authorSubplebbit },
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
        const log = Logger("plebbit-js:local-subplebbit:_publishChallengeVerification");
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
                failureReason = (e as PlebbitError).message;
                log.error("Failed to store store Publication And Encrypt For ChallengeVerification", e);
            }

            const toSignMsg: Omit<ChallengeVerificationMessageType, "signature"> = cleanUpBeforePublishing({
                type: "CHALLENGEVERIFICATION",
                challengeRequestId: request.challengeRequestId,
                encrypted: toEncrypt?.encrypted, // could be undefined
                challengeErrors: challengeResult.challengeErrors,
                userAgent: this._plebbit.userAgent,
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
        rolesToCheckAgainst: SubplebbitRoleNameUnion[]
    ): Promise<boolean> {
        if (!this.roles) return false;
        // is the author of publication a moderator?
        const signerAddress = await getPlebbitAddressFromPublicKey(publication.signature.publicKey);
        if (rolesToCheckAgainst.includes(this.roles[signerAddress]?.role as SubplebbitRoleNameUnion)) return true;

        if (this._plebbit.resolveAuthorNames) {
            const resolvedSignerAddress = isStringDomain(publication.author.address)
                ? await this._plebbit.resolveAuthorName({ address: publication.author.address })
                : publication.author.address;
            if (resolvedSignerAddress !== signerAddress) return false;
            if (rolesToCheckAgainst.includes(this.roles[publication.author.address]?.role as SubplebbitRoleNameUnion)) return true;
            if (rolesToCheckAgainst.includes(this.roles[resolvedSignerAddress]?.role as SubplebbitRoleNameUnion)) return true;
        }
        return false;
    }

    private async _checkPublicationValidity(
        request: DecryptedChallengeRequestMessageType,
        publication: PublicationFromDecryptedChallengeRequest,
        authorSubplebbit?: PublicationWithSubplebbitAuthorFromDecryptedChallengeRequest["author"]["subplebbit"]
    ): Promise<messages | undefined> {
        const log = Logger("plebbit-js:local-subplebbit:handleChallengeRequest:checkPublicationValidity");

        if (!areEquivalentSubplebbitAddresses(publication.subplebbitAddress, this.address))
            return messages.ERR_PUBLICATION_INVALID_SUBPLEBBIT_ADDRESS;

        if (publication.timestamp <= timestamp() - 5 * 60 || publication.timestamp >= timestamp() + 5 * 60)
            return messages.ERR_PUBLICATION_TIMESTAMP_IS_NOT_IN_PROPER_RANGE;

        if (typeof authorSubplebbit?.banExpiresAt === "number" && authorSubplebbit.banExpiresAt > timestamp())
            return messages.ERR_AUTHOR_IS_BANNED;

        if (remeda.intersection(remeda.keys.strict(publication.author), AuthorReservedFields).length > 0)
            return messages.ERR_PUBLICATION_AUTHOR_HAS_RESERVED_FIELD;

        if ("commentCid" in publication || "parentCid" in publication) {
            // vote or reply or commentEdit or commentModeration
            // not post though
            //@ts-expect-error
            const parentCid: string | undefined = publication.parentCid || publication.commentCid;

            if (typeof parentCid !== "string") return messages.ERR_SUB_PUBLICATION_PARENT_CID_NOT_DEFINED;

            const parent = this._dbHandler.queryComment(parentCid);
            if (!parent) return messages.ERR_PUBLICATION_PARENT_DOES_NOT_EXIST_IN_SUB;

            const parentFlags = this._dbHandler.queryCommentFlagsSetByMod(parentCid);

            if (parentFlags.removed && !request.commentModeration)
                // not allowed to vote or reply under removed comments
                return messages.ERR_SUB_PUBLICATION_PARENT_HAS_BEEN_REMOVED;

            const isParentDeletedQueryRes = this._dbHandler.queryAuthorEditDeleted(parentCid);

            if (isParentDeletedQueryRes?.deleted && !request.commentModeration) return messages.ERR_SUB_PUBLICATION_PARENT_HAS_BEEN_DELETED; // not allowed to vote or reply under deleted comments

            const postFlags = this._dbHandler.queryCommentFlagsSetByMod(parent.postCid);

            if (postFlags.removed && !request.commentModeration) return messages.ERR_SUB_PUBLICATION_POST_HAS_BEEN_REMOVED;

            const isPostDeletedQueryRes = this._dbHandler.queryAuthorEditDeleted(parent.postCid);

            if (isPostDeletedQueryRes?.deleted && !request.commentModeration) return messages.ERR_SUB_PUBLICATION_POST_HAS_BEEN_DELETED;

            if (postFlags.locked && !request.commentModeration) return messages.ERR_SUB_PUBLICATION_POST_IS_LOCKED;

            if (postFlags.archived && !request.commentModeration) return messages.ERR_SUB_PUBLICATION_POST_IS_ARCHIVED;

            if (parent.timestamp > publication.timestamp) return messages.ERR_SUB_COMMENT_TIMESTAMP_IS_EARLIER_THAN_PARENT;

            // if user publishes vote/reply/commentEdit under pending comment, it should fail
            if (parent.pendingApproval && !("commentModeration" in request)) return messages.ERR_USER_PUBLISHED_UNDER_PENDING_COMMENT;

            const isCommentDisapproved = this._dbHandler._queryIsCommentApproved(parent);
            if (isCommentDisapproved && !isCommentDisapproved.approved && !("commentModeration" in request))
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

            const voteAuthorSignerAddress = await getPlebbitAddressFromPublicKey(votePublication.signature.publicKey);
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
                return messages.ERR_SUB_COMMENT_MOD_CAN_NOT_LOCK_REPLY;
            if (isAuthorMod && commentModerationPublication.commentModeration.archived && commentToBeEdited.depth !== 0)
                return messages.ERR_SUB_COMMENT_MOD_CAN_NOT_ARCHIVE_REPLY;
            const commentModInDb = this._dbHandler.hasCommentModerationWithSignatureEncoded(
                commentModerationPublication.signature.signature
            );
            if (commentModInDb) return messages.ERR_DUPLICATE_COMMENT_MODERATION;
            if ("approved" in commentModerationPublication.commentModeration && !commentToBeEdited.pendingApproval)
                return messages.ERR_MOD_ATTEMPTING_TO_APPROVE_OR_DISAPPROVE_COMMENT_THAT_IS_NOT_PENDING;
        } else if (request.subplebbitEdit) {
            const subplebbitEdit = request.subplebbitEdit;
            if (remeda.intersection(SubplebbitEditPublicationPubsubReservedFields, remeda.keys.strict(subplebbitEdit)).length > 0)
                return messages.ERR_SUBPLEBBIT_EDIT_HAS_RESERVED_FIELD;

            if (subplebbitEdit.subplebbitEdit.roles || subplebbitEdit.subplebbitEdit.address) {
                const isAuthorOwner = await this._isPublicationAuthorPartOfRoles(subplebbitEdit, ["owner"]);
                if (!isAuthorOwner) return messages.ERR_SUBPLEBBIT_EDIT_ATTEMPTED_TO_MODIFY_OWNER_EXCLUSIVE_PROPS;
            }

            const isAuthorOwnerOrAdmin = await this._isPublicationAuthorPartOfRoles(subplebbitEdit, ["owner", "admin"]);
            if (!isAuthorOwnerOrAdmin) {
                return messages.ERR_SUBPLEBBIT_EDIT_ATTEMPTED_TO_MODIFY_SUB_WITHOUT_BEING_OWNER_OR_ADMIN;
            }

            if (
                remeda.difference(remeda.keys.strict(subplebbitEdit.subplebbitEdit), remeda.keys.strict(SubplebbitIpfsSchema.shape))
                    .length > 0
            ) {
                // should only be allowed to modify public props from SubplebbitIpfs
                // shouldn't be able to modify settings for example
                return messages.ERR_SUBPLEBBIT_EDIT_ATTEMPTED_TO_NON_PUBLIC_PROPS;
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
            decryptedJson = parseJsonWithPlebbitErrorIfFails(decryptedRawString);
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

            throw new PlebbitError("ERR_REQUEST_ENCRYPTED_HAS_INVALID_SCHEMA_AFTER_DECRYPTING", {
                decryptedJson,
                schemaError: parseRes.error
            });
        }

        return decryptedJson;
    }

    async handleChallengeRequest(request: ChallengeRequestMessageType, isLocalPublisher: boolean) {
        const log = Logger("plebbit-js:local-subplebbit:handleChallengeRequest");

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
            throw new PlebbitError(getErrorCodeFromMessage(requestSignatureValidation.reason), {
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

        const authorSignerAddress = await getPlebbitAddressFromPublicKey(publication.signature.publicKey);
        const authorDomain = isStringDomain(publication.author.address) ? publication.author.address : undefined;

        // Check publication props validity
        const subplebbitAuthor = this._dbHandler.querySubplebbitAuthor(authorSignerAddress, authorDomain);
        const decryptedRequestMsg = <DecryptedChallengeRequestMessageType>{ ...request, ...decryptedRequest };
        const decryptedRequestWithSubplebbitAuthor = <DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor>(
            remeda.clone(decryptedRequestMsg)
        );

        // set author.subplebbit for all publication fields (vote, comment, commentEdit, commentModeration) if they exist
        publicationFieldNames.forEach((pubField) => {
            if (pubField in decryptedRequestWithSubplebbitAuthor && decryptedRequestWithSubplebbitAuthor[pubField])
                decryptedRequestWithSubplebbitAuthor[pubField].author.subplebbit = subplebbitAuthor;
        });

        try {
            await this._respondWithErrorIfSignatureOfPublicationIsInvalid(decryptedRequestMsg); // This function will throw an error if signature is invalid
        } catch (e) {
            log.error(
                "Signature of challengerequest.publication is invalid, emitting an error event and aborting the challenge exchange",
                e
            );
            this.emit("challengerequest", decryptedRequestWithSubplebbitAuthor);
            return;
        }

        log.trace("Received a valid challenge request", decryptedRequestWithSubplebbitAuthor);

        this.emit("challengerequest", decryptedRequestWithSubplebbitAuthor);

        const publicationInvalidityReason = await this._checkPublicationValidity(decryptedRequestMsg, publication, subplebbitAuthor);
        if (publicationInvalidityReason)
            return this._publishFailedChallengeVerification({ reason: publicationInvalidityReason }, request.challengeRequestId);

        const answerPromiseKey = decryptedRequestWithSubplebbitAuthor.challengeRequestId.toString();
        const getChallengeAnswers: GetChallengeAnswers = async (challenges) => {
            // ...get challenge answers from user. e.g.:
            // step 1. subplebbit publishes challenge pubsub message with `challenges` provided in argument of `getChallengeAnswers`
            // step 2. subplebbit waits for challenge answer pubsub message with `challengeAnswers` and then returns `challengeAnswers`
            await this._publishChallenges(challenges, decryptedRequestWithSubplebbitAuthor);
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
            challengeVerification = await getChallengeVerification(decryptedRequestWithSubplebbitAuthor, this, getChallengeAnswers);
        } catch (e) {
            // getChallengeVerification will throw if one of the getChallenge function throws, which indicates a bug with the challenge script
            // notify the sub owner that that one of his challenge is misconfigured via an error event
            log.error("getChallenge failed, the sub owner needs to check the challenge code. The error is: ", e);
            this.emit("error", <PlebbitError>e);

            // notify the author that his publication wasn't published because the subplebbit is misconfigured
            challengeVerification = {
                challengeSuccess: false,
                reason: `One of the subplebbit challenges is misconfigured: ${(<Error>e).message}`
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
            parsedJson = parseJsonWithPlebbitErrorIfFails(decryptedRawString);
        } catch (e) {
            await this._publishFailedChallengeVerification(
                { reason: messages.ERR_CHALLENGE_ANSWER_IS_INVALID_JSON },
                challengeAnswer.challengeRequestId
            );
            throw e;
        }

        try {
            return parseDecryptedChallengeAnswerWithPlebbitErrorIfItFails(parsedJson);
        } catch (e) {
            await this._publishFailedChallengeVerification(
                { reason: messages.ERR_CHALLENGE_ANSWER_IS_INVALID_SCHEMA },
                challengeAnswer.challengeRequestId
            );
            throw e;
        }
    }

    async handleChallengeAnswer(challengeAnswer: ChallengeAnswerMessageType) {
        const log = Logger("plebbit-js:local-subplebbit:handleChallengeAnswer");

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
            throw new PlebbitError(getErrorCodeFromMessage(answerSignatureValidation.reason), { challengeAnswer });
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
        const log = Logger("plebbit-js:local-subplebbit:handleChallengeExchange");

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
            log.trace(`Received a pubsub message that is not meant to by processed by the sub - ${parsedPubsubMsg.type}. Will ignore it`);
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
        const log = Logger("plebbit-js:local-subplebbit:_calculateNewCommentUpdate");

        // If we're here that means we're gonna calculate the new update and publish it
        log.trace(`Attempting to calculate new CommentUpdate for comment (${comment.cid}) on subplebbit`, this.address);

        // This comment will have the local new CommentUpdate, which we will publish to IPFS fiels
        // It includes new author.subplebbit as well as updated values in CommentUpdate (except for replies field)
        const storedCommentUpdate = this._dbHandler.queryStoredCommentUpdate(comment);
        const authorDomain = isStringDomain(comment.author.address) ? comment.author.address : undefined;
        const calculatedCommentUpdate = this._dbHandler.queryCalculatedCommentUpdate({ comment, authorDomain });
        log.trace(
            "Calculated comment update for comment",
            comment.cid,
            "on subplebbit",
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
            subplebbit: this,
            comment,
            overrideAuthorAddressIfInvalid: false,
            validatePages: this._plebbit.validatePages,
            validateUpdateSignature: true
        };
        const validation = await verifyCommentUpdate(verificationOpts);
        if (!validation.valid) {
            log.error(`CommentUpdate (${comment.cid}) signature is invalid due to (${validation.reason}). This is a critical error`);
            throw new PlebbitError("ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID", { validation, verificationOpts });
        }
    }

    private async _listenToIncomingRequests() {
        const log = Logger("plebbit-js:local-subplebbit:sync:_listenToIncomingRequests");
        // Make sure subplebbit listens to pubsub topic
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
        const log = Logger("plebbit-js:local-subplebbit:_movePostUpdatesFolderToNewAddress");
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
        const log = Logger(`plebbit-js:local-subplebbit:_updateCommentsThatNeedToBeUpdated`);

        // Get all comments that need to be updated
        const commentsToUpdate = this._dbHandler.queryCommentsToBeUpdated();

        if (commentsToUpdate.length === 0) return [];

        this._subplebbitUpdateTrigger = true;
        log(`Will update ${commentsToUpdate.length} comments in this update loop for subplebbit (${this.address})`);

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
        log.trace("Pinned comment", unpinnedCommentRow.cid, "of subplebbit", this.address, "to IPFS node");
    }

    private async _repinCommentsIPFSIfNeeded() {
        const log = Logger("plebbit-js:local-subplebbit:start:_repinCommentsIPFSIfNeeded");
        const latestCommentCid = this._dbHandler.queryLatestCommentCid(); // latest comment ordered by id
        if (!latestCommentCid) return;
        const kuboRpcOrHelia = this._clientsManager.getDefaultKuboRpcClient();
        try {
            await genToArray(kuboRpcOrHelia._client.pin.ls({ paths: latestCommentCid.cid }));
            return; // the comment is already pinned, we assume the rest of the comments are so too
        } catch (e) {
            if (!(<Error>e).message.includes("is not pinned")) throw e;
        }

        log(
            "The latest comment is not pinned in the ipfs node, plebbit-js will repin all existing comment ipfs for subplebbit",
            this.address
        );

        // latestCommentCid should be the last in unpinnedCommentsFromDb array, in case we throw an error on a comment before it, it does not get pinned
        const unpinnedCommentsFromDb = this._dbHandler.queryAllCommentsOrderedByIdAsc(); // we assume all comments are unpinned if latest comment is not pinned

        // In the _repinCommentIpfs method:
        const limit = pLimit(50);
        const pinningPromises = unpinnedCommentsFromDb.map((unpinnedCommentRow) =>
            limit(async () => {
                if (unpinnedCommentRow.pendingApproval) return; // we don't pin comments waiting to get approved
                await this._addCommentRowToIPFS(
                    unpinnedCommentRow,
                    Logger("plebbit-js:local-subplebbit:start:_repinCommentsIPFSIfNeeded:_addCommentRowToIPFS")
                );
            })
        );

        await Promise.all(pinningPromises);

        this._dbHandler.forceUpdateOnAllComments(); // force plebbit-js to republish all comment updates

        log(`${unpinnedCommentsFromDb.length} comments' IPFS have been repinned`);
    }

    private async _unpinStaleCids() {
        const log = Logger("plebbit-js:local-subplebbit:sync:unpinStaleCids");

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
                                log.trace("Failed to unpin cid", cid, "on subplebbit", this.address, "due to error", error);
                            }
                        }
                    })
                )
            );

            log(`unpinned ${sizeBefore - this._cidsToUnPin.size} stale cids from ipfs node for subplebbit (${this.address})`);
        }
    }

    private async _rmUnneededMfsPaths(): Promise<string[]> {
        const log = Logger("plebbit-js:local-subplebbit:sync:_rmUnneededMfsPaths");

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
        const log = Logger("plebbit-js:start:_repinCommentUpdateIfNeeded");

        // iterating on all comment updates is not efficient, we should figure out a better way
        // Most of the time we run this function, the comment updates are already written to ipfs rpeo
        const kuboRpc = this._clientsManager.getDefaultKuboRpcClient();
        try {
            await kuboRpc._client.files.stat(`/${this.address}`, { hash: true });
            return; // if the directory of this sub exists, we assume all the comment updates are there
        } catch (e) {
            if (!(<Error>e).message.includes("file does not exist")) throw e;
        }

        // sub has no comment updates, we can return
        if (!this.lastCommentCid) return;

        log(`CommentUpdate directory`, this.address, "will republish all comment updates");

        this._dbHandler.forceUpdateOnAllComments(); // plebbit-js will recalculate and publish all comment updates
    }

    private async _syncPostUpdatesWithIpfs(commentUpdateRowsToPublishToIpfs: CommentUpdateToWriteToDbAndPublishToIpfs[]) {
        const log = Logger("plebbit-js:local-subplebbit:sync:_syncPostUpdatesFilesystemWithIpfs");

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
            "Subplebbit",
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

        const log = Logger("plebbit-js:local-subplebbit:start:_adjustPostUpdatesBucketsIfNeeded");
        const postsWithOutdatedPostUpdateBucket = this._dbHandler.queryPostsWithOutdatedBuckets(this._postUpdatesBuckets);
        if (postsWithOutdatedPostUpdateBucket.length === 0) return;

        this._dbHandler.forceUpdateOnAllCommentsWithCid(postsWithOutdatedPostUpdateBucket.map((post) => post.cid));

        log(`Found ${postsWithOutdatedPostUpdateBucket.length} posts with outdated buckets and forced their updates`);
    }

    private async _cleanUpIpfsRepoRarely(force = false) {
        const log = Logger("plebbit-js:local-subplebbit:syncIpnsWithDb:_cleanUpIpfsRepoRarely");
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
        const log = Logger("plebbit-js:local-subplebbit:_providePubsubTopicRoutingCidsIfNeeded");
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
        const log = Logger("plebbit-js:_addAllCidsUnderPurgedCommentToBeRemoved");
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

        const log = Logger("plebbit-js:local-subplebbit:_purgeDisapprovedCommentsOlderThan");
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
        const log = Logger("plebbit-js:local-subplebbit:sync");

        const kuboRpc = this._clientsManager.getDefaultKuboRpcClient();
        try {
            await this._listenToIncomingRequests();
            await this._providePubsubTopicRoutingCidsIfNeeded();
            await this._adjustPostUpdatesBucketsIfNeeded();
            this._setStartedStateWithEmission("publishing-ipns");
            this._clientsManager.updateKuboRpcState("publishing-ipns", kuboRpc.url);
            await this._purgeDisapprovedCommentsOlderThan();
            const commentUpdateRows = await this._updateCommentsThatNeedToBeUpdated();
            this._requireSubplebbitUpdateIfModQueueChanged();
            await this.updateSubplebbitIpnsIfNeeded(commentUpdateRows);
            await this._cleanUpIpfsRepoRarely();
        } catch (e) {
            //@ts-expect-error
            e.details = { ...e.details, subplebbitAddress: this.address };
            const errorTyped = <Error>e;
            this._setStartedStateWithEmission("failed");
            this._clientsManager.updateKuboRpcState("stopped", kuboRpc.url);

            log.error(
                `Failed to sync sub`,
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
            await this._clientsManager.clearDomainCache(newAddressAsDomain, "community");
            const resolvedIpnsFromNewDomain = await this._clientsManager.resolveCommunityNameIfNeeded(newAddressAsDomain);
            if (resolvedIpnsFromNewDomain !== this.signer.address)
                throw new PlebbitError("ERR_DOMAIN_SUB_ADDRESS_TXT_RECORD_POINT_TO_DIFFERENT_ADDRESS", {
                    currentSubplebbitAddress: this.address,
                    newAddressAsDomain,
                    resolvedIpnsFromNewDomain,
                    signerAddress: this.signer.address,
                    started: this.started
                });
        }
    }

    private async _initSignerProps(newSignerProps: InternalSubplebbitRecordBeforeFirstUpdateType["signer"]) {
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
        const log = Logger("plebbit-js:local-subplebbit:_publishLoop");
        // we need to continue the loop if there's at least one pending edit

        const shouldStopPublishLoop = () => {
            return this.state !== "started" || (this._stopHasBeenCalled && this._pendingEditProps.length === 0);
        };

        const waitUntilNextSync = async () => {
            const doneWithLoopTime = Date.now();
            await new Promise((resolve) => {
                const checkInterval = setInterval(() => {
                    const syncIntervalMsPassedSinceDoneWithLoop = Date.now() - doneWithLoopTime >= syncIntervalMs;
                    this._calculateLatestUpdateTrigger(); // will update this._subplebbitUpdateTrigger
                    if (this._subplebbitUpdateTrigger || shouldStopPublishLoop() || syncIntervalMsPassedSinceDoneWithLoop) {
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
        log("Stopping the publishing loop of subplebbit", this.address);
    }

    private async _initBeforeStarting() {
        this.protocolVersion = env.PROTOCOL_VERSION;
        if (!this.signer?.address) throwWithErrorCode("ERR_SUB_SIGNER_NOT_DEFINED");
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
        await this._dbHandler.initDbIfNeeded();
    }

    private async _parseRolesToEdit(
        newRawRoles: NonNullable<SubplebbitEditOptions["roles"]>
    ): Promise<NonNullable<InternalSubplebbitRecordAfterFirstUpdateType["roles"]>> {
        for (const [roleAddress, roleValue] of Object.entries(newRawRoles)) {
            if (roleValue === undefined || roleValue === null) continue; // skip removals
            if (isStringDomain(roleAddress)) {
                let resolved: string | null;
                try {
                    resolved = await this._clientsManager.resolveAuthorNameIfNeeded(roleAddress);
                } catch {
                    resolved = null;
                }
                if (!resolved) throw new PlebbitError("ERR_ROLE_ADDRESS_DOMAIN_COULD_NOT_BE_RESOLVED", { roleAddress });
            }
        }
        return <NonNullable<SubplebbitIpfsType["roles"]>>remeda.omitBy(newRawRoles, (val, key) => val === undefined || val === null);
    }

    private async _parseChallengesToEdit(
        newChallengeSettings: NonNullable<NonNullable<SubplebbitEditOptions["settings"]>["challenges"]>
    ): Promise<NonNullable<Pick<InternalSubplebbitRecordAfterFirstUpdateType, "challenges" | "_usingDefaultChallenge">>> {
        return {
            challenges: await Promise.all(
                newChallengeSettings.map((cs) => getSubplebbitChallengeFromSubplebbitChallengeSettings(cs, this._plebbit))
            ),
            _usingDefaultChallenge: remeda.isDeepEqual(newChallengeSettings, this._defaultSubplebbitChallenges)
        };
    }

    async _validateNewAddressBeforeEditing(newAddress: string, log: Logger) {
        if (doesDomainAddressHaveCapitalLetter(newAddress))
            throw new PlebbitError("ERR_DOMAIN_ADDRESS_HAS_CAPITAL_LETTER", { subplebbitAddress: newAddress });
        // Check if any existing sub (other than this one) already has an equivalent address
        // This handles both exact matches and .eth/.bso alias equivalence
        const existingEquivalent = this._plebbit.subplebbits.find(
            (existing) =>
                areEquivalentSubplebbitAddresses(existing, newAddress) && !areEquivalentSubplebbitAddresses(existing, this.address)
        );
        if (existingEquivalent)
            throw new PlebbitError("ERR_SUB_OWNER_ATTEMPTED_EDIT_NEW_ADDRESS_THAT_ALREADY_EXISTS", {
                currentSubplebbitAddress: this.address,
                newSubplebbitAddress: newAddress,
                currentSubs: this._plebbit.subplebbits
            });
        this._assertDomainResolvesCorrectly(newAddress).catch((err: PlebbitError) => {
            log.error(err);
            this.emit("error", err);
        });
    }

    async _editPropsOnStartedSubplebbit(parsedEditOptions: ParsedSubplebbitEditOptions): Promise<typeof this> {
        // 'this' is the started subplebbit with state="started"
        // this._plebbit._startedSubplebbits[this.address] === this
        const log = Logger("plebbit-js:local-subplebbit:start:editPropsOnStartedSubplebbit");
        const oldAddress = remeda.clone(this.address);
        if (typeof parsedEditOptions.address === "string" && this.address !== parsedEditOptions.address) {
            await this._validateNewAddressBeforeEditing(parsedEditOptions.address, log);

            log(`Attempting to edit subplebbit.address from ${oldAddress} to ${parsedEditOptions.address}. We will stop sub first`);
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
            await this.initInternalSubplebbitAfterFirstUpdateNoMerge({
                ...this.toJSONInternalAfterFirstUpdate(),
                ...parsedEditOptions,
                _internalStateUpdateId: uniqueEditId
            });
        else
            await this.initInternalSubplebbitBeforeFirstUpdateNoMerge({
                ...this.toJSONInternalBeforeFirstUpdate(),
                ...parsedEditOptions,
                _internalStateUpdateId: uniqueEditId
            });
        this._subplebbitUpdateTrigger = true;
        log(
            `Subplebbit (${this.address}) props (${remeda.keys.strict(parsedEditOptions)}) has been edited. Will be including edited props in next update: `,
            remeda.pick(this, remeda.keys.strict(parsedEditOptions))
        );
        this.emit("update", this);
        if (this.address !== oldAddress) {
            this._plebbit._startedSubplebbits[this.address] = this._plebbit._startedSubplebbits[oldAddress] = this;
            _startedSubplebbits[this.address] = _startedSubplebbits[oldAddress] = this;
        }
        return this;
    }

    async _editPropsOnNotStartedSubplebbit(parsedEditOptions: ParsedSubplebbitEditOptions): Promise<typeof this> {
        // sceneario 3, the sub is not running anywhere, we need to edit the db and update this instance
        const log = Logger("plebbit-js:local-subplebbit:edit:editPropsOnNotStartedSubplebbit");
        const oldAddress = remeda.clone(this.address);
        await this.initDbHandlerIfNeeded();
        await this._dbHandler.initDbIfNeeded();
        if (typeof parsedEditOptions.address === "string" && this.address !== parsedEditOptions.address) {
            await this._validateNewAddressBeforeEditing(parsedEditOptions.address, log);

            log(`Attempting to edit subplebbit.address from ${oldAddress} to ${parsedEditOptions.address}`);

            // in this sceneario we're editing a subplebbit that's not started anywhere
            log("will rename the subplebbit", this.address, "db in edit() because the subplebbit is not being ran anywhere else");
            await this._movePostUpdatesFolderToNewAddress(this.address, parsedEditOptions.address);
            this._dbHandler.destoryConnection();
            await this._dbHandler.changeDbFilename(this.address, parsedEditOptions.address);
            await this._dbHandler.initDbIfNeeded();
            this.setAddress(parsedEditOptions.address);
        }
        const mergedInternalState = await this._updateDbInternalState(parsedEditOptions);

        if ("updatedAt" in mergedInternalState && mergedInternalState.updatedAt)
            await this.initInternalSubplebbitAfterFirstUpdateNoMerge(mergedInternalState);
        else await this.initInternalSubplebbitBeforeFirstUpdateNoMerge(mergedInternalState);
        await this._dbHandler.destoryConnection();
        this.emit("update", this);
        return this;
    }

    override async edit(newSubplebbitOptions: SubplebbitEditOptions): Promise<typeof this> {
        // scenearios
        // 1 - calling edit() on a subplebbit instance that's not running, but the it's started in plebbit._startedSubplebbits (should edit the started subplebbit)
        // 2 - calling edit() on a subplebbit that's started in another process (should throw)
        // 3 - calling edit() on a subplebbit that's not started (should load db and edit it)
        // 4 - calling edit() on the subplebbit that's started (should edit the started subplebbit)

        const startedSubplebbit = this._plebbit._startedSubplebbits[this.address] || _startedSubplebbits[this.address];
        if (startedSubplebbit && this.state !== "started") {
            // sceneario 1
            const editRes = await startedSubplebbit.edit(newSubplebbitOptions);

            this.setAddress(editRes.address); // need to force an update of the address for this instance
            await this._updateInstancePropsWithStartedSubOrDb();
            return this;
        }

        await this.initDbHandlerIfNeeded();
        await this._updateStartedValue();
        if (this.started && this.state !== "started") {
            // sceneario 2
            this._dbHandler.destoryConnection();
            throw new PlebbitError("ERR_CAN_NOT_EDIT_A_LOCAL_SUBPLEBBIT_THAT_IS_ALREADY_STARTED_IN_ANOTHER_PROCESS", {
                address: this.address,
                dataPath: this._plebbit.dataPath
            });
        }

        const parsedEditOptions = parseSubplebbitEditOptionsSchemaWithPlebbitErrorIfItFails(newSubplebbitOptions);

        const newInternalProps = <Pick<InternalSubplebbitRecordAfterFirstUpdateType, "roles" | "challenges" | "_usingDefaultChallenge">>{
            ...(parsedEditOptions.roles ? { roles: await this._parseRolesToEdit(parsedEditOptions.roles) } : undefined),
            ...(parsedEditOptions?.settings?.challenges
                ? await this._parseChallengesToEdit(parsedEditOptions.settings.challenges)
                : undefined)
        };

        const newProps = <ParsedSubplebbitEditOptions>{
            ...remeda.omit(parsedEditOptions, ["roles"]), // we omit here to make tsc shut up
            ...newInternalProps
        };

        if (!this.started && !startedSubplebbit) {
            // sceneario 3
            return this._editPropsOnNotStartedSubplebbit(newProps);
        }

        if (this._plebbit._startedSubplebbits[this.address] === this) {
            // sceneario 4
            return this._editPropsOnStartedSubplebbit(newProps);
        }
        throw new Error("Can't edit a subplebbit that's started in another process");
    }

    override async start() {
        const log = Logger("plebbit-js:local-subplebbit:start");
        if (this.state === "updating") throw new PlebbitError("ERR_NEED_TO_STOP_UPDATING_SUB_BEFORE_STARTING", { address: this.address });
        this._stopHasBeenCalled = false;
        this._firstUpdateAfterStart = true;
        if (!this._clientsManager.getDefaultKuboRpcClientOrHelia())
            throw Error("You need to define an IPFS client in your plebbit instance to be able to start a local sub");
        await this.initDbHandlerIfNeeded();
        await this._updateStartedValue();
        if (this.started || this._plebbit._startedSubplebbits[this.address] || _startedSubplebbits[this.address])
            throw new PlebbitError("ERR_SUB_ALREADY_STARTED", { address: this.address });
        try {
            await this._initBeforeStarting();
            // update started value twice because it could be started prior lockSubStart
            this._setState("started");
            await this._updateStartedValue();
            await this._dbHandler.lockSubStart(); // Will throw if sub is locked already
            this._plebbit._startedSubplebbits[this.address] = this;
            _startedSubplebbits[this.address] = this;
            await this._updateStartedValue();
            await this._dbHandler.initDbIfNeeded();
            await this._dbHandler.createOrMigrateTablesIfNeeded();

            await this._setChallengesToDefaultIfNotDefined(log);
            // Import subplebbit keys onto ipfs node
            await this._importSubplebbitSignerIntoIpfsIfNeeded();
            await this._providePubsubTopicRoutingCidsIfNeeded(true);

            this._subplebbitUpdateTrigger = true;
            this._setStartedStateWithEmission("publishing-ipns");
            await this._repinCommentsIPFSIfNeeded();
            await this._repinCommentUpdateIfNeeded();
            await this._listenToIncomingRequests();
            this.challenges = await Promise.all(
                this.settings.challenges!.map((cs) => getSubplebbitChallengeFromSubplebbitChallengeSettings(cs, this._plebbit))
            ); // make sure subplebbit.challenges is using latest props from settings.challenges
        } catch (e) {
            await this.stop(); // Make sure to reset the sub state
            //@ts-expect-error
            e.details = { ...e.details, subAddress: this.address };
            throw e;
        }

        this._publishLoopPromise = this._publishLoop(this._plebbit.publishInterval).catch((err) => {
            log.error(err);
            this.emit("error", err);
        });
    }

    private async _initMirroringStartedOrUpdatingSubplebbit(startedSubplebbit: LocalSubplebbit) {
        const updatingStateChangeListener = (newState: SubplebbitUpdatingState) => {
            this._setUpdatingStateWithEventEmissionIfNewState(newState);
        };

        const startedStateChangeListener = (newState: LocalSubplebbit["startedState"]) => {
            this._setStartedStateWithEmission(newState);
            updatingStateChangeListener(newState);
        };

        const updateListener = async (updatedSubplebbit: RemoteSubplebbit) => {
            const startedSubplebbit = updatedSubplebbit as LocalSubplebbit;
            if (startedSubplebbit.updateCid)
                await this.initInternalSubplebbitAfterFirstUpdateNoMerge(startedSubplebbit.toJSONInternalAfterFirstUpdate());
            else await this.initInternalSubplebbitBeforeFirstUpdateNoMerge(startedSubplebbit.toJSONInternalBeforeFirstUpdate());
            this.started = startedSubplebbit.started;
            this.emit("update", this);
        };
        const stateChangeListener = async (newState: SubplebbitState) => {
            // plebbit._startedSubplebbits[address].stop() has been called, we need to stop mirroring
            // or plebbit._updatingSubplebbits[address].stop(), we need to stop mirroring
            if (newState === "stopped") await this._cleanUpMirroredStartedOrUpdatingSubplebbit();
        };
        this._mirroredStartedOrUpdatingSubplebbit = {
            subplebbit: startedSubplebbit,
            updatingstatechange: updatingStateChangeListener,
            update: updateListener,
            statechange: stateChangeListener,
            startedstatechange: startedStateChangeListener,
            error: (err: PlebbitError | Error) => this.emit("error", err),
            challengerequest: (challengeRequest) => this.emit("challengerequest", challengeRequest),
            challengeverification: (challengeVerification) => this.emit("challengeverification", challengeVerification),
            challengeanswer: (challengeAnswer) => this.emit("challengeanswer", challengeAnswer),
            challenge: (challenge) => this.emit("challenge", challenge)
        };

        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.on("update", this._mirroredStartedOrUpdatingSubplebbit.update);
        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.on(
            "startedstatechange",
            this._mirroredStartedOrUpdatingSubplebbit.startedstatechange
        );
        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.on(
            "updatingstatechange",
            this._mirroredStartedOrUpdatingSubplebbit.updatingstatechange
        );
        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.on("statechange", this._mirroredStartedOrUpdatingSubplebbit.statechange);
        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.on("error", this._mirroredStartedOrUpdatingSubplebbit.error);
        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.on(
            "challengerequest",
            this._mirroredStartedOrUpdatingSubplebbit.challengerequest
        );
        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.on(
            "challengeverification",
            this._mirroredStartedOrUpdatingSubplebbit.challengeverification
        );
        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.on(
            "challengeanswer",
            this._mirroredStartedOrUpdatingSubplebbit.challengeanswer
        );
        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.on("challenge", this._mirroredStartedOrUpdatingSubplebbit.challenge);

        const clientKeys = remeda.keys.strict(this.clients);
        for (const clientType of clientKeys)
            if (this.clients[clientType])
                for (const clientUrl of Object.keys(this.clients[clientType]))
                    if (clientUrl in this._mirroredStartedOrUpdatingSubplebbit.subplebbit.clients[clientType])
                        this.clients[clientType][clientUrl].mirror(
                            this._mirroredStartedOrUpdatingSubplebbit.subplebbit.clients[clientType][clientUrl]
                        );
        if (startedSubplebbit.updateCid)
            await this.initInternalSubplebbitAfterFirstUpdateNoMerge(startedSubplebbit.toJSONInternalAfterFirstUpdate());
        else await this.initInternalSubplebbitBeforeFirstUpdateNoMerge(startedSubplebbit.toJSONInternalBeforeFirstUpdate());
        this.emit("update", this);
    }

    private async _cleanUpMirroredStartedOrUpdatingSubplebbit() {
        if (!this._mirroredStartedOrUpdatingSubplebbit) return;
        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.removeListener("update", this._mirroredStartedOrUpdatingSubplebbit.update);
        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.removeListener(
            "updatingstatechange",
            this._mirroredStartedOrUpdatingSubplebbit.updatingstatechange
        );

        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.removeListener(
            "startedstatechange",
            this._mirroredStartedOrUpdatingSubplebbit.startedstatechange
        );
        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.removeListener(
            "statechange",
            this._mirroredStartedOrUpdatingSubplebbit.statechange
        );
        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.removeListener("error", this._mirroredStartedOrUpdatingSubplebbit.error);
        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.removeListener(
            "challengerequest",
            this._mirroredStartedOrUpdatingSubplebbit.challengerequest
        );
        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.removeListener(
            "challengeverification",
            this._mirroredStartedOrUpdatingSubplebbit.challengeverification
        );
        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.removeListener(
            "challengeanswer",
            this._mirroredStartedOrUpdatingSubplebbit.challengeanswer
        );
        this._mirroredStartedOrUpdatingSubplebbit.subplebbit.removeListener(
            "challenge",
            this._mirroredStartedOrUpdatingSubplebbit.challenge
        );

        const clientKeys = remeda.keys.strict(this.clients);

        for (const clientType of clientKeys)
            if (this.clients[clientType])
                for (const clientUrl of Object.keys(this.clients[clientType])) this.clients[clientType][clientUrl].unmirror();

        this._mirroredStartedOrUpdatingSubplebbit = undefined;
    }

    private async _updateOnce() {
        const log = Logger("plebbit-js:local-subplebbit:_updateOnce");
        await this.initDbHandlerIfNeeded();
        await this._updateStartedValue();
        const startedSubplebbit = (this._plebbit._startedSubplebbits[this.address] || _startedSubplebbits[this.address]) as
            | LocalSubplebbit
            | undefined;
        if (this._mirroredStartedOrUpdatingSubplebbit)
            return; // we're already mirroring a started or updating subplebbit
        else if (startedSubplebbit) {
            // let's mirror the started subplebbit in this process
            await this._initMirroringStartedOrUpdatingSubplebbit(startedSubplebbit);
            delete this._plebbit._updatingSubplebbits[this.address];
            delete this._plebbit._updatingSubplebbits[this.signer.address];
            return;
        } else if (
            this._plebbit._updatingSubplebbits[this.address] instanceof LocalSubplebbit &&
            this._plebbit._updatingSubplebbits[this.address] !== this
        ) {
            // different instance is updating, let's mirror it
            await this._initMirroringStartedOrUpdatingSubplebbit(this._plebbit._updatingSubplebbits[this.address] as LocalSubplebbit);
            return;
        } else {
            // this sub is not started or updated anywhere, but maybe another process will call edit() on it
            this._plebbit._updatingSubplebbits[this.address] = this;
            const oldUpdateId = remeda.clone(this._internalStateUpdateId);
            await this._updateInstancePropsWithStartedSubOrDb(); // will update this instance props with DB
            if (this._internalStateUpdateId !== oldUpdateId) {
                log(
                    `Local Subplebbit (${this.address}) received a new update from db with updatedAt (${this.updatedAt}). Will emit an update event`
                );

                this._changeStateEmitEventEmitStateChangeEvent({
                    event: { name: "update", args: [this] },
                    newUpdatingState: "succeeded"
                });
            }
        }
    }

    private async _updateLoop() {
        const log = Logger("plebbit-js:local-subplebbit:update:_updateLoop");
        while (this.state === "updating" && !this._stopHasBeenCalled) {
            try {
                await this._updateOnce();
            } catch (e) {
                log.error("Error in update loop", e);
                this.emit("error", e as PlebbitError | Error);
            } finally {
                await new Promise<void>((resolve) => {
                    if (this._updateLoopAbortController?.signal.aborted) return resolve();
                    const timer = setTimeout(resolve, this._plebbit.updateInterval);
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
        if (this.state === "started") throw new PlebbitError("ERR_SUB_ALREADY_STARTED", { address: this.address });
        if (this.state === "updating") return;
        this._stopHasBeenCalled = false;
        this._setState("updating");

        try {
            await this._updateOnce();
        } catch (e) {
            this.emit("error", e as PlebbitError | Error);
        }
        this._updateLoopAbortController = new AbortController();
        this._updateLoopPromise = this._updateLoop();
    }

    override async stop() {
        const log = Logger("plebbit-js:local-subplebbit:stop");
        this._stopHasBeenCalled = true;
        if (this._updateLoopAbortController) {
            this._updateLoopAbortController.abort();
            this._updateLoopAbortController = undefined;
        }
        this.posts._stop();

        if (this.state === "started") {
            log("Stopping running subplebbit", this.address);
            try {
                await this._clientsManager.pubsubUnsubscribe(this.pubsubTopicWithfallback(), this.handleChallengeExchange);
            } catch (e) {
                log.error("Failed to unsubscribe from challenge exchange pubsub when stopping subplebbit", e);
            }
            if (this._publishLoopPromise) {
                try {
                    await this._publishLoopPromise;
                } catch (e) {
                    log.error(`Failed to stop subplebbit publish loop`, e);
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
                await this._dbHandler.unlockSubStart();
            } catch (e) {
                log.error(`Failed to unlock start lock on sub (${this.address})`, e);
            }
            const kuboRpcClient = this._clientsManager.getDefaultKuboRpcClient();
            const pubsubClient = this._clientsManager.getDefaultKuboPubsubClient();

            this._setStartedStateWithEmission("stopped");
            delete this._plebbit._startedSubplebbits[this.address];
            delete this._plebbit._startedSubplebbits[this.signer.address]; // in case we changed address
            delete _startedSubplebbits[this.address];
            delete _startedSubplebbits[this.signer.address];
            await this._dbHandler.rollbackAllTransactions();
            await this._dbHandler.unlockSubState();
            await this._updateStartedValue();
            this._clientsManager.updateKuboRpcState("stopped", kuboRpcClient.url);
            this._clientsManager.updateKuboRpcPubsubState("stopped", pubsubClient.url);
            if (this._dbHandler) this._dbHandler.destoryConnection();
            log(`Stopped the running of local subplebbit (${this.address})`);
            this._setState("stopped");
        } else if (this.state === "updating") {
            if (this._updateLoopPromise) {
                await this._updateLoopPromise;
                this._updateLoopPromise = undefined;
            }
            if (this._dbHandler) this._dbHandler.destoryConnection();
            if (this._mirroredStartedOrUpdatingSubplebbit) await this._cleanUpMirroredStartedOrUpdatingSubplebbit();
            if (this._plebbit._updatingSubplebbits[this.address] === this) {
                delete this._plebbit._updatingSubplebbits[this.address];
                delete this._plebbit._updatingSubplebbits[this.signer.address];
            }
            this._setUpdatingStateWithEventEmissionIfNewState("stopped");
            log(`Stopped the updating of local subplebbit (${this.address})`);
            this._setState("stopped");
        }
    }

    override async delete() {
        const log = Logger("plebbit-js:local-subplebbit:delete");
        log.trace(`Attempting to stop the subplebbit (${this.address}) before deleting, if needed`);

        const startedSubplebbit = (this._plebbit._startedSubplebbits[this.address] || _startedSubplebbits[this.address]) as
            | LocalSubplebbit
            | undefined;
        if (startedSubplebbit && startedSubplebbit !== this) {
            await startedSubplebbit.delete();
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
            log.error("Failed to delete subplebbit mfs folder", "/" + this.address, e);
        }
        // sceneario 1: we call delete() on a subplebbit that is not started or updating
        // scenario 2: we call delete() on a subplebbit that is updating
        // scenario 3: we call delete() on a subplebbit that is started
        // scenario 4: we call delete() on a subplebbit that is not started, but the same sub is started in plebbit._startedSubplebbits[address]

        try {
            await this._addOldPageCidsToCidsToUnpin(this.raw?.subplebbitIpfs?.posts, undefined);
        } catch (e) {
            log.error("Failed to add old page cids from subplebbit.posts to be unpinned", e);
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
            log.error("Failed to query all cids under this subplebbit to delete them", e);
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

        await moveSubplebbitDbToDeletedDirectory(this.address, this._plebbit);

        log(`Deleted subplebbit (${this.address}) successfully`);
    }
}

import {
    getDefaultDataPath,
    listSubplebbitsSync as nodeListSubplebbits,
    createKuboRpcClient,
    monitorSubplebbitsDirectory,
    trytoDeleteSubsThatFailedToBeDeletedBefore
} from "../runtime/node/util.js";
import type {
    StorageInterface,
    GatewayClient,
    KuboRpcClient,
    PlebbitEvents,
    PubsubClient,
    ParsedPlebbitOptions,
    LRUStorageInterface,
    LRUStorageConstructor,
    PubsubSubscriptionHandler,
    InputPlebbitOptions,
    AuthorPubsubType,
    PlebbitMemCaches,
    CreatePublicationOptions
} from "../types.js";
import { Comment } from "../publications/comment/comment.js";
import {
    waitForUpdateInSubInstanceWithErrorAndTimeout,
    areEquivalentSubplebbitAddresses,
    deepMergeRuntimeFields,
    doesDomainAddressHaveCapitalLetter,
    hideClassPrivateProps,
    removeUndefinedValuesRecursively,
    timestamp,
    resolveWhenPredicateIsTrue
} from "../util.js";
import Vote from "../publications/vote/vote.js";
import { createSigner, verifyCommentPubsubMessage } from "../signer/index.js";
import { CommentEdit } from "../publications/comment-edit/comment-edit.js";
import Logger from "@plebbit/plebbit-logger";
import env from "../version.js";
import { verifyCommentEdit, verifyCommentIpfs, verifyCommentUpdate, verifySubplebbitEdit } from "../signer/signatures.js";
import Stats from "../stats.js";
import Storage from "../runtime/node/storage.js";
import { PlebbitClientsManager } from "./plebbit-client-manager.js";
import PlebbitRpcClient from "../clients/rpc-client/plebbit-rpc-client.js";
import { PlebbitError } from "../plebbit-error.js";
import { InflightFetchManager } from "../util/inflight-fetch-manager.js";
import type {
    ChallengeFileFactoryInput,
    CreateInstanceOfLocalOrRemoteSubplebbitOptions,
    CreateNewLocalSubplebbitParsedOptions,
    CreateRemoteSubplebbitOptions,
    SubplebbitJson,
    SubplebbitIpfsType,
    RemoteSubplebbitJson,
    RpcRemoteSubplebbitJson
} from "../subplebbit/types.js";
import LRUStorage from "../runtime/node/lru-storage.js";
import { RemoteSubplebbit } from "../subplebbit/remote-subplebbit.js";
import { RpcRemoteSubplebbit } from "../subplebbit/rpc-remote-subplebbit.js";
import { RpcLocalSubplebbit } from "../subplebbit/rpc-local-subplebbit.js";
import { LocalSubplebbit } from "../runtime/node/subplebbit/local-subplebbit.js";
import { extractSubplebbitRuntimeFieldsFromParsedPages } from "../pages/util.js";
import pTimeout, { TimeoutError } from "p-timeout";
import * as remeda from "remeda";
import { z } from "zod";
import type { CreateSignerOptions } from "../signer/types.js";
import type {
    CommentEditOptionsToSign,
    CommentEditPubsubMessagePublication,
    CommentEditTypeJson,
    CreateCommentEditOptions
} from "../publications/comment-edit/types.js";
import type { CreateVoteOptions, VoteJson, VoteOptionsToSign, VotePubsubMessagePublication } from "../publications/vote/types.js";
import type {
    CommentIpfsType,
    CommentIpfsWithCidDefined,
    CommentJson,
    CommentOptionsToSign,
    CommentPubsubMessagePublication,
    CommentUpdateType,
    CommentWithinRepliesPostsPageJson,
    CreateCommentOptions,
    MinimumCommentFieldsToFetchPages
} from "../publications/comment/types.js";

import { AuthorAddressSchema, AuthorReservedFields, CidStringSchema, SubplebbitAddressSchema } from "../schema/schema.js";
import {
    CreateRemoteSubplebbitFunctionArgumentSchema,
    CreateSubplebbitFunctionArgumentsSchema,
    PubsubTopicSchema,
    SubplebbitIpfsSchema
} from "../subplebbit/schema.js";
import {
    parseCidStringSchemaWithPlebbitErrorIfItFails,
    parseCommentEditPubsubMessagePublicationSchemaWithPlebbitErrorIfItFails,
    parseCommentIpfsSchemaWithPlebbitErrorIfItFails,
    parseCommentModerationPubsubMessagePublicationSchemaWithPlebbitErrorIfItFails,
    parseCommentPubsubMessagePublicationWithPlebbitErrorIfItFails,
    parseCreateCommentEditOptionsSchemaWithPlebbitErrorIfItFails,
    parseCreateCommentModerationOptionsSchemaWithPlebbitErrorIfItFails,
    parseCreateCommentOptionsSchemaWithPlebbitErrorIfItFails,
    parseCreateRemoteSubplebbitFunctionArgumentSchemaWithPlebbitErrorIfItFails,
    parseCreateSubplebbitEditPublicationOptionsSchemaWithPlebbitErrorIfItFails,
    parseCreateVoteOptionsSchemaWithPlebbitErrorIfItFails,
    parsePlebbitUserOptionsSchemaWithPlebbitErrorIfItFails,
    parseSubplebbitAddressWithPlebbitErrorIfItFails,
    parseSubplebbitEditPubsubMessagePublicationSchemaWithPlebbitErrorIfItFails,
    parseVotePubsubMessagePublicationSchemaWithPlebbitErrorIfItFails
} from "../schema/schema-util.js";
import { CommentModeration } from "../publications/comment-moderation/comment-moderation.js";
import type {
    CommentModerationOptionsToSign,
    CommentModerationPubsubMessagePublication,
    CommentModerationTypeJson,
    CreateCommentModerationOptions
} from "../publications/comment-moderation/types.js";
import { setupKuboAddressesRewriterAndHttpRouters } from "../runtime/node/setup-kubo-address-rewriter-and-http-router.js";
import SubplebbitEdit from "../publications/subplebbit-edit/subplebbit-edit.js";
import type {
    CreateSubplebbitEditPublicationOptions,
    SubplebbitEditJson,
    SubplebbitEditPublicationOptionsToSign,
    SubplebbitEditPubsubMessagePublication
} from "../publications/subplebbit-edit/types.js";
import { LRUCache } from "lru-cache";
import { PlebbitTypedEmitter } from "../clients/plebbit-typed-emitter.js";
import type { PageTypeJson } from "../pages/types.js";
import { createLibp2pJsClientOrUseExistingOne } from "../helia/helia-for-plebbit.js";
import { Libp2pJsClient } from "../helia/libp2pjsClient.js";
import { AuthorNameRpcParam, CidRpcParam, SubplebbitAddressRpcParam } from "../clients/rpc-client/types.js";
import { parseRpcAuthorNameParam, parseRpcCidParam, parseRpcSubplebbitAddressParam } from "../clients/rpc-client/rpc-schema-util.js";
import { cleanWireAuthor, normalizeCreatePublicationAuthor } from "../publications/publication-author.js";
import { IndexedTrackedInstanceRegistry, TrackedInstanceRegistry } from "./tracked-instance-registry.js";
import {
    findUpdatingSubplebbit,
    listStartedSubplebbits,
    listUpdatingComments,
    listUpdatingSubplebbits
} from "./tracked-instance-registry-util.js";

export class Plebbit extends PlebbitTypedEmitter<PlebbitEvents> implements ParsedPlebbitOptions {
    ipfsGatewayUrls: ParsedPlebbitOptions["ipfsGatewayUrls"];
    kuboRpcClientsOptions?: ParsedPlebbitOptions["kuboRpcClientsOptions"];
    pubsubKuboRpcClientsOptions: ParsedPlebbitOptions["pubsubKuboRpcClientsOptions"];
    plebbitRpcClientsOptions?: ParsedPlebbitOptions["plebbitRpcClientsOptions"];
    libp2pJsClientsOptions?: ParsedPlebbitOptions["libp2pJsClientsOptions"];
    dataPath?: ParsedPlebbitOptions["dataPath"];
    resolveAuthorNames: ParsedPlebbitOptions["resolveAuthorNames"];
    nameResolvers?: ParsedPlebbitOptions["nameResolvers"];
    parsedPlebbitOptions: ParsedPlebbitOptions;
    publishInterval: ParsedPlebbitOptions["publishInterval"];
    updateInterval: ParsedPlebbitOptions["updateInterval"];
    noData: ParsedPlebbitOptions["noData"];
    validatePages: ParsedPlebbitOptions["validatePages"];
    userAgent: ParsedPlebbitOptions["userAgent"];
    httpRoutersOptions: ParsedPlebbitOptions["httpRoutersOptions"];

    // Only Plebbit instance has these props
    clients: {
        ipfsGateways: { [ipfsGatewayUrl: NonNullable<ParsedPlebbitOptions["ipfsGatewayUrls"]>[number]]: GatewayClient };
        kuboRpcClients: { [kuboRpcClientUrl: string]: KuboRpcClient };
        pubsubKuboRpcClients: { [pubsubKuboClientUrl: string]: PubsubClient };
        plebbitRpcClients: { [plebbitRpcUrl: NonNullable<ParsedPlebbitOptions["plebbitRpcClientsOptions"]>[number]]: PlebbitRpcClient };
        libp2pJsClients: {
            [libp2pJsClientKey: NonNullable<ParsedPlebbitOptions["libp2pJsClientsOptions"]>[number]["key"]]: Libp2pJsClient;
        };
    };
    subplebbits!: string[]; // default is [], in case of RPC it will be the aggregate of all RPC servers' subs

    settings: {
        challenges?: Record<string, ChallengeFileFactoryInput>;
    };

    // private props

    _plebbitRpcClient?: PlebbitRpcClient; // default rpc client for now. For now we will default to clients.plebbitRpcClients[0]
    private _pubsubSubscriptions: Record<string, PubsubSubscriptionHandler> = {};
    _clientsManager!: PlebbitClientsManager;
    _userPlebbitOptions: InputPlebbitOptions; // this is the raw input from user
    _stats!: Stats;
    _storage!: StorageInterface;
    _updatingSubplebbits: IndexedTrackedInstanceRegistry<RemoteSubplebbit | RpcRemoteSubplebbit | RpcLocalSubplebbit | LocalSubplebbit> =
        new TrackedInstanceRegistry() as IndexedTrackedInstanceRegistry<
            RemoteSubplebbit | RpcRemoteSubplebbit | RpcLocalSubplebbit | LocalSubplebbit
        >; // storing subplebbit instance that are getting updated rn
    _updatingComments: IndexedTrackedInstanceRegistry<Comment> = new TrackedInstanceRegistry() as IndexedTrackedInstanceRegistry<Comment>; // storing comment instancse that are getting updated rn
    _startedSubplebbits: IndexedTrackedInstanceRegistry<LocalSubplebbit | RpcLocalSubplebbit> =
        new TrackedInstanceRegistry() as IndexedTrackedInstanceRegistry<LocalSubplebbit | RpcLocalSubplebbit>; // storing subplebbit instance that are started rn
    private _subplebbitFsWatchAbort?: AbortController;

    private _addressRewriterDestroy?: () => Promise<void>;
    private _addressRewriterSetupPromise?: Promise<void>;
    destroyed = false;
    private _promiseToWaitForFirstSubplebbitschangeEvent: Promise<string[]>;

    private _storageLRUs: Record<string, LRUStorageInterface> = {}; // Cache name to storage interface
    _memCaches!: PlebbitMemCaches;
    _inflightFetchManager: InflightFetchManager;

    _timeouts = {
        "subplebbit-ipns": 5 * 60 * 1000, // 5min, for resolving subplebbit IPNS, or fetching subplebbit from gateways
        "subplebbit-ipfs": 60 * 1000, // 1min, for fetching subplebbit cid P2P
        "comment-ipfs": 60 * 1000, // 1 min
        "comment-update-ipfs": 2 * 60 * 1000, // 2 min
        "page-ipfs": 30 * 1000, // 30s for pages
        "generic-ipfs": 30 * 1000 // 30s generic ipfs
    }; // timeout in ms for each load type when we're loading from kubo/helia/gateway

    constructor(options: InputPlebbitOptions) {
        super();
        this._userPlebbitOptions = options;
        this.parsedPlebbitOptions = parsePlebbitUserOptionsSchemaWithPlebbitErrorIfItFails(options);

        // Make nameResolver function props non-enumerable so they're excluded from JSON serialization and spread
        if (this.parsedPlebbitOptions.nameResolvers) {
            for (const resolver of this.parsedPlebbitOptions.nameResolvers) {
                Object.defineProperty(resolver, "resolve", {
                    enumerable: false,
                    value: resolver.resolve,
                    writable: true,
                    configurable: true
                });
                Object.defineProperty(resolver, "canResolve", {
                    enumerable: false,
                    value: resolver.canResolve,
                    writable: true,
                    configurable: true
                });
            }
        }

        // initializing fields

        this.plebbitRpcClientsOptions = this.parsedPlebbitOptions.plebbitRpcClientsOptions;

        this.ipfsGatewayUrls = this.parsedPlebbitOptions.ipfsGatewayUrls =
            this.plebbitRpcClientsOptions || !this.parsedPlebbitOptions.ipfsGatewayUrls?.length
                ? undefined
                : this.parsedPlebbitOptions.ipfsGatewayUrls;
        this.kuboRpcClientsOptions = this.parsedPlebbitOptions.kuboRpcClientsOptions = this.plebbitRpcClientsOptions
            ? undefined
            : this.parsedPlebbitOptions.kuboRpcClientsOptions;

        // We default for ipfsHttpClientsOptions first, but if it's not defined we use the default from schema
        this.pubsubKuboRpcClientsOptions = this.parsedPlebbitOptions.pubsubKuboRpcClientsOptions = this.plebbitRpcClientsOptions
            ? undefined
            : this._userPlebbitOptions.pubsubKuboRpcClientsOptions // did the user provide their own pubsub options
              ? this.parsedPlebbitOptions.pubsubKuboRpcClientsOptions // if not, then we use ipfsHttpClientOptions or defaults
              : this.parsedPlebbitOptions.kuboRpcClientsOptions || this.parsedPlebbitOptions.pubsubKuboRpcClientsOptions;

        this.libp2pJsClientsOptions = this.parsedPlebbitOptions.libp2pJsClientsOptions;
        if (this.libp2pJsClientsOptions && (this.kuboRpcClientsOptions?.length || this.pubsubKuboRpcClientsOptions?.length))
            throw new PlebbitError("ERR_CAN_NOT_HAVE_BOTH_KUBO_AND_LIBP2P_JS_CLIENTS_DEFINED", {
                libp2pJsClientsOptions: this.libp2pJsClientsOptions,
                kuboRpcClientsOptions: this.kuboRpcClientsOptions,
                pubsubKuboRpcClientsOptions: this.pubsubKuboRpcClientsOptions
            });
        this.resolveAuthorNames = this.parsedPlebbitOptions.resolveAuthorNames;
        this.publishInterval = this.parsedPlebbitOptions.publishInterval;
        this.updateInterval = this.parsedPlebbitOptions.updateInterval;
        this.noData = this.parsedPlebbitOptions.noData;
        this.validatePages = this.parsedPlebbitOptions.validatePages;
        this.userAgent = this.parsedPlebbitOptions.userAgent;
        this.httpRoutersOptions = this.parsedPlebbitOptions.httpRoutersOptions;
        this.settings = {
            challenges: this.parsedPlebbitOptions.challenges
        };
        // nameResolvers contains functions that can't be serialized over RPC, so skip for RPC clients
        this.nameResolvers = this.plebbitRpcClientsOptions ? undefined : this.parsedPlebbitOptions.nameResolvers;
        this.on("subplebbitschange", (newSubs) => {
            this.subplebbits = newSubs;
        });

        this._promiseToWaitForFirstSubplebbitschangeEvent = new Promise((resolve) => this.once("subplebbitschange", resolve));

        //@ts-expect-error
        this.clients = {};

        this._initKuboRpcClientsIfNeeded();
        this._initKuboPubsubClientsIfNeeded();
        this._initRpcClientsIfNeeded();
        this._initIpfsGatewaysIfNeeded();
        this._initMemCaches();
        this._inflightFetchManager = new InflightFetchManager();

        if (!this.noData && !this.plebbitRpcClientsOptions)
            this.dataPath = this.parsedPlebbitOptions.dataPath =
                "dataPath" in this.parsedPlebbitOptions ? this.parsedPlebbitOptions.dataPath : getDefaultDataPath();
    }

    _initMemCaches() {
        this._memCaches = {
            subplebbitVerificationCache: new LRUCache<string, boolean>({ max: 100 }),
            pageVerificationCache: new LRUCache<string, boolean>({ max: 1000 }),
            commentVerificationCache: new LRUCache<string, boolean>({ max: 5000 }),
            commentUpdateVerificationCache: new LRUCache<string, boolean>({ max: 100_000 }),
            commentIpfs: new LRUCache<string, CommentIpfsType>({ max: 10 }),
            subplebbitForPublishing: new LRUCache({
                max: 100,
                ttl: 600000
            }),
            pageCidToSortTypes: new LRUCache<string, string[]>({ max: 5000 }),
            pagesMaxSize: new LRUCache<string, number>({ max: 50000 }),
            nameResolvedCache: new LRUCache<string, boolean>({ max: 5000 })
        };
    }

    private _initKuboRpcClientsIfNeeded() {
        this.clients.kuboRpcClients = {};
        if (!this.kuboRpcClientsOptions) return;
        for (const clientOptions of this.kuboRpcClientsOptions) {
            const kuboRpcClient = createKuboRpcClient(clientOptions);
            this.clients.kuboRpcClients[clientOptions.url!.toString()] = {
                _client: kuboRpcClient,
                _clientOptions: clientOptions,
                peers: kuboRpcClient.swarm.peers,
                url: clientOptions.url!.toString(),
                destroy: async () => {}
            };
        }
    }

    private _initKuboPubsubClientsIfNeeded() {
        this.clients.pubsubKuboRpcClients = {};
        if (!this.pubsubKuboRpcClientsOptions) return;

        for (const clientOptions of this.pubsubKuboRpcClientsOptions) {
            const kuboRpcClient = createKuboRpcClient(clientOptions);
            this.clients.pubsubKuboRpcClients[clientOptions.url!.toString()] = {
                _client: kuboRpcClient,
                _clientOptions: clientOptions,
                peers: async () => {
                    const topics = await kuboRpcClient.pubsub.ls();
                    const topicPeers = remeda.flattenDeep(await Promise.all(topics.map((topic) => kuboRpcClient.pubsub.peers(topic))));
                    const peers = remeda.unique(topicPeers.map((topicPeer) => topicPeer.toString()));
                    return peers;
                },
                url: clientOptions.url!.toString(),
                destroy: async () => {}
            };
        }
    }

    private async _initLibp2pJsClientsIfNeeded() {
        this.clients.libp2pJsClients = {};
        if (!this.libp2pJsClientsOptions) return;
        if (!this.httpRoutersOptions) throw Error("httpRoutersOptions is required for libp2pJsClient");
        for (const clientOptions of this.libp2pJsClientsOptions) {
            const heliaNode = await createLibp2pJsClientOrUseExistingOne({
                ...clientOptions,
                httpRoutersOptions: this.httpRoutersOptions
            });
            this.clients.libp2pJsClients[clientOptions.key] = heliaNode;
        }
    }

    private _initRpcClientsIfNeeded() {
        this.clients.plebbitRpcClients = {};
        if (!this.plebbitRpcClientsOptions) return;
        for (const rpcUrl of this.plebbitRpcClientsOptions) this.clients.plebbitRpcClients[rpcUrl] = new PlebbitRpcClient(rpcUrl);
    }

    private _initIpfsGatewaysIfNeeded() {
        // If user did not provide ipfsGatewayUrls
        this.clients.ipfsGateways = {};
        if (!this.ipfsGatewayUrls) return;
        for (const gatewayUrl of this.ipfsGatewayUrls) this.clients.ipfsGateways[gatewayUrl] = {};
    }

    private async _setupHttpRoutersWithKuboNodeInBackground() {
        const log = Logger("plebbit-js:plebbit:_initHttpRoutersWithIpfsInBackground");

        if (this.destroyed) return;

        if (this.httpRoutersOptions?.length && this.kuboRpcClientsOptions?.length && this._canCreateNewLocalSub()) {
            // only for node
            const setupPromise = setupKuboAddressesRewriterAndHttpRouters(this)
                .then(async (addressesRewriterProxyServer) => {
                    if (this.destroyed) {
                        await addressesRewriterProxyServer.destroy();
                        return;
                    }

                    log(
                        "Set http router options and their proxies successfully on all connected ipfs",
                        Object.keys(this.clients.kuboRpcClients)
                    );
                    this._addressRewriterDestroy = addressesRewriterProxyServer.destroy;
                })
                .catch((e: Error) => {
                    if (this.destroyed) return;
                    log.error("Failed to set http router options and their proxies on ipfs nodes due to error", e);
                    this.emit("error", e);
                });

            this._addressRewriterSetupPromise = setupPromise;
        }
    }

    async _init() {
        const log = Logger("plebbit-js:plebbit:_init");
        // Init storage
        this._storage = new Storage(this);
        await this._storage.init();

        // Init stats
        this._stats = new Stats({ _storage: this._storage, clients: this.clients });
        // Init clients manager

        // plebbit-with-rpc-client will subscribe to subplebbitschange and settingschange for us
        if (this._canCreateNewLocalSub() && !this.plebbitRpcClientsOptions) {
            await trytoDeleteSubsThatFailedToBeDeletedBefore(this, log);
            this._subplebbitFsWatchAbort = await monitorSubplebbitsDirectory(this);
            await this._waitForSubplebbitsToBeDefined();
        } else {
            this.subplebbits = []; // subplebbits = [] on browser
        }

        await this._setupHttpRoutersWithKuboNodeInBackground();
        await this._initLibp2pJsClientsIfNeeded();
        this._clientsManager = new PlebbitClientsManager(this);

        hideClassPrivateProps(this);
    }

    async getSubplebbit(getSubplebbitArgs: SubplebbitAddressRpcParam) {
        const parsedArgs = parseRpcSubplebbitAddressParam(getSubplebbitArgs);
        const subplebbit = await this.createSubplebbit(parsedArgs);

        if (typeof subplebbit.createdAt === "number") return <RpcLocalSubplebbit | LocalSubplebbit>subplebbit; // It's a local sub, and alreadh has been loaded, no need to wait
        const timeoutMs = this._timeouts["subplebbit-ipns"];
        await waitForUpdateInSubInstanceWithErrorAndTimeout(subplebbit, timeoutMs);

        return subplebbit;
    }

    async getComment(cid: CidRpcParam): Promise<Comment> {
        const log = Logger("plebbit-js:plebbit:getComment");
        const parsedGetCommentArgs = parseRpcCidParam(cid);
        // getComment is interested in loading CommentIpfs only
        const comment = await this.createComment(parsedGetCommentArgs);

        let lastUpdateError: Error | undefined;

        const errorListener = (err: Error) => (lastUpdateError = err);
        comment.on("error", errorListener);

        const commentTimeout = this._timeouts["comment-ipfs"];
        try {
            await pTimeout(comment._attemptInfintelyToLoadCommentIpfs(), {
                milliseconds: commentTimeout,
                message:
                    lastUpdateError ||
                    new TimeoutError(`plebbit.getComment({cid: ${parsedGetCommentArgs}}) timed out after ${commentTimeout}ms`)
            });
            if (!comment.signature) throw Error("Failed to load CommentIpfs");
            return comment;
        } catch (e) {
            if (lastUpdateError) throw lastUpdateError;
            throw e;
        } finally {
            comment.removeListener("error", errorListener);
            await comment.stop();
        }
    }

    private async _initMissingFieldsOfPublicationBeforeSigning(
        pubOptions:
            | CreateCommentOptions
            | CreateCommentEditOptions
            | CreateVoteOptions
            | CreateCommentModerationOptions
            | CreateSubplebbitEditPublicationOptions,
        log: Logger
    ): Promise<CommentOptionsToSign | VoteOptionsToSign | CommentEditOptionsToSign | SubplebbitEditPublicationOptionsToSign> {
        const finalOptions = remeda.clone(pubOptions);
        if (!finalOptions.signer) throw Error("User did not provide a signer to create a local publication");
        const normalizedAuthor = normalizeCreatePublicationAuthor(finalOptions.author);
        const cleanedAuthor = cleanWireAuthor(normalizedAuthor);
        const filledTimestamp = typeof finalOptions.timestamp !== "number" ? timestamp() : finalOptions.timestamp;
        const filledSigner = await this.createSigner(finalOptions.signer);
        const filledProtocolVersion = finalOptions.protocolVersion || env.PROTOCOL_VERSION;

        return {
            ...finalOptions,
            timestamp: filledTimestamp,
            signer: filledSigner,
            author: cleanedAuthor,
            protocolVersion: filledProtocolVersion
        };
    }

    private async _createCommentInstanceFromAnotherCommentInstance(options: Comment | CommentWithinRepliesPostsPageJson | CommentJson) {
        const commentInstance = new Comment(this);

        if (options.cid) commentInstance.setCid(options.cid);
        if (options.communityAddress) commentInstance.setCommunityAddress(options.communityAddress);
        if (options.raw?.commentUpdate?.cid) commentInstance.setCid(options.raw?.commentUpdate?.cid);
        if ("pubsubMessageToPublish" in options.raw && options.raw.pubsubMessageToPublish && "signer" in options && options.signer)
            commentInstance._initLocalProps({
                comment: options.raw.pubsubMessageToPublish,
                signer: options.signer,
                challengeRequest: options.challengeRequest
            });
        else if ("signer" in options && options.signer) {
            const unsignedOpts = (options.raw as { unsignedPublicationOptions?: CreatePublicationOptions }).unsignedPublicationOptions;
            if (unsignedOpts) {
                const log = Logger("plebbit-js:plebbit:createComment");
                const finalOptions = <CommentOptionsToSign>(
                    await this._initMissingFieldsOfPublicationBeforeSigning({ ...unsignedOpts, signer: options.signer }, log)
                );
                commentInstance._initUnsignedLocalProps({
                    unsignedOptions: finalOptions,
                    challengeRequest: options.challengeRequest
                });
            }
        }
        if (options.raw.comment) commentInstance._initIpfsProps(options.raw.comment);
        // can only get one CommentUpdate
        if ("commentUpdateFromChallengeVerification" in options.raw && options.raw.commentUpdateFromChallengeVerification)
            commentInstance._initCommentUpdateFromChallengeVerificationProps(options.raw.commentUpdateFromChallengeVerification);
        if (options.raw.commentUpdate) commentInstance._initCommentUpdate(options.raw.commentUpdate);
        if (commentInstance.author && typeof options.author?.nameResolved === "boolean")
            commentInstance.author.nameResolved = options.author.nameResolved;
        return commentInstance;
    }

    async createComment(
        options:
            | CommentIpfsType
            | CommentPubsubMessagePublication
            | { cid: CommentUpdateType["cid"]; communityAddress?: string; subplebbitAddress?: string }
            | MinimumCommentFieldsToFetchPages
            | CreateCommentOptions
            | CommentJson
            | Comment
            | CommentWithinRepliesPostsPageJson
            | CommentIpfsWithCidDefined
    ): Promise<Comment> {
        const log = Logger("plebbit-js:plebbit:createComment");

        if ("clients" in options || "raw" in options || "original" in options || options instanceof Comment)
            return this._createCommentInstanceFromAnotherCommentInstance(
                options as Comment | CommentWithinRepliesPostsPageJson | CommentJson
            ); // CommentJson

        const commentInstance = new Comment(this);
        if ("communityAddress" in options && options.communityAddress)
            commentInstance.setCommunityAddress(parseSubplebbitAddressWithPlebbitErrorIfItFails(options.communityAddress));
        else if ("subplebbitAddress" in options && options.subplebbitAddress)
            commentInstance.setCommunityAddress(parseSubplebbitAddressWithPlebbitErrorIfItFails(options.subplebbitAddress as string));

        if ("depth" in options) {
            // Options is CommentIpfs | CommentIpfsWithCidDefined | MinimumCommentFieldsToFetchPages
            if ("cid" in options) commentInstance.setCid(parseCidStringSchemaWithPlebbitErrorIfItFails(options.cid));
            //@ts-expect-error
            const commentIpfs: CommentIpfsType = remeda.omit(options, ["cid"]); // remove cid to make sure if options:CommentIpfsWithCidDefined that cid doesn't become part of comment.raw.comment

            // if it has signature it means it's a full CommentIpfs
            if (!("signature" in options)) Object.assign(commentInstance, options);
            else commentInstance._initIpfsProps(parseCommentIpfsSchemaWithPlebbitErrorIfItFails(commentIpfs));
        } else if ("signature" in options) {
            // parsedOptions is CommentPubsubMessage
            const parsedOptions = parseCommentPubsubMessagePublicationWithPlebbitErrorIfItFails(options);
            commentInstance._initPubsubMessageProps(parsedOptions);
        } else if ("signer" in options) {
            // options is CreateCommentOptions
            const runtimeAuthorNameResolved = typeof options.author?.nameResolved === "boolean" ? options.author.nameResolved : undefined;
            const parsedOptions = parseCreateCommentOptionsSchemaWithPlebbitErrorIfItFails(options);
            // Defer signing to publish() — just fill missing fields and store unsigned options
            const fieldsFilled = <CommentOptionsToSign>await this._initMissingFieldsOfPublicationBeforeSigning(parsedOptions, log);
            commentInstance._initUnsignedLocalProps({
                unsignedOptions: fieldsFilled,
                challengeRequest: parsedOptions.challengeRequest
            });
            if (typeof runtimeAuthorNameResolved === "boolean") commentInstance.author.nameResolved = runtimeAuthorNameResolved;
        } else if ("cid" in options) {
            // {cid: string, subplebbitAddress?: string}
            commentInstance.setCid(parseCidStringSchemaWithPlebbitErrorIfItFails(options.cid));
        } else {
            throw Error("Make sure you provided a remote comment props or signer to create a new local comment");
        }
        if (commentInstance.cid) {
            commentInstance._useUpdatePropsFromUpdatingStartedSubplebbitIfPossible();
            commentInstance._useUpdatePropsFromUpdatingCommentIfPossible();
        }

        return commentInstance;
    }

    _canCreateNewLocalSub(): boolean {
        // TODO check if we have a connection to kubo rpc node for IPFS and pubsub
        const isNode = typeof process?.versions?.node !== "undefined";
        return isNode && Boolean(this.dataPath);
    }

    protected async _setSubplebbitIpfsOnInstanceIfPossible(
        subplebbit: RpcRemoteSubplebbit | RemoteSubplebbit,
        options: CreateRemoteSubplebbitOptions | SubplebbitIpfsType | RemoteSubplebbitJson | RpcRemoteSubplebbitJson
    ) {
        await subplebbit.initRemoteSubplebbitPropsNoMerge(options);
        const preservedRuntimeFields = extractSubplebbitRuntimeFieldsFromParsedPages({
            postsPages: subplebbit.posts.pages,
            modQueuePages: subplebbit.modQueue.pages
        });
        const reapplyPreservedRuntimeFields = () => {
            if (preservedRuntimeFields) deepMergeRuntimeFields(subplebbit, preservedRuntimeFields);
        };

        if ("raw" in options && options.raw.subplebbitIpfs) {
            await subplebbit.initSubplebbitIpfsPropsNoMerge(options.raw.subplebbitIpfs); // we're setting SubplebbitIpfs
            reapplyPreservedRuntimeFields();
        }

        if ("updateCid" in options && options.updateCid) subplebbit.updateCid = options.updateCid;
        if (!subplebbit.raw.subplebbitIpfs) {
            // we didn't receive options that we can parse into SubplebbitIpfs
            // let's try using _updatingSubplebbits
            await subplebbit._setSubplebbitIpfsPropsFromUpdatingSubplebbitsIfPossible();
            if (subplebbit.raw.subplebbitIpfs) reapplyPreservedRuntimeFields();
        }

        // last resort to set subplebbit ipfs props
        if (!subplebbit.raw.subplebbitIpfs) {
            if (options.signature) {
                const resParseSubplebbitIpfs = SubplebbitIpfsSchema.loose().safeParse(
                    remeda.pick(options, <(keyof SubplebbitIpfsType)[]>[...options.signature.signedPropertyNames, "signature"])
                );
                if (resParseSubplebbitIpfs.success) {
                    const cleanedRecord = removeUndefinedValuesRecursively(resParseSubplebbitIpfs.data); // safe way to replicate JSON.stringify() which is done before adding record to ipfs
                    await subplebbit.initSubplebbitIpfsPropsNoMerge(cleanedRecord);
                    reapplyPreservedRuntimeFields();
                }
            }
        }
    }

    protected async _waitForSubplebbitsToBeDefined() {
        // we're just wait until this.subplebbits is either defined, or subplebbitschange is emitted

        await this._promiseToWaitForFirstSubplebbitschangeEvent;
        if (!Array.isArray(this.subplebbits)) throw Error("plebbit.subplebbits should be defined after subplebbitschange event");
    }

    async _awaitSubplebbitsToIncludeSub(subAddress: string): Promise<void> {
        if (this.subplebbits.includes(subAddress)) return;
        else
            await resolveWhenPredicateIsTrue({
                toUpdate: this,
                predicate: () => this.subplebbits.includes(subAddress),
                eventName: "subplebbitschange"
            });
    }

    private async _createRemoteSubplebbitInstance(options: z.infer<typeof CreateRemoteSubplebbitFunctionArgumentSchema>) {
        const log = Logger("plebbit-js:plebbit:createRemoteSubplebbit");

        log.trace("Received subplebbit options to create a remote subplebbit instance:", options);
        const subplebbit = new RemoteSubplebbit(this);
        await this._setSubplebbitIpfsOnInstanceIfPossible(subplebbit, options);

        log.trace(`Created remote subplebbit instance (${subplebbit.address})`);
        return subplebbit;
    }

    private async _createLocalSub(
        options: CreateNewLocalSubplebbitParsedOptions | CreateInstanceOfLocalOrRemoteSubplebbitOptions
    ): Promise<LocalSubplebbit> {
        const log = Logger("plebbit-js:plebbit:createLocalSubplebbit");
        log.trace("Received subplebbit options to create a local subplebbit instance:", options);

        const canCreateLocalSub = this._canCreateNewLocalSub();
        if (!canCreateLocalSub) throw new PlebbitError("ERR_CAN_NOT_CREATE_A_LOCAL_SUB", { plebbitOptions: this._userPlebbitOptions });

        const localSubs = await nodeListSubplebbits(this);
        const isLocalSub = localSubs.includes(options.address); // Sub exists already, only pass address so we don't override other props
        const subplebbit = new LocalSubplebbit(this);
        if (isLocalSub) {
            // If the sub is already created before, then load it with address only. We don't care about other props
            subplebbit.setAddress(options.address);
            await subplebbit._updateInstancePropsWithStartedSubOrDb();
            log.trace(`Created instance of existing local subplebbit (${subplebbit.address}) with props:`);
            subplebbit.emit("update", subplebbit);
            return subplebbit;
        } else if ("signer" in options) {
            // This is a new sub
            const parsedOptions = <CreateNewLocalSubplebbitParsedOptions>options;
            await subplebbit.initNewLocalSubPropsNoMerge(parsedOptions); // We're initializing a new local sub props here
            await subplebbit._createNewLocalSubDb();
            log.trace(`Created a new local subplebbit (${subplebbit.address}) with props:`);
            subplebbit.emit("update", subplebbit);
            await this._awaitSubplebbitsToIncludeSub(subplebbit.address);
            return subplebbit;
        } else throw Error("Are you trying to create a local sub with no address or signer? This is a critical error");
    }

    private async _createSubInstanceFromJsonifiedSub(jsonfied: SubplebbitJson): ReturnType<Plebbit["createSubplebbit"]> {
        // jsonfied = JSON.parse(JSON.stringify(subplebbitInstance))
        // should probably exclude internal and instance-exclusive props like states

        if (this.subplebbits.includes(jsonfied.address)) return this._createLocalSub(jsonfied);
        else return this._createRemoteSubplebbitInstance(jsonfied);
    }

    async createSubplebbit(
        options: z.infer<typeof CreateSubplebbitFunctionArgumentsSchema> | SubplebbitJson = {}
    ): Promise<RemoteSubplebbit | RpcRemoteSubplebbit | RpcLocalSubplebbit | LocalSubplebbit> {
        const log = Logger("plebbit-js:plebbit:createSubplebbit");
        if (options instanceof RemoteSubplebbit) return options; // not sure why somebody would call createSubplebbit with an instance, will probably change later
        if ("clients" in options) return this._createSubInstanceFromJsonifiedSub(<SubplebbitJson>options);
        const parsedOptions = <z.infer<typeof CreateSubplebbitFunctionArgumentsSchema>>options;
        log.trace("Received options: ", parsedOptions);

        const hasAddress = "address" in parsedOptions && typeof parsedOptions.address === "string";
        const hasName = "name" in parsedOptions && typeof parsedOptions.name === "string";
        const hasPublicKey = "publicKey" in parsedOptions && typeof parsedOptions.publicKey === "string";
        const hasSigner = "signer" in parsedOptions && parsedOptions.signer !== undefined;
        const hasIdentifier = hasAddress || hasName || hasPublicKey; // can identify an existing sub

        // Derive effective address for local-vs-remote checks
        const effectiveAddress =
            ((parsedOptions as Record<string, unknown>).address as string | undefined) ||
            ((parsedOptions as Record<string, unknown>).name as string | undefined) ||
            ((parsedOptions as Record<string, unknown>).publicKey as string | undefined);

        if (effectiveAddress && doesDomainAddressHaveCapitalLetter(effectiveAddress))
            throw new PlebbitError("ERR_DOMAIN_ADDRESS_HAS_CAPITAL_LETTER", { ...parsedOptions });

        // Creating a subplebbit when we're connected to RPC will be handled in plebbit-with-rpc-client
        // Code below is for NodeJS and browser using IPFS-P2P/gateway

        const canCreateLocalSub = this._canCreateNewLocalSub(); // this is true if we're on NodeJS and have a dataPath

        if (hasSigner && !canCreateLocalSub)
            throw new PlebbitError("ERR_CAN_NOT_CREATE_A_LOCAL_SUB", {
                plebbitOptions: this._userPlebbitOptions,
                isEnvNode: Boolean(process),
                hasDataPath: Boolean(this.dataPath)
            });

        if (!canCreateLocalSub) {
            // we're either on browser or on NodeJS with no dataPath
            const parsedRemoteOptions = parseCreateRemoteSubplebbitFunctionArgumentSchemaWithPlebbitErrorIfItFails(options);
            return this._createRemoteSubplebbitInstance(parsedRemoteOptions);
        }

        if (hasIdentifier && !hasSigner) {
            // sub is already created, need to check if it's local or remote
            const localSubs = await nodeListSubplebbits(this);
            // Check for exact match or .eth/.bso alias match
            const localSubAddress = localSubs.find((localAddr) => areEquivalentSubplebbitAddresses(localAddr, effectiveAddress!));
            if (localSubAddress) return this._createLocalSub({ address: localSubAddress });
            else {
                const parsedRemoteOptions = parseCreateRemoteSubplebbitFunctionArgumentSchemaWithPlebbitErrorIfItFails(options);
                return this._createRemoteSubplebbitInstance(parsedRemoteOptions);
            }
        } else if (!hasIdentifier && !hasSigner) {
            // no identifier, no signer, create signer and assign address to signer.address
            const signer = await this.createSigner();
            const localOptions = <CreateNewLocalSubplebbitParsedOptions>{ ...parsedOptions, signer, address: signer.address };
            log(`Did not provide CreateSubplebbitOptions.signer, generated random signer with address (${localOptions.address})`);

            return this._createLocalSub(localOptions);
        } else if (!hasIdentifier && hasSigner) {
            const signerInput = parsedOptions.signer as { type: "ed25519"; privateKey: string } | undefined;
            const signer = await this.createSigner(signerInput);
            const localOptions = <CreateNewLocalSubplebbitParsedOptions>{
                ...parsedOptions,
                address: signer.address,
                signer
            };
            return this._createLocalSub(localOptions);
        } else if (hasIdentifier && hasSigner)
            return this._createLocalSub(parsedOptions as unknown as CreateNewLocalSubplebbitParsedOptions);
        else throw new PlebbitError("ERR_CAN_NOT_CREATE_A_LOCAL_SUB", { parsedOptions });
    }

    async _createVoteInstanceFromJsonfiedVote(jsonfied: VoteJson) {
        const voteInstance = new Vote(this);
        const unsignedOpts = (jsonfied.raw as { unsignedPublicationOptions?: CreatePublicationOptions }).unsignedPublicationOptions;
        if (jsonfied.raw.pubsubMessageToPublish)
            voteInstance._initLocalProps({
                vote: jsonfied.raw.pubsubMessageToPublish,
                signer: jsonfied.signer,
                challengeRequest: jsonfied.challengeRequest
            });
        else if (unsignedOpts && jsonfied.signer) {
            const log = Logger("plebbit-js:plebbit:createVote");
            const finalOptions = <VoteOptionsToSign>(
                await this._initMissingFieldsOfPublicationBeforeSigning({ ...unsignedOpts, signer: jsonfied.signer }, log)
            );
            voteInstance._initUnsignedLocalProps({
                unsignedOptions: finalOptions,
                challengeRequest: jsonfied.challengeRequest
            });
        }
        return voteInstance;
    }

    async createVote(options: CreateVoteOptions | VotePubsubMessagePublication | VoteJson): Promise<Vote> {
        const log = Logger("plebbit-js:plebbit:createVote");
        if ("clients" in options) return this._createVoteInstanceFromJsonfiedVote(options);
        const voteInstance = new Vote(this);

        if ("signature" in options) {
            const parsedOptions = parseVotePubsubMessagePublicationSchemaWithPlebbitErrorIfItFails(options);
            voteInstance._initRemoteProps(parsedOptions);
        } else {
            const parsedOptions = parseCreateVoteOptionsSchemaWithPlebbitErrorIfItFails(options);
            const finalOptions = <VoteOptionsToSign>await this._initMissingFieldsOfPublicationBeforeSigning(parsedOptions, log);
            voteInstance._initUnsignedLocalProps({
                unsignedOptions: finalOptions,
                challengeRequest: parsedOptions.challengeRequest
            });
        }
        return voteInstance;
    }

    async _createCommentEditInstanceFromJsonfiedCommentEdit(jsonfied: CommentEditTypeJson) {
        const editInstance = new CommentEdit(this);
        const unsignedOpts = (jsonfied.raw as { unsignedPublicationOptions?: CreatePublicationOptions }).unsignedPublicationOptions;
        if (jsonfied.raw.pubsubMessageToPublish)
            editInstance._initLocalProps({
                commentEdit: jsonfied.raw.pubsubMessageToPublish,
                signer: jsonfied.signer,
                challengeRequest: jsonfied.challengeRequest
            });
        else if (unsignedOpts && jsonfied.signer) {
            const log = Logger("plebbit-js:plebbit:createCommentEdit");
            const finalOptions = <CommentEditOptionsToSign>(
                await this._initMissingFieldsOfPublicationBeforeSigning({ ...unsignedOpts, signer: jsonfied.signer }, log)
            );
            editInstance._initUnsignedLocalProps({
                unsignedOptions: finalOptions,
                challengeRequest: jsonfied.challengeRequest
            });
        }
        return editInstance;
    }

    async createCommentEdit(
        options: CreateCommentEditOptions | CommentEditPubsubMessagePublication | CommentEditTypeJson
    ): Promise<CommentEdit> {
        const log = Logger("plebbit-js:plebbit:createCommentEdit");
        if ("clients" in options) return this._createCommentEditInstanceFromJsonfiedCommentEdit(options);
        const editInstance = new CommentEdit(this);

        if ("signature" in options) {
            const parsedOptions = parseCommentEditPubsubMessagePublicationSchemaWithPlebbitErrorIfItFails(options);
            editInstance._initPubsubPublicationProps(parsedOptions); // User just wants to instantiate a CommentEdit object, not publish
        } else {
            const parsedOptions = parseCreateCommentEditOptionsSchemaWithPlebbitErrorIfItFails(options);
            const finalOptions = <CommentEditOptionsToSign>await this._initMissingFieldsOfPublicationBeforeSigning(options, log);
            editInstance._initUnsignedLocalProps({
                unsignedOptions: finalOptions,
                challengeRequest: parsedOptions.challengeRequest
            });
        }
        return editInstance;
    }

    async _createCommentModerationInstanceFromJsonfiedCommentModeration(jsonfied: CommentModerationTypeJson) {
        const modInstance = new CommentModeration(this);
        const unsignedOpts = (jsonfied.raw as { unsignedPublicationOptions?: CreatePublicationOptions }).unsignedPublicationOptions;
        if (jsonfied.raw.pubsubMessageToPublish)
            modInstance._initLocalProps({
                commentModeration: jsonfied.raw.pubsubMessageToPublish,
                signer: jsonfied.signer,
                challengeRequest: jsonfied.challengeRequest
            });
        else if (unsignedOpts && jsonfied.signer) {
            const log = Logger("plebbit-js:plebbit:createCommentModeration");
            const finalOptions = <CommentModerationOptionsToSign>(
                await this._initMissingFieldsOfPublicationBeforeSigning({ ...unsignedOpts, signer: jsonfied.signer }, log)
            );
            modInstance._initUnsignedLocalProps({
                unsignedOptions: finalOptions,
                challengeRequest: jsonfied.challengeRequest
            });
        }
        return modInstance;
    }

    async createCommentModeration(
        options: CreateCommentModerationOptions | CommentModerationPubsubMessagePublication | CommentModerationTypeJson
    ): Promise<CommentModeration> {
        const log = Logger("plebbit-js:plebbit:createCommentEdit");
        if ("clients" in options) return this._createCommentModerationInstanceFromJsonfiedCommentModeration(options);
        const modInstance = new CommentModeration(this);

        if ("signature" in options) {
            const parsedOptions = parseCommentModerationPubsubMessagePublicationSchemaWithPlebbitErrorIfItFails(options);
            modInstance._initPubsubPublication(parsedOptions); // User just wants to instantiate a CommentEdit object, not publish
        } else {
            const parsedOptions = parseCreateCommentModerationOptionsSchemaWithPlebbitErrorIfItFails(options);
            const finalOptions = <CommentModerationOptionsToSign>(
                await this._initMissingFieldsOfPublicationBeforeSigning(parsedOptions, log)
            );
            modInstance._initUnsignedLocalProps({
                unsignedOptions: finalOptions,
                challengeRequest: parsedOptions.challengeRequest
            });
        }
        return modInstance;
    }

    async _createSubplebbitEditInstanceFromJsonfiedSubplebbitEdit(jsonfied: SubplebbitEditJson) {
        const subplebbitEditInstance = new SubplebbitEdit(this);
        const unsignedOpts = (jsonfied.raw as { unsignedPublicationOptions?: CreatePublicationOptions }).unsignedPublicationOptions;
        if (jsonfied.raw.pubsubMessageToPublish)
            subplebbitEditInstance._initLocalProps({
                subplebbitEdit: jsonfied.raw.pubsubMessageToPublish,
                signer: jsonfied.signer,
                challengeRequest: jsonfied.challengeRequest
            });
        else if (unsignedOpts && jsonfied.signer) {
            const log = Logger("plebbit-js:plebbit:createSubplebbitEdit");
            const finalOptions = <SubplebbitEditPublicationOptionsToSign>(
                await this._initMissingFieldsOfPublicationBeforeSigning({ ...unsignedOpts, signer: jsonfied.signer }, log)
            );
            subplebbitEditInstance._initUnsignedLocalProps({
                unsignedOptions: finalOptions,
                challengeRequest: jsonfied.challengeRequest
            });
        }
        return subplebbitEditInstance;
    }

    async createSubplebbitEdit(
        options: CreateSubplebbitEditPublicationOptions | SubplebbitEditPubsubMessagePublication | SubplebbitEditJson
    ): Promise<SubplebbitEdit> {
        const log = Logger("plebbit-js:plebbit:createSubplebbitEdit");
        if ("clients" in options) return this._createSubplebbitEditInstanceFromJsonfiedSubplebbitEdit(options);
        const subplebbitEditInstance = new SubplebbitEdit(this);

        if ("signature" in options) {
            const parsedOptions = parseSubplebbitEditPubsubMessagePublicationSchemaWithPlebbitErrorIfItFails(options);
            subplebbitEditInstance._initRemoteProps(parsedOptions);
        } else {
            const parsedOptions = parseCreateSubplebbitEditPublicationOptionsSchemaWithPlebbitErrorIfItFails(options);
            const finalOptions = <SubplebbitEditPublicationOptionsToSign>(
                await this._initMissingFieldsOfPublicationBeforeSigning(parsedOptions, log)
            );
            subplebbitEditInstance._initUnsignedLocalProps({
                unsignedOptions: finalOptions,
                challengeRequest: parsedOptions.challengeRequest
            });
        }
        return subplebbitEditInstance;
    }

    createSigner(createSignerOptions?: CreateSignerOptions) {
        return createSigner(createSignerOptions);
    }

    async fetchCid(fetchCidArgs: CidRpcParam): Promise<string> {
        // plebbit-with-rpc-client will handle if user is connected to rpc client

        const parsedArgs = parseRpcCidParam(fetchCidArgs);
        return this._clientsManager.fetchCid(parsedArgs.cid);
    }

    // Used to pre-subscribe so publishing on pubsub would be faster
    async pubsubSubscribe(pubsubTopic: string) {
        const parsedTopic = PubsubTopicSchema.parse(pubsubTopic);
        if (this._pubsubSubscriptions[parsedTopic]) return;
        const handler = () => {};
        await this._clientsManager.pubsubSubscribe(parsedTopic, handler);
        this._pubsubSubscriptions[parsedTopic] = handler;
    }

    async pubsubUnsubscribe(pubsubTopic: string) {
        const parsedTopic = PubsubTopicSchema.parse(pubsubTopic);
        if (!this._pubsubSubscriptions[parsedTopic]) return;
        await this._clientsManager.pubsubUnsubscribe(parsedTopic, this._pubsubSubscriptions[parsedTopic]);
        delete this._pubsubSubscriptions[parsedTopic];
    }

    async resolveAuthorName(resolveAuthorAddressArgs: AuthorNameRpcParam) {
        const parsedArgs = parseRpcAuthorNameParam(resolveAuthorAddressArgs);
        const resolved = await this._clientsManager.resolveAuthorNameIfNeeded({ authorAddress: parsedArgs.address });
        return resolved;
    }

    async validateComment(comment: Comment | PageTypeJson["comments"][number], opts?: { validateReplies?: boolean }) {
        const commentIpfs = comment.raw.comment;
        const commentUpdate = comment.raw.commentUpdate;
        const commentCid = comment.cid;
        const postCid: string | undefined = comment.postCid;
        if (!commentCid) throw new PlebbitError("ERR_COMMENT_MISSING_CID", { comment, commentCid });
        if (!commentIpfs) throw new PlebbitError("ERR_COMMENT_MISSING_IPFS", { comment, commentIpfs });
        if (!commentUpdate) throw new PlebbitError("ERR_COMMENT_MISSING_UPDATE", { comment, commentUpdate });
        if (!postCid) throw new PlebbitError("ERR_COMMENT_MISSING_POST_CID", { comment, postCid }); // postCid should always be defined if you have CommentIpfs

        const commentIpfsVerificationOpts = {
            comment: commentIpfs,
            resolveAuthorNames: this.resolveAuthorNames,
            clientsManager: this._clientsManager,
            calculatedCommentCid: commentCid
        };
        const commentIpfsValidity = await verifyCommentIpfs(commentIpfsVerificationOpts);
        if (!commentIpfsValidity.valid)
            throw new PlebbitError("ERR_INVALID_COMMENT_IPFS", {
                commentIpfsVerificationOpts,
                commentIpfsValidity
            });

        const subplebbitIpfs = findUpdatingSubplebbit(this, { address: comment.communityAddress })?.raw?.subplebbitIpfs;
        const subplebbit: { address: string; signature?: SubplebbitIpfsType["signature"] } = subplebbitIpfs
            ? { address: comment.communityAddress, signature: subplebbitIpfs.signature }
            : { address: comment.communityAddress };
        const commentUpdateVerificationOpts = {
            update: commentUpdate,
            resolveAuthorNames: this.resolveAuthorNames,
            clientsManager: this._clientsManager,
            subplebbit,
            validatePages: typeof opts?.validateReplies === "boolean" ? opts.validateReplies : this.validatePages,
            comment: { ...commentIpfs, cid: commentCid, postCid },
            validateUpdateSignature: true
        };
        const commentUpdateValidity = await verifyCommentUpdate(commentUpdateVerificationOpts);
        if (!commentUpdateValidity.valid)
            throw new PlebbitError("ERR_INVALID_COMMENT_UPDATE", {
                commentUpdateVerificationOpts,
                commentUpdateValidity
            });
    }

    async _createStorageLRU(opts: Omit<LRUStorageConstructor, "plebbit">) {
        // should add the storage LRU to an array, so we can destroy all of them on plebbit.destroy
        if (!this._storageLRUs[opts.cacheName]) {
            this._storageLRUs[opts.cacheName] = new LRUStorage({ ...opts, plebbit: this });
            await this._storageLRUs[opts.cacheName].init();
        }
        return this._storageLRUs[opts.cacheName];
    }

    async destroy() {
        const log = Logger("plebbit-js:plebbit:destroy");
        if (this.destroyed) return;
        this.destroyed = true;
        // Clean up connections

        for (const comment of listUpdatingComments(this)) await comment.stop();

        for (const subplebbit of listUpdatingSubplebbits(this)) await subplebbit.stop();

        await Promise.all(listStartedSubplebbits(this).map((sub) => sub.stop()));

        if (this._subplebbitFsWatchAbort) this._subplebbitFsWatchAbort.abort();

        if (this._addressRewriterSetupPromise) {
            await this._addressRewriterSetupPromise;
            this._addressRewriterSetupPromise = undefined;
        }

        if (this._addressRewriterDestroy) {
            await this._addressRewriterDestroy();
            this._addressRewriterDestroy = undefined;
        }
        await this._storage.destroy();
        for (const storage of Object.values(this._storageLRUs)) await storage.destroy();
        Object.values(this._memCaches).forEach((cache) => cache.clear());

        if (Object.keys(this._pubsubSubscriptions).length > 0) {
            for (const client of Object.values(this.clients.pubsubKuboRpcClients)) {
                try {
                    const subscribedPubsubTopics = await client._client.pubsub.ls();
                    for (const topic of subscribedPubsubTopics) {
                        await client._client.pubsub.unsubscribe(topic);
                    }
                } catch (e) {
                    log.error("Error unsubscribing from pubsub topics", e);
                }
            }
        }

        const kuboClients = [...Object.values(this.clients.kuboRpcClients), ...Object.values(this.clients.pubsubKuboRpcClients)];

        await Promise.all(kuboClients.map(async (client) => client.destroy()));

        await Promise.all(Object.values(this.clients.libp2pJsClients).map((client) => client.heliaWithKuboRpcClientFunctions.stop()));

        await Promise.all(Object.values(this.clients.plebbitRpcClients).map((client) => client.destroy()));

        // Get all methods on the instance and override them to throw errors if used after destruction
        Object.getOwnPropertyNames(Object.getPrototypeOf(this))
            .filter((prop) => typeof (this as any)[prop] === "function")
            .forEach((method) => {
                (this as any)[method] = () => {
                    throw new PlebbitError("ERR_PLEBBIT_IS_DESTROYED");
                };
            });
        log("Destroyed plebbit instance");
    }
}

import {
    getDefaultDataPath,
    listCommunitiesSync as nodeListCommunities,
    createKuboRpcClient,
    monitorCommunitiesDirectory,
    tryToDeleteCommunitiesThatFailedToBeDeletedBefore
} from "../runtime/node/util.js";
import type {
    StorageInterface,
    GatewayClient,
    KuboRpcClient,
    PKCEvents,
    PubsubClient,
    ParsedPKCOptions,
    LRUStorageInterface,
    LRUStorageConstructor,
    PubsubSubscriptionHandler,
    InputPKCOptions,
    AuthorPubsubType,
    PKCMemCaches,
    CreatePublicationOptions
} from "../types.js";
import { Comment } from "../publications/comment/comment.js";
import {
    waitForUpdateInCommunityInstanceWithErrorAndTimeout,
    areEquivalentCommunityAddresses,
    deepMergeRuntimeFields,
    doesDomainAddressHaveCapitalLetter,
    hideClassPrivateProps,
    isStringDomain,
    removeUndefinedValuesRecursively,
    timestamp,
    resolveWhenPredicateIsTrue
} from "../util.js";
import Vote from "../publications/vote/vote.js";
import { createSigner, verifyCommentPubsubMessage } from "../signer/index.js";
import { CommentEdit } from "../publications/comment-edit/comment-edit.js";
import Logger from "../logger.js";
import env from "../version.js";
import { verifyCommentEdit, verifyCommentIpfs, verifyCommentUpdate, verifyCommunityEdit } from "../signer/signatures.js";
import Stats from "../stats.js";
import Storage from "../runtime/node/storage.js";
import { PKCClientsManager } from "./pkc-client-manager.js";
import PKCRpcClient from "../clients/rpc-client/pkc-rpc-client.js";
import { PKCError } from "../pkc-error.js";
import { InflightFetchManager } from "../util/inflight-fetch-manager.js";
import type {
    ChallengeFileFactoryInput,
    CreateInstanceOfLocalOrRemoteCommunityOptions,
    CreateNewLocalCommunityParsedOptions,
    CreateRemoteCommunityOptions,
    CommunityJson,
    CommunityIpfsType,
    RemoteCommunityJson,
    RpcRemoteCommunityJson
} from "../community/types.js";
import LRUStorage from "../runtime/node/lru-storage.js";
import { RemoteCommunity } from "../community/remote-community.js";
import { RpcRemoteCommunity } from "../community/rpc-remote-community.js";
import { RpcLocalCommunity } from "../community/rpc-local-community.js";
import { LocalCommunity } from "../runtime/node/community/local-community.js";
import { extractCommunityRuntimeFieldsFromParsedPages } from "../pages/util.js";
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

import { AuthorAddressSchema, AuthorReservedFields, CidStringSchema, CommunityAddressSchema } from "../schema/schema.js";
import {
    CreateRemoteCommunityFunctionArgumentSchema,
    CreateCommunityFunctionArgumentsSchema,
    PubsubTopicSchema,
    CommunityIpfsSchema
} from "../community/schema.js";
import {
    parseCidStringSchemaWithPKCErrorIfItFails,
    parseCommentEditPubsubMessagePublicationSchemaWithPKCErrorIfItFails,
    parseCommentIpfsSchemaWithPKCErrorIfItFails,
    parseCommentModerationPubsubMessagePublicationSchemaWithPKCErrorIfItFails,
    parseCommentPubsubMessagePublicationWithPKCErrorIfItFails,
    parseCreateCommentEditOptionsSchemaWithPKCErrorIfItFails,
    parseCreateCommentModerationOptionsSchemaWithPKCErrorIfItFails,
    parseCreateCommentOptionsSchemaWithPKCErrorIfItFails,
    parseCreateRemoteCommunityFunctionArgumentSchemaWithPKCErrorIfItFails,
    parseCreateCommunityEditPublicationOptionsSchemaWithPKCErrorIfItFails,
    parseCreateVoteOptionsSchemaWithPKCErrorIfItFails,
    parsePKCUserOptionsSchemaWithPKCErrorIfItFails,
    parseCommunityAddressWithPKCErrorIfItFails,
    parseCommunityEditPubsubMessagePublicationSchemaWithPKCErrorIfItFails,
    parseVotePubsubMessagePublicationSchemaWithPKCErrorIfItFails
} from "../schema/schema-util.js";
import { CommentModeration } from "../publications/comment-moderation/comment-moderation.js";
import type {
    CommentModerationOptionsToSign,
    CommentModerationPubsubMessagePublication,
    CommentModerationTypeJson,
    CreateCommentModerationOptions
} from "../publications/comment-moderation/types.js";
import { setupKuboAddressesRewriterAndHttpRouters } from "../runtime/node/setup-kubo-address-rewriter-and-http-router.js";
import CommunityEdit from "../publications/community-edit/community-edit.js";
import type {
    CreateCommunityEditPublicationOptions,
    CommunityEditJson,
    CommunityEditPublicationOptionsToSign,
    CommunityEditPubsubMessagePublication
} from "../publications/community-edit/types.js";
import { LRUCache } from "lru-cache";
import { PKCTypedEmitter } from "../clients/pkc-typed-emitter.js";
import type { PageTypeJson } from "../pages/types.js";
import { createLibp2pJsClientOrUseExistingOne } from "../helia/helia-for-pkc.js";
import { Libp2pJsClient } from "../helia/libp2pjsClient.js";
import { AuthorNameRpcParam, CidRpcParam, CommunityLookupRpcParam } from "../clients/rpc-client/types.js";
import { parseRpcAuthorNameParam, parseRpcCidParam, parseRpcCommunityLookupParam } from "../clients/rpc-client/rpc-schema-util.js";
import { cleanWireAuthor, normalizeCreatePublicationAuthor } from "../publications/publication-author.js";
import { IndexedTrackedInstanceRegistry, TrackedInstanceRegistry } from "./tracked-instance-registry.js";
import {
    findUpdatingCommunity,
    listStartedCommunities,
    listUpdatingComments,
    listUpdatingCommunities
} from "./tracked-instance-registry-util.js";

export class PKC extends PKCTypedEmitter<PKCEvents> implements ParsedPKCOptions {
    ipfsGatewayUrls: ParsedPKCOptions["ipfsGatewayUrls"];
    kuboRpcClientsOptions?: ParsedPKCOptions["kuboRpcClientsOptions"];
    pubsubKuboRpcClientsOptions: ParsedPKCOptions["pubsubKuboRpcClientsOptions"];
    pkcRpcClientsOptions?: ParsedPKCOptions["pkcRpcClientsOptions"];
    libp2pJsClientsOptions?: ParsedPKCOptions["libp2pJsClientsOptions"];
    dataPath?: ParsedPKCOptions["dataPath"];
    resolveAuthorNames: ParsedPKCOptions["resolveAuthorNames"];
    nameResolvers?: ParsedPKCOptions["nameResolvers"];
    parsedPKCOptions: ParsedPKCOptions;
    publishInterval: ParsedPKCOptions["publishInterval"];
    updateInterval: ParsedPKCOptions["updateInterval"];
    noData: ParsedPKCOptions["noData"];
    validatePages: ParsedPKCOptions["validatePages"];
    userAgent: ParsedPKCOptions["userAgent"];
    httpRoutersOptions: ParsedPKCOptions["httpRoutersOptions"];

    // Only PKC instance has these props
    clients: {
        ipfsGateways: { [ipfsGatewayUrl: NonNullable<ParsedPKCOptions["ipfsGatewayUrls"]>[number]]: GatewayClient };
        kuboRpcClients: { [kuboRpcClientUrl: string]: KuboRpcClient };
        pubsubKuboRpcClients: { [pubsubKuboClientUrl: string]: PubsubClient };
        pkcRpcClients: { [pkcRpcUrl: NonNullable<ParsedPKCOptions["pkcRpcClientsOptions"]>[number]]: PKCRpcClient };
        libp2pJsClients: {
            [libp2pJsClientKey: NonNullable<ParsedPKCOptions["libp2pJsClientsOptions"]>[number]["key"]]: Libp2pJsClient;
        };
    };
    communities!: string[]; // default is [], in case of RPC it will be the aggregate of all RPC servers' communities

    settings: {
        challenges?: Record<string, ChallengeFileFactoryInput>;
    };

    // private props

    _pkcRpcClient?: PKCRpcClient; // default rpc client for now. For now we will default to clients.pkcRpcClients[0]
    private _pubsubSubscriptions: Record<string, PubsubSubscriptionHandler> = {};
    _clientsManager!: PKCClientsManager;
    _userPKCOptions: InputPKCOptions; // this is the raw input from user
    _stats!: Stats;
    _storage!: StorageInterface;
    _updatingCommunities: IndexedTrackedInstanceRegistry<RemoteCommunity | RpcRemoteCommunity | RpcLocalCommunity | LocalCommunity> =
        new TrackedInstanceRegistry() as IndexedTrackedInstanceRegistry<
            RemoteCommunity | RpcRemoteCommunity | RpcLocalCommunity | LocalCommunity
        >; // storing community instances that are getting updated rn
    _updatingComments: IndexedTrackedInstanceRegistry<Comment> = new TrackedInstanceRegistry() as IndexedTrackedInstanceRegistry<Comment>; // storing comment instancse that are getting updated rn
    _startedCommunities: IndexedTrackedInstanceRegistry<LocalCommunity | RpcLocalCommunity> =
        new TrackedInstanceRegistry() as IndexedTrackedInstanceRegistry<LocalCommunity | RpcLocalCommunity>; // storing community instances that are started rn
    private _communityFsWatchAbort?: AbortController;

    private _addressRewriterDestroy?: () => Promise<void>;
    private _addressRewriterSetupPromise?: Promise<void>;
    destroyed = false;
    private _promiseToWaitForFirstCommunitieschangeEvent: Promise<string[]>;

    private _storageLRUs: Record<string, LRUStorageInterface> = {}; // Cache name to storage interface
    _memCaches!: PKCMemCaches;
    _inflightFetchManager: InflightFetchManager;

    _timeouts = {
        "community-ipns": 5 * 60 * 1000, // 5min, for resolving community IPNS, or fetching community from gateways
        "community-ipfs": 60 * 1000, // 1min, for fetching community cid P2P
        "comment-ipfs": 60 * 1000, // 1 min
        "comment-update-ipfs": 2 * 60 * 1000, // 2 min
        "page-ipfs": 30 * 1000, // 30s for pages
        "generic-ipfs": 30 * 1000 // 30s generic ipfs
    }; // timeout in ms for each load type when we're loading from kubo/helia/gateway

    constructor(options: InputPKCOptions) {
        super();
        this._userPKCOptions = options;
        this.parsedPKCOptions = parsePKCUserOptionsSchemaWithPKCErrorIfItFails(options);

        // Make nameResolver function props non-enumerable so they're excluded from JSON serialization and spread
        if (this.parsedPKCOptions.nameResolvers) {
            for (const resolver of this.parsedPKCOptions.nameResolvers) {
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
                if (resolver.destroy) {
                    Object.defineProperty(resolver, "destroy", {
                        enumerable: false,
                        value: resolver.destroy,
                        writable: true,
                        configurable: true
                    });
                }
            }
        }

        // initializing fields

        this.pkcRpcClientsOptions = this.parsedPKCOptions.pkcRpcClientsOptions;

        this.ipfsGatewayUrls = this.parsedPKCOptions.ipfsGatewayUrls =
            this.pkcRpcClientsOptions || !this.parsedPKCOptions.ipfsGatewayUrls?.length ? undefined : this.parsedPKCOptions.ipfsGatewayUrls;
        this.kuboRpcClientsOptions = this.parsedPKCOptions.kuboRpcClientsOptions = this.pkcRpcClientsOptions
            ? undefined
            : this.parsedPKCOptions.kuboRpcClientsOptions;

        // We default for ipfsHttpClientsOptions first, but if it's not defined we use the default from schema
        this.pubsubKuboRpcClientsOptions = this.parsedPKCOptions.pubsubKuboRpcClientsOptions = this.pkcRpcClientsOptions
            ? undefined
            : this._userPKCOptions.pubsubKuboRpcClientsOptions // did the user provide their own pubsub options
              ? this.parsedPKCOptions.pubsubKuboRpcClientsOptions // if not, then we use ipfsHttpClientOptions or defaults
              : this.parsedPKCOptions.kuboRpcClientsOptions || this.parsedPKCOptions.pubsubKuboRpcClientsOptions;

        this.libp2pJsClientsOptions = this.parsedPKCOptions.libp2pJsClientsOptions;
        if (this.libp2pJsClientsOptions && (this.kuboRpcClientsOptions?.length || this.pubsubKuboRpcClientsOptions?.length))
            throw new PKCError("ERR_CAN_NOT_HAVE_BOTH_KUBO_AND_LIBP2P_JS_CLIENTS_DEFINED", {
                libp2pJsClientsOptions: this.libp2pJsClientsOptions,
                kuboRpcClientsOptions: this.kuboRpcClientsOptions,
                pubsubKuboRpcClientsOptions: this.pubsubKuboRpcClientsOptions
            });
        this.resolveAuthorNames = this.parsedPKCOptions.resolveAuthorNames;
        this.publishInterval = this.parsedPKCOptions.publishInterval;
        this.updateInterval = this.parsedPKCOptions.updateInterval;
        this.noData = this.parsedPKCOptions.noData;
        this.validatePages = this.parsedPKCOptions.validatePages;
        this.userAgent = this.parsedPKCOptions.userAgent;
        this.httpRoutersOptions = this.parsedPKCOptions.httpRoutersOptions;
        this.settings = {
            challenges: this.parsedPKCOptions.challenges
        };
        // nameResolvers contains functions that can't be serialized over RPC, so skip for RPC clients
        this.nameResolvers = this.pkcRpcClientsOptions ? undefined : this.parsedPKCOptions.nameResolvers;
        this.on("communitieschange", (newCommunities) => {
            this.communities = newCommunities;
        });

        this._promiseToWaitForFirstCommunitieschangeEvent = new Promise((resolve) => this.once("communitieschange", resolve));

        //@ts-expect-error
        this.clients = {};

        this._initKuboRpcClientsIfNeeded();
        this._initKuboPubsubClientsIfNeeded();
        this._initRpcClientsIfNeeded();
        this._initIpfsGatewaysIfNeeded();
        this._initMemCaches();
        this._inflightFetchManager = new InflightFetchManager();

        if (!this.noData && !this.pkcRpcClientsOptions)
            this.dataPath = this.parsedPKCOptions.dataPath =
                "dataPath" in this.parsedPKCOptions ? this.parsedPKCOptions.dataPath : getDefaultDataPath();
    }

    _initMemCaches() {
        this._memCaches = {
            communityVerificationCache: new LRUCache<string, boolean>({ max: 100 }),
            pageVerificationCache: new LRUCache<string, boolean>({ max: 1000 }),
            commentVerificationCache: new LRUCache<string, boolean>({ max: 5000 }),
            commentUpdateVerificationCache: new LRUCache<string, boolean>({ max: 100_000 }),
            commentIpfs: new LRUCache<string, CommentIpfsType>({ max: 10 }),
            communityForPublishing: new LRUCache({
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
        this.clients.pkcRpcClients = {};
        if (!this.pkcRpcClientsOptions) return;
        for (const rpcUrl of this.pkcRpcClientsOptions) this.clients.pkcRpcClients[rpcUrl] = new PKCRpcClient(rpcUrl);
    }

    private _initIpfsGatewaysIfNeeded() {
        // If user did not provide ipfsGatewayUrls
        this.clients.ipfsGateways = {};
        if (!this.ipfsGatewayUrls) return;
        for (const gatewayUrl of this.ipfsGatewayUrls) this.clients.ipfsGateways[gatewayUrl] = {};
    }

    private async _setupHttpRoutersWithKuboNodeInBackground() {
        const log = Logger("pkc-js:pkc:_initHttpRoutersWithIpfsInBackground");

        if (this.destroyed) return;

        if (this.httpRoutersOptions?.length && this.kuboRpcClientsOptions?.length && this._canCreateNewLocalCommunity()) {
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
        const log = Logger("pkc-js:pkc:_init");
        // Init storage
        this._storage = new Storage(this);
        await this._storage.init();

        // Init stats
        this._stats = new Stats({ _storage: this._storage, clients: this.clients });
        // Init clients manager

        // pkc-with-rpc-client will subscribe to communitieschange and settingschange for us
        if (this._canCreateNewLocalCommunity() && !this.pkcRpcClientsOptions) {
            await tryToDeleteCommunitiesThatFailedToBeDeletedBefore(this, log);
            this._communityFsWatchAbort = await monitorCommunitiesDirectory(this);
            await this._waitForCommunitiesToBeDefined();
        } else {
            this.communities = []; // communities = [] on browser
        }

        await this._setupHttpRoutersWithKuboNodeInBackground();
        await this._initLibp2pJsClientsIfNeeded();
        this._clientsManager = new PKCClientsManager(this);

        hideClassPrivateProps(this);
    }

    async getCommunity(getCommunityArgs: CommunityLookupRpcParam) {
        const parsedArgs = parseRpcCommunityLookupParam(getCommunityArgs);
        const community = await this.createCommunity(parsedArgs);

        if (typeof community.createdAt === "number") return <RpcLocalCommunity | LocalCommunity>community; // It's a local community, and already has been loaded, no need to wait
        const timeoutMs = this._timeouts["community-ipns"];
        await waitForUpdateInCommunityInstanceWithErrorAndTimeout(community, timeoutMs);

        return community;
    }

    async getComment(cid: CidRpcParam): Promise<Comment> {
        const log = Logger("pkc-js:pkc:getComment");
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
                    new TimeoutError(`pkc.getComment({cid: ${parsedGetCommentArgs}}) timed out after ${commentTimeout}ms`)
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
            | CreateCommunityEditPublicationOptions,
        log: Logger
    ): Promise<CommentOptionsToSign | VoteOptionsToSign | CommentEditOptionsToSign | CommunityEditPublicationOptionsToSign> {
        const finalOptions = remeda.clone(pubOptions);
        if (!finalOptions.signer) throw Error("User did not provide a signer to create a local publication");
        const normalizedAuthor = normalizeCreatePublicationAuthor(finalOptions.author);
        let cleanedAuthor = cleanWireAuthor(normalizedAuthor);
        // Strip empty objects from author — empty {} should not be signed
        if (cleanedAuthor) {
            for (const key of Object.keys(cleanedAuthor)) {
                const val = (cleanedAuthor as Record<string, unknown>)[key];
                if (typeof val === "object" && val !== null && !Array.isArray(val) && Object.keys(val).length === 0)
                    delete (cleanedAuthor as Record<string, unknown>)[key];
            }
            if (remeda.isEmpty(cleanedAuthor)) cleanedAuthor = undefined;
        }
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
                const log = Logger("pkc-js:pkc:createComment");
                const finalOptions = <CommentOptionsToSign>(
                    await this._initMissingFieldsOfPublicationBeforeSigning({ ...unsignedOpts, signer: options.signer }, log)
                );
                commentInstance._initUnsignedLocalProps({
                    unsignedOptions: finalOptions,
                    challengeRequest: options.challengeRequest
                });
                await commentInstance._signPublicationWithKnownCommunityFieldsIfAvailable();
            }
        }
        if (options.raw.comment) commentInstance._initIpfsProps(options.raw.comment);
        // can only get one CommentUpdate
        if ("commentUpdateFromChallengeVerification" in options.raw && options.raw.commentUpdateFromChallengeVerification)
            commentInstance._initCommentUpdateFromChallengeVerificationProps(options.raw.commentUpdateFromChallengeVerification);
        if (options.raw.commentUpdate) commentInstance._initCommentUpdate(options.raw.commentUpdate);
        // nameResolved is strictly runtime — never carry it over when cloning
        if (commentInstance.author?.nameResolved !== undefined) delete commentInstance.author.nameResolved;
        return commentInstance;
    }

    async createComment(
        options:
            | CommentIpfsType
            | CommentPubsubMessagePublication
            | {
                  cid: CommentUpdateType["cid"];
                  communityAddress?: string;
                  subplebbitAddress?: string;
                  communityPublicKey?: string;
                  communityName?: string;
              }
            | MinimumCommentFieldsToFetchPages
            | CreateCommentOptions
            | CommentJson
            | Comment
            | CommentWithinRepliesPostsPageJson
            | CommentIpfsWithCidDefined
    ): Promise<Comment> {
        const log = Logger("pkc-js:pkc:createComment");

        if ("clients" in options || "raw" in options || "original" in options || options instanceof Comment)
            return this._createCommentInstanceFromAnotherCommentInstance(
                options as Comment | CommentWithinRepliesPostsPageJson | CommentJson
            ); // CommentJson

        const commentInstance = new Comment(this);
        if ("communityAddress" in options && options.communityAddress)
            commentInstance.setCommunityAddress(parseCommunityAddressWithPKCErrorIfItFails(options.communityAddress));
        else if ("subplebbitAddress" in options && options.subplebbitAddress)
            commentInstance.setCommunityAddress(parseCommunityAddressWithPKCErrorIfItFails(options.subplebbitAddress as string));

        if ("communityPublicKey" in options && typeof options.communityPublicKey === "string")
            commentInstance.communityPublicKey = options.communityPublicKey;
        else if (commentInstance.communityAddress && !isStringDomain(commentInstance.communityAddress))
            commentInstance.communityPublicKey = commentInstance.communityAddress;

        if ("communityName" in options && typeof options.communityName === "string") commentInstance.communityName = options.communityName;
        else if (commentInstance.communityAddress && isStringDomain(commentInstance.communityAddress))
            commentInstance.communityName = commentInstance.communityAddress;

        if ("depth" in options) {
            // Options is CommentIpfs | CommentIpfsWithCidDefined | MinimumCommentFieldsToFetchPages
            if ("cid" in options) commentInstance.setCid(parseCidStringSchemaWithPKCErrorIfItFails(options.cid));
            //@ts-expect-error
            const commentIpfs: CommentIpfsType = remeda.omit(options, ["cid"]); // remove cid to make sure if options:CommentIpfsWithCidDefined that cid doesn't become part of comment.raw.comment

            // if it has signature it means it's a full CommentIpfs
            if (!("signature" in options)) Object.assign(commentInstance, options);
            else commentInstance._initIpfsProps(parseCommentIpfsSchemaWithPKCErrorIfItFails(commentIpfs));
            // nameResolved is strictly runtime — never carry it over
            if (commentInstance.author?.nameResolved !== undefined) delete commentInstance.author.nameResolved;
        } else if ("signature" in options) {
            // parsedOptions is CommentPubsubMessage
            const parsedOptions = parseCommentPubsubMessagePublicationWithPKCErrorIfItFails(options);
            commentInstance._initPubsubMessageProps(parsedOptions);
        } else if ("signer" in options) {
            // options is CreateCommentOptions
            const parsedOptions = parseCreateCommentOptionsSchemaWithPKCErrorIfItFails(options);
            // Defer signing to publish() — just fill missing fields and store unsigned options
            const fieldsFilled = <CommentOptionsToSign>await this._initMissingFieldsOfPublicationBeforeSigning(parsedOptions, log);
            commentInstance._initUnsignedLocalProps({
                unsignedOptions: fieldsFilled,
                challengeRequest: parsedOptions.challengeRequest
            });
            await commentInstance._signPublicationWithKnownCommunityFieldsIfAvailable();
        } else if ("cid" in options) {
            // {cid: string, communityAddress?: string} (also accepts subplebbitAddress for backward compat)
            commentInstance.setCid(parseCidStringSchemaWithPKCErrorIfItFails(options.cid));
        } else {
            throw Error("Make sure you provided a remote comment props or signer to create a new local comment");
        }
        if (commentInstance.cid) {
            commentInstance._useUpdatePropsFromUpdatingStartedCommunityIfPossible();
            commentInstance._useUpdatePropsFromUpdatingCommentIfPossible();
        }

        return commentInstance;
    }

    _canCreateNewLocalCommunity(): boolean {
        // TODO check if we have a connection to kubo rpc node for IPFS and pubsub
        const isNode = typeof process?.versions?.node !== "undefined";
        return isNode && Boolean(this.dataPath);
    }

    protected async _setCommunityIpfsOnInstanceIfPossible(
        community: RpcRemoteCommunity | RemoteCommunity,
        options: CreateRemoteCommunityOptions | CommunityIpfsType | RemoteCommunityJson | RpcRemoteCommunityJson
    ) {
        await community.initRemoteCommunityPropsNoMerge(options);
        const preservedRuntimeFields = extractCommunityRuntimeFieldsFromParsedPages({
            postsPages: community.posts.pages,
            modQueuePages: community.modQueue.pages
        });
        const reapplyPreservedRuntimeFields = () => {
            if (preservedRuntimeFields) deepMergeRuntimeFields(community, preservedRuntimeFields);
        };

        if ("raw" in options && options.raw.communityIpfs) {
            await community.initCommunityIpfsPropsNoMerge(options.raw.communityIpfs); // we're setting CommunityIpfs
            reapplyPreservedRuntimeFields();
        }

        if ("updateCid" in options && options.updateCid) community.updateCid = options.updateCid;
        if (!community.raw.communityIpfs) {
            // we didn't receive options that we can parse into CommunityIpfs
            // let's try using _updatingCommunities
            await community._setCommunityIpfsPropsFromUpdatingCommunitiesIfPossible();
            if (community.raw.communityIpfs) reapplyPreservedRuntimeFields();
        }

        // last resort to set community ipfs props
        if (!community.raw.communityIpfs) {
            if (options.signature) {
                const resParseCommunityIpfs = CommunityIpfsSchema.loose().safeParse(
                    remeda.pick(options, <(keyof CommunityIpfsType)[]>[...options.signature.signedPropertyNames, "signature"])
                );
                if (resParseCommunityIpfs.success) {
                    const cleanedRecord = removeUndefinedValuesRecursively(resParseCommunityIpfs.data); // safe way to replicate JSON.stringify() which is done before adding record to ipfs
                    await community.initCommunityIpfsPropsNoMerge(cleanedRecord);
                    reapplyPreservedRuntimeFields();
                }
            }
        }

        // Backward compat: old serialized instances have raw.subplebbitIpfs instead of raw.communityIpfs
        if (!community.raw.communityIpfs && "raw" in options) {
            const legacyRaw = (options.raw as Record<string, unknown>).subplebbitIpfs;
            if (legacyRaw) {
                community.raw.communityIpfs = legacyRaw as CommunityIpfsType;
            }
        }
    }

    protected async _waitForCommunitiesToBeDefined() {
        // we're just wait until this.communities is either defined, or communitieschange is emitted

        await this._promiseToWaitForFirstCommunitieschangeEvent;
        if (!Array.isArray(this.communities)) throw Error("pkc.communities should be defined after communitieschange event");
    }

    async _awaitCommunitiesToIncludeCommunity(communityAddress: string): Promise<void> {
        if (this.communities.includes(communityAddress)) return;
        else
            await resolveWhenPredicateIsTrue({
                toUpdate: this,
                predicate: () => this.communities.includes(communityAddress),
                eventName: "communitieschange"
            });
    }

    private async _createRemoteCommunityInstance(options: z.infer<typeof CreateRemoteCommunityFunctionArgumentSchema>) {
        const log = Logger("pkc-js:pkc:createRemoteCommunity");

        log.trace("Received community options to create a remote community instance:", options);
        const community = new RemoteCommunity(this);
        await this._setCommunityIpfsOnInstanceIfPossible(community, options);

        log.trace(`Created remote community instance (${community.address})`);
        return community;
    }

    private async _createLocalCommunity(
        options: CreateNewLocalCommunityParsedOptions | CreateInstanceOfLocalOrRemoteCommunityOptions
    ): Promise<LocalCommunity> {
        const log = Logger("pkc-js:pkc:createLocalCommunity");
        log.trace("Received community options to create a local community instance:", options);

        const canCreateLocalCommunity = this._canCreateNewLocalCommunity();
        if (!canCreateLocalCommunity) throw new PKCError("ERR_CAN_NOT_CREATE_A_LOCAL_COMMUNITY", { pkcOptions: this._userPKCOptions });

        const localCommunities = await nodeListCommunities(this);
        const isLocalCommunity = localCommunities.includes(options.address); // Community exists already, only pass address so we don't override other props
        const community = new LocalCommunity(this);
        if (isLocalCommunity) {
            // If the community is already created before, then load it with address only. We don't care about other props
            community.setAddress(options.address);
            await community._updateInstancePropsWithStartedCommunityOrDb();
            log.trace(`Created instance of existing local community (${community.address}) with props:`);
            community.emit("update", community);
            return community;
        } else if ("signer" in options) {
            // This is a new community
            const parsedOptions = <CreateNewLocalCommunityParsedOptions>options;
            await community.initNewLocalCommunityPropsNoMerge(parsedOptions); // We're initializing a new local community props here
            await community._createNewLocalCommunityDb();
            log.trace(`Created a new local community (${community.address}) with props:`);
            community.emit("update", community);
            await this._awaitCommunitiesToIncludeCommunity(community.address);
            return community;
        } else throw Error("Are you trying to create a local community with no address or signer? This is a critical error");
    }

    private async _createCommunityInstanceFromJsonifiedCommunity(jsonfied: CommunityJson): ReturnType<PKC["createCommunity"]> {
        // jsonfied = JSON.parse(JSON.stringify(communityInstance))
        // should probably exclude internal and instance-exclusive props like states

        if (this.communities.includes(jsonfied.address)) return this._createLocalCommunity(jsonfied);
        else return this._createRemoteCommunityInstance(jsonfied);
    }

    async createCommunity(
        options: z.infer<typeof CreateCommunityFunctionArgumentsSchema> | CommunityJson = {}
    ): Promise<RemoteCommunity | RpcRemoteCommunity | RpcLocalCommunity | LocalCommunity> {
        const log = Logger("pkc-js:pkc:createCommunity");
        if ("clients" in options) return this._createCommunityInstanceFromJsonifiedCommunity(<CommunityJson>options);
        const parsedOptions = <z.infer<typeof CreateCommunityFunctionArgumentsSchema>>options;
        log.trace("Received options: ", parsedOptions);

        const hasAddress = "address" in parsedOptions && typeof parsedOptions.address === "string";
        const hasName = "name" in parsedOptions && typeof parsedOptions.name === "string";
        const hasPublicKey = "publicKey" in parsedOptions && typeof parsedOptions.publicKey === "string";
        const hasSigner = "signer" in parsedOptions && parsedOptions.signer !== undefined;
        const hasIdentifier = hasAddress || hasName || hasPublicKey; // can identify an existing community

        // Derive effective address for local-vs-remote checks
        const effectiveAddress =
            ((parsedOptions as Record<string, unknown>).address as string | undefined) ||
            ((parsedOptions as Record<string, unknown>).name as string | undefined) ||
            ((parsedOptions as Record<string, unknown>).publicKey as string | undefined);

        if (effectiveAddress && doesDomainAddressHaveCapitalLetter(effectiveAddress))
            throw new PKCError("ERR_COMMUNITY_NAME_HAS_CAPITAL_LETTER", { ...parsedOptions });

        // Creating a community when we're connected to RPC will be handled in pkc-with-rpc-client
        // Code below is for NodeJS and browser using IPFS-P2P/gateway

        const canCreateLocalCommunity = this._canCreateNewLocalCommunity(); // this is true if we're on NodeJS and have a dataPath

        if (hasSigner && !canCreateLocalCommunity)
            throw new PKCError("ERR_CAN_NOT_CREATE_A_LOCAL_COMMUNITY", {
                pkcOptions: this._userPKCOptions,
                isEnvNode: Boolean(process),
                hasDataPath: Boolean(this.dataPath)
            });

        if (!canCreateLocalCommunity) {
            // we're either on browser or on NodeJS with no dataPath
            const parsedRemoteOptions = parseCreateRemoteCommunityFunctionArgumentSchemaWithPKCErrorIfItFails(options);
            return this._createRemoteCommunityInstance(parsedRemoteOptions);
        }

        if (hasIdentifier && !hasSigner) {
            // community is already created, need to check if it's local or remote
            const localCommunities = await nodeListCommunities(this);
            // Check for exact match or .eth/.bso alias match
            const localCommunityAddress = localCommunities.find((localAddr) =>
                areEquivalentCommunityAddresses(localAddr, effectiveAddress!)
            );
            if (localCommunityAddress) return this._createLocalCommunity({ address: localCommunityAddress });
            else {
                const parsedRemoteOptions = parseCreateRemoteCommunityFunctionArgumentSchemaWithPKCErrorIfItFails(options);
                return this._createRemoteCommunityInstance(parsedRemoteOptions);
            }
        } else if (!hasIdentifier && !hasSigner) {
            // no identifier, no signer, create signer and assign address to signer.address
            const signer = await this.createSigner();
            const localOptions = <CreateNewLocalCommunityParsedOptions>{ ...parsedOptions, signer, address: signer.address };
            log(`Did not provide CreateCommunityOptions.signer, generated random signer with address (${localOptions.address})`);

            return this._createLocalCommunity(localOptions);
        } else if (!hasIdentifier && hasSigner) {
            const signerInput = parsedOptions.signer as { type: "ed25519"; privateKey: string } | undefined;
            const signer = await this.createSigner(signerInput);
            const localOptions = <CreateNewLocalCommunityParsedOptions>{
                ...parsedOptions,
                address: signer.address,
                signer
            };
            return this._createLocalCommunity(localOptions);
        } else if (hasIdentifier && hasSigner)
            return this._createLocalCommunity(parsedOptions as unknown as CreateNewLocalCommunityParsedOptions);
        else throw new PKCError("ERR_CAN_NOT_CREATE_A_LOCAL_COMMUNITY", { parsedOptions });
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
            const log = Logger("pkc-js:pkc:createVote");
            const finalOptions = <VoteOptionsToSign>(
                await this._initMissingFieldsOfPublicationBeforeSigning({ ...unsignedOpts, signer: jsonfied.signer }, log)
            );
            voteInstance._initUnsignedLocalProps({
                unsignedOptions: finalOptions,
                challengeRequest: jsonfied.challengeRequest
            });
            await voteInstance._signPublicationWithKnownCommunityFieldsIfAvailable();
        }
        return voteInstance;
    }

    async createVote(options: CreateVoteOptions | VotePubsubMessagePublication | VoteJson): Promise<Vote> {
        const log = Logger("pkc-js:pkc:createVote");
        if ("clients" in options) return this._createVoteInstanceFromJsonfiedVote(options);
        const voteInstance = new Vote(this);

        if ("signature" in options) {
            const parsedOptions = parseVotePubsubMessagePublicationSchemaWithPKCErrorIfItFails(options);
            voteInstance._initRemoteProps(parsedOptions);
        } else {
            const parsedOptions = parseCreateVoteOptionsSchemaWithPKCErrorIfItFails(options);
            const finalOptions = <VoteOptionsToSign>await this._initMissingFieldsOfPublicationBeforeSigning(parsedOptions, log);
            voteInstance._initUnsignedLocalProps({
                unsignedOptions: finalOptions,
                challengeRequest: parsedOptions.challengeRequest
            });
            await voteInstance._signPublicationWithKnownCommunityFieldsIfAvailable();
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
            const log = Logger("pkc-js:pkc:createCommentEdit");
            const finalOptions = <CommentEditOptionsToSign>(
                await this._initMissingFieldsOfPublicationBeforeSigning({ ...unsignedOpts, signer: jsonfied.signer }, log)
            );
            editInstance._initUnsignedLocalProps({
                unsignedOptions: finalOptions,
                challengeRequest: jsonfied.challengeRequest
            });
            await editInstance._signPublicationWithKnownCommunityFieldsIfAvailable();
        }
        return editInstance;
    }

    async createCommentEdit(
        options: CreateCommentEditOptions | CommentEditPubsubMessagePublication | CommentEditTypeJson
    ): Promise<CommentEdit> {
        const log = Logger("pkc-js:pkc:createCommentEdit");
        if ("clients" in options) return this._createCommentEditInstanceFromJsonfiedCommentEdit(options);
        const editInstance = new CommentEdit(this);

        if ("signature" in options) {
            const parsedOptions = parseCommentEditPubsubMessagePublicationSchemaWithPKCErrorIfItFails(options);
            editInstance._initPubsubPublicationProps(parsedOptions); // User just wants to instantiate a CommentEdit object, not publish
        } else {
            const parsedOptions = parseCreateCommentEditOptionsSchemaWithPKCErrorIfItFails(options);
            const finalOptions = <CommentEditOptionsToSign>await this._initMissingFieldsOfPublicationBeforeSigning(options, log);
            editInstance._initUnsignedLocalProps({
                unsignedOptions: finalOptions,
                challengeRequest: parsedOptions.challengeRequest
            });
            await editInstance._signPublicationWithKnownCommunityFieldsIfAvailable();
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
            const log = Logger("pkc-js:pkc:createCommentModeration");
            const finalOptions = <CommentModerationOptionsToSign>(
                await this._initMissingFieldsOfPublicationBeforeSigning({ ...unsignedOpts, signer: jsonfied.signer }, log)
            );
            modInstance._initUnsignedLocalProps({
                unsignedOptions: finalOptions,
                challengeRequest: jsonfied.challengeRequest
            });
            await modInstance._signPublicationWithKnownCommunityFieldsIfAvailable();
        }
        return modInstance;
    }

    async createCommentModeration(
        options: CreateCommentModerationOptions | CommentModerationPubsubMessagePublication | CommentModerationTypeJson
    ): Promise<CommentModeration> {
        const log = Logger("pkc-js:pkc:createCommentEdit");
        if ("clients" in options) return this._createCommentModerationInstanceFromJsonfiedCommentModeration(options);
        const modInstance = new CommentModeration(this);

        if ("signature" in options) {
            const parsedOptions = parseCommentModerationPubsubMessagePublicationSchemaWithPKCErrorIfItFails(options);
            modInstance._initPubsubPublication(parsedOptions); // User just wants to instantiate a CommentEdit object, not publish
        } else {
            const parsedOptions = parseCreateCommentModerationOptionsSchemaWithPKCErrorIfItFails(options);
            const finalOptions = <CommentModerationOptionsToSign>(
                await this._initMissingFieldsOfPublicationBeforeSigning(parsedOptions, log)
            );
            modInstance._initUnsignedLocalProps({
                unsignedOptions: finalOptions,
                challengeRequest: parsedOptions.challengeRequest
            });
            await modInstance._signPublicationWithKnownCommunityFieldsIfAvailable();
        }
        return modInstance;
    }

    async _createCommunityEditInstanceFromJsonfiedCommunityEdit(jsonfied: CommunityEditJson) {
        const communityEditInstance = new CommunityEdit(this);
        const unsignedOpts = (jsonfied.raw as { unsignedPublicationOptions?: CreatePublicationOptions }).unsignedPublicationOptions;
        if (jsonfied.raw.pubsubMessageToPublish)
            communityEditInstance._initLocalProps({
                communityEdit: jsonfied.raw.pubsubMessageToPublish,
                signer: jsonfied.signer,
                challengeRequest: jsonfied.challengeRequest
            });
        else if (unsignedOpts && jsonfied.signer) {
            const log = Logger("pkc-js:pkc:createCommunityEdit");
            const finalOptions = <CommunityEditPublicationOptionsToSign>(
                await this._initMissingFieldsOfPublicationBeforeSigning({ ...unsignedOpts, signer: jsonfied.signer }, log)
            );
            communityEditInstance._initUnsignedLocalProps({
                unsignedOptions: finalOptions,
                challengeRequest: jsonfied.challengeRequest
            });
            await communityEditInstance._signPublicationWithKnownCommunityFieldsIfAvailable();
        }
        return communityEditInstance;
    }

    async createCommunityEdit(
        options: CreateCommunityEditPublicationOptions | CommunityEditPubsubMessagePublication | CommunityEditJson
    ): Promise<CommunityEdit> {
        const log = Logger("pkc-js:pkc:createCommunityEdit");
        if ("clients" in options) return this._createCommunityEditInstanceFromJsonfiedCommunityEdit(options);
        const communityEditInstance = new CommunityEdit(this);

        if ("signature" in options) {
            const parsedOptions = parseCommunityEditPubsubMessagePublicationSchemaWithPKCErrorIfItFails(options);
            communityEditInstance._initRemoteProps(parsedOptions);
        } else {
            const parsedOptions = parseCreateCommunityEditPublicationOptionsSchemaWithPKCErrorIfItFails(options);
            const finalOptions = <CommunityEditPublicationOptionsToSign>(
                await this._initMissingFieldsOfPublicationBeforeSigning(parsedOptions, log)
            );
            communityEditInstance._initUnsignedLocalProps({
                unsignedOptions: finalOptions,
                challengeRequest: parsedOptions.challengeRequest
            });
            await communityEditInstance._signPublicationWithKnownCommunityFieldsIfAvailable();
        }
        return communityEditInstance;
    }

    createSigner(createSignerOptions?: CreateSignerOptions) {
        return createSigner(createSignerOptions);
    }

    async fetchCid(fetchCidArgs: CidRpcParam): Promise<string> {
        // pkc-with-rpc-client will handle if user is connected to rpc client

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
        if (!commentCid) throw new PKCError("ERR_COMMENT_MISSING_CID", { comment, commentCid });
        if (!commentIpfs) throw new PKCError("ERR_COMMENT_MISSING_IPFS", { comment, commentIpfs });
        if (!commentUpdate) throw new PKCError("ERR_COMMENT_MISSING_UPDATE", { comment, commentUpdate });
        if (!postCid) throw new PKCError("ERR_COMMENT_MISSING_POST_CID", { comment, postCid }); // postCid should always be defined if you have CommentIpfs

        const commentIpfsVerificationOpts = {
            comment: commentIpfs,
            resolveAuthorNames: this.resolveAuthorNames,
            clientsManager: this._clientsManager,
            calculatedCommentCid: commentCid
        };
        const commentIpfsValidity = await verifyCommentIpfs(commentIpfsVerificationOpts);
        if (!commentIpfsValidity.valid)
            throw new PKCError("ERR_INVALID_COMMENT_IPFS", {
                commentIpfsVerificationOpts,
                commentIpfsValidity
            });

        const communityIpfs = findUpdatingCommunity(this, { address: comment.communityAddress })?.raw?.communityIpfs;
        const community: { address: string; signature?: CommunityIpfsType["signature"] } = communityIpfs
            ? { address: comment.communityAddress, signature: communityIpfs.signature }
            : { address: comment.communityAddress };
        const commentUpdateVerificationOpts = {
            update: commentUpdate,
            resolveAuthorNames: this.resolveAuthorNames,
            clientsManager: this._clientsManager,
            community,
            validatePages: typeof opts?.validateReplies === "boolean" ? opts.validateReplies : this.validatePages,
            comment: { ...commentIpfs, cid: commentCid, postCid },
            validateUpdateSignature: true
        };
        const commentUpdateValidity = await verifyCommentUpdate(commentUpdateVerificationOpts);
        if (!commentUpdateValidity.valid)
            throw new PKCError("ERR_INVALID_COMMENT_UPDATE", {
                commentUpdateVerificationOpts,
                commentUpdateValidity
            });
    }

    async _createStorageLRU(opts: Omit<LRUStorageConstructor, "pkc">) {
        // should add the storage LRU to an array, so we can destroy all of them on pkc.destroy
        if (!this._storageLRUs[opts.cacheName]) {
            this._storageLRUs[opts.cacheName] = new LRUStorage({ ...opts, pkc: this });
            await this._storageLRUs[opts.cacheName].init();
        }
        return this._storageLRUs[opts.cacheName];
    }

    async destroy() {
        const log = Logger("pkc-js:pkc:destroy");
        if (this.destroyed) return;
        this.destroyed = true;
        // Clean up connections

        for (const comment of listUpdatingComments(this)) await comment.stop();

        for (const community of listUpdatingCommunities(this)) await community.stop();

        await Promise.all(listStartedCommunities(this).map((community) => community.stop()));

        if (this._communityFsWatchAbort) this._communityFsWatchAbort.abort();

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

        await Promise.all(Object.values(this.clients.pkcRpcClients).map((client) => client.destroy()));

        if (this.nameResolvers) {
            await Promise.all(this.nameResolvers.map((resolver) => resolver.destroy?.()));
        }

        // Get all methods on the instance and override them to throw errors if used after destruction
        Object.getOwnPropertyNames(Object.getPrototypeOf(this))
            .filter((prop) => typeof (this as any)[prop] === "function")
            .forEach((method) => {
                (this as any)[method] = () => {
                    throw new PKCError("ERR_PKC_IS_DESTROYED");
                };
            });
        log("Destroyed pkc instance");
    }
}

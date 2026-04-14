import {
    createAbortError,
    doesDomainAddressHaveCapitalLetter,
    hideClassPrivateProps,
    ipnsNameToIpnsOverPubsubTopic,
    isIpns,
    isStringDomain,
    pubsubTopicToDhtKey,
    shortifyAddress,
    timestamp
} from "../util.js";
import { PKC } from "../pkc/pkc.js";

import Logger from "../logger.js";

import { TypedEmitter } from "tiny-typed-emitter";
import { FailedToFetchCommunityFromGatewaysError, PKCError } from "../pkc-error.js";
import type {
    CreateRemoteCommunityOptions,
    CommunityIpfsType,
    RpcRemoteCommunityType,
    CommunityJson,
    CommunityUpdatingState,
    CommunityState,
    CommunityStartedState,
    CommunitySettings,
    RpcLocalCommunityLocalProps,
    CommunityEditOptions,
    CommunityEventArgs,
    CommunityEvents
} from "./types.js";
import * as remeda from "remeda";
import { ModQueuePages, PostsPages } from "../pages/pages.js";
import type { PostsPagesTypeIpfs } from "../pages/types.js";
import { parseRawPages } from "../pages/util.js";
import { CommunityIpfsSchema } from "./schema.js";
import { SignerWithPublicKeyAddress } from "../signer/index.js";
import { CommunityClientsManager } from "./community-client-manager.js";
import { getPKCAddressFromPublicKeySync } from "../signer/util.js";
import {
    findUpdatingCommunity,
    refreshTrackedCommunityAliases,
    trackUpdatingCommunity,
    untrackUpdatingCommunity
} from "../pkc/tracked-instance-registry-util.js";

export class RemoteCommunity extends TypedEmitter<CommunityEvents> implements Omit<Partial<CommunityIpfsType>, "posts"> {
    // public
    title?: CommunityIpfsType["title"];
    description?: CommunityIpfsType["description"];
    roles?: CommunityIpfsType["roles"];
    lastPostCid?: CommunityIpfsType["lastPostCid"];
    lastCommentCid?: CommunityIpfsType["lastCommentCid"];
    posts: PostsPages;
    modQueue: ModQueuePages;
    pubsubTopic?: CommunityIpfsType["pubsubTopic"];
    features?: CommunityIpfsType["features"];
    suggested?: CommunityIpfsType["suggested"];
    flairs?: CommunityIpfsType["flairs"];
    name?: CommunityIpfsType["name"];
    publicKey?: string; // derived from signature.publicKey, or explicit publicKey passed via createCommunity
    nameResolved?: boolean; // whether the domain name resolves to the correct publicKey
    address!: string;
    shortAddress!: string;
    statsCid?: CommunityIpfsType["statsCid"];
    createdAt?: CommunityIpfsType["createdAt"];
    updatedAt?: CommunityIpfsType["updatedAt"];
    encryption?: CommunityIpfsType["encryption"];
    protocolVersion?: CommunityIpfsType["protocolVersion"];
    signature?: CommunityIpfsType["signature"];
    rules?: CommunityIpfsType["rules"];
    challenges?: CommunityIpfsType["challenges"];
    postUpdates?: CommunityIpfsType["postUpdates"];

    // to be overridden by local community classes
    startedState?: "stopped" | CommunityStartedState = "stopped";
    started?: boolean;
    signer?: SignerWithPublicKeyAddress | RpcLocalCommunityLocalProps["signer"];
    settings?: CommunitySettings;
    editable?: Pick<RemoteCommunity, keyof CommunityEditOptions>;

    // Only for Community instance, informational
    state!: CommunityState;
    clients: CommunityClientsManager["clients"];
    updateCid?: string;
    declare ipnsName?: string;
    declare ipnsPubsubTopic?: string; // ipns over pubsub topic
    declare ipnsPubsubTopicRoutingCid?: string; // peers of community.ipnsPubsubTopic, use this cid with http routers to find peers of ipns-over-pubsub
    pubsubTopicRoutingCid?: string; // peers of community.pubsubTopic, use this cid with http routers to find peers of community.pubsubTopic

    // should be used internally
    _pkc: PKC;
    _clientsManager: CommunityClientsManager;
    raw: { communityIpfs?: CommunityIpfsType; runtimeFieldsFromRpc?: Record<string, any> } = {};
    _updatingCommunityInstanceWithListeners?: { community: RemoteCommunity } & Pick<
        CommunityEvents,
        "error" | "updatingstatechange" | "update" | "statechange"
    > = undefined; // The pkc._updatingCommunities we're subscribed to
    _numOfListenersForUpdatingInstance = 0;
    protected _ipnsName?: string;
    protected _ipnsPubsubTopic?: string;
    protected _ipnsPubsubTopicRoutingCid?: string;
    protected _stopAbortController?: AbortController;

    // Add a private property to store the actual updatingState value
    protected _updatingState!: CommunityUpdatingState;

    constructor(pkc: PKC) {
        super();
        this._pkc = pkc;
        this._setState("stopped");
        this._updatingState = "stopped";
        this._defineIpnsAccessorProps();
        this._defineEnumerableUpdatingState();

        // these functions might get separated from their `this` when used
        this.update = this.update.bind(this);
        this.stop = this.stop.bind(this);

        this.on("error", (...args) => this.listenerCount("error") === 1 && this._pkc.emit("error", ...args)); // only bubble up to pkc if no other listeners are attached

        this._clientsManager = new CommunityClientsManager(this);
        this.clients = this._clientsManager.clients;

        this.posts = new PostsPages({
            pageCids: {},
            pages: {},
            pkc: this._pkc,
            community: this
        });
        this.modQueue = new ModQueuePages({ pageCids: {}, pkc: this._pkc, community: this, pages: {} });
        hideClassPrivateProps(this);
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

    protected _defineEnumerableUpdatingState() {
        const proto = Object.getPrototypeOf(this);
        const updatingStateDescriptor = Object.getOwnPropertyDescriptor(proto, "updatingState");
        if (!updatingStateDescriptor) return;
        Object.defineProperty(this, "updatingState", {
            ...updatingStateDescriptor,
            enumerable: true
        });
    }

    protected _defineIpnsAccessorProps() {
        Object.defineProperties(this, {
            _ipnsName: { enumerable: false, configurable: true, writable: true, value: undefined },
            _ipnsPubsubTopic: { enumerable: false, configurable: true, writable: true, value: undefined },
            _ipnsPubsubTopicRoutingCid: { enumerable: false, configurable: true, writable: true, value: undefined }
        });
        Object.defineProperties(this, {
            ipnsName: {
                enumerable: true,
                configurable: true,
                get: () => this._getIpnsName(),
                set: (value: string | undefined) => this._setIpnsName(value)
            },
            ipnsPubsubTopic: {
                enumerable: true,
                configurable: true,
                get: () => this._getIpnsPubsubTopic(),
                set: (value: string | undefined) => this._setIpnsPubsubTopic(value)
            },
            ipnsPubsubTopicRoutingCid: {
                enumerable: true,
                configurable: true,
                get: () => this._getIpnsPubsubTopicRoutingCid(),
                set: (value: string | undefined) => this._setIpnsPubsubTopicRoutingCid(value)
            }
        });
    }

    _updateLocalPostsInstance(
        newPosts: CommunityIpfsType["posts"] | CommunityJson["posts"] | Pick<NonNullable<CommunityIpfsType["posts"]>, "pageCids">
    ) {
        const log = Logger("pkc-js:remote-community:_updateLocalPostsInstanceIfNeeded");
        const postsPagesCreationTimestamp = this.updatedAt;
        this.posts._community = this;
        if (!newPosts)
            // The community has changed its address, need to reset the posts
            this.posts.resetPages();
        else if (
            (!("pages" in newPosts) || !newPosts.pages || Object.keys(newPosts.pages).length === 0) &&
            newPosts.pageCids &&
            Object.keys(newPosts.pageCids).length > 0
        ) {
            // only pageCids is provided (or pages is empty)
            this.posts.updateProps({
                pageCids: newPosts.pageCids,
                community: this,
                pages: {}
            });
        } else if (
            (!newPosts.pageCids || Object.keys(newPosts.pageCids).length === 0) &&
            "pages" in newPosts &&
            newPosts.pages &&
            Object.keys(newPosts.pages).length > 0
        ) {
            // was only provided with a single preloaded page, no page cids
            if (typeof postsPagesCreationTimestamp !== "number") throw Error("community.updatedAt should be defined when updating posts");
            const parsedPages = parseRawPages(newPosts);
            this.posts.updateProps({
                ...parsedPages,
                community: this,
                pageCids: {}
            });
        } else if (
            "pages" in newPosts &&
            newPosts.pages &&
            Object.keys(newPosts.pages).length > 0 &&
            "pageCids" in newPosts &&
            newPosts.pageCids &&
            Object.keys(newPosts.pageCids).length > 0
        ) {
            // both pageCids and pages are provided

            log.trace(`Updating the props of community (${this.address}) posts`);
            if (typeof postsPagesCreationTimestamp !== "number") throw Error("community.updatedAt should be defined when updating posts");
            const parsedPages = <Pick<PostsPages, "pages"> & { pagesIpfs: PostsPagesTypeIpfs | undefined }>parseRawPages(newPosts);
            this.posts.updateProps({
                ...parsedPages,
                community: this,
                pageCids: newPosts?.pageCids || {}
            });
        }
    }

    _updateLocalModQueueInstance(
        newModQueue:
            | CommunityIpfsType["modQueue"]
            | CommunityJson["modQueue"]
            | Pick<NonNullable<CommunityIpfsType["modQueue"]>, "pageCids">
    ) {
        this.modQueue._community = this;
        if (!newModQueue)
            // The community has changed its address, need to reset the posts
            this.modQueue.resetPages();
        else if (newModQueue.pageCids) {
            // only pageCids is provided
            this.modQueue.updateProps({
                pageCids: newModQueue.pageCids,
                community: this,
                pages: {}
            });
        }
    }

    initCommunityIpfsPropsNoMerge(newProps: CommunityIpfsType) {
        const log = Logger("pkc-js:remote-community:initCommunityIpfsPropsNoMerge");
        this.raw.communityIpfs = newProps;
        this.initRemoteCommunityPropsNoMerge(newProps);
        const unknownProps = remeda.difference(remeda.keys.strict(this.raw.communityIpfs), remeda.keys.strict(CommunityIpfsSchema.shape));
        if (unknownProps.length > 0) {
            log(`Found unknown props on community (${this.address}) ipfs record`, unknownProps);
            Object.assign(this, remeda.pick(this.raw.communityIpfs, unknownProps));
        }
    }

    protected _updateIpnsPubsubPropsIfNeeded(newProps: CommunityJson | CreateRemoteCommunityOptions | CommunityIpfsType) {
        if ("ipnsName" in newProps && newProps.ipnsName) {
            this.ipnsName = newProps.ipnsName;
            this.ipnsPubsubTopic = ipnsNameToIpnsOverPubsubTopic(this.ipnsName);
            this.ipnsPubsubTopicRoutingCid = pubsubTopicToDhtKey(this.ipnsPubsubTopic);
        } else if (newProps.signature?.publicKey && this.signature?.publicKey !== newProps.signature?.publicKey) {
            // The signature public key has changed, we need to update the ipns name and pubsub topic
            this.ipnsName = getPKCAddressFromPublicKeySync(newProps.signature.publicKey);
            this.ipnsPubsubTopic = ipnsNameToIpnsOverPubsubTopic(this.ipnsName);
            this.ipnsPubsubTopicRoutingCid = pubsubTopicToDhtKey(this.ipnsPubsubTopic);
        } else if ("address" in newProps && typeof newProps.address === "string" && isIpns(newProps.address)) {
            // Address is already an IPNS name; initialize pubsub fields immediately.
            this.ipnsName = newProps.address;
            this.ipnsPubsubTopic = ipnsNameToIpnsOverPubsubTopic(this.ipnsName);
            this.ipnsPubsubTopicRoutingCid = pubsubTopicToDhtKey(this.ipnsPubsubTopic);
        }
        if (!this.pubsubTopicRoutingCid) {
            if ("pubsubTopicRoutingCid" in newProps) this.pubsubTopicRoutingCid = newProps.pubsubTopicRoutingCid;
            else if (this.raw.communityIpfs)
                this.pubsubTopicRoutingCid = pubsubTopicToDhtKey(
                    newProps.pubsubTopic ||
                        this.pubsubTopic ||
                        ("address" in newProps ? (newProps.address as string) : undefined) ||
                        this.address
                );
        }
    }

    initRemoteCommunityPropsNoMerge(newProps: CommunityJson | CreateRemoteCommunityOptions | CommunityIpfsType) {
        // This function is not strict, and will assume all props can be undefined, except address
        this.title = newProps.title;
        this.description = newProps.description;
        this.lastPostCid = newProps.lastPostCid;
        this.lastCommentCid = newProps.lastCommentCid;
        this.protocolVersion = newProps.protocolVersion;

        this.roles = newProps.roles;
        this.features = newProps.features;
        this.suggested = newProps.suggested;
        this.rules = newProps.rules;
        this.flairs = newProps.flairs;
        this.postUpdates = newProps.postUpdates;
        this.challenges = newProps.challenges;
        this.statsCid = newProps.statsCid;
        this.createdAt = newProps.createdAt;
        this.updatedAt = newProps.updatedAt;
        this.encryption = newProps.encryption;
        this._updateIpnsPubsubPropsIfNeeded(newProps);
        this.pubsubTopic = newProps.pubsubTopic;

        this.signature = newProps.signature;

        // Compute runtime fields: publicKey, name, address
        const explicitPublicKey = "publicKey" in newProps ? (newProps.publicKey as string) : undefined;
        if (newProps.signature?.publicKey) {
            this.publicKey = getPKCAddressFromPublicKeySync(newProps.signature.publicKey);
        } else if (explicitPublicKey) {
            this.publicKey = explicitPublicKey;
        } else if (
            !this.publicKey &&
            "address" in newProps &&
            typeof newProps.address === "string" &&
            !isStringDomain(newProps.address as string)
        ) {
            this.publicKey = newProps.address as string;
        }
        if (typeof newProps.name === "string") this.name = newProps.name;
        else if (
            !this.name &&
            "address" in newProps &&
            typeof newProps.address === "string" &&
            isStringDomain(newProps.address as string)
        ) {
            this.name = newProps.address as string;
        }

        // Only set address during initial creation (no address yet).
        // Once set, address is immutable -- record updates must not override it.
        if (!this.address) {
            const explicitAddress = "address" in newProps ? (newProps.address as string) : undefined;
            const derivedAddress = this.name || this.publicKey || explicitPublicKey || explicitAddress;
            if (derivedAddress) this.setAddress(derivedAddress);
        } else {
            // Address already set -- refresh tracking aliases without changing address
            refreshTrackedCommunityAliases(this._pkc, this);
            this._assertHasIdentity();
        }

        this._updateLocalPostsInstance(newProps.posts);
        this._updateLocalModQueueInstance(newProps.modQueue);

        // Exclusive Instance props
        if ("updateCid" in newProps && newProps.updateCid) this.updateCid = newProps.updateCid as string;
    }

    private _assertHasIdentity(): void {
        if (!this.name && !this.publicKey) {
            throw new Error(`Community identity invariant violated: both name and publicKey are undefined (address: ${this.address})`);
        }
    }

    setAddress(newAddress: string) {
        // check if domain or ipns
        // else, throw an error
        if (doesDomainAddressHaveCapitalLetter(newAddress))
            throw new PKCError("ERR_COMMUNITY_NAME_HAS_CAPITAL_LETTER", { communityAddress: newAddress });
        const isDomain = newAddress.includes(".");
        if (!isDomain && !isIpns(newAddress))
            throw new PKCError("ERR_INVALID_COMMUNITY_ADDRESS_SCHEMA", { communityAddress: newAddress, isDomain, isIpns: false });

        this.address = newAddress;
        this.shortAddress = shortifyAddress(this.address);
        // Sync wire-format name field: domains go into `name`, non-domains clear it
        this.name = isStringDomain(newAddress) ? newAddress : undefined;
        // For non-domain addresses, the address IS the publicKey (IPNS name from ed25519 key)
        if (!isStringDomain(newAddress) && !this.publicKey) {
            this.publicKey = newAddress;
        }
        this.posts._community = this;
        this.modQueue._community = this;
        refreshTrackedCommunityAliases(this._pkc, this);
        this._assertHasIdentity();
    }

    _clearDataForKeyMigration(newPublicKey: string) {
        this.raw.communityIpfs = undefined;
        this.updateCid = undefined;
        // Clear all display fields via initRemoteCommunityPropsNoMerge with empty props.
        // Address immutability in initRemoteCommunityPropsNoMerge ensures address won't change.
        this.initRemoteCommunityPropsNoMerge({} as CreateRemoteCommunityOptions);

        // Update to new key and IPNS routing props
        this.publicKey = newPublicKey;
        this.ipnsName = newPublicKey;
        this.ipnsPubsubTopic = ipnsNameToIpnsOverPubsubTopic(newPublicKey);
        this.ipnsPubsubTopicRoutingCid = pubsubTopicToDhtKey(this.ipnsPubsubTopic);
        this._assertHasIdentity();
    }

    protected _toJSONIpfsBaseNoPosts() {
        const communityIpfsKeys = remeda.keys.strict(remeda.omit(CommunityIpfsSchema.shape, ["posts", "modQueue"]));
        return remeda.pick(this, communityIpfsKeys);
    }

    toJSONRpcRemote(): RpcRemoteCommunityType {
        if (!this.updateCid || !this.raw.communityIpfs) {
            // Post key-migration cleared state — tell client to reset its instance
            return {
                resetInstance: true,
                runtimeFields: {
                    newPublicKey: this.publicKey!,
                    nameResolved: this.nameResolved,
                    updatingState: this.updatingState
                }
            };
        }
        return {
            community: this.raw.communityIpfs,
            runtimeFields: {
                updateCid: this.updateCid,
                updatingState: this.updatingState,
                nameResolved: this.nameResolved
            }
        };
    }

    get updatingState(): CommunityUpdatingState {
        if (this._updatingCommunityInstanceWithListeners) {
            return this._updatingCommunityInstanceWithListeners.community.updatingState;
        } else return this._updatingState;
    }

    protected _getIpnsName(): string | undefined {
        return this._updatingCommunityInstanceWithListeners?.community.ipnsName ?? this._ipnsName;
    }

    protected _setIpnsName(value: string | undefined) {
        this._ipnsName = value;
    }

    protected _getIpnsPubsubTopic(): string | undefined {
        return this._updatingCommunityInstanceWithListeners?.community.ipnsPubsubTopic ?? this._ipnsPubsubTopic;
    }

    protected _setIpnsPubsubTopic(value: string | undefined) {
        this._ipnsPubsubTopic = value;
    }

    protected _getIpnsPubsubTopicRoutingCid(): string | undefined {
        return this._updatingCommunityInstanceWithListeners?.community.ipnsPubsubTopicRoutingCid ?? this._ipnsPubsubTopicRoutingCid;
    }

    protected _setIpnsPubsubTopicRoutingCid(value: string | undefined) {
        this._ipnsPubsubTopicRoutingCid = value;
    }

    _setState(newState: RemoteCommunity["state"]) {
        if (newState === this.state) return;
        this.state = newState;
        this.emit("statechange", this.state);
    }

    _setStateNoEmission(newState: RemoteCommunity["state"]) {
        if (newState === this.state) return;
        this.state = newState;
    }

    _changeStateEmitEventEmitStateChangeEvent<T extends keyof Omit<CommunityEvents, "statechange" | "updatingstatechange">>(opts: {
        event: { name: T; args: CommunityEventArgs<T> };
        newUpdatingState?: RemoteCommunity["updatingState"];
        newState?: RemoteCommunity["state"];
        newStartedState?: RemoteCommunity["startedState"];
    }) {
        // this code block is only called on a community whose update loop is already started
        // never called in a community that's mirroring a community with an update loop
        const shouldEmitStateChange = opts.newState && opts.newState !== this.state;
        const shouldEmitUpdatingStateChange = opts.newUpdatingState && opts.newUpdatingState !== this.updatingState;
        const shouldEmitStartedStateChange = opts.newStartedState && opts.newStartedState !== this.startedState;
        if (opts.newState) this._setStateNoEmission(opts.newState);
        if (opts.newUpdatingState) this._setUpdatingStateNoEmission(opts.newUpdatingState);
        if (opts.newStartedState) this._setStartedStateNoEmission(opts.newStartedState);

        this.emit(opts.event.name, ...opts.event.args);

        if (shouldEmitStateChange) this.emit("statechange", this.state);
        if (shouldEmitUpdatingStateChange) this.emit("updatingstatechange", this.updatingState);
        if (shouldEmitStartedStateChange) this.emit("startedstatechange", this.startedState!);
    }

    _setUpdatingStateNoEmission(newState: RemoteCommunity["updatingState"]) {
        if (newState === this.updatingState) return;
        this._updatingState = newState;
    }

    _setUpdatingStateWithEventEmissionIfNewState(newState: RemoteCommunity["updatingState"]) {
        if (newState === this._updatingState) return;
        this._updatingState = newState;
        this.emit("updatingstatechange", this._updatingState);
    }

    protected _setStartedStateNoEmission(newState: CommunityStartedState) {
        if (newState === this.startedState) return;
        this.startedState = newState;
    }

    protected _setStartedStateWithEmission(newState: CommunityStartedState) {
        if (newState === this.startedState) return;
        this.startedState = newState;
        this.emit("startedstatechange", this.startedState);
    }

    // Errors that retrying to load the ipns record will not help
    // Instead we should abort the retries, and emit an error event to notify the user to do something about it
    _isRetriableErrorWhenLoading(err: PKCError | Error): boolean {
        if (!(err instanceof PKCError)) return false; // If it's not a recognizable error, then we throw to notify the user
        if (
            err.code === "ERR_COMMUNITY_SIGNATURE_IS_INVALID" ||
            err.code === "ERR_INVALID_COMMUNITY_IPFS_SCHEMA" ||
            err.code === "ERR_THE_COMMUNITY_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED" ||
            err.code === "ERR_OVER_DOWNLOAD_LIMIT" ||
            err.code === "ERR_INVALID_JSON" ||
            err.code === "ERR_NO_RESOLVER_FOR_NAME"
        )
            return false;

        if (err instanceof FailedToFetchCommunityFromGatewaysError) {
            // If all gateway errors are non retriable, then the error is non retriable
            for (const gatewayError of Object.values(err.details.gatewayToError))
                if (this._isRetriableErrorWhenLoading(gatewayError)) return true;
            return false; // if all gateways are non retriable, then we should not retry
        }
        return true;
    }

    _setCommunityIpfsPropsFromUpdatingCommunitiesIfPossible() {
        const log = Logger("pkc-js:comment:_setCommunityIpfsPropsFromUpdatingCommunitiesIfPossible");
        const updatingCommunity = findUpdatingCommunity(this._pkc, { publicKey: this.publicKey, name: this.name });
        if (updatingCommunity?.raw?.communityIpfs && (this.updatedAt || 0) < updatingCommunity.raw.communityIpfs.updatedAt) {
            this.initCommunityIpfsPropsNoMerge(updatingCommunity.raw.communityIpfs);
            this.updateCid = updatingCommunity.updateCid;
            log.trace(
                `New Remote Community instance`,
                this.address,
                `will use CommunityIpfs from pkc._updatingCommunities[${this.address}] with updatedAt`,
                this.updatedAt,
                "that's",
                timestamp() - this.updatedAt!,
                "seconds old"
            );
            this.emit("update", this);
        }
    }

    private async _initCommunityInstanceWithListeners() {
        const trackedUpdatingCommunity = findUpdatingCommunity(this._pkc, { publicKey: this.publicKey, name: this.name });
        if (!trackedUpdatingCommunity) throw Error("should be defined at this stage");
        const log = Logger("pkc-js:remote-community:update");
        const communityInstance = trackedUpdatingCommunity;
        return <NonNullable<this["_updatingCommunityInstanceWithListeners"]>>{
            community: communityInstance,
            update: () => {
                if (!communityInstance.raw.communityIpfs || !communityInstance.updateCid) {
                    if (communityInstance.publicKey) this._clearDataForKeyMigration(communityInstance.publicKey);
                } else {
                    this.initCommunityIpfsPropsNoMerge(communityInstance.raw.communityIpfs);
                    this.updateCid = communityInstance.updateCid;
                }
                if (typeof communityInstance.nameResolved === "boolean") this.nameResolved = communityInstance.nameResolved;
                log(
                    `Remote Community instance`,
                    this.address,
                    `received update event from pkc._updatingCommunities[${this.address}] with updatedAt`,
                    this.updatedAt,
                    "that's",
                    timestamp() - this.updatedAt!,
                    "seconds old"
                );
                this.emit("update", this);
            },
            error: (error: PKCError) => {
                this.emit("error", error);
            },
            updatingstatechange: (newUpdatingState) => {
                this.emit("updatingstatechange", newUpdatingState);
            },
            statechange: async (newState) => {
                if (newState === "stopped" && this.state !== "stopped") await this.stop();
            }
        };
    }

    private async fetchLatestCommunityOrSubscribeToEvent() {
        const log = Logger("pkc-js:remote-community:update:updateOnce");

        if (!findUpdatingCommunity(this._pkc, { publicKey: this.publicKey, name: this.name })) {
            // Pass publicKey alongside name/address so the updating community can use publicKey fallback
            const createOpts =
                this.publicKey && isStringDomain(this.address)
                    ? { name: this.address, publicKey: this.publicKey }
                    : { address: this.address };
            const updatingCommunity = await this._pkc.createCommunity(createOpts);
            trackUpdatingCommunity(this._pkc, updatingCommunity);
            log("Creating a new entry for this._pkc._updatingCommunities", this.address);
        }

        const communityInstance = findUpdatingCommunity(this._pkc, { publicKey: this.publicKey, name: this.name });
        if (!communityInstance) throw Error("should be defined at this stage");
        if (communityInstance === this) {
            // Already tracking this instance; start the loop directly without mirroring to itself
            this._clientsManager.startUpdatingLoop().catch((err) => log.error("Failed to start update loop of community", err));
            return;
        }

        this._updatingCommunityInstanceWithListeners = await this._initCommunityInstanceWithListeners();
        this._updatingCommunityInstanceWithListeners.community.on("update", this._updatingCommunityInstanceWithListeners.update);

        this._updatingCommunityInstanceWithListeners.community.on(
            "updatingstatechange",
            this._updatingCommunityInstanceWithListeners.updatingstatechange
        );
        this._updatingCommunityInstanceWithListeners.community.on("error", this._updatingCommunityInstanceWithListeners.error);
        this._updatingCommunityInstanceWithListeners.community.on("statechange", this._updatingCommunityInstanceWithListeners.statechange);

        const clientKeys = remeda.keys.strict(this.clients);
        for (const clientType of clientKeys)
            if (this.clients[clientType])
                for (const clientUrl of Object.keys(this.clients[clientType]))
                    this.clients[clientType][clientUrl].mirror(
                        this._updatingCommunityInstanceWithListeners.community.clients[clientType][clientUrl]
                    );
        this._updatingCommunityInstanceWithListeners.community._numOfListenersForUpdatingInstance++;
        if (this._updatingCommunityInstanceWithListeners.community.state === "stopped") {
            this._updatingCommunityInstanceWithListeners.community._setState("updating");
            this._updatingCommunityInstanceWithListeners.community._clientsManager
                .startUpdatingLoop()
                .catch((err) => log.error("Failed to start update loop of community", err));
        }
    }

    async update() {
        if (this.state !== "stopped") return; // No need to do anything if community is already updating

        const log = Logger("pkc-js:remote-community:update");

        this._setState("updating");

        await this.fetchLatestCommunityOrSubscribeToEvent();
        if (this.raw.communityIpfs) this.emit("update", this);
    }

    private async _cleanUpUpdatingCommunityInstanceWithListeners() {
        if (!this._updatingCommunityInstanceWithListeners) throw Error("should be defined at this stage");

        const log = Logger("pkc-js:remote-community:stop:cleanUpUpdatingCommunityInstanceWithListeners");
        const updatingCommunity = this._updatingCommunityInstanceWithListeners.community;
        if (typeof updatingCommunity.ipnsName === "string") this._ipnsName = updatingCommunity.ipnsName;
        if (typeof updatingCommunity.ipnsPubsubTopic === "string") this._ipnsPubsubTopic = updatingCommunity.ipnsPubsubTopic;
        if (typeof updatingCommunity.ipnsPubsubTopicRoutingCid === "string")
            this._ipnsPubsubTopicRoutingCid = updatingCommunity.ipnsPubsubTopicRoutingCid;
        this._updatingState = this._updatingCommunityInstanceWithListeners.community.updatingState; // need to capture latest updating state before removing listeners
        // this instance is subscribed to pkc._updatingCommunity[address]
        // removing listeners should reset pkc._updatingCommunity by itself when there are no subscribers
        this._updatingCommunityInstanceWithListeners.community.removeListener(
            "statechange",
            this._updatingCommunityInstanceWithListeners.statechange
        );
        this._updatingCommunityInstanceWithListeners.community.removeListener(
            "update",
            this._updatingCommunityInstanceWithListeners.update
        );
        this._updatingCommunityInstanceWithListeners.community.removeListener(
            "updatingstatechange",
            this._updatingCommunityInstanceWithListeners.updatingstatechange
        );
        this._updatingCommunityInstanceWithListeners.community.removeListener("error", this._updatingCommunityInstanceWithListeners.error);

        const clientKeys = remeda.keys.strict(this.clients);

        for (const clientType of clientKeys)
            if (this.clients[clientType])
                for (const clientUrl of Object.keys(this.clients[clientType])) this.clients[clientType][clientUrl].unmirror();

        this._updatingCommunityInstanceWithListeners.community._numOfListenersForUpdatingInstance--;
        if (
            this._updatingCommunityInstanceWithListeners.community._numOfListenersForUpdatingInstance === 0 &&
            this._updatingCommunityInstanceWithListeners.community.state !== "stopped"
        ) {
            log("Cleaning up pkc._updatingCommunities", this.address, "There are no communities using it for updates");
            await this._updatingCommunityInstanceWithListeners.community.stop();
        }
        this._updatingCommunityInstanceWithListeners = undefined;
    }

    async stop() {
        if (this.state === "stopped") return; // no-op if already stopped, mirrors update()'s idempotency
        if (this.state !== "updating") throw new PKCError("ERR_CALLED_COMMUNITY_STOP_WITHOUT_UPDATE", { address: this.address });

        const log = Logger("pkc-js:remote-community:stop");
        this._abortStopOperations(`Aborting community operations for ${this.address} because community.stop() was called`);

        if (this._updatingCommunityInstanceWithListeners) await this._cleanUpUpdatingCommunityInstanceWithListeners();
        else {
            // this instance is pkc._updatingCommunity[address] itself
            await this._clientsManager.stopUpdatingLoop();
            untrackUpdatingCommunity(this._pkc, this);
        }
        this._setUpdatingStateWithEventEmissionIfNewState("stopped");
        this._setState("stopped");
        this.posts._stop();
        this.modQueue._stop();
    }

    // functions to be overridden in local community classes

    async edit(options: CommunityEditOptions): Promise<any> {
        throw Error("Can't edit a remote community");
    }

    async delete() {
        throw Error("Can't delete a remote community");
    }

    async start() {
        throw Error("Can't start a remote community");
    }
}

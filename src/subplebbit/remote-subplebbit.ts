import {
    createAbortError,
    doesDomainAddressHaveCapitalLetter,
    hideClassPrivateProps,
    ipnsNameToIpnsOverPubsubTopic,
    isIpns,
    pubsubTopicToDhtKey,
    shortifyAddress,
    timestamp
} from "../util.js";
import { Plebbit } from "../plebbit/plebbit.js";

import Logger from "@plebbit/plebbit-logger";

import { TypedEmitter } from "tiny-typed-emitter";
import { FailedToFetchSubplebbitFromGatewaysError, PlebbitError } from "../plebbit-error.js";
import type {
    CreateRemoteSubplebbitOptions,
    SubplebbitIpfsType,
    RpcRemoteSubplebbitType,
    SubplebbitJson,
    SubplebbitUpdatingState,
    SubplebbitState,
    SubplebbitStartedState,
    SubplebbitSettings,
    RpcInternalSubplebbitRecordAfterFirstUpdateType,
    SubplebbitEditOptions,
    SubplebbitEventArgs,
    SubplebbitEvents
} from "./types.js";
import * as remeda from "remeda";
import { ModQueuePages, PostsPages } from "../pages/pages.js";
import type { PostsPagesTypeIpfs } from "../pages/types.js";
import { parseRawPages } from "../pages/util.js";
import { SubplebbitIpfsSchema } from "./schema.js";
import { SignerWithPublicKeyAddress } from "../signer/index.js";
import { SubplebbitClientsManager } from "./subplebbit-client-manager.js";
import { getPlebbitAddressFromPublicKeySync } from "../signer/util.js";

export class RemoteSubplebbit extends TypedEmitter<SubplebbitEvents> implements Omit<Partial<SubplebbitIpfsType>, "posts"> {
    // public
    title?: SubplebbitIpfsType["title"];
    description?: SubplebbitIpfsType["description"];
    roles?: SubplebbitIpfsType["roles"];
    lastPostCid?: SubplebbitIpfsType["lastPostCid"];
    lastCommentCid?: SubplebbitIpfsType["lastCommentCid"];
    posts: PostsPages;
    modQueue: ModQueuePages;
    pubsubTopic?: SubplebbitIpfsType["pubsubTopic"];
    features?: SubplebbitIpfsType["features"];
    suggested?: SubplebbitIpfsType["suggested"];
    flairs?: SubplebbitIpfsType["flairs"];
    address!: SubplebbitIpfsType["address"];
    shortAddress!: string;
    statsCid?: SubplebbitIpfsType["statsCid"];
    createdAt?: SubplebbitIpfsType["createdAt"];
    updatedAt?: SubplebbitIpfsType["updatedAt"];
    encryption?: SubplebbitIpfsType["encryption"];
    protocolVersion?: SubplebbitIpfsType["protocolVersion"];
    signature?: SubplebbitIpfsType["signature"];
    rules?: SubplebbitIpfsType["rules"];
    challenges?: SubplebbitIpfsType["challenges"];
    postUpdates?: SubplebbitIpfsType["postUpdates"];

    // to be overridden by local subplebbit classes
    startedState?: "stopped" | SubplebbitStartedState = "stopped";
    started?: boolean;
    signer?: SignerWithPublicKeyAddress | RpcInternalSubplebbitRecordAfterFirstUpdateType["signer"];
    settings?: SubplebbitSettings;
    editable?: Pick<RemoteSubplebbit, keyof SubplebbitEditOptions>;

    // Only for Subplebbit instance, informational
    state!: SubplebbitState;
    clients: SubplebbitClientsManager["clients"];
    updateCid?: string;
    declare ipnsName?: string;
    declare ipnsPubsubTopic?: string; // ipns over pubsub topic
    declare ipnsPubsubTopicRoutingCid?: string; // peers of subplebbit.ipnsPubsubTopic, use this cid with http routers to find peers of ipns-over-pubsub
    pubsubTopicRoutingCid?: string; // peers of subplebbit.pubsubTopic, use this cid with http routers to find peers of subplebbit.pubsubTopic

    // should be used internally
    _plebbit: Plebbit;
    _clientsManager: SubplebbitClientsManager;
    raw: { subplebbitIpfs?: SubplebbitIpfsType } = {};
    _updatingSubInstanceWithListeners?: { subplebbit: RemoteSubplebbit } & Pick<
        SubplebbitEvents,
        "error" | "updatingstatechange" | "update" | "statechange"
    > = undefined; // The plebbit._updatingSubplebbits we're subscribed to
    _numOfListenersForUpdatingInstance = 0;
    protected _ipnsName?: string;
    protected _ipnsPubsubTopic?: string;
    protected _ipnsPubsubTopicRoutingCid?: string;
    protected _stopAbortController?: AbortController;

    // Add a private property to store the actual updatingState value
    protected _updatingState!: SubplebbitUpdatingState;

    constructor(plebbit: Plebbit) {
        super();
        this._plebbit = plebbit;
        this._setState("stopped");
        this._updatingState = "stopped";
        this._defineIpnsAccessorProps();
        this._defineEnumerableUpdatingState();

        // these functions might get separated from their `this` when used
        this.update = this.update.bind(this);
        this.stop = this.stop.bind(this);

        this.on("error", (...args) => this.listenerCount("error") === 1 && this._plebbit.emit("error", ...args)); // only bubble up to plebbit if no other listeners are attached

        this._clientsManager = new SubplebbitClientsManager(this);
        this.clients = this._clientsManager.clients;

        this.posts = new PostsPages({
            pageCids: {},
            pages: {},
            plebbit: this._plebbit,
            subplebbit: this
        });
        this.modQueue = new ModQueuePages({ pageCids: {}, plebbit: this._plebbit, subplebbit: this, pages: undefined });
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
        newPosts: SubplebbitIpfsType["posts"] | SubplebbitJson["posts"] | Pick<NonNullable<SubplebbitIpfsType["posts"]>, "pageCids">
    ) {
        const log = Logger("plebbit-js:remote-subplebbit:_updateLocalPostsInstanceIfNeeded");
        const postsPagesCreationTimestamp = this.updatedAt;
        this.posts._subplebbit = this;
        if (!newPosts)
            // The sub has changed its address, need to reset the posts
            this.posts.resetPages();
        else if (
            (!("pages" in newPosts) || !newPosts.pages || Object.keys(newPosts.pages).length === 0) &&
            newPosts.pageCids &&
            Object.keys(newPosts.pageCids).length > 0
        ) {
            // only pageCids is provided (or pages is empty)
            this.posts.updateProps({
                pageCids: newPosts.pageCids,
                subplebbit: this,
                pages: {}
            });
        } else if (
            (!newPosts.pageCids || Object.keys(newPosts.pageCids).length === 0) &&
            "pages" in newPosts &&
            newPosts.pages &&
            Object.keys(newPosts.pages).length > 0
        ) {
            // was only provided with a single preloaded page, no page cids
            if (typeof postsPagesCreationTimestamp !== "number") throw Error("subplebbit.updatedAt should be defined when updating posts");
            const parsedPages = parseRawPages(newPosts);
            this.posts.updateProps({
                ...parsedPages,
                subplebbit: this,
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

            log.trace(`Updating the props of subplebbit (${this.address}) posts`);
            if (typeof postsPagesCreationTimestamp !== "number") throw Error("subplebbit.updatedAt should be defined when updating posts");
            const parsedPages = <Pick<PostsPages, "pages"> & { pagesIpfs: PostsPagesTypeIpfs | undefined }>parseRawPages(newPosts);
            this.posts.updateProps({
                ...parsedPages,
                subplebbit: this,
                pageCids: newPosts?.pageCids || {}
            });
        }
    }

    _updateLocalModQueueInstance(
        newModQueue:
            | SubplebbitIpfsType["modQueue"]
            | SubplebbitJson["modQueue"]
            | Pick<NonNullable<SubplebbitIpfsType["modQueue"]>, "pageCids">
    ) {
        this.modQueue._subplebbit = this;
        if (!newModQueue)
            // The sub has changed its address, need to reset the posts
            this.modQueue.resetPages();
        else if (newModQueue.pageCids) {
            // only pageCids is provided
            this.modQueue.updateProps({
                pageCids: newModQueue.pageCids,
                subplebbit: this,
                pages: {}
            });
        }
    }

    initSubplebbitIpfsPropsNoMerge(newProps: SubplebbitIpfsType) {
        const log = Logger("plebbit-js:remote-subplebbit:initSubplebbitIpfsPropsNoMerge");
        this.raw.subplebbitIpfs = newProps;
        this.initRemoteSubplebbitPropsNoMerge(newProps);
        const unknownProps = remeda.difference(remeda.keys.strict(this.raw.subplebbitIpfs), remeda.keys.strict(SubplebbitIpfsSchema.shape));
        if (unknownProps.length > 0) {
            log(`Found unknown props on subplebbit (${this.raw.subplebbitIpfs.address}) ipfs record`, unknownProps);
            Object.assign(this, remeda.pick(this.raw.subplebbitIpfs, unknownProps));
        }
    }

    protected _updateIpnsPubsubPropsIfNeeded(newProps: SubplebbitJson | CreateRemoteSubplebbitOptions) {
        if ("ipnsName" in newProps && newProps.ipnsName) {
            this.ipnsName = newProps.ipnsName;
            this.ipnsPubsubTopic = ipnsNameToIpnsOverPubsubTopic(this.ipnsName);
            this.ipnsPubsubTopicRoutingCid = pubsubTopicToDhtKey(this.ipnsPubsubTopic);
        } else if (newProps.signature?.publicKey && this.signature?.publicKey !== newProps.signature?.publicKey) {
            // The signature public key has changed, we need to update the ipns name and pubsub topic
            this.ipnsName = getPlebbitAddressFromPublicKeySync(newProps.signature.publicKey);
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
            else if (this.raw.subplebbitIpfs)
                this.pubsubTopicRoutingCid = pubsubTopicToDhtKey(newProps.pubsubTopic || this.pubsubTopic || newProps.address);
        }
    }

    initRemoteSubplebbitPropsNoMerge(newProps: SubplebbitJson | CreateRemoteSubplebbitOptions) {
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

        this.setAddress(newProps.address);
        this._updateLocalPostsInstance(newProps.posts);
        this._updateLocalModQueueInstance(newProps.modQueue);

        // Exclusive Instance props
        if (newProps.updateCid) this.updateCid = newProps.updateCid;
    }

    setAddress(newAddress: string) {
        // check if domain or ipns
        // else, throw an error
        if (doesDomainAddressHaveCapitalLetter(newAddress))
            throw new PlebbitError("ERR_DOMAIN_ADDRESS_HAS_CAPITAL_LETTER", { subplebbitAddress: newAddress });
        const isDomain = newAddress.includes(".");
        if (!isDomain && !isIpns(newAddress))
            throw new PlebbitError("ERR_INVALID_SUBPLEBBIT_ADDRESS_SCHEMA", { subplebbitAddress: newAddress, isDomain, isIpns: false });

        this.address = newAddress;
        this.shortAddress = shortifyAddress(this.address);
        this.posts._subplebbit = this;
        this.modQueue._subplebbit = this;
    }

    protected _toJSONIpfsBaseNoPosts() {
        const subplebbitIpfsKeys = remeda.keys.strict(remeda.omit(SubplebbitIpfsSchema.shape, ["posts", "modQueue"]));
        return remeda.pick(this, subplebbitIpfsKeys);
    }

    toJSONRpcRemote(): RpcRemoteSubplebbitType {
        if (!this.updateCid) throw Error("subplebbit.updateCid should be defined before calling toJSONRpcRemote");
        if (!this.raw.subplebbitIpfs) throw Error("subplebbit.raw.subplebbitIpfs should be defined before calling toJSONRpcRemote");
        return {
            subplebbit: this.raw.subplebbitIpfs,
            runtimeFields: {
                updateCid: this.updateCid,
                updatingState: this.updatingState
            }
        };
    }

    get updatingState(): SubplebbitUpdatingState {
        if (this._updatingSubInstanceWithListeners) {
            return this._updatingSubInstanceWithListeners.subplebbit.updatingState;
        } else return this._updatingState;
    }

    protected _getIpnsName(): string | undefined {
        return this._updatingSubInstanceWithListeners?.subplebbit.ipnsName ?? this._ipnsName;
    }

    protected _setIpnsName(value: string | undefined) {
        this._ipnsName = value;
    }

    protected _getIpnsPubsubTopic(): string | undefined {
        return this._updatingSubInstanceWithListeners?.subplebbit.ipnsPubsubTopic ?? this._ipnsPubsubTopic;
    }

    protected _setIpnsPubsubTopic(value: string | undefined) {
        this._ipnsPubsubTopic = value;
    }

    protected _getIpnsPubsubTopicRoutingCid(): string | undefined {
        return this._updatingSubInstanceWithListeners?.subplebbit.ipnsPubsubTopicRoutingCid ?? this._ipnsPubsubTopicRoutingCid;
    }

    protected _setIpnsPubsubTopicRoutingCid(value: string | undefined) {
        this._ipnsPubsubTopicRoutingCid = value;
    }

    _setState(newState: RemoteSubplebbit["state"]) {
        if (newState === this.state) return;
        this.state = newState;
        this.emit("statechange", this.state);
    }

    _setStateNoEmission(newState: RemoteSubplebbit["state"]) {
        if (newState === this.state) return;
        this.state = newState;
    }

    _changeStateEmitEventEmitStateChangeEvent<T extends keyof Omit<SubplebbitEvents, "statechange" | "updatingstatechange">>(opts: {
        event: { name: T; args: SubplebbitEventArgs<T> };
        newUpdatingState?: RemoteSubplebbit["updatingState"];
        newState?: RemoteSubplebbit["state"];
        newStartedState?: RemoteSubplebbit["startedState"];
    }) {
        // this code block is only called on a sub whose update loop is already started
        // never called in a subplebbit that's mirroring a subplebbit with an update loop
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

    _setUpdatingStateNoEmission(newState: RemoteSubplebbit["updatingState"]) {
        if (newState === this.updatingState) return;
        this._updatingState = newState;
    }

    _setUpdatingStateWithEventEmissionIfNewState(newState: RemoteSubplebbit["updatingState"]) {
        if (newState === this._updatingState) return;
        this._updatingState = newState;
        this.emit("updatingstatechange", this._updatingState);
    }

    protected _setStartedStateNoEmission(newState: SubplebbitStartedState) {
        if (newState === this.startedState) return;
        this.startedState = newState;
    }

    protected _setStartedStateWithEmission(newState: SubplebbitStartedState) {
        if (newState === this.startedState) return;
        this.startedState = newState;
        this.emit("startedstatechange", this.startedState);
    }

    // Errors that retrying to load the ipns record will not help
    // Instead we should abort the retries, and emit an error event to notify the user to do something about it
    _isRetriableErrorWhenLoading(err: PlebbitError | Error): boolean {
        if (!(err instanceof PlebbitError)) return false; // If it's not a recognizable error, then we throw to notify the user
        if (
            err.code === "ERR_SUBPLEBBIT_SIGNATURE_IS_INVALID" ||
            err.code === "ERR_INVALID_SUBPLEBBIT_IPFS_SCHEMA" ||
            err.code === "ERR_THE_SUBPLEBBIT_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED" ||
            err.code === "ERR_OVER_DOWNLOAD_LIMIT" ||
            err.code === "ERR_INVALID_JSON"
        )
            return false;

        if (err instanceof FailedToFetchSubplebbitFromGatewaysError) {
            // If all gateway errors are non retriable, then the error is non retriable
            for (const gatewayError of Object.values(err.details.gatewayToError))
                if (this._isRetriableErrorWhenLoading(gatewayError)) return true;
            return false; // if all gateways are non retriable, then we should not retry
        }
        return true;
    }

    _setSubplebbitIpfsPropsFromUpdatingSubplebbitsIfPossible() {
        const log = Logger("plebbit-js:comment:_setSubplebbitIpfsPropsFromUpdatingSubplebbitsIfPossible");
        const updatingSub = this._plebbit._updatingSubplebbits[this.address];
        if (updatingSub?.raw?.subplebbitIpfs && (this.updatedAt || 0) < updatingSub.raw.subplebbitIpfs.updatedAt) {
            this.initSubplebbitIpfsPropsNoMerge(updatingSub.raw.subplebbitIpfs);
            this.updateCid = updatingSub.updateCid;
            log.trace(
                `New Remote Subplebbit instance`,
                this.address,
                `will use SubplebbitIpfs from plebbit._updatingSubplebbits[${this.address}] with updatedAt`,
                this.updatedAt,
                "that's",
                timestamp() - this.updatedAt!,
                "seconds old"
            );
            this.emit("update", this);
        }
    }

    private async _initSubInstanceWithListeners() {
        if (!this._plebbit._updatingSubplebbits[this.address]) throw Error("should be defined at this stage");
        const log = Logger("plebbit-js:remote-subplebbit:update");
        const subInstance = this._plebbit._updatingSubplebbits[this.address];
        return <NonNullable<this["_updatingSubInstanceWithListeners"]>>{
            subplebbit: subInstance,
            update: () => {
                this.initSubplebbitIpfsPropsNoMerge(subInstance.raw.subplebbitIpfs!);
                this.updateCid = subInstance.updateCid;
                log(
                    `Remote Subplebbit instance`,
                    this.address,
                    `received update event from plebbit._updatingSubplebbits[${this.address}] with updatedAt`,
                    this.updatedAt,
                    "that's",
                    timestamp() - this.updatedAt!,
                    "seconds old"
                );
                this.emit("update", this);
            },
            error: (error: PlebbitError) => {
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

    private async fetchLatestSubOrSubscribeToEvent() {
        const log = Logger("plebbit-js:remote-subplebbit:update:updateOnce");

        if (!this._plebbit._updatingSubplebbits[this.address]) {
            const updatingSub = await this._plebbit.createSubplebbit({ address: this.address });
            this._plebbit._updatingSubplebbits[this.address] = updatingSub;
            log("Creating a new entry for this._plebbit._updatingSubplebbits", this.address);
        }

        const subInstance = this._plebbit._updatingSubplebbits[this.address];
        if (subInstance === this) {
            // Already tracking this instance; start the loop directly without mirroring to itself
            this._clientsManager.startUpdatingLoop().catch((err) => log.error("Failed to start update loop of subplebbit", err));
            return;
        }

        this._updatingSubInstanceWithListeners = await this._initSubInstanceWithListeners();
        this._updatingSubInstanceWithListeners.subplebbit.on("update", this._updatingSubInstanceWithListeners.update);

        this._updatingSubInstanceWithListeners.subplebbit.on(
            "updatingstatechange",
            this._updatingSubInstanceWithListeners.updatingstatechange
        );
        this._updatingSubInstanceWithListeners.subplebbit.on("error", this._updatingSubInstanceWithListeners.error);
        this._updatingSubInstanceWithListeners.subplebbit.on("statechange", this._updatingSubInstanceWithListeners.statechange);

        const clientKeys = remeda.keys.strict(this.clients);
        for (const clientType of clientKeys)
            if (this.clients[clientType])
                for (const clientUrl of Object.keys(this.clients[clientType]))
                    this.clients[clientType][clientUrl].mirror(
                        this._updatingSubInstanceWithListeners.subplebbit.clients[clientType][clientUrl]
                    );
        this._updatingSubInstanceWithListeners.subplebbit._numOfListenersForUpdatingInstance++;
        if (this._updatingSubInstanceWithListeners.subplebbit.state === "stopped") {
            this._updatingSubInstanceWithListeners.subplebbit._setState("updating");
            this._updatingSubInstanceWithListeners.subplebbit._clientsManager
                .startUpdatingLoop()
                .catch((err) => log.error("Failed to start update loop of subplebbit", err));
        }
    }

    async update() {
        if (this.state !== "stopped") return; // No need to do anything if subplebbit is already updating

        const log = Logger("plebbit-js:remote-subplebbit:update");

        this._setState("updating");

        await this.fetchLatestSubOrSubscribeToEvent();
        if (this.raw.subplebbitIpfs) this.emit("update", this);
    }

    private async _cleanUpUpdatingSubInstanceWithListeners() {
        if (!this._updatingSubInstanceWithListeners) throw Error("should be defined at this stage");

        const log = Logger("plebbit-js:remote-subplebbit:stop:cleanUpUpdatingSubInstanceWithListeners");
        const updatingSubplebbit = this._updatingSubInstanceWithListeners.subplebbit;
        if (typeof updatingSubplebbit.ipnsName === "string") this._ipnsName = updatingSubplebbit.ipnsName;
        if (typeof updatingSubplebbit.ipnsPubsubTopic === "string") this._ipnsPubsubTopic = updatingSubplebbit.ipnsPubsubTopic;
        if (typeof updatingSubplebbit.ipnsPubsubTopicRoutingCid === "string")
            this._ipnsPubsubTopicRoutingCid = updatingSubplebbit.ipnsPubsubTopicRoutingCid;
        this._updatingState = this._updatingSubInstanceWithListeners.subplebbit.updatingState; // need to capture latest updating state before removing listeners
        // this instance is subscribed to plebbit._updatingSubplebbit[address]
        // removing listeners should reset plebbit._updatingSubplebbit by itself when there are no subscribers
        this._updatingSubInstanceWithListeners.subplebbit.removeListener("statechange", this._updatingSubInstanceWithListeners.statechange);
        this._updatingSubInstanceWithListeners.subplebbit.removeListener("update", this._updatingSubInstanceWithListeners.update);
        this._updatingSubInstanceWithListeners.subplebbit.removeListener(
            "updatingstatechange",
            this._updatingSubInstanceWithListeners.updatingstatechange
        );
        this._updatingSubInstanceWithListeners.subplebbit.removeListener("error", this._updatingSubInstanceWithListeners.error);

        const clientKeys = remeda.keys.strict(this.clients);

        for (const clientType of clientKeys)
            if (this.clients[clientType])
                for (const clientUrl of Object.keys(this.clients[clientType])) this.clients[clientType][clientUrl].unmirror();

        this._updatingSubInstanceWithListeners.subplebbit._numOfListenersForUpdatingInstance--;
        if (
            this._updatingSubInstanceWithListeners.subplebbit._numOfListenersForUpdatingInstance === 0 &&
            this._updatingSubInstanceWithListeners.subplebbit.state !== "stopped"
        ) {
            log("Cleaning up plebbit._updatingSubplebbits", this.address, "There are no subplebbits using it for updates");
            await this._updatingSubInstanceWithListeners.subplebbit.stop();
        }
        this._updatingSubInstanceWithListeners = undefined;
    }

    async stop() {
        if (this.state === "stopped") return; // no-op if already stopped, mirrors update()'s idempotency
        if (this.state !== "updating") throw new PlebbitError("ERR_CALLED_SUBPLEBBIT_STOP_WITHOUT_UPDATE", { address: this.address });

        const log = Logger("plebbit-js:remote-subplebbit:stop");
        this._abortStopOperations(`Aborting subplebbit operations for ${this.address} because subplebbit.stop() was called`);

        if (this._updatingSubInstanceWithListeners) await this._cleanUpUpdatingSubInstanceWithListeners();
        else {
            // this instance is plebbit._updatingSubplebbit[address] itself
            await this._clientsManager.stopUpdatingLoop();
            delete this._plebbit._updatingSubplebbits[this.address];
        }
        this._setUpdatingStateWithEventEmissionIfNewState("stopped");
        this._setState("stopped");
        this.posts._stop();
        this.modQueue._stop();
    }

    // functions to be overridden in local subplebbit classes

    async edit(options: SubplebbitEditOptions): Promise<any> {
        throw Error("Can't edit a remote subplebbit");
    }

    async delete() {
        throw Error("Can't delete a remote subplebbit");
    }

    async start() {
        throw Error("Can't start a remote subplebbit");
    }
}

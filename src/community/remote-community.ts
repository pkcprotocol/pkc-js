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
    CommunityEvents,
    CommunityExportRecord,
    ExportCommunityUserOptions,
    ExportCommunityModLogsOptions,
    CommunityAnchor
} from "./types.js";
import type { CommentModerationTableRow } from "../publications/comment-moderation/types.js";
import { difference, keys, omit, pick } from "remeda";
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
    declare ipnsHops?: string[]; // the resolved IPNS delegation chain [anchor, ..., terminal]; single element for non-delegated communities. See docs/protocol/delegated-ipns.md
    anchor?: CommunityAnchor; // the record's signed anchor claim (#257): present exactly when the community is delegated; defines the identity readers address
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
    protected _ipnsHops?: string[];
    protected _ipnsPubsubTopic?: string;
    protected _ipnsPubsubTopicRoutingCid?: string;
    protected _stopAbortController?: AbortController;
    // Set when construction-time warm start (issue #197) found the tracked instance holding a record
    // keyed to a different publicKey than the caller requested: a key migration the caller has not
    // observed. The announcement is deferred to update() because callers attach their "error"
    // listener only after createCommunity() returns, so emitting here would be unobservable.
    // The explicit `= undefined` matters: it makes the field an own property at construction so
    // hideClassPrivateProps() can mark it non-enumerable — without it (target ES2021) the first
    // assignment would create an enumerable prop that leaks into JSON.stringify(community).
    protected _pendingWarmStartKeyMigration?: { previousPublicKey: string; newPublicKey: string } = undefined;

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

    _getStopAbortSignal(): AbortSignal | undefined {
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
            _ipnsHops: { enumerable: false, configurable: true, writable: true, value: undefined },
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
            ipnsHops: {
                enumerable: true,
                configurable: true,
                get: () => this._getIpnsHops(),
                set: (value: string[] | undefined) => this._setIpnsHops(value)
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
        // pubsubTopicRoutingCid is derived state of the PUBLISHED topic, so a full record is the
        // authority for it and it is recomputed on every one. Absence of pubsubTopic means the
        // challenge exchange is disabled (issue #229), so no routing CID may survive the record that
        // dropped the topic, and a changed topic has to move the CID with it. The record is authoritative
        // even against the instance: a LocalCommunity keeps community.pubsubTopic configured while the
        // setting is on, precisely so it can be republished later, but it is not being served now.
        this.pubsubTopicRoutingCid = newProps.pubsubTopic ? pubsubTopicToDhtKey(newProps.pubsubTopic) : undefined;
        const unknownProps = difference(keys(this.raw.communityIpfs), keys(CommunityIpfsSchema.shape));
        if (unknownProps.length > 0) {
            log(`Found unknown props on community (${this.address}) ipfs record`, unknownProps);
            Object.assign(this, pick(this.raw.communityIpfs, unknownProps));
        }
    }

    _updateIpnsPubsubPropsIfNeeded(newProps: CommunityJson | CreateRemoteCommunityOptions | CommunityIpfsType) {
        // The IPNS name we resolve/subscribe to is the ANCHOR of the (possibly delegated) chain.
        // For a delegated community the content is signed by the terminal (minter) key, so deriving
        // the ipns name from signature.publicKey would point us at the minter instead of the anchor.
        // The record's signed anchor claim wins over ipnsHops[0] (#257): a record reached by
        // addressing the minter directly has ipnsHops = [minter], and subsequent fetches must route
        // through the anchor chain — the anchor is the authoritative, rotation-safe pointer.
        // See docs/protocol/delegated-ipns.md.
        const anchorFromClaimOrHops = this.anchor?.publicKey ?? this.ipnsHops?.[0];
        if ("ipnsName" in newProps && newProps.ipnsName) {
            this.ipnsName = newProps.ipnsName;
            this.ipnsPubsubTopic = ipnsNameToIpnsOverPubsubTopic(this.ipnsName);
            this.ipnsPubsubTopicRoutingCid = pubsubTopicToDhtKey(this.ipnsPubsubTopic);
        } else if (anchorFromClaimOrHops) {
            this.ipnsName = anchorFromClaimOrHops;
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
        // A clone of an already-resolved instance carries the field explicitly; otherwise it is derived
        // from the published record in initCommunityIpfsPropsNoMerge, which is the only authority for
        // it. There is no fallback to the address: a record without pubsubTopic has its challenge
        // exchange disabled (issue #229), so there are no challenge-topic peers to look up.
        if (!this.pubsubTopicRoutingCid && "pubsubTopicRoutingCid" in newProps) this.pubsubTopicRoutingCid = newProps.pubsubTopicRoutingCid;
    }

    initRemoteCommunityPropsNoMerge(newProps: CommunityJson | CreateRemoteCommunityOptions | CommunityIpfsType) {
        // This function is not strict, and will assume all props can be undefined, except address
        // Carry over the resolved IPNS delegation chain when the source provides it (e.g.
        // createCommunity(loadedCommunity) clones an already-resolved instance). ipnsHops cannot be
        // re-derived from the address, so copy it before deriving identity below — this keeps the
        // clone anchored to ipnsHops[0] and lets runtime fields round-trip. A CommunityIpfs record
        // never carries ipnsHops, so this is a no-op for the normal resolution/RPC-update paths.
        // See docs/protocol/delegated-ipns.md.
        const incomingIpnsHops = (newProps as { ipnsHops?: unknown }).ipnsHops;
        if (Array.isArray(incomingIpnsHops) && incomingIpnsHops.length > 0) this._ipnsHops = incomingIpnsHops as string[];
        // The record's signed anchor claim (#257). Assigned before the identity derivation below,
        // which prefers it over ipnsHops[0]. A full record without the claim clears it — the record
        // is the authority, and a stale claim surviving a non-delegated record would fabricate an
        // identity — while clone/options sources simply carry it when they have it.
        if ("anchor" in newProps) this.anchor = newProps.anchor;
        else if (newProps.signature) this.anchor = undefined;
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
        // community.publicKey is the ANCHOR IPNS name (the user-facing identity). For a delegated
        // community the content is signed by the terminal (minter) key, so we must NOT derive
        // publicKey from signature.publicKey — that would expose the minter as the identity. The
        // record's signed anchor claim is the strongest source (#257): it recovers the identity even
        // when the record was reached by addressing the minter directly, where ipnsHops[0] IS the
        // minter. ipnsHops[0] is the fallback when the chain was resolved but the record carries no
        // claim (non-delegated). See docs/protocol/delegated-ipns.md.
        const explicitPublicKey = "publicKey" in newProps ? (newProps.publicKey as string) : undefined;
        const anchorFromClaim = this.anchor?.publicKey; // assigned above from newProps
        const anchorFromHops = this.ipnsHops?.[0];
        if (anchorFromClaim) {
            this.publicKey = anchorFromClaim;
        } else if (anchorFromHops) {
            this.publicKey = anchorFromHops;
        } else if (newProps.signature?.publicKey) {
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
        // A migration invalidates any anchor claim along with the record that carried it (#257); the
        // new key's record is the only authority for whether the migrated-to community is delegated.
        this.anchor = undefined;
        // Clear all display fields via initRemoteCommunityPropsNoMerge with empty props.
        // Address immutability in initRemoteCommunityPropsNoMerge ensures address won't change.
        this.initRemoteCommunityPropsNoMerge({} as CreateRemoteCommunityOptions);
        // initRemoteCommunityPropsNoMerge clears pubsubTopic, but the routing CID is only re-derived from
        // a full record in initCommunityIpfsPropsNoMerge, which this path does not reach. Clear it here so
        // the invariant holds on every path: no routing CID outlives the topic it was derived from, or a
        // reader keeps looking up peers of the old key's challenge topic until the next record lands.
        this.pubsubTopicRoutingCid = undefined;

        // Update to new key and IPNS routing props
        this.publicKey = newPublicKey;
        this.ipnsName = newPublicKey;
        this.ipnsPubsubTopic = ipnsNameToIpnsOverPubsubTopic(newPublicKey);
        this.ipnsPubsubTopicRoutingCid = pubsubTopicToDhtKey(this.ipnsPubsubTopic);
        this._assertHasIdentity();
    }

    // Explicit return type: remeda v2's pick infers a PickFromArray<this, ...> branded type that
    // references non-exported remeda symbols, which tsc cannot serialize into the .d.ts. This is
    // the CommunityIpfs record without the paginated posts/modQueue fields.
    _toJSONIpfsBaseNoPosts(): Omit<CommunityIpfsType, "posts" | "modQueue"> {
        const communityIpfsKeys = keys(omit(CommunityIpfsSchema.shape, ["posts", "modQueue"]));
        return pick(this, communityIpfsKeys) as unknown as Omit<CommunityIpfsType, "posts" | "modQueue">;
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
                nameResolved: this.nameResolved,
                ipnsHops: this.ipnsHops
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

    protected _getIpnsHops(): string[] | undefined {
        return this._updatingCommunityInstanceWithListeners?.community.ipnsHops ?? this._ipnsHops;
    }

    protected _setIpnsHops(value: string[] | undefined) {
        this._ipnsHops = value;
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

    _setStartedStateWithEmission(newState: CommunityStartedState) {
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
            err.code === "ERR_NO_RESOLVER_FOR_NAME" ||
            // Delegated-IPNS chain failures are definitive (forged/invalid chain or unsupported value),
            // not transient. See docs/protocol/delegated-ipns.md.
            err.code === "ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID" ||
            err.code === "ERR_IPNS_MAX_HOPS_EXCEEDED" ||
            err.code === "ERR_RESOLVED_IPNS_TO_UNSUPPORTED_VALUE" ||
            // A record claiming an anchor that does not delegate to it is forged, not transient: the
            // claimed anchor resolved fine and simply does not endorse this minter (#261).
            err.code === "ERR_COMMUNITY_RECORD_ANCHOR_CLAIM_IS_NOT_ENDORSED"
        )
            return false;

        if (err instanceof FailedToFetchCommunityFromGatewaysError) {
            // If all gateway errors are non retriable, then the error is non retriable
            for (const gatewayError of Object.values(err.details.gatewayToError)) {
                // Invalid signature from a gateway is retriable (transient gateway issue, e.g. stale IPNS cache)
                if (gatewayError instanceof PKCError && gatewayError.code === "ERR_COMMUNITY_SIGNATURE_IS_INVALID") return true;
                if (this._isRetriableErrorWhenLoading(gatewayError)) return true;
            }
            return false; // if all gateways are non retriable, then we should not retry
        }
        return true;
    }

    _setCommunityIpfsPropsFromUpdatingCommunitiesIfPossible() {
        const log = Logger("pkc-js:remote-community:_setCommunityIpfsPropsFromUpdatingCommunitiesIfPossible");
        const updatingCommunity = findUpdatingCommunity(this._pkc, { publicKey: this.publicKey, name: this.name });
        if (updatingCommunity?.raw?.communityIpfs && (this.updatedAt || 0) < updatingCommunity.raw.communityIpfs.updatedAt) {
            // The caller asked for a specific publicKey and the tracked instance holds a record keyed
            // to a different one (its anchor for delegated communities — never signature.publicKey,
            // whose minter key legitimately differs): the community key-migrated before this caller
            // joined. Don't adopt the record silently — that would hand the caller a record for a key
            // they never requested with no migration signal (issue #197, the publickey-fallback and
            // update.community CI failures). Record the fact and let update() announce it the same
            // way the first loader's background resolution does, then mirror-replay the record.
            if (this.publicKey && updatingCommunity.publicKey && this.publicKey !== updatingCommunity.publicKey) {
                this._pendingWarmStartKeyMigration = { previousPublicKey: this.publicKey, newPublicKey: updatingCommunity.publicKey };
                log.trace(
                    `New Remote Community instance`,
                    this.address,
                    `skipped warm start from pkc._updatingCommunities[${this.address}]: tracked instance is keyed to`,
                    updatingCommunity.publicKey,
                    `while the caller requested`,
                    this.publicKey,
                    `- deferring key-migration announcement to update()`
                );
                return;
            }
            const nameResolvedBeforeAdoption = this.nameResolved;
            this.initCommunityIpfsPropsNoMerge(updatingCommunity.raw.communityIpfs);
            this.updateCid = updatingCommunity.updateCid;
            // Same guard as the mirror's update handler: adopt the tracked instance's nameResolved
            // only when its name describes us (#119). Without this a warm-started instance reports
            // nameResolved undefined while a cold-started sibling of the same community reports true.
            this._adoptMirroredNameResolved(updatingCommunity, nameResolvedBeforeAdoption);
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

    // nameResolved reflects whether THIS community's own name resolved to its publicKey. When we mirror an
    // updating instance that we share only by publicKey — e.g. a community loaded by a raw IPNS key sharing a
    // key with a resolved-domain sibling (migrating.bso), or two different domains that resolve to the same
    // key — the sibling's nameResolved does NOT describe us. Adopt it only when the names match; otherwise
    // restore the value we had before mirroring, undoing anything deepMergeRuntimeFields copied in. See #119.
    protected _adoptMirroredNameResolved(source: { name?: string; nameResolved?: boolean }, nameResolvedBeforeMirror: boolean | undefined) {
        if (this.name === source.name) {
            if (typeof source.nameResolved === "boolean") this.nameResolved = source.nameResolved;
        } else this.nameResolved = nameResolvedBeforeMirror;
    }

    private async _initCommunityInstanceWithListeners(communityInstance: RemoteCommunity) {
        const log = Logger("pkc-js:remote-community:update");
        return <NonNullable<this["_updatingCommunityInstanceWithListeners"]>>{
            community: communityInstance,
            update: () => {
                const nameResolvedBeforeMirror = this.nameResolved;
                if (!communityInstance.raw.communityIpfs || !communityInstance.updateCid) {
                    if (communityInstance.publicKey) this._clearDataForKeyMigration(communityInstance.publicKey);
                } else {
                    this.initCommunityIpfsPropsNoMerge(communityInstance.raw.communityIpfs);
                    this.updateCid = communityInstance.updateCid;
                }
                this._adoptMirroredNameResolved(communityInstance, nameResolvedBeforeMirror);
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

    // Resolves to true when the attach-time replay below emitted an "update" for the record it
    // applied, so update() can avoid emitting a duplicate for the same record.
    private async fetchLatestCommunityOrSubscribeToEvent(): Promise<boolean> {
        const log = Logger("pkc-js:remote-community:update:updateOnce");

        // The instance flows from a single find-or-create: after a key migration this instance's
        // {publicKey, name} are the post-migration values while the fresh updating instance is
        // tracked under the pre-migration address, so a second alias lookup here used to come up
        // empty and throw "should be defined at this stage" even though the instance was tracked —
        // which is how the RPC server's setSettings handler orphaned migrated subscriptions (#197).
        let communityInstance = findUpdatingCommunity(this._pkc, { publicKey: this.publicKey, name: this.name });
        if (!communityInstance) {
            // Pass publicKey alongside name/address so the updating community can use publicKey fallback.
            // createOpts is deliberately keyed by the (immutable, possibly pre-migration) address: the
            // re-created updating instance re-resolves and re-announces a migration exactly like a
            // fresh subscribe would.
            const createOpts =
                this.publicKey && isStringDomain(this.address)
                    ? { name: this.address, publicKey: this.publicKey }
                    : { address: this.address };
            const updatingCommunity = await this._pkc.createCommunity(createOpts);
            communityInstance = trackUpdatingCommunity(this._pkc, updatingCommunity);
            log("Creating a new entry for this._pkc._updatingCommunities", this.address);
        }
        if (communityInstance === this) {
            // Already tracking this instance; start the loop directly without mirroring to itself
            this._clientsManager.startUpdatingLoop().catch((err) => log.error("Failed to start update loop of community", err));
            return false;
        }

        // The awaits above are a window for a concurrent stop() to untrack the instance. Attaching
        // mirrors to an untracked instance would strand this community on a dying entry, so assert
        // the update loop's real precondition — membership of this exact instance — by identity,
        // which a key rotation cannot spuriously trip the way the old alias lookups could.
        if (!this._pkc._updatingCommunities.has(communityInstance))
            throw Error(`Updating community instance (${communityInstance.address}) was untracked before listeners could be attached`);

        this._updatingCommunityInstanceWithListeners = await this._initCommunityInstanceWithListeners(<RemoteCommunity>communityInstance);
        this._updatingCommunityInstanceWithListeners.community.on("update", this._updatingCommunityInstanceWithListeners.update);

        this._updatingCommunityInstanceWithListeners.community.on(
            "updatingstatechange",
            this._updatingCommunityInstanceWithListeners.updatingstatechange
        );
        this._updatingCommunityInstanceWithListeners.community.on("error", this._updatingCommunityInstanceWithListeners.error);
        this._updatingCommunityInstanceWithListeners.community.on("statechange", this._updatingCommunityInstanceWithListeners.statechange);

        const clientKeys = keys(this.clients);
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

        // Replay the updating instance's current record through the mirror's own update handler.
        // Listener attach alone has a gap: an instance that already holds a newer record than ours
        // (e.g. it settled a key migration before we joined, #197) emits nothing until its NEXT
        // record lands, which for a quiet community could be arbitrarily far away. The updatedAt
        // guard makes this a no-op when we warm-started from the same record at construction.
        if (
            communityInstance.raw.communityIpfs &&
            (this.updatedAt ?? 0) < communityInstance.raw.communityIpfs.updatedAt &&
            this._updatingCommunityInstanceWithListeners
        ) {
            this._updatingCommunityInstanceWithListeners.update(<RemoteCommunity>communityInstance);
            return true; // the replay emitted "update"; update() must not emit again for the same record
        }
        return false;
    }

    // A construction-time warm start that found the tracked instance migrated to a different key
    // (issue #197) deferred its announcement to here, the first point where the caller's listeners
    // are attached. Replays the exact observable sequence the first loader's background resolution
    // produces (community-client-manager's _resolveNameInBackground): cleared update, then the
    // migration error. The migrated record itself follows via the attach-time replay in
    // fetchLatestCommunityOrSubscribeToEvent.
    private _announcePendingWarmStartKeyMigrationIfAny() {
        if (!this._pendingWarmStartKeyMigration) return;
        const { previousPublicKey, newPublicKey } = this._pendingWarmStartKeyMigration;
        this._pendingWarmStartKeyMigration = undefined;
        const error = new PKCError("ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY", {
            communityName: this.name,
            previousPublicKey,
            newPublicKey
        });
        this._clearDataForKeyMigration(newPublicKey);
        // The migration was established by resolving this very name (on the tracked instance's own
        // loop), so the name is known to resolve — same as the first loader's flow. A nameless
        // (key-addressed) joiner has no name to describe, so nameResolved stays undefined for it.
        if (this.name) this.nameResolved = true;
        this.emit("update", this);
        this.emit("error", error);
    }

    async update() {
        if (this.state !== "stopped") return; // No need to do anything if community is already updating

        const log = Logger("pkc-js:remote-community:update");

        this._setState("updating");

        this._announcePendingWarmStartKeyMigrationIfAny();
        // Only the construction-time warm start emits here. The attach-time replay reports whether
        // it already emitted for a record it applied (e.g. the tracked instance advanced past the
        // record we warm-started with), and on the cold path the record lands asynchronously after
        // this returns.
        const hadRecordBeforeFetch = Boolean(this.raw.communityIpfs);
        const replayEmittedUpdate = await this.fetchLatestCommunityOrSubscribeToEvent();
        if (this.raw.communityIpfs && hadRecordBeforeFetch && !replayEmittedUpdate) this.emit("update", this);
    }

    private async _cleanUpUpdatingCommunityInstanceWithListeners() {
        if (!this._updatingCommunityInstanceWithListeners) throw Error("should be defined at this stage");

        const log = Logger("pkc-js:remote-community:stop:cleanUpUpdatingCommunityInstanceWithListeners");
        const updatingCommunity = this._updatingCommunityInstanceWithListeners.community;
        if (typeof updatingCommunity.ipnsName === "string") this._ipnsName = updatingCommunity.ipnsName;
        if (Array.isArray(updatingCommunity.ipnsHops)) this._ipnsHops = updatingCommunity.ipnsHops;
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

        const clientKeys = keys(this.clients);

        for (const clientType of clientKeys)
            if (this.clients[clientType])
                for (const clientUrl of Object.keys(this.clients[clientType])) this.clients[clientType][clientUrl].unmirror();

        this._updatingCommunityInstanceWithListeners.community._numOfListenersForUpdatingInstance--;
        if (
            this._updatingCommunityInstanceWithListeners.community._numOfListenersForUpdatingInstance === 0 &&
            this._updatingCommunityInstanceWithListeners.community.state !== "stopped"
        ) {
            log("Cleaning up pkc._updatingCommunities", this.address, "There are no communities using it for updates");
            // Untrack before stop() to prevent findUpdatingCommunity from returning a dying entry
            // during the async stop window
            untrackUpdatingCommunity(this._pkc, this._updatingCommunityInstanceWithListeners.community);
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

    // Community export (issue #79). Overridden by LocalCommunity and the RPC variants.
    // The base implementation rejects because a read-only RemoteCommunity has no DB to back up.
    get exports(): CommunityExportRecord[] {
        return [];
    }

    async export(options?: ExportCommunityUserOptions): Promise<{ exportId: string }> {
        throw new PKCError("ERR_COMMUNITY_NOT_LOCAL", { address: this.address });
    }

    // Read the community moderation log (commentModeration records). Overridden by LocalCommunity
    // (direct DB read) and RpcLocalCommunity (RPC call). The base rejects because a read-only
    // RemoteCommunity has no community DB to read mod logs from.
    async exportCommunityModLogs(opts?: ExportCommunityModLogsOptions): Promise<{ moderations: CommentModerationTableRow[] }> {
        throw new PKCError("ERR_COMMUNITY_NOT_LOCAL", { address: this.address });
    }
}

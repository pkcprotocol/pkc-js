import { PKCClientsManager } from "../pkc/pkc-client-manager.js";
import { PKCError } from "../pkc-error.js";
import { RemoteCommunity } from "../community/remote-community.js";
import { NameResolverClient } from "../clients/name-resolver-client.js";
import Publication from "./publication.js";
import * as remeda from "remeda";
import {
    PublicationIpfsGatewayClient,
    PublicationKuboPubsubClient,
    PublicationKuboRpcClient,
    PublicationLibp2pJsClient,
    PublicationPKCRpcStateClient
} from "./publication-clients.js";
import { CommentIpfsGatewayClient, CommentKuboRpcClient } from "./comment/comment-clients.js";
import type { CommunityEvents, CommunityIpfsType } from "../community/types.js";
import { waitForUpdateInCommunityInstanceWithErrorAndTimeout } from "../util.js";
import { findStartedCommunity, findUpdatingCommunity, untrackUpdatingCommunity } from "../pkc/tracked-instance-registry-util.js";

export class PublicationClientsManager extends PKCClientsManager {
    override clients!: {
        ipfsGateways: { [ipfsGatewayUrl: string]: PublicationIpfsGatewayClient | CommentIpfsGatewayClient };
        kuboRpcClients: { [kuboRpcUrl: string]: PublicationKuboRpcClient | CommentKuboRpcClient };
        pubsubKuboRpcClients: { [kuboRpcUrl: string]: PublicationKuboPubsubClient };
        pkcRpcClients: Record<string, PublicationPKCRpcStateClient>;
        libp2pJsClients: { [libp2pJsUrl: string]: PublicationLibp2pJsClient };
        nameResolvers: { [resolverKey: string]: NameResolverClient };
    };
    _publication: Publication;
    _communityForUpdating?: {
        community: RemoteCommunity;
        ipfsGatewayListeners?: Record<string, Parameters<RemoteCommunity["clients"]["ipfsGateways"][string]["on"]>[1]>;
        kuboRpcListeners?: Record<string, Parameters<RemoteCommunity["clients"]["kuboRpcClients"][string]["on"]>[1]>;
        libp2pJsListeners?: Record<string, Parameters<RemoteCommunity["clients"]["libp2pJsClients"][string]["on"]>[1]>;
        nameResolverListeners?: Record<string, Parameters<RemoteCommunity["clients"]["nameResolvers"][string]["on"]>[1]>;
    } & Pick<CommunityEvents, "updatingstatechange" | "update" | "error"> = undefined;

    constructor(publication: Publication) {
        super(publication._pkc);
        this._publication = publication;
        this._initPKCRpcClients();
        this.handleErrorEventFromCommunity = this.handleErrorEventFromCommunity.bind(this);
        this.handleIpfsGatewayCommunityState = this.handleIpfsGatewayCommunityState.bind(this);
        this.handleUpdateEventFromCommunity = this.handleUpdateEventFromCommunity.bind(this);
        this.handleUpdatingStateChangeEventFromCommunity = this.handleUpdatingStateChangeEventFromCommunity.bind(this);
    }

    protected override _initKuboRpcClients(): void {
        if (this._pkc.clients.kuboRpcClients)
            for (const ipfsUrl of remeda.keys.strict(this._pkc.clients.kuboRpcClients))
                this.clients.kuboRpcClients = { ...this.clients.kuboRpcClients, [ipfsUrl]: new PublicationKuboRpcClient("stopped") };
    }

    protected override _initPubsubKuboRpcClients(): void {
        for (const pubsubUrl of remeda.keys.strict(this._pkc.clients.pubsubKuboRpcClients))
            this.clients.pubsubKuboRpcClients = {
                ...this.clients.pubsubKuboRpcClients,
                [pubsubUrl]: new PublicationKuboPubsubClient("stopped")
            };
    }

    protected _initPKCRpcClients() {
        for (const rpcUrl of remeda.keys.strict(this._pkc.clients.pkcRpcClients))
            this.clients.pkcRpcClients = {
                ...this.clients.pkcRpcClients,
                [rpcUrl]: new PublicationPKCRpcStateClient("stopped")
            };
    }

    override emitError(e: PKCError): void {
        this._publication.emit("error", e);
    }

    override updateKuboRpcState(newState: PublicationKuboRpcClient["state"] | CommentKuboRpcClient["state"], kuboRpcClientUrl: string) {
        super.updateKuboRpcState(newState, kuboRpcClientUrl);
    }

    override updateKuboRpcPubsubState(newState: PublicationKuboPubsubClient["state"], pubsubProvider: string) {
        super.updateKuboRpcPubsubState(newState, pubsubProvider);
    }

    override updateGatewayState(
        newState: PublicationIpfsGatewayClient["state"] | CommentIpfsGatewayClient["state"],
        gateway: string
    ): void {
        super.updateGatewayState(newState, gateway);
    }

    _translateCommunityUpdatingStateToPublishingState(newUpdatingState: RemoteCommunity["updatingState"]) {
        const mapper: Partial<Record<typeof newUpdatingState, Publication["publishingState"]>> = {
            failed: "failed",
            "fetching-ipfs": "fetching-community-ipfs",
            "fetching-ipns": "fetching-community-ipns",
            "resolving-name": "resolving-community-name"
        };
        const translatedState = mapper[newUpdatingState];
        if (translatedState) this._publication._updatePublishingStateWithEmission(translatedState);
    }

    handleUpdatingStateChangeEventFromCommunity(newUpdatingState: RemoteCommunity["updatingState"]) {
        // will be overridden in comment-client-manager to provide a specific states relevant to post updating
        // below is for handling translation to publishingState
        this._translateCommunityUpdatingStateToPublishingState(newUpdatingState);
    }
    handleUpdateEventFromCommunity(community: RemoteCommunity) {
        // a new update has been emitted by community
        // should be handled in comment-client-manager
    }

    handleErrorEventFromCommunity(err: PKCError | Error) {}

    handleIpfsGatewayCommunityState(
        communityNewGatewayState: RemoteCommunity["clients"]["ipfsGateways"][string]["state"],
        gatewayUrl: string
    ) {
        this.updateGatewayState(
            communityNewGatewayState === "fetching-ipns" ? "fetching-community-ipns" : communityNewGatewayState,
            gatewayUrl
        );
    }

    handleNameResolverCommunityState(
        communityNewResolverState: RemoteCommunity["clients"]["nameResolvers"][string]["state"],
        resolverKey: string
    ) {
        // Don't forward page-author resolution states from the community — only community-name resolution is relevant
        if (communityNewResolverState === "resolving-author-name") return;
        this.updateNameResolverState(communityNewResolverState, resolverKey);
    }

    handleKuboRpcCommunityState(
        communityNewKuboRpcState: RemoteCommunity["clients"]["kuboRpcClients"][string]["state"],
        kuboRpcUrl: string
    ) {
        const stateMapper: Record<typeof communityNewKuboRpcState, PublicationKuboRpcClient["state"] | undefined> = {
            "fetching-ipns": "fetching-community-ipns",
            "fetching-ipfs": "fetching-community-ipfs",
            stopped: "stopped",
            "publishing-ipns": undefined
        };

        const translatedState = stateMapper[communityNewKuboRpcState];
        if (translatedState) this.updateKuboRpcState(translatedState, kuboRpcUrl);
    }

    handleLibp2pJsClientCommunityState(
        communityNewLibp2pJsState: RemoteCommunity["clients"]["libp2pJsClients"][string]["state"],
        libp2pJsClientKey: string
    ) {
        const stateMapper: Record<typeof communityNewLibp2pJsState, PublicationLibp2pJsClient["state"] | undefined> = {
            "fetching-ipns": "fetching-community-ipns",
            "fetching-ipfs": "fetching-community-ipfs",
            stopped: "stopped",
            "publishing-ipns": undefined,
            "waiting-challenge-answers": undefined,
            "waiting-challenge-requests": undefined,
            "publishing-challenge": undefined,
            "publishing-challenge-verification": undefined
        };

        const translatedState = stateMapper[communityNewLibp2pJsState];
        if (translatedState) this.updateLibp2pJsClientState(translatedState, libp2pJsClientKey);
    }

    async _createCommunityInstanceWithStateTranslation() {
        // basically in Publication or comment we need to be fetching the community record
        // this function will be for translating between the states of the community and its clients to publication/comment states
        const directCommunityInstance =
            findUpdatingCommunity(this._pkc, { publicKey: this._publication.communityPublicKey, name: this._publication.communityName }) ||
            findStartedCommunity(this._pkc, { publicKey: this._publication.communityPublicKey, name: this._publication.communityName });
        const community =
            directCommunityInstance ||
            (await this._pkc.createCommunity({
                name: this._publication.communityName,
                publicKey: this._publication.communityPublicKey
            }));

        this._communityForUpdating = {
            community: community,
            error: this.handleErrorEventFromCommunity.bind(this),
            update: this.handleUpdateEventFromCommunity.bind(this),
            updatingstatechange: this.handleUpdatingStateChangeEventFromCommunity.bind(this)
        };

        if (
            this._communityForUpdating.community.clients.ipfsGateways &&
            Object.keys(this._communityForUpdating.community.clients.ipfsGateways).length > 0
        ) {
            // we're using gateways
            const ipfsGatewayListeners: (typeof this._communityForUpdating)["ipfsGatewayListeners"] = {};

            for (const gatewayUrl of Object.keys(this._communityForUpdating.community.clients.ipfsGateways)) {
                const ipfsStateListener = (communityNewIpfsState: RemoteCommunity["clients"]["ipfsGateways"][string]["state"]) =>
                    this.handleIpfsGatewayCommunityState(communityNewIpfsState, gatewayUrl);

                this._communityForUpdating.community.clients.ipfsGateways[gatewayUrl].on("statechange", ipfsStateListener);
                ipfsGatewayListeners[gatewayUrl] = ipfsStateListener;
            }
            this._communityForUpdating.ipfsGatewayListeners = ipfsGatewayListeners;
        }

        // Add Kubo RPC client state listeners
        if (
            this._communityForUpdating.community.clients.kuboRpcClients &&
            Object.keys(this._communityForUpdating.community.clients.kuboRpcClients).length > 0
        ) {
            const kuboRpcListeners: Record<string, Parameters<RemoteCommunity["clients"]["kuboRpcClients"][string]["on"]>[1]> = {};

            for (const kuboRpcUrl of Object.keys(this._communityForUpdating.community.clients.kuboRpcClients)) {
                const kuboRpcStateListener = (communityNewKuboRpcState: RemoteCommunity["clients"]["kuboRpcClients"][string]["state"]) =>
                    this.handleKuboRpcCommunityState(communityNewKuboRpcState, kuboRpcUrl);

                this._communityForUpdating.community.clients.kuboRpcClients[kuboRpcUrl].on("statechange", kuboRpcStateListener);
                kuboRpcListeners[kuboRpcUrl] = kuboRpcStateListener;
            }
            this._communityForUpdating.kuboRpcListeners = kuboRpcListeners;
        }

        // add libp2pJs client state listeners
        if (
            this._communityForUpdating.community.clients.libp2pJsClients &&
            Object.keys(this._communityForUpdating.community.clients.libp2pJsClients).length > 0
        ) {
            const libp2pJsListeners: Record<string, Parameters<RemoteCommunity["clients"]["libp2pJsClients"][string]["on"]>[1]> = {};

            for (const libp2pJsClientKey of Object.keys(this._communityForUpdating.community.clients.libp2pJsClients)) {
                const libp2pJsClientStateListener = (
                    communityNewLibp2pJsState: RemoteCommunity["clients"]["libp2pJsClients"][string]["state"]
                ) => this.handleLibp2pJsClientCommunityState(communityNewLibp2pJsState, libp2pJsClientKey);

                this._communityForUpdating.community.clients.libp2pJsClients[libp2pJsClientKey].on(
                    "statechange",
                    libp2pJsClientStateListener
                );
                libp2pJsListeners[libp2pJsClientKey] = libp2pJsClientStateListener;
            }
            this._communityForUpdating.libp2pJsListeners = libp2pJsListeners;
        }

        // Add name resolver state listeners
        if (
            this._communityForUpdating.community.clients.nameResolvers &&
            Object.keys(this._communityForUpdating.community.clients.nameResolvers).length > 0
        ) {
            const nameResolverListeners: Record<string, Parameters<RemoteCommunity["clients"]["nameResolvers"][string]["on"]>[1]> = {};

            for (const resolverKey of Object.keys(this._communityForUpdating.community.clients.nameResolvers)) {
                const resolverStateListener = (communityNewResolverState: RemoteCommunity["clients"]["nameResolvers"][string]["state"]) =>
                    this.handleNameResolverCommunityState(communityNewResolverState, resolverKey);

                this._communityForUpdating.community.clients.nameResolvers[resolverKey].on("statechange", resolverStateListener);
                nameResolverListeners[resolverKey] = resolverStateListener;
            }
            this._communityForUpdating.nameResolverListeners = nameResolverListeners;
        }

        this._communityForUpdating.community.on("update", this._communityForUpdating.update);

        this._communityForUpdating.community.on("updatingstatechange", this._communityForUpdating.updatingstatechange);

        this._communityForUpdating.community.on("error", this._communityForUpdating.error);

        if (directCommunityInstance) {
            directCommunityInstance._numOfListenersForUpdatingInstance++;
        }
        return this._communityForUpdating!;
    }

    async cleanUpUpdatingCommunityInstance() {
        if (!this._communityForUpdating) throw Error("Need to define communityForUpdating first");

        // Clean up IPFS Gateway listeners
        if (this._communityForUpdating.ipfsGatewayListeners) {
            for (const gatewayUrl of Object.keys(this._communityForUpdating.ipfsGatewayListeners)) {
                this._communityForUpdating.community.clients.ipfsGateways[gatewayUrl].removeListener(
                    "statechange",
                    this._communityForUpdating.ipfsGatewayListeners[gatewayUrl]
                );
                this.updateGatewayState("stopped", gatewayUrl); // need to reset all gateway states
            }
        }

        // Clean up Kubo RPC listeners
        if (this._communityForUpdating.kuboRpcListeners) {
            for (const kuboRpcUrl of Object.keys(this._communityForUpdating.kuboRpcListeners)) {
                this._communityForUpdating.community.clients.kuboRpcClients[kuboRpcUrl].removeListener(
                    "statechange",
                    this._communityForUpdating.kuboRpcListeners[kuboRpcUrl]
                );
                this.updateKuboRpcState("stopped", kuboRpcUrl); // need to reset all Kubo RPC states
            }
        }

        // clean up libp2pJs listeners
        if (this._communityForUpdating.libp2pJsListeners) {
            for (const libp2pJsClientKey of Object.keys(this._communityForUpdating.libp2pJsListeners)) {
                this._communityForUpdating.community.clients.libp2pJsClients[libp2pJsClientKey].removeListener(
                    "statechange",
                    this._communityForUpdating.libp2pJsListeners[libp2pJsClientKey]
                );
                this.updateLibp2pJsClientState("stopped", libp2pJsClientKey); // need to reset all libp2pJs states
            }
        }

        // Clean up name resolver listeners
        if (this._communityForUpdating.nameResolverListeners) {
            for (const resolverKey of Object.keys(this._communityForUpdating.nameResolverListeners)) {
                this._communityForUpdating.community.clients.nameResolvers[resolverKey].removeListener(
                    "statechange",
                    this._communityForUpdating.nameResolverListeners[resolverKey]
                );
                this.updateNameResolverState("stopped", resolverKey); // need to reset all name resolver states
            }
        }

        // Remove update event at the end
        this._communityForUpdating.community.removeListener("updatingstatechange", this._communityForUpdating.updatingstatechange);
        this._communityForUpdating.community.removeListener("error", this._communityForUpdating.error);
        this._communityForUpdating.community.removeListener("update", this._communityForUpdating.update);

        if (this._communityForUpdating.community._updatingCommunityInstanceWithListeners)
            // should only stop when _communityForUpdating is not pkc._updatingCommunities
            await this._communityForUpdating.community.stop();
        else {
            // _communityForUpdating is actually pkc._updatingCommunities or pkc._startedCommunities
            this._communityForUpdating.community._numOfListenersForUpdatingInstance--;
            if (
                this._communityForUpdating.community._numOfListenersForUpdatingInstance <= 0 &&
                this._communityForUpdating.community.state === "updating"
            ) {
                // Untrack before stop() to prevent findUpdatingCommunity from returning a dying entry
                // during the async stop window
                untrackUpdatingCommunity(this._pkc, this._communityForUpdating.community);
                await this._communityForUpdating.community.stop();
            }
        }
        this._communityForUpdating = undefined;
    }

    async fetchCommunityForPublishingWithCacheGuard(): Promise<NonNullable<Publication["_community"]>> {
        return this._loadCommunityForPublishingFromNetwork();
    }

    private async _loadCommunityForPublishingFromNetwork(): Promise<NonNullable<Publication["_community"]>> {
        const updatingCommunityInstance = await this._createCommunityInstanceWithStateTranslation();
        let communityIpfs: CommunityIpfsType;
        if (!updatingCommunityInstance.community.raw.communityIpfs) {
            const timeoutMs = this._pkc._timeouts["community-ipns"];
            try {
                await waitForUpdateInCommunityInstanceWithErrorAndTimeout(updatingCommunityInstance.community, timeoutMs);
                communityIpfs = updatingCommunityInstance.community.raw.communityIpfs!;
            } catch (e) {
                await this.cleanUpUpdatingCommunityInstance();
                throw e;
            }
            await this.cleanUpUpdatingCommunityInstance();
        } else {
            communityIpfs = updatingCommunityInstance.community.raw.communityIpfs!;
            await this.cleanUpUpdatingCommunityInstance();
        }

        if (!communityIpfs)
            throw new PKCError("ERR_GET_COMMUNITY_TIMED_OUT", {
                communityAddress: updatingCommunityInstance.community.address,
                timeoutMs: this._pkc._timeouts["community-ipns"]
            });
        return {
            address: updatingCommunityInstance.community.address,
            publicKey: updatingCommunityInstance.community.publicKey!,
            name: updatingCommunityInstance.community.name,
            encryption: communityIpfs.encryption,
            pubsubTopic: communityIpfs.pubsubTopic
        };
    }
}

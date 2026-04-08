import { PKCClientsManager } from "../pkc/pkc-client-manager.js";
import { PKCError } from "../pkc-error.js";
import { RemoteCommunity } from "../community/remote-community.js";
import { NameResolverClient } from "../clients/name-resolver-client.js";
import Publication from "./publication.js";
import { PublicationIpfsGatewayClient, PublicationKuboPubsubClient, PublicationKuboRpcClient, PublicationLibp2pJsClient, PublicationPKCRpcStateClient } from "./publication-clients.js";
import { CommentIpfsGatewayClient, CommentKuboRpcClient } from "./comment/comment-clients.js";
import type { CommunityEvents } from "../community/types.js";
export declare class PublicationClientsManager extends PKCClientsManager {
    clients: {
        ipfsGateways: {
            [ipfsGatewayUrl: string]: PublicationIpfsGatewayClient | CommentIpfsGatewayClient;
        };
        kuboRpcClients: {
            [kuboRpcUrl: string]: PublicationKuboRpcClient | CommentKuboRpcClient;
        };
        pubsubKuboRpcClients: {
            [kuboRpcUrl: string]: PublicationKuboPubsubClient;
        };
        pkcRpcClients: Record<string, PublicationPKCRpcStateClient>;
        libp2pJsClients: {
            [libp2pJsUrl: string]: PublicationLibp2pJsClient;
        };
        nameResolvers: {
            [resolverKey: string]: NameResolverClient;
        };
    };
    _publication: Publication;
    _communityForUpdating?: {
        community: RemoteCommunity;
        ipfsGatewayListeners?: Record<string, Parameters<RemoteCommunity["clients"]["ipfsGateways"][string]["on"]>[1]>;
        kuboRpcListeners?: Record<string, Parameters<RemoteCommunity["clients"]["kuboRpcClients"][string]["on"]>[1]>;
        libp2pJsListeners?: Record<string, Parameters<RemoteCommunity["clients"]["libp2pJsClients"][string]["on"]>[1]>;
        nameResolverListeners?: Record<string, Parameters<RemoteCommunity["clients"]["nameResolvers"][string]["on"]>[1]>;
    } & Pick<CommunityEvents, "updatingstatechange" | "update" | "error">;
    constructor(publication: Publication);
    protected _initKuboRpcClients(): void;
    protected _initPubsubKuboRpcClients(): void;
    protected _initPKCRpcClients(): void;
    emitError(e: PKCError): void;
    updateKuboRpcState(newState: PublicationKuboRpcClient["state"] | CommentKuboRpcClient["state"], kuboRpcClientUrl: string): void;
    updateKuboRpcPubsubState(newState: PublicationKuboPubsubClient["state"], pubsubProvider: string): void;
    updateGatewayState(newState: PublicationIpfsGatewayClient["state"] | CommentIpfsGatewayClient["state"], gateway: string): void;
    _translateCommunityUpdatingStateToPublishingState(newUpdatingState: RemoteCommunity["updatingState"]): void;
    handleUpdatingStateChangeEventFromCommunity(newUpdatingState: RemoteCommunity["updatingState"]): void;
    handleUpdateEventFromCommunity(community: RemoteCommunity): void;
    handleErrorEventFromCommunity(err: PKCError | Error): void;
    handleIpfsGatewayCommunityState(communityNewGatewayState: RemoteCommunity["clients"]["ipfsGateways"][string]["state"], gatewayUrl: string): void;
    handleNameResolverCommunityState(communityNewResolverState: RemoteCommunity["clients"]["nameResolvers"][string]["state"], resolverKey: string): void;
    handleKuboRpcCommunityState(communityNewKuboRpcState: RemoteCommunity["clients"]["kuboRpcClients"][string]["state"], kuboRpcUrl: string): void;
    handleLibp2pJsClientCommunityState(communityNewLibp2pJsState: RemoteCommunity["clients"]["libp2pJsClients"][string]["state"], libp2pJsClientKey: string): void;
    _createCommunityInstanceWithStateTranslation(): Promise<{
        community: RemoteCommunity;
        ipfsGatewayListeners?: Record<string, Parameters<RemoteCommunity["clients"]["ipfsGateways"][string]["on"]>[1]>;
        kuboRpcListeners?: Record<string, Parameters<RemoteCommunity["clients"]["kuboRpcClients"][string]["on"]>[1]>;
        libp2pJsListeners?: Record<string, Parameters<RemoteCommunity["clients"]["libp2pJsClients"][string]["on"]>[1]>;
        nameResolverListeners?: Record<string, Parameters<RemoteCommunity["clients"]["nameResolvers"][string]["on"]>[1]>;
    } & Pick<CommunityEvents, "error" | "update" | "updatingstatechange">>;
    cleanUpUpdatingCommunityInstance(): Promise<void>;
    fetchCommunityForPublishingWithCacheGuard(): Promise<NonNullable<Publication["_community"]>>;
    private _loadCommunityForPublishingFromNetwork;
}

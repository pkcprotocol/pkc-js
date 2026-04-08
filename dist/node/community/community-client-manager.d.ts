import { RetryOperation } from "retry";
import { PreResolveNameResolverOptions, PostResolveNameResolverSuccessOptions } from "../clients/base-client-manager.js";
import { PKCClientsManager } from "../pkc/pkc-client-manager.js";
import { PKCError } from "../pkc-error.js";
import { ResultOfFetchingCommunity } from "../types.js";
import { NameResolverClient } from "../clients/name-resolver-client.js";
import { LimitedSet } from "../general-util/limited-set.js";
import { CommunityIpfsGatewayClient, CommunityKuboPubsubClient, CommunityKuboRpcClient, CommunityLibp2pJsClient, CommunityPKCRpcStateClient } from "./community-clients.js";
export declare const MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS: number;
export declare class CommunityClientsManager extends PKCClientsManager {
    clients: {
        ipfsGateways: {
            [ipfsGatewayUrl: string]: CommunityIpfsGatewayClient;
        };
        kuboRpcClients: {
            [kuboRpcClientUrl: string]: CommunityKuboRpcClient;
        };
        pubsubKuboRpcClients: {
            [pubsubClientUrl: string]: CommunityKuboPubsubClient;
        };
        pkcRpcClients: Record<string, CommunityPKCRpcStateClient>;
        libp2pJsClients: {
            [libp2pJsClientUrl: string]: CommunityLibp2pJsClient;
        };
        nameResolvers: {
            [resolverKey: string]: NameResolverClient;
        };
    };
    private _community;
    private _suppressUpdatingStateForNameResolution;
    _ipnsLoadingOperation?: RetryOperation;
    _updateCidsAlreadyLoaded: LimitedSet<string>;
    constructor(community: CommunityClientsManager["_community"]);
    protected _initKuboRpcClients(): void;
    protected _initPubsubKuboRpcClients(): void;
    protected _initLibp2pJsClients(): void;
    protected _initPKCRpcClients(): void;
    updateKuboRpcState(newState: CommunityKuboRpcClient["state"], kuboRpcClientUrl: string): void;
    updateKuboRpcPubsubState(newState: CommunityKuboPubsubClient["state"], pubsubProvider: string): void;
    updateGatewayState(newState: CommunityIpfsGatewayClient["state"], gateway: string): void;
    updateLibp2pJsClientState(newState: CommunityLibp2pJsClient["state"], libp2pJsClientUrl: string): void;
    emitError(e: PKCError): void;
    protected _getStatePriorToResolvingCommunityIpns(): "fetching-community-ipns" | "fetching-ipns";
    preResolveNameResolver(opts: PreResolveNameResolverOptions): void;
    postResolveNameResolverSuccess(opts: PostResolveNameResolverSuccessOptions): void;
    protected _getCommunityAddressFromInstance(): string;
    private _areEquivalentCommunityAddresses;
    private _deriveAddressFromWireRecord;
    private _retryLoadingCommunityAddress;
    updateOnce(): Promise<void>;
    startUpdatingLoop(): Promise<void>;
    stopUpdatingLoop(): Promise<void>;
    private _resolveCommunityNameWithoutUpdatingState;
    private _resolveNameInBackground;
    _resolvePageAuthorNamesInBackground(): void;
    fetchNewUpdateForCommunity(subAddress: string): Promise<ResultOfFetchingCommunity>;
    private _fetchCommunityIpnsP2PAndVerify;
    private _fetchCommunityFromGateways;
    private _findErrorInCommunityRecord;
}

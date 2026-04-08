import { PKC } from "./pkc.js";
import { NameResolverClient } from "../clients/name-resolver-client.js";
import { BaseClientsManager, OptionsToLoadFromGateway, PreResolveNameResolverOptions, PostResolveNameResolverSuccessOptions, PostResolveNameResolverFailureOptions } from "../clients/base-client-manager.js";
import { PKCIpfsGatewayClient, PKCKuboRpcClient, PKCLibp2pJsClient } from "./pkc-clients.js";
import { GenericStateClient } from "../generic-state-client.js";
export declare class PKCClientsManager extends BaseClientsManager {
    clients: {
        ipfsGateways: {
            [ipfsGatewayUrl: string]: PKCIpfsGatewayClient;
        };
        kuboRpcClients: {
            [kuboRpcClientUrl: string]: PKCKuboRpcClient;
        };
        pubsubKuboRpcClients: {
            [pubsubKuboClientUrl: string]: GenericStateClient<string>;
        };
        libp2pJsClients: {
            [libp2pJsClientKey: string]: PKCLibp2pJsClient;
        };
        nameResolvers: {
            [resolverKey: string]: NameResolverClient;
        };
    };
    constructor(pkc: PKC);
    protected _initIpfsGateways(): void;
    protected _initKuboRpcClients(): void;
    protected _initPubsubKuboRpcClients(): void;
    protected _initLibp2pJsClients(): void;
    protected _initNameResolvers(): void;
    preFetchGateway(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway): void;
    postFetchGatewayFailure(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway): void;
    postFetchGatewaySuccess(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway): void;
    postFetchGatewayAborted(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway): void;
    preResolveNameResolver({ resolveType, resolverKey }: PreResolveNameResolverOptions): void;
    postResolveNameResolverSuccess({ resolverKey }: PostResolveNameResolverSuccessOptions): void;
    postResolveNameResolverFailure({ resolverKey }: PostResolveNameResolverFailureOptions): void;
    updateKuboRpcPubsubState(newState: PKCClientsManager["clients"]["pubsubKuboRpcClients"][string]["state"], pubsubProvider: string): void;
    updateKuboRpcState(newState: PKCClientsManager["clients"]["kuboRpcClients"][string]["state"], kuboRpcClientUrl: string): void;
    updateLibp2pJsClientState(newState: PKCClientsManager["clients"]["libp2pJsClients"][string]["state"], libp2pJsClientKey: string): void;
    updateGatewayState(newState: PKCClientsManager["clients"]["ipfsGateways"][string]["state"], gateway: string): void;
    updateNameResolverState(newState: NameResolverClient["state"], resolverKey: string): void;
    fetchCid(cid: string): Promise<string>;
    protected _getStatePriorToResolvingCommunityIpns(): "fetching-community-ipns" | "fetching-ipns";
}

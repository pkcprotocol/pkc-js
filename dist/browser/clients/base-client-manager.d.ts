import { PKC } from "../pkc/pkc.js";
import { PKCError } from "../pkc-error.js";
import Logger from "../logger.js";
import type { PubsubMessage } from "../pubsub-messages/types.js";
import type { PubsubSubscriptionHandler, ResultOfFetchingCommunity } from "../types.js";
export type LoadType = "community" | "comment-update" | "comment" | "page-ipfs" | "generic-ipfs";
export type ResolveType = "community" | "author";
export type PreResolveNameResolverOptions = {
    address: string;
    resolveType: ResolveType;
    resolverKey: string;
};
export type PostResolveNameResolverSuccessOptions = PreResolveNameResolverOptions & {
    resolvedValue: string | undefined;
};
export type PostResolveNameResolverFailureOptions = PreResolveNameResolverOptions & {
    error: Error;
};
export type OptionsToLoadFromGateway = {
    recordIpfsType: "ipfs" | "ipns";
    maxFileSizeBytes: number;
    requestHeaders?: Record<string, string>;
    root: string;
    path?: string;
    recordPKCType: LoadType;
    abortController: AbortController;
    timeoutMs: number;
    abortRequestErrorBeforeLoadingBodyFunc?: (res: Response) => Promise<PKCError | undefined>;
    validateGatewayResponseFunc: (resObj: {
        resText: string | undefined;
        res: Response;
    }) => Promise<void>;
    log: Logger;
};
export declare class BaseClientsManager {
    _pkc: PKC;
    pubsubProviderSubscriptions: Record<string, string[]>;
    constructor(pkc: PKC);
    toJSON(): undefined;
    getDefaultPubsubKuboRpcClientOrHelia(): import("../types.js").PubsubClient | import("../helia/libp2pjsClient.js").Libp2pJsClient;
    getDefaultKuboRpcClientOrHelia(): PKC["clients"]["kuboRpcClients"][string] | PKC["clients"]["libp2pJsClients"][string];
    getDefaultKuboRpcClient(): import("../types.js").KuboRpcClient;
    getDefaultKuboPubsubClient(): import("../types.js").PubsubClient;
    getIpfsClientWithKuboRpcClientFunctions(): import("../helia/types.js").HeliaWithKuboRpcClientFunctions;
    pubsubSubscribeOnProvider(pubsubTopic: string, handler: PubsubSubscriptionHandler, kuboPubsubRpcUrlOrLibp2pJsKey: string): Promise<void>;
    pubsubSubscribe(pubsubTopic: string, handler: PubsubSubscriptionHandler): Promise<void>;
    pubsubUnsubscribeOnProvider(pubsubTopic: string, kuboPubsubRpcUrlOrLibp2pJsKey: string, handler?: PubsubSubscriptionHandler): Promise<void>;
    pubsubUnsubscribe(pubsubTopic: string, handler?: PubsubSubscriptionHandler): Promise<void>;
    pubsubPublishOnProvider(pubsubTopic: string, data: PubsubMessage, kuboPubsubRpcUrlOrLibp2pJsKey: string): Promise<void>;
    pubsubPublish(pubsubTopic: string, data: PubsubMessage): Promise<void>;
    _fetchWithLimit(url: string, options: {
        cache: string;
        signal: AbortSignal;
    } & Pick<OptionsToLoadFromGateway, "abortRequestErrorBeforeLoadingBodyFunc" | "maxFileSizeBytes" | "requestHeaders">): Promise<{
        resText: string | undefined;
        res: Response;
        abortError?: PKCError;
    }>;
    preFetchGateway(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway): void;
    postFetchGatewaySuccess(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway): void;
    postFetchGatewayFailure(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway, error: PKCError): void;
    postFetchGatewayAborted(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway): void;
    _fetchFromGatewayAndVerifyIfBodyCorrespondsToProvidedCid(url: string, loadOpts: Omit<OptionsToLoadFromGateway, "validateGatewayResponses">): Promise<{
        resText: string | undefined;
        res: Response;
        abortError?: PKCError;
    }>;
    private _handleIfGatewayRedirectsToSubdomainResolution;
    protected _fetchWithGateway(gateway: string, loadOpts: OptionsToLoadFromGateway): Promise<{
        res: Response;
        resText: string | undefined;
    } | {
        error: PKCError;
    }>;
    protected _firstResolve(promises: Promise<{
        res: Response;
        resText: string;
    } | {
        error: PKCError;
    }>[]): Promise<{
        res: {
            res: Response;
            resText: string;
        };
        i: number;
    }>;
    fetchFromMultipleGateways(loadOpts: Omit<OptionsToLoadFromGateway, "abortController"> & {
        abortSignal?: AbortSignal;
    }): Promise<{
        resText: string;
        res: Response;
    }>;
    resolveIpnsToCidP2P(ipnsName: string, loadOpts: {
        timeoutMs: number;
        abortSignal?: AbortSignal;
    }): Promise<string>;
    _fetchCidP2P(cidV0: string, loadOpts: {
        maxFileSizeBytes: number;
        timeoutMs: number;
        abortSignal?: AbortSignal;
    }): Promise<string>;
    private _verifyGatewayResponseMatchesCid;
    preResolveNameResolver(opts: PreResolveNameResolverOptions): void;
    postResolveNameResolverSuccess(opts: PostResolveNameResolverSuccessOptions): void;
    postResolveNameResolverFailure(opts: PostResolveNameResolverFailureOptions): void;
    private _resolveViaNameResolvers;
    resolveCommunityNameIfNeeded({ communityAddress, abortSignal }: {
        communityAddress: string;
        abortSignal?: AbortSignal;
    }): Promise<string | null>;
    resolveAuthorNameIfNeeded({ authorAddress, abortSignal }: {
        authorAddress: string;
        abortSignal?: AbortSignal;
    }): Promise<string | null>;
    resolveAuthorNamesInBackground({ authors, onResolved, abortSignal }: {
        authors: Array<{
            authorName: string;
            signaturePublicKey: string;
        }>;
        onResolved: () => void;
        abortSignal?: AbortSignal;
    }): void;
    emitError(e: PKCError): void;
    calculateIpfsCid(content: string): Promise<string>;
    protected _withInflightCommunityFetch(subAddress: string, fetcher: () => Promise<ResultOfFetchingCommunity>): Promise<ResultOfFetchingCommunity>;
}

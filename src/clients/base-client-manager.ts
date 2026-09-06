import { PKC } from "../pkc/pkc.js";
import assert from "assert";
import {
    calculateIpfsCidV0,
    extractNetworkErrorDetails,
    hideClassPrivateProps,
    isAbortError,
    isIpns,
    isIpfsPath,
    isIpnsPath,
    isStringDomain,
    raceAgainstAbort,
    throwIfAbortSignalAborted
} from "../util.js";
import { sha256 } from "js-sha256";
import { getPKCAddressFromPublicKey } from "../signer/util.js";
import { nativeFunctions } from "../runtime/node/util.js";
import pLimit from "p-limit";
import pRetry, { AbortError as PRetryAbortError } from "p-retry";
import {
    FailedToFetchCommentIpfsFromGatewaysError,
    FailedToFetchCommentUpdateFromGatewaysError,
    FailedToFetchGenericIpfsFromGatewaysError,
    FailedToFetchPageIpfsFromGatewaysError,
    FailedToFetchCommunityFromGatewaysError,
    PKCError
} from "../pkc-error.js";
import Logger from "../logger.js";
import type { PubsubMessage } from "../pubsub-messages/types.js";
import type { PubsubSubscriptionHandler, ResultOfFetchingCommunity } from "../types.js";
import * as cborg from "cborg";
import { concat as uint8ArrayConcat } from "uint8arrays/concat";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import all from "it-all";
import { keys } from "remeda";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { CidPathSchema } from "../schema/schema.js";
import { CID } from "multiformats/cid"; // re-sourced from kubo-rpc-client (identical class) to keep kubo off the eager import path
import { convertBase58IpnsNameToBase36Cid } from "../signer/util.js";
import pTimeout from "p-timeout";
import { InflightResourceTypes } from "../util/inflight-fetch-manager.js";
import { NameResolutionCache } from "./name-resolution-cache.js";
import type { NameResolveCacheOptions } from "../schema.js";

export type LoadType = "community" | "comment-update" | "comment" | "page-ipfs" | "generic-ipfs";

type GenericGatewayFetch = {
    [gatewayUrl: string]: {
        abortController: AbortController;
        promise: Promise<any>;
        response?: string;
        error?: Error;
        timeoutId: any;
    };
};

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
    abortRequestErrorBeforeLoadingBodyFunc?: (res: Response) => Promise<PKCError | undefined>; // this is called before consuming the body of the gateway response. Can be used to abort and stop the consumption. Should provide an abort error
    validateGatewayResponseFunc: (resObj: { resText: string | undefined; res: Response }) => Promise<void>; // can throw here to trigger a failure in response
    log: Logger;
};

const createUrlFromPathResolution = (gateway: string, opts: OptionsToLoadFromGateway): string => {
    const root = opts.recordIpfsType === "ipfs" ? CID.parse(opts.root).toV1().toString() : convertBase58IpnsNameToBase36Cid(opts.root);
    return `${gateway}/${opts.recordIpfsType}/${root}${opts.path ? "/" + opts.path : ""}`;
};

const createUrlFromSubdomainResolution = (gateway: string, opts: OptionsToLoadFromGateway): string => {
    const gatewayUrl = new URL(gateway);
    const root =
        opts.recordIpfsType === "ipfs"
            ? CID.parse(opts.root).toV1().toString()
            : opts.recordIpfsType === "ipns"
              ? convertBase58IpnsNameToBase36Cid(opts.root)
              : opts.root;

    return `${gatewayUrl.protocol}//${root}.${opts.recordIpfsType}.${gatewayUrl.host}${opts.path ? "/" + opts.path : ""}`;
};

const GATEWAYS_THAT_SUPPORT_SUBDOMAIN_RESOLUTION: Record<string, boolean> = {}; // gateway url -> whether it supports subdomain resolution

// How many author names resolveAuthorNamesInBackground keeps in flight at once. Set high on purpose,
// for two opposing pressures:
//
// Too low fragments a batching resolver. bso-resolver hands every concurrent resolve to one viem
// client configured with batch.multicall, coalescing them into a single Multicall3.aggregate3
// eth_call within a 200ms window, and it only gets that coalescing if the resolves are actually
// concurrent. A limit of 5 would turn one round trip into ceil(n / 5) of them.
//
// Unbounded is wrong too. A crosspost chain is capped at MAX_CROSSPOST_DEPTH (#250), but the page
// producers are not: a preloaded page is bounded by FIRST_PAGE_MAX_FILE_SIZE_BYTES (1mb of json,
// so hundreds of comments) and CommunityClientsManager._resolvePageAuthorNamesInBackground sweeps
// every preloaded posts page across every sort type in one call. On a cold cache that is a burst of
// hundreds, which is fine for a batching resolver and not fine for a resolver configured with
// batch: false, or for any user-supplied nameResolvers entry that issues one request per name.
//
// 100 sits above the realistic batch window, so coalescing survives, and caps the burst for the
// resolvers that do not batch.
const MAX_CONCURRENT_AUTHOR_NAME_RESOLUTIONS = 100;

export class BaseClientsManager {
    // Class that has all function but without clients field for maximum interopability

    _pkc: PKC;
    pubsubProviderSubscriptions: Record<string, string[]> = {}; // To keep track of subscriptions of each kubo pubsub provider/helia

    constructor(pkc: PKC) {
        this._pkc = pkc;
        for (const provider of keys(pkc.clients.pubsubKuboRpcClients)) this.pubsubProviderSubscriptions[provider] = [];
        for (const provider of keys(pkc.clients.libp2pJsClients)) this.pubsubProviderSubscriptions[provider] = [];

        hideClassPrivateProps(this);
    }

    toJSON() {
        return undefined;
    }

    getDefaultPubsubKuboRpcClientOrHelia() {
        const defaultPubsubProviderUrl = keys(this._pkc.clients.pubsubKuboRpcClients)[0];
        if (defaultPubsubProviderUrl) return this._pkc.clients.pubsubKuboRpcClients[defaultPubsubProviderUrl];
        const defaultLibp2pJsClient = keys(this._pkc.clients.libp2pJsClients)[0];
        if (defaultLibp2pJsClient) return this._pkc.clients.libp2pJsClients[defaultLibp2pJsClient];
        throw new PKCError("ERR_NO_DEFAULT_PUBSUB_PROVIDER", {
            pubsubKuboRpcClients: this._pkc.clients.pubsubKuboRpcClients,
            libp2pJsClients: this._pkc.clients.libp2pJsClients
        });
    }

    getDefaultKuboRpcClientOrHelia(): PKC["clients"]["kuboRpcClients"][string] | PKC["clients"]["libp2pJsClients"][string] {
        const defaultKuboRpcClient = keys(this._pkc.clients.kuboRpcClients)[0];
        if (defaultKuboRpcClient) return this._pkc.clients.kuboRpcClients[defaultKuboRpcClient];
        const defaultLibp2pJsClient = keys(this._pkc.clients.libp2pJsClients)[0];
        if (defaultLibp2pJsClient) return this._pkc.clients.libp2pJsClients[defaultLibp2pJsClient];
        throw new PKCError("ERR_NO_DEFAULT_IPFS_PROVIDER", {
            kuboRpcClients: this._pkc.clients.kuboRpcClients,
            libp2pJsClients: this._pkc.clients.libp2pJsClients
        });
    }

    getDefaultKuboRpcClient() {
        const defaultKuboRpcClient = keys(this._pkc.clients.kuboRpcClients)[0];
        if (defaultKuboRpcClient) return this._pkc.clients.kuboRpcClients[defaultKuboRpcClient];
        throw new PKCError("ERR_NO_DEFAULT_KUBO_RPC_IPFS_PROVIDER", {
            kuboRpcClients: this._pkc.clients.kuboRpcClients,
            libp2pJsClients: this._pkc.clients.libp2pJsClients
        });
    }

    getDefaultKuboPubsubClient() {
        const defaultKuboPubsubClient = this.getDefaultKuboPubsubClientIfAny();
        if (defaultKuboPubsubClient) return defaultKuboPubsubClient;
        throw new PKCError("ERR_NO_DEFAULT_KUBO_RPC_PUBSUB_PROVIDER", {
            pubsubKuboRpcClients: this._pkc.clients.pubsubKuboRpcClients
        });
    }

    // A node that only runs read-only communities (settings.disablePubsubChallengeExchange, issue #229)
    // may be configured with no pubsub provider at all. Use this wherever the client is only needed to
    // label a diagnostic state, so its absence is not turned into a failure.
    getDefaultKuboPubsubClientIfAny() {
        const defaultKuboPubsubClient = keys(this._pkc.clients.pubsubKuboRpcClients)[0];
        return defaultKuboPubsubClient ? this._pkc.clients.pubsubKuboRpcClients[defaultKuboPubsubClient] : undefined;
    }

    getIpfsClientWithKuboRpcClientFunctions() {
        const defaultKuboRpcClient = keys(this._pkc.clients.kuboRpcClients)[0];
        if (defaultKuboRpcClient) return this._pkc.clients.kuboRpcClients[defaultKuboRpcClient]._client;
        const defaultLibp2pJsClient = keys(this._pkc.clients.libp2pJsClients)[0];
        if (defaultLibp2pJsClient) return this._pkc.clients.libp2pJsClients[defaultLibp2pJsClient].heliaWithKuboRpcClientFunctions;
        throw new PKCError("ERR_NO_DEFAULT_IPFS_PROVIDER", {
            kuboRpcClients: this._pkc.clients.kuboRpcClients,
            libp2pJsClients: this._pkc.clients.libp2pJsClients
        });
    }

    // Pubsub methods

    async pubsubSubscribeOnProvider(pubsubTopic: string, handler: PubsubSubscriptionHandler, kuboPubsubRpcUrlOrLibp2pJsKey: string) {
        const log = Logger("pkc-js:pkc:client-manager:pubsubSubscribeOnProvider");

        const pubsubClient =
            this._pkc.clients.libp2pJsClients[kuboPubsubRpcUrlOrLibp2pJsKey]?.heliaWithKuboRpcClientFunctions ||
            this._pkc.clients.pubsubKuboRpcClients[kuboPubsubRpcUrlOrLibp2pJsKey]._client;
        if (!pubsubClient) throw new PKCError("ERR_INVALID_PUBSUB_PROVIDER", { pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey });

        const timeBefore = Date.now();

        const handlePubsubError = async (err: Error) => {
            error = err;
            log.error(
                "pubsub callback error, topic",
                pubsubTopic,
                "provider url",
                kuboPubsubRpcUrlOrLibp2pJsKey,
                "error",
                err,
                "Will unsubscribe and re-attempt to subscribe"
            );

            await this._pkc._stats.recordGatewayFailure(kuboPubsubRpcUrlOrLibp2pJsKey, "pubsub-subscribe");
            try {
                await this.pubsubUnsubscribeOnProvider(pubsubTopic, kuboPubsubRpcUrlOrLibp2pJsKey, handler);
            } catch (e) {
                log.error("Failed to unsubscribe after onError, topic", pubsubTopic, "provider url", kuboPubsubRpcUrlOrLibp2pJsKey, e);
            }
            await this.pubsubSubscribeOnProvider(pubsubTopic, handler, kuboPubsubRpcUrlOrLibp2pJsKey);
        };

        let error: Error | undefined;
        try {
            await pubsubClient.pubsub.subscribe(pubsubTopic, handler, { onError: handlePubsubError });
            if (error) throw error;
            await this._pkc._stats.recordGatewaySuccess(kuboPubsubRpcUrlOrLibp2pJsKey, "pubsub-subscribe", Date.now() - timeBefore);
            this.pubsubProviderSubscriptions[kuboPubsubRpcUrlOrLibp2pJsKey].push(pubsubTopic);
        } catch (e) {
            //@ts-expect-error
            e.details = { ...e.details, pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey, pubsubTopic };
            if ((e as Error).message?.startsWith("Already subscribed to")) {
                this.pubsubProviderSubscriptions[kuboPubsubRpcUrlOrLibp2pJsKey].push(pubsubTopic);
                return;
            }
            await this._pkc._stats.recordGatewayFailure(kuboPubsubRpcUrlOrLibp2pJsKey, "pubsub-subscribe");
            log.error(`Failed to subscribe to pubsub topic (${pubsubTopic}) to (${kuboPubsubRpcUrlOrLibp2pJsKey}) due to error`, e);
            throw e;
        }
    }

    async pubsubSubscribe(pubsubTopic: string, handler: PubsubSubscriptionHandler) {
        const providersSorted = await this._pkc._stats.sortGatewaysAccordingToScore("pubsub-subscribe");
        const providerToError: Record<string, PKCError> = {};

        for (let i = 0; i < providersSorted.length; i++) {
            const pubsubProviderUrl = providersSorted[i];
            try {
                return this.pubsubSubscribeOnProvider(pubsubTopic, handler, pubsubProviderUrl);
            } catch (e: unknown) {
                providerToError[pubsubProviderUrl] = <PKCError>e;
            }
        }

        const combinedError = new PKCError("ERR_PUBSUB_FAILED_TO_SUBSCRIBE", { pubsubTopic, providerToError });

        this.emitError(combinedError);
        throw combinedError;
    }

    async pubsubUnsubscribeOnProvider(pubsubTopic: string, kuboPubsubRpcUrlOrLibp2pJsKey: string, handler?: PubsubSubscriptionHandler) {
        const pubsubClient =
            this._pkc.clients.libp2pJsClients[kuboPubsubRpcUrlOrLibp2pJsKey]?.heliaWithKuboRpcClientFunctions ||
            this._pkc.clients.pubsubKuboRpcClients[kuboPubsubRpcUrlOrLibp2pJsKey]._client;
        if (!pubsubClient) throw new PKCError("ERR_INVALID_PUBSUB_PROVIDER", { pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey });

        try {
            await pubsubClient.pubsub.unsubscribe(pubsubTopic, handler);
            this.pubsubProviderSubscriptions[kuboPubsubRpcUrlOrLibp2pJsKey] = this.pubsubProviderSubscriptions[
                kuboPubsubRpcUrlOrLibp2pJsKey
            ].filter((subPubsubTopic) => subPubsubTopic !== pubsubTopic);
        } catch (e) {
            //@ts-expect-error
            e.details = { ...e.details, pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey, pubsubTopic };
            throw e;
        }
    }

    async pubsubUnsubscribe(pubsubTopic: string, handler?: PubsubSubscriptionHandler) {
        for (const pubsubProviderUrl of keys(this._pkc.clients.pubsubKuboRpcClients)) {
            try {
                await this.pubsubUnsubscribeOnProvider(pubsubTopic, pubsubProviderUrl, handler);
            } catch (e) {
                await this._pkc._stats.recordGatewayFailure(pubsubProviderUrl, "pubsub-unsubscribe");
                //@ts-expect-error
                e.details = { ...e.details, pubsubProviderUrl, pubsubTopic };
                this.emitError(<PKCError>e);
            }
        }
    }

    async pubsubPublishOnProvider(pubsubTopic: string, data: PubsubMessage, kuboPubsubRpcUrlOrLibp2pJsKey: string) {
        const log = Logger("pkc-js:pkc:pubsubPublish");
        const pubsubClient =
            this._pkc.clients.libp2pJsClients[kuboPubsubRpcUrlOrLibp2pJsKey]?.heliaWithKuboRpcClientFunctions ||
            this._pkc.clients.pubsubKuboRpcClients[kuboPubsubRpcUrlOrLibp2pJsKey]._client;
        if (!pubsubClient) throw new PKCError("ERR_INVALID_PUBSUB_PROVIDER", { pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey });

        const dataBinary = cborg.encode(data);
        const timeBefore = Date.now();
        try {
            await pubsubClient.pubsub.publish(pubsubTopic, dataBinary);
            this._pkc._stats.recordGatewaySuccess(kuboPubsubRpcUrlOrLibp2pJsKey, "pubsub-publish", Date.now() - timeBefore); // Awaiting this statement will bug out tests
        } catch (error) {
            //@ts-expect-error
            error.details = { ...error.details, pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey, pubsubTopic };
            await this._pkc._stats.recordGatewayFailure(kuboPubsubRpcUrlOrLibp2pJsKey, "pubsub-publish");
            throw error;
        }
    }

    async pubsubPublish(pubsubTopic: string, data: PubsubMessage): Promise<void> {
        const log = Logger("pkc-js:pkc:client-manager:pubsubPublish");
        const providersSorted = await this._pkc._stats.sortGatewaysAccordingToScore("pubsub-publish");
        if (providersSorted.length === 0)
            throw new PKCError("ERR_NO_PUBSUB_PROVIDERS_AVAILABLE_TO_PUBLISH_OVER_PUBSUB", { pubsubTopic, data });
        const providerToError: Record<string, PKCError> = {};

        for (let i = 0; i < providersSorted.length; i++) {
            const pubsubProviderUrl = providersSorted[i];
            try {
                return await this.pubsubPublishOnProvider(pubsubTopic, data, pubsubProviderUrl);
            } catch (e) {
                log.error(`Failed to publish to pubsub topic (${pubsubTopic}) to (${pubsubProviderUrl})`);
                providerToError[pubsubProviderUrl] = <PKCError>e;
            }
        }

        const combinedError = new PKCError("ERR_PUBSUB_FAILED_TO_PUBLISH", { pubsubTopic, data, providerToError });

        this.emitError(combinedError);
        throw combinedError;
    }

    // Gateway methods

    async _fetchWithLimit(
        url: string,
        options: { cache: string; signal: AbortSignal } & Pick<
            OptionsToLoadFromGateway,
            "abortRequestErrorBeforeLoadingBodyFunc" | "maxFileSizeBytes" | "requestHeaders"
        >
    ): Promise<{ resText: string | undefined; res: Response; abortError?: PKCError }> {
        // Node-fetch will take care of size limits through options.size, while browsers will process stream manually

        const handleError = (e: Error | PKCError) => {
            const nodeError = <NodeJS.ErrnoException & { address?: string; port?: number; cause?: unknown }>(<unknown>e);
            if (e instanceof PKCError) throw e;
            else if (e instanceof Error && e.message.includes("over limit"))
                throw new PKCError("ERR_OVER_DOWNLOAD_LIMIT", { url, options });
            else if (options.signal?.aborted) throw new PKCError("ERR_GATEWAY_TIMED_OUT_OR_ABORTED", { url, options });
            else {
                const errorCode =
                    url.includes("/ipfs/") || url.includes(".ipfs.")
                        ? "ERR_FAILED_TO_FETCH_IPFS_VIA_GATEWAY"
                        : url.includes("/ipns/") || url.includes(".ipns.")
                          ? "ERR_FAILED_TO_FETCH_IPNS_VIA_GATEWAY"
                          : "ERR_FAILED_TO_FETCH_GENERIC";
                throw new PKCError(errorCode, {
                    url,
                    status: res?.status,
                    statusText: res?.statusText,
                    fetchError: String(e),
                    fetchErrorCode: nodeError?.code,
                    fetchErrorErrno: nodeError?.errno,
                    fetchErrorSyscall: nodeError?.syscall,
                    fetchErrorAddress: nodeError?.address,
                    fetchErrorPort: nodeError?.port,
                    fetchErrorCause: nodeError?.cause,
                    options
                });
            }

            // If error is not related to size limit, then throw it again
        };

        let res: Response;
        // should have a callback after calling fetch, but before streaming the body
        try {
            res = await nativeFunctions.fetch(url, {
                //@ts-expect-error, cache option is for browsers
                cache: options.cache,
                signal: options.signal,
                size: options.maxFileSizeBytes,
                headers: options.requestHeaders
            });

            if (res.status !== 200)
                throw Error(`Failed to fetch due to status code: ${res.status} + ", res.statusText" + (${res.statusText})`);
            if (options.abortRequestErrorBeforeLoadingBodyFunc) {
                const abortError = await options.abortRequestErrorBeforeLoadingBodyFunc(res);
                if (abortError) {
                    return { res, resText: undefined, abortError: abortError };
                }
            }
            const sizeHeader = <string | null>res.headers.get("Content-Length");
            if (sizeHeader && Number(sizeHeader) > options.maxFileSizeBytes)
                throw new PKCError("ERR_OVER_DOWNLOAD_LIMIT", { url, options, res, sizeHeader });

            // If getReader is undefined that means node-fetch is used here. node-fetch processes options.size automatically
            if (res?.body?.getReader === undefined) return { resText: await res.text(), res };
        } catch (e) {
            handleError(<Error>e);
        }

        //@ts-expect-error
        if (res?.body?.getReader !== undefined) {
            let totalBytesRead = 0;

            try {
                const reader = res.body.getReader();
                const decoder = new TextDecoder("utf-8");

                let resText: string = "";

                while (true) {
                    const { done, value } = await reader.read();
                    //@ts-ignore
                    if (value) resText += decoder.decode(value);
                    if (done || !value) break;
                    if (value.length + totalBytesRead > options.maxFileSizeBytes)
                        throw new PKCError("ERR_OVER_DOWNLOAD_LIMIT", { url, options });
                    totalBytesRead += value.length;
                }
                return { resText, res };
            } catch (e) {
                handleError(<Error>e);
            }
        }

        throw Error("should not reach this block in _fetchWithLimit");
    }

    preFetchGateway(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway) {}

    postFetchGatewaySuccess(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway) {}

    postFetchGatewayFailure(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway, error: PKCError) {}

    postFetchGatewayAborted(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway) {}

    async _fetchFromGatewayAndVerifyIfBodyCorrespondsToProvidedCid(
        url: string,
        loadOpts: Omit<OptionsToLoadFromGateway, "validateGatewayResponses">
    ) {
        loadOpts.log.trace(`Fetching url (${url})`);

        const resObj = await this._fetchWithLimit(url, {
            cache: loadOpts.recordIpfsType === "ipfs" ? "force-cache" : "no-store",
            signal: loadOpts.abortController.signal,
            ...loadOpts
        });
        const shouldVerifyBodyAgainstCid = loadOpts.recordIpfsType === "ipfs" && !loadOpts.path;
        if (shouldVerifyBodyAgainstCid && !resObj.resText) throw Error("Can't verify body against cid when there's no body");
        if (shouldVerifyBodyAgainstCid && resObj.resText)
            await this._verifyGatewayResponseMatchesCid(resObj.resText, loadOpts.root, loadOpts);
        return resObj;
    }

    private _handleIfGatewayRedirectsToSubdomainResolution(
        gateway: string,
        loadOpts: OptionsToLoadFromGateway,
        res: Response | undefined,
        log: Logger
    ) {
        if (GATEWAYS_THAT_SUPPORT_SUBDOMAIN_RESOLUTION[gateway]) return; // already handled, no need to do anything
        if (!res?.redirected) return; // if it doesn't redirect to subdomain gateway then the gateway doesn't support subdomain resolution
        const resUrl = new URL(res.url);
        if (resUrl.hostname.includes(`.${loadOpts.recordIpfsType}.`)) {
            log(`Gateway`, gateway, "supports subdomain resolution. Switching url formulation to subdomain resolution");
            GATEWAYS_THAT_SUPPORT_SUBDOMAIN_RESOLUTION[gateway] = true;
        }
    }

    protected async _fetchWithGateway(
        gateway: string,
        loadOpts: OptionsToLoadFromGateway
    ): Promise<{ res: Response; resText: string | undefined } | { error: PKCError }> {
        const log = Logger("pkc-js:pkc:fetchWithGateway");

        const url = GATEWAYS_THAT_SUPPORT_SUBDOMAIN_RESOLUTION[gateway]
            ? createUrlFromSubdomainResolution(gateway, loadOpts)
            : createUrlFromPathResolution(gateway, loadOpts);

        this.preFetchGateway(gateway, loadOpts);
        const timeBefore = Date.now();
        try {
            const resObj = await this._fetchFromGatewayAndVerifyIfBodyCorrespondsToProvidedCid(url, loadOpts);

            if (resObj.abortError) {
                if (!loadOpts.abortController.signal.aborted) loadOpts.abortController.abort(resObj.abortError.message);
                throw resObj.abortError;
            }

            await loadOpts.validateGatewayResponseFunc(resObj); // should throw if there's an issue
            this.postFetchGatewaySuccess(gateway, loadOpts);

            this._pkc._stats
                .recordGatewaySuccess(gateway, loadOpts.recordIpfsType, Date.now() - timeBefore)
                .catch((err) => log.error("Failed to report gateway success", err));
            this._handleIfGatewayRedirectsToSubdomainResolution(gateway, loadOpts, resObj.res, log);
            return resObj;
        } catch (e) {
            //@ts-expect-error
            e.details = { ...e.details, url, loadOpts, wasRequestAborted: loadOpts.abortController.signal.aborted };

            this.postFetchGatewayFailure(gateway, loadOpts, <PKCError>e);
            this._pkc._stats
                .recordGatewayFailure(gateway, loadOpts.recordIpfsType)
                .catch((err) => log.error("failed to report gateway error", err));
            return { error: <PKCError>e };
        }
    }

    protected _firstResolve(promises: Promise<{ res: Response; resText: string } | { error: PKCError }>[]) {
        if (promises.length === 0) throw Error("No promises to find the first resolve");
        return new Promise<{ res: { res: Response; resText: string }; i: number }>((resolve) =>
            promises.forEach((promise, i) =>
                promise.then((res) => {
                    if ("resText" in res) resolve({ res, i });
                })
            )
        );
    }

    async fetchFromMultipleGateways(
        loadOpts: Omit<OptionsToLoadFromGateway, "abortController"> & { abortSignal?: AbortSignal }
    ): Promise<{ resText: string; res: Response }> {
        const timeoutMs = loadOpts.timeoutMs;
        const concurrencyLimit = 3;

        const queueLimit = pLimit(concurrencyLimit);

        // Only sort if we have more than 3 gateways
        const gatewaysSorted =
            keys(this._pkc.clients.ipfsGateways).length <= concurrencyLimit
                ? keys(this._pkc.clients.ipfsGateways)
                : await this._pkc._stats.sortGatewaysAccordingToScore(loadOpts.recordIpfsType);

        const gatewayFetches: GenericGatewayFetch = {};

        const cleanUp = () => {
            queueLimit.clearQueue();
            Object.values(gatewayFetches).map((gateway) => {
                if (!gateway.response && !gateway.error) gateway.abortController.abort();
                clearTimeout(gateway.timeoutId);
            });
            if (loadOpts.abortSignal) loadOpts.abortSignal.removeEventListener("abort", onParentAbort);
        };

        const onParentAbort = () => cleanUp();
        if (loadOpts.abortSignal) {
            throwIfAbortSignalAborted(loadOpts.abortSignal);
            loadOpts.abortSignal.addEventListener("abort", onParentAbort, { once: true });
        }

        for (const gateway of gatewaysSorted) {
            const abortController = new AbortController();
            gatewayFetches[gateway] = {
                abortController,
                promise: queueLimit(() => this._fetchWithGateway(gateway, { ...loadOpts, abortController })),
                timeoutId: setTimeout(() => abortController.abort("Gateway request timed out"), timeoutMs)
            };
        }

        const gatewayPromises = Object.values(gatewayFetches).map((fetching) => fetching.promise);

        //@ts-expect-error
        const res: { res: { resText: string; res: Response }; i: number } | { value: { error: PKCError } }[] = await Promise.race([
            this._firstResolve(gatewayPromises),
            Promise.allSettled(gatewayPromises)
        ]);
        if (Array.isArray(res)) {
            cleanUp();
            throwIfAbortSignalAborted(loadOpts.abortSignal);
            const gatewayToError: Record<string, PKCError> = {};
            for (let i = 0; i < res.length; i++) if (res[i]["value"]) gatewayToError[gatewaysSorted[i]] = res[i]["value"].error;

            const combinedError =
                loadOpts.recordPKCType === "comment"
                    ? new FailedToFetchCommentIpfsFromGatewaysError({ commentCid: loadOpts.root, gatewayToError, loadOpts })
                    : loadOpts.recordPKCType === "comment-update"
                      ? new FailedToFetchCommentUpdateFromGatewaysError({ gatewayToError, loadOpts })
                      : loadOpts.recordPKCType === "page-ipfs"
                        ? new FailedToFetchPageIpfsFromGatewaysError({ pageCid: loadOpts.root, gatewayToError, loadOpts })
                        : loadOpts.recordPKCType === "community"
                          ? new FailedToFetchCommunityFromGatewaysError({ ipnsName: loadOpts.root, gatewayToError, loadOpts })
                          : new FailedToFetchGenericIpfsFromGatewaysError({ cid: loadOpts.root, gatewayToError, loadOpts });

            throw combinedError;
        } else {
            cleanUp();
            return res.res;
        }
    }

    // IPFS P2P methods

    // Maximum number of /ipns/ -> /ipns/ delegation hops we follow before giving up. For now this
    // is capped at 1, so only a single anchor -> minter delegation is supported (see
    // docs/protocol/delegated-ipns.md). A normal (non-delegated) community resolves in zero hops
    // (its record points straight at /ipfs/); a delegated community resolves in exactly one
    // (anchor -> minter -> /ipfs/). Longer chains are rejected with ERR_IPNS_MAX_HOPS_EXCEEDED.
    static readonly MAX_IPNS_HOPS = 1;

    // Resolves an IPNS name to its terminal /ipfs/ CID, following any /ipns/ -> /ipns/
    // delegation hops along the way. Returns the resolved CID together with the ordered
    // chain of IPNS names traversed: ipnsHops[0] is the anchor (the name we were asked to
    // resolve) and ipnsHops.at(-1) is the terminal name (the name whose record points
    // directly at the /ipfs/ CID, i.e. the key that signs the content).
    async resolveIpnsToCidP2P(
        ipnsName: string,
        // `nocache: true` forces a network revalidation even on the libp2p-js resolver (whose
        // default below is to let its gossip-fed routing-layer cache serve, issue #301). The
        // community update loop sets it on safety-net ticks, which exist precisely for pushed
        // records the cache never received. It is spread AFTER the per-client default, so the
        // caller's value wins.
        loadOpts: { timeoutMs: number; abortSignal?: AbortSignal; nocache?: boolean }
    ): Promise<{ cid: string; ipnsHops: string[] }> {
        const log = Logger("pkc-js:clients-manager:resolveIpnsToCidP2P");
        throwIfAbortSignalAborted(loadOpts.abortSignal);
        // recursive: false so the resolver returns the IMMEDIATE value of each record (so we can
        // walk /ipns/ -> /ipns/ hops ourselves); see performIpnsResolve below.
        // nocache differs by client (issue #301). The libp2p-js resolver keeps its routing-layer
        // cache fresh from gossipsub pushes and honors the record's ttl, so letting it serve from
        // cache is what turns the update loop's 1s cadence into pushes plus one revalidation per
        // ttl instead of a multi-peer fetch race per community per second. Kubo keeps
        // nocache: true (pre-existing behavior): its namesys cache is not fed by pkc's pubsub
        // subscriptions, so serving from it could hand back records up to a full record ttl stale.
        // Mirrors getIpfsClientWithKuboRpcClientFunctions' precedence: kubo wins when present.
        const resolvingViaLibp2pJsClient =
            keys(this._pkc.clients.kuboRpcClients).length === 0 && keys(this._pkc.clients.libp2pJsClients).length > 0;
        const ipnsResolveOpts = { nocache: !resolvingViaLibp2pJsClient, recursive: false, ...loadOpts };
        const ipfsClient = this.getIpfsClientWithKuboRpcClientFunctions();

        const performIpnsResolve = async () => {
            // We resolve ONE hop at a time (recursive: false) rather than letting the resolver
            // collapse the whole chain to its final /ipfs/ CID. Kubo's recursive resolve only
            // yields the final value and hides intermediate names, so resolving hop-by-hop is the
            // only way to learn the terminal name (the key that signs the content) and to keep
            // per-record signature verification at each hop. A normal (non-delegated) community
            // resolves in a single hop, so this costs exactly one lookup in the common case.
            const ipnsHops: string[] = [ipnsName];
            let currentName = ipnsName;
            // Follow at most MAX_IPNS_HOPS delegation hops. The loop exits only via a return (we hit
            // a terminal /ipfs/ value) or a throw (undefined/unsupported value, or too many hops).
            while (true) {
                // Label the record we're about to resolve so any failure names WHICH record was at
                // fault. hop 0 is the anchor; with MAX_IPNS_HOPS === 1 the only other hop fetched is
                // the minter (the cap below throws before a 3rd hop is fetched), so the role is
                // unambiguous — "anchor" or "minter". Mirrors the gateway chain walker's labelling so
                // both resolution paths report failures identically. See docs/protocol/delegated-ipns.md.
                const hopIndex = ipnsHops.length - 1;
                const hopRole = hopIndex === 0 ? "anchor" : "minter";
                const yieldedValues: string[] = await all(ipfsClient.name.resolve(currentName, ipnsResolveOpts));
                // The single-hop value (kubo may yield it more than once; helia yields it once).
                const value: string | undefined = yieldedValues[yieldedValues.length - 1];
                if (!value)
                    throw new PKCError("ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED", {
                        hopRole,
                        hopIndex,
                        resolvedValue: value,
                        yieldedValues,
                        currentName,
                        ipnsName,
                        ipnsHops,
                        ipnsResolveOpts
                    });

                if (isIpfsPath(value)) return { cid: CidPathSchema.parse(value), ipnsHops };

                if (isIpnsPath(value)) {
                    currentName = value.split("/")[2];
                    ipnsHops.push(currentName);
                    // ipnsHops.length - 1 is the number of /ipns/ -> /ipns/ hops followed so far.
                    if (ipnsHops.length - 1 > BaseClientsManager.MAX_IPNS_HOPS)
                        throw new PKCError("ERR_IPNS_MAX_HOPS_EXCEEDED", {
                            // hopRole/hopIndex describe the record that delegated one hop too far.
                            hopRole,
                            hopIndex,
                            ipnsHops,
                            maxHops: BaseClientsManager.MAX_IPNS_HOPS,
                            ipnsName,
                            ipnsResolveOpts
                        });
                    continue;
                }

                throw new PKCError("ERR_RESOLVED_IPNS_TO_UNSUPPORTED_VALUE", {
                    hopRole,
                    hopIndex,
                    unsupportedValue: value,
                    currentName,
                    ipnsName,
                    ipnsHops,
                    ipnsResolveOpts
                });
            }
        };
        try {
            // Wrap the resolution function with pTimeout because kubo-rpc-client doesn't support timeout for IPNS
            const result = await pTimeout(performIpnsResolve(), {
                milliseconds: loadOpts.timeoutMs,
                message: new PKCError("ERR_IPNS_RESOLUTION_P2P_TIMEOUT", {
                    ipnsName,
                    ipnsResolveOpts
                }),
                signal: loadOpts.abortSignal
            });

            return result;
        } catch (error) {
            if (isAbortError(error)) throw error;
            // Over P2P, per-record IPNS signature validation — and therefore forgery/tamper detection —
            // is performed inside the resolver (kubo/helia), not by us. So a forged, tampered, or
            // otherwise unverifiable record surfaces here as an opaque resolution failure rather than an
            // explicit forgery error like the gateway path's ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID. We
            // attach this note to resolver-level failures (not to our own structured chain errors, which
            // already explain themselves) so the surfaced error documents that asymmetry.
            const isOpaqueResolverError = !(error instanceof PKCError);
            const p2pValidationNote = isOpaqueResolverError
                ? "Resolution failed inside the IPNS resolver (kubo/helia). Over P2P the resolver performs per-record signature validation, so a forged/tampered/unverifiable record appears here as a resolution failure, not an explicit forgery error (cf. the gateway path's ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID). See docs/protocol/delegated-ipns.md."
                : undefined;
            //@ts-expect-error attaching extra context to whatever propagated (PKCError or raw resolver error)
            error.details = { ...error.details, ipnsName, ipnsResolveOpts, ...(p2pValidationNote ? { note: p2pValidationNote } : {}) };
            // Wrap ETIMEDOUT in PKCError so _isRetriableErrorWhenLoading recognizes it as retriable
            if (error instanceof Error && "cause" in error && (error.cause as { code?: string })?.code === "ETIMEDOUT") {
                log.error(`Failed to resolve IPNS ${ipnsName}: ${error.message} (ETIMEDOUT)`);
                throw new PKCError("ERR_FAILED_TO_RESOLVE_IPNS_VIA_IPFS_P2P", {
                    ipnsName,
                    ipnsResolveOpts,
                    error,
                    errorMessage: error.message,
                    errorName: error.name,
                    note: p2pValidationNote
                });
            }
            throw error;
        }

        throw Error("Should not reach this block in resolveIpnsToCidP2P");
    }

    // TODO rename this to _fetchPathP2P

    async _fetchCidP2P(
        cidV0: string,
        loadOpts: {
            maxFileSizeBytes: number;
            timeoutMs: number;
            abortSignal?: AbortSignal;
            // IPNS-over-pubsub record topic of the community the CID belongs to, used to scope
            // bitswap session seed peers when fetching through helia (issue #202). Ignored (and
            // never forwarded) when the fetch goes through kubo-rpc-client.
            bitswapSessionSeedScopeIpnsPubsubTopic?: string;
        }
    ): Promise<string> {
        const log = Logger("pkc-js:clients-manager:_fetchCidP2P");
        throwIfAbortSignalAborted(loadOpts.abortSignal);
        const kuboRpcOrHelia = this.getDefaultKuboRpcClientOrHelia();

        const ipfsClient = this.getIpfsClientWithKuboRpcClientFunctions();

        const fetchPromise = async () => {
            const seedScopeOptions =
                "_helia" in kuboRpcOrHelia && loadOpts.bitswapSessionSeedScopeIpnsPubsubTopic
                    ? { bitswapSessionSeedScopeIpnsPubsubTopic: loadOpts.bitswapSessionSeedScopeIpnsPubsubTopic }
                    : undefined;
            // The caller's signal goes to cat() as well as to the pTimeout below: pTimeout only
            // abandons the promise on abort, and a helia cat left running would keep opening bitswap
            // sessions and retrying "no providers" until its own timeout fired, long after the
            // comment/community/pkc that asked for it was stopped (issue #345).
            const rawData = await all(
                ipfsClient.cat(cidV0, {
                    length: loadOpts.maxFileSizeBytes,
                    timeout: `${loadOpts.timeoutMs}ms`,
                    signal: loadOpts.abortSignal,
                    ...seedScopeOptions
                })
            );
            const data = uint8ArrayConcat(rawData);
            const fileContent = uint8ArrayToString(data);

            if (typeof fileContent !== "string") {
                log.error(`Failed to fetch CID ${cidV0}: fileContent is not a string`);
                throw new PKCError("ERR_FAILED_TO_FETCH_IPFS_CID_VIA_IPFS_P2P", { cid: cidV0, loadOpts });
            }
            if (data.byteLength === loadOpts.maxFileSizeBytes) {
                const calculatedCid: string = await calculateIpfsHash(fileContent);
                if (calculatedCid !== cidV0)
                    throw new PKCError("ERR_OVER_DOWNLOAD_LIMIT", {
                        cid: cidV0,
                        loadOpts,
                        endedDownloadAtFileContentLength: data.byteLength
                    });
            }
            return fileContent;
        };

        try {
            // Wrap the fetch function with pTimeout to ensure it times out properly
            const result = <string>await pTimeout(fetchPromise(), {
                milliseconds: loadOpts.timeoutMs,
                message: new PKCError("ERR_FETCH_CID_P2P_TIMEOUT", { cid: cidV0, loadOpts }),
                signal: loadOpts.abortSignal
            });
            return result;
        } catch (e) {
            if (isAbortError(e)) throw e;
            if (e instanceof PKCError) throw e;
            else if (e instanceof Error && e.name === "TimeoutError")
                throw new PKCError("ERR_FETCH_CID_P2P_TIMEOUT", { cid: cidV0, error: e, loadOpts });
            else {
                const networkErrorDetails = extractNetworkErrorDetails(e);
                log.error(`Failed to fetch CID ${cidV0}: ${(e as Error)?.message} (${(e as Error)?.name})`, networkErrorDetails);
                throw new PKCError("ERR_FAILED_TO_FETCH_IPFS_CID_VIA_IPFS_P2P", {
                    cid: cidV0,
                    error: e,
                    errorMessage: (e as Error)?.message,
                    errorName: (e as Error)?.name,
                    errorCode: (e as { code?: string })?.code,
                    networkErrorDetails,
                    loadOpts
                });
            }
        }
    }

    // Retry helper for callers of `_fetchCidP2P`. Retries only on transient socket-level errors
    // (undici TypeError("fetch failed") with an AggregateError of ECONNREFUSED/ECONNRESET/UND_ERR_SOCKET,
    // surfaced through _fetchCidP2P as ERR_FAILED_TO_FETCH_IPFS_CID_VIA_IPFS_P2P). Content-level errors
    // (CID mismatch, schema, over-download, invalid signature) and timeouts/aborts are NOT retried —
    // they either indicate a real problem or should be respected. The abortSignal is passed to p-retry
    // so callers can cancel a stale retry chain when fresher parent state arrives.
    protected async _retryTransientP2PFetch<T>(
        fetcher: () => Promise<T>,
        opts: { abortSignal?: AbortSignal; retries?: number; log?: Logger; context?: string }
    ): Promise<T> {
        return pRetry(
            async () => {
                try {
                    return await fetcher();
                } catch (e) {
                    // Only transient socket-level fetch failures are retriable. For anything else we
                    // throw an AbortError which p-retry treats as a non-retriable stop.
                    const isTransient = e instanceof PKCError && e.code === "ERR_FAILED_TO_FETCH_IPFS_CID_VIA_IPFS_P2P";
                    if (!isTransient) throw e instanceof Error ? new PRetryAbortError(e) : e;
                    throw e;
                }
            },
            {
                // 3 retries + initial attempt = up to 4 attempts. Backoff 1s, 2s, 4s between retries.
                retries: opts.retries ?? 3,
                factor: 2,
                minTimeout: 1000,
                maxTimeout: 4000,
                signal: opts.abortSignal,
                onFailedAttempt: ({ error, attemptNumber, retriesLeft }) => {
                    opts.log?.trace(
                        `Transient fetch failure on attempt ${attemptNumber}/${attemptNumber + retriesLeft}${opts.context ? ` (${opts.context})` : ""}`,
                        error?.message
                    );
                }
            }
        );
    }

    private async _verifyGatewayResponseMatchesCid(
        gatewayResponseBody: string,
        cid: string,
        loadOpts: Pick<OptionsToLoadFromGateway, "maxFileSizeBytes">
    ) {
        const calculatedCid: string = await calculateIpfsHash(gatewayResponseBody);
        if (gatewayResponseBody.length === loadOpts.maxFileSizeBytes && calculatedCid !== cid)
            throw new PKCError("ERR_OVER_DOWNLOAD_LIMIT", { cid, loadOpts, gatewayResponseBody });
        if (calculatedCid !== cid)
            throw new PKCError("ERR_CALCULATED_CID_DOES_NOT_MATCH", { calculatedCid, cid, gatewayResponseBody, loadOpts });
    }

    // Resolver methods here

    // Name resolver hooks — overridden by PKCClientsManager and subclass client managers
    preResolveNameResolver(opts: PreResolveNameResolverOptions) {}
    postResolveNameResolverSuccess(opts: PostResolveNameResolverSuccessOptions) {}
    postResolveNameResolverFailure(opts: PostResolveNameResolverFailureOptions) {}

    private _nameResolutionCache?: NameResolutionCache;
    private _getNameResolutionCache(): NameResolutionCache {
        if (!this._nameResolutionCache) this._nameResolutionCache = new NameResolutionCache(this._pkc);
        return this._nameResolutionCache;
    }

    private async _resolveViaNameResolvers({
        name,
        resolveType,
        abortSignal,
        cache
    }: {
        name: string;
        resolveType: ResolveType;
        abortSignal?: AbortSignal;
        cache?: NameResolveCacheOptions;
    }): Promise<string | null> {
        const log = Logger("pkc-js:client-manager:_resolveViaNameResolvers");
        const nameResolvers = this._pkc.nameResolvers;
        if (!nameResolvers || nameResolvers.length === 0) {
            throw new PKCError("ERR_NO_RESOLVER_FOR_NAME", { address: name });
        }

        throwIfAbortSignalAborted(abortSignal);

        const persistentCache = this._getNameResolutionCache();
        let value: string | undefined;
        let anyResolverCanHandle = false;

        for (const nameResolver of nameResolvers) {
            if (!nameResolver.canResolve({ name })) continue;
            anyResolverCanHandle = true;

            // Persistent cache lookup (skipped when cache.maxAge === 0; obeys cache.maxAge threshold)
            const cached = await persistentCache.get({
                name,
                resolverKey: nameResolver.key,
                provider: nameResolver.provider,
                cache
            });
            if (cached) {
                value = cached.publicKey;
                break;
            }

            this.preResolveNameResolver({ address: name, resolveType, resolverKey: nameResolver.key });
            try {
                throwIfAbortSignalAborted(abortSignal);
                // Race resolve() against the abort signal so resolvers that ignore the signal still get
                // interrupted. raceAgainstAbort detaches its abort listener once the race settles regardless
                // of who wins, so it never leaks on the long-lived stop signal (see issue #144).
                const result = await raceAgainstAbort(nameResolver.resolve({ name, abortSignal }), abortSignal);
                throwIfAbortSignalAborted(abortSignal);
                value = result?.publicKey;
            } catch (e) {
                const error = isAbortError(e) ? e : (e as Error);
                this.postResolveNameResolverFailure({ address: name, resolveType, resolverKey: nameResolver.key, error });
                if (abortSignal?.aborted) throwIfAbortSignalAborted(abortSignal);
                if (isAbortError(error)) throw error;
                log.trace(`Resolver ${nameResolver.key} failed for ${name}`, error);
                continue;
            }
            this.postResolveNameResolverSuccess({ address: name, resolveType, resolverKey: nameResolver.key, resolvedValue: value });

            if (value) {
                // Persist successful network resolution. Failures are not persisted (callers retry).
                try {
                    await persistentCache.set({
                        name,
                        entry: {
                            publicKey: value,
                            resolverKey: nameResolver.key,
                            provider: nameResolver.provider,
                            resolvedAtMs: Date.now()
                        }
                    });
                } catch (e) {
                    log.error("Failed to write name resolution to persistent cache", name, e);
                }
                break;
            }
        }

        if (!anyResolverCanHandle) {
            throw new PKCError("ERR_NO_RESOLVER_FOR_NAME", { address: name });
        }

        return value || null;
    }

    async resolveCommunityNameIfNeeded({
        communityName,
        abortSignal,
        cache
    }: {
        communityName: string;
        abortSignal?: AbortSignal;
        cache?: NameResolveCacheOptions;
    }): Promise<string | null> {
        assert(typeof communityName === "string", "communityName needs to be a string to be resolved");
        if (!isStringDomain(communityName)) return communityName;
        const result = await this._resolveViaNameResolvers({ name: communityName, resolveType: "community", abortSignal, cache });
        if (typeof result === "string" && !isIpns(result))
            throw new PKCError("ERR_RESOLVED_TEXT_RECORD_TO_NON_IPNS", { resolvedTextRecord: result, address: communityName });
        return result;
    }

    async resolveAuthorNameIfNeeded({
        authorName,
        abortSignal,
        cache
    }: {
        authorName: string;
        abortSignal?: AbortSignal;
        cache?: NameResolveCacheOptions;
    }): Promise<{ resolvedAuthorName: string | null }> {
        if (!isStringDomain(authorName)) throw new PKCError("ERR_AUTHOR_ADDRESS_IS_NOT_A_DOMAIN_OR_B58", { authorAddress: authorName });
        const result = await this._resolveViaNameResolvers({ name: authorName, resolveType: "author", abortSignal, cache });
        if (typeof result === "string" && !isIpns(result))
            throw new PKCError("ERR_RESOLVED_TEXT_RECORD_TO_NON_IPNS", { resolvedTextRecord: result, address: authorName });
        return { resolvedAuthorName: result };
    }

    // Background author name resolution — fire-and-forget, populates nameResolvedCache
    resolveAuthorNamesInBackground({
        authors,
        onResolved,
        abortSignal
    }: {
        authors: Array<{ authorName: string; signaturePublicKey: string }>;
        onResolved: () => void;
        abortSignal?: AbortSignal;
    }): void {
        const log = Logger("pkc-js:base-client-manager:resolveAuthorNamesInBackground");
        const verificationCache = this._pkc._memCaches.nameResolvedCache;

        // Deduplicate and skip already-cached entries
        const seen = new Set<string>();
        const toResolve: Array<{ authorName: string; signaturePublicKey: string; cacheKey: string }> = [];
        for (const { authorName, signaturePublicKey } of authors) {
            if (!isStringDomain(authorName)) continue;
            const cacheKey = sha256(authorName + signaturePublicKey);
            if (seen.has(cacheKey)) continue;
            seen.add(cacheKey);
            if (typeof verificationCache.get(cacheKey) === "boolean") continue;
            toResolve.push({ authorName, signaturePublicKey, cacheKey });
        }

        if (toResolve.length === 0) return;

        const limit = pLimit(MAX_CONCURRENT_AUTHOR_NAME_RESOLUTIONS);
        const resolveOne = async (entry: (typeof toResolve)[0]) => {
            if (abortSignal?.aborted) return false;
            try {
                const { resolvedAuthorName: resolved } = await this.resolveAuthorNameIfNeeded({
                    authorName: entry.authorName,
                    abortSignal,
                    cache: { maxAge: 3600 }
                });
                if (typeof resolved !== "string") {
                    // null result: either no TXT record (definitive) or all resolvers errored (transient).
                    // _resolveViaNameResolvers cannot distinguish these today, so leave the verification cache
                    // undefined so the next pass retries. Failing-shut here would risk permanently rejecting an author after a brief outage.
                    return false;
                }
                const signerAddress = await getPKCAddressFromPublicKey(entry.signaturePublicKey);
                verificationCache.set(entry.cacheKey, resolved === signerAddress);
                return true; // newly set
            } catch (e) {
                if (isAbortError(e)) return false;
                if (e instanceof PKCError && e.code === "ERR_NO_RESOLVER_FOR_NAME") {
                    // Definitive: no resolver in this PKC instance handles this TLD. Cache as false.
                    verificationCache.set(entry.cacheKey, false);
                    return true; // newly set
                }
                log.error("Failed to resolve author name in background", entry.authorName, e);
                // Transient failure — leave undefined for retry on next update
                return false;
            }
        };

        Promise.allSettled(toResolve.map((entry) => limit(() => resolveOne(entry))))
            .then((results) => {
                const anyNewlySet = results.some((r) => r.status === "fulfilled" && r.value === true);
                if (anyNewlySet) onResolved();
            })
            .catch((e) => log.error("Unexpected error in resolveAuthorNamesInBackground", e));
    }

    // Misc functions
    emitError(e: PKCError) {
        this._pkc.emit("error", e);
    }

    calculateIpfsCid(content: string) {
        return calculateIpfsCidV0(content);
    }

    protected async _withInflightCommunityFetch(
        communityAddress: string,
        fetcher: () => Promise<ResultOfFetchingCommunity>
    ): Promise<ResultOfFetchingCommunity> {
        return this._pkc._inflightFetchManager.withResource(InflightResourceTypes.COMMUNITY_IPNS, communityAddress, fetcher);
    }
}

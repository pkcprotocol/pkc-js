import { Plebbit } from "../plebbit/plebbit.js";
import assert from "assert";
import { calculateIpfsCidV0, hideClassPrivateProps, isIpns, isStringDomain, throwWithErrorCode, timestamp } from "../util.js";
import { nativeFunctions } from "../runtime/node/util.js";
import pLimit from "p-limit";
import {
    FailedToFetchCommentIpfsFromGatewaysError,
    FailedToFetchCommentUpdateFromGatewaysError,
    FailedToFetchGenericIpfsFromGatewaysError,
    FailedToFetchPageIpfsFromGatewaysError,
    FailedToFetchSubplebbitFromGatewaysError,
    PlebbitError
} from "../plebbit-error.js";
import Logger from "@plebbit/plebbit-logger";
import type { PubsubMessage } from "../pubsub-messages/types.js";
import type { PubsubSubscriptionHandler, ResultOfFetchingSubplebbit } from "../types.js";
import * as cborg from "cborg";
import last from "it-last";
import { concat as uint8ArrayConcat } from "uint8arrays/concat";
import { toString as uint8ArrayToString } from "uint8arrays/to-string";
import all from "it-all";
import * as remeda from "remeda";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { CidPathSchema } from "../schema/schema.js";
import { CID } from "kubo-rpc-client";
import { convertBase58IpnsNameToBase36Cid } from "../signer/util.js";
import pTimeout from "p-timeout";
import { InflightResourceTypes } from "../util/inflight-fetch-manager.js";

export type LoadType = "subplebbit" | "comment-update" | "comment" | "page-ipfs" | "generic-ipfs";

type GenericGatewayFetch = {
    [gatewayUrl: string]: {
        abortController: AbortController;
        promise: Promise<any>;
        response?: string;
        error?: Error;
        timeoutId: any;
    };
};

export type CachedTextRecordResolve = { timestampSeconds: number; valueOfTextRecord: string };

export type OptionsToLoadFromGateway = {
    recordIpfsType: "ipfs" | "ipns";
    maxFileSizeBytes: number;
    requestHeaders?: Record<string, string>;
    root: string;
    path?: string;
    recordPlebbitType: LoadType;
    abortController: AbortController;
    timeoutMs: number;
    abortRequestErrorBeforeLoadingBodyFunc?: (res: Response) => Promise<PlebbitError | undefined>; // this is called before consuming the body of the gateway response. Can be used to abort and stop the consumption. Should provide an abort error
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

export class BaseClientsManager {
    // Class that has all function but without clients field for maximum interopability

    _plebbit: Plebbit;
    pubsubProviderSubscriptions: Record<string, string[]> = {}; // To keep track of subscriptions of each kubo pubsub provider/helia

    constructor(plebbit: Plebbit) {
        this._plebbit = plebbit;
        for (const provider of remeda.keys.strict(plebbit.clients.pubsubKuboRpcClients)) this.pubsubProviderSubscriptions[provider] = [];
        for (const provider of remeda.keys.strict(plebbit.clients.libp2pJsClients)) this.pubsubProviderSubscriptions[provider] = [];

        hideClassPrivateProps(this);
    }

    toJSON() {
        return undefined;
    }

    getDefaultPubsubKuboRpcClientOrHelia() {
        const defaultPubsubProviderUrl = remeda.keys.strict(this._plebbit.clients.pubsubKuboRpcClients)[0];
        if (defaultPubsubProviderUrl) return this._plebbit.clients.pubsubKuboRpcClients[defaultPubsubProviderUrl];
        const defaultLibp2pJsClient = remeda.keys.strict(this._plebbit.clients.libp2pJsClients)[0];
        if (defaultLibp2pJsClient) return this._plebbit.clients.libp2pJsClients[defaultLibp2pJsClient];
        throw new PlebbitError("ERR_NO_DEFAULT_PUBSUB_PROVIDER", {
            pubsubKuboRpcClients: this._plebbit.clients.pubsubKuboRpcClients,
            libp2pJsClients: this._plebbit.clients.libp2pJsClients
        });
    }

    getDefaultKuboRpcClientOrHelia(): Plebbit["clients"]["kuboRpcClients"][string] | Plebbit["clients"]["libp2pJsClients"][string] {
        const defaultKuboRpcClient = remeda.keys.strict(this._plebbit.clients.kuboRpcClients)[0];
        if (defaultKuboRpcClient) return this._plebbit.clients.kuboRpcClients[defaultKuboRpcClient];
        const defaultLibp2pJsClient = remeda.keys.strict(this._plebbit.clients.libp2pJsClients)[0];
        if (defaultLibp2pJsClient) return this._plebbit.clients.libp2pJsClients[defaultLibp2pJsClient];
        throw new PlebbitError("ERR_NO_DEFAULT_IPFS_PROVIDER", {
            kuboRpcClients: this._plebbit.clients.kuboRpcClients,
            libp2pJsClients: this._plebbit.clients.libp2pJsClients
        });
    }

    getDefaultKuboRpcClient() {
        const defaultKuboRpcClient = remeda.keys.strict(this._plebbit.clients.kuboRpcClients)[0];
        if (defaultKuboRpcClient) return this._plebbit.clients.kuboRpcClients[defaultKuboRpcClient];
        throw new PlebbitError("ERR_NO_DEFAULT_KUBO_RPC_IPFS_PROVIDER", {
            kuboRpcClients: this._plebbit.clients.kuboRpcClients,
            libp2pJsClients: this._plebbit.clients.libp2pJsClients
        });
    }

    getDefaultKuboPubsubClient() {
        const defaultKuboPubsubClient = remeda.keys.strict(this._plebbit.clients.pubsubKuboRpcClients)[0];
        if (defaultKuboPubsubClient) return this._plebbit.clients.pubsubKuboRpcClients[defaultKuboPubsubClient];
        throw new PlebbitError("ERR_NO_DEFAULT_KUBO_RPC_PUBSUB_PROVIDER", {
            pubsubKuboRpcClients: this._plebbit.clients.pubsubKuboRpcClients
        });
    }

    getIpfsClientWithKuboRpcClientFunctions() {
        const defaultKuboRpcClient = remeda.keys.strict(this._plebbit.clients.kuboRpcClients)[0];
        if (defaultKuboRpcClient) return this._plebbit.clients.kuboRpcClients[defaultKuboRpcClient]._client;
        const defaultLibp2pJsClient = remeda.keys.strict(this._plebbit.clients.libp2pJsClients)[0];
        if (defaultLibp2pJsClient) return this._plebbit.clients.libp2pJsClients[defaultLibp2pJsClient].heliaWithKuboRpcClientFunctions;
        throw new PlebbitError("ERR_NO_DEFAULT_IPFS_PROVIDER", {
            kuboRpcClients: this._plebbit.clients.kuboRpcClients,
            libp2pJsClients: this._plebbit.clients.libp2pJsClients
        });
    }

    // Pubsub methods

    async pubsubSubscribeOnProvider(pubsubTopic: string, handler: PubsubSubscriptionHandler, kuboPubsubRpcUrlOrLibp2pJsKey: string) {
        const log = Logger("plebbit-js:plebbit:client-manager:pubsubSubscribeOnProvider");

        const pubsubClient =
            this._plebbit.clients.libp2pJsClients[kuboPubsubRpcUrlOrLibp2pJsKey]?.heliaWithKuboRpcClientFunctions ||
            this._plebbit.clients.pubsubKuboRpcClients[kuboPubsubRpcUrlOrLibp2pJsKey]._client;
        if (!pubsubClient) throw new PlebbitError("ERR_INVALID_PUBSUB_PROVIDER", { pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey });

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

            await this._plebbit._stats.recordGatewayFailure(kuboPubsubRpcUrlOrLibp2pJsKey, "pubsub-subscribe");
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
            await this._plebbit._stats.recordGatewaySuccess(kuboPubsubRpcUrlOrLibp2pJsKey, "pubsub-subscribe", Date.now() - timeBefore);
            this.pubsubProviderSubscriptions[kuboPubsubRpcUrlOrLibp2pJsKey].push(pubsubTopic);
        } catch (e) {
            //@ts-expect-error
            e.details = { ...e.details, pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey, pubsubTopic };
            if ((e as Error).message?.startsWith("Already subscribed to")) {
                this.pubsubProviderSubscriptions[kuboPubsubRpcUrlOrLibp2pJsKey].push(pubsubTopic);
                return;
            }
            await this._plebbit._stats.recordGatewayFailure(kuboPubsubRpcUrlOrLibp2pJsKey, "pubsub-subscribe");
            log.error(`Failed to subscribe to pubsub topic (${pubsubTopic}) to (${kuboPubsubRpcUrlOrLibp2pJsKey}) due to error`, e);
            throw e;
        }
    }

    async pubsubSubscribe(pubsubTopic: string, handler: PubsubSubscriptionHandler) {
        const providersSorted = await this._plebbit._stats.sortGatewaysAccordingToScore("pubsub-subscribe");
        const providerToError: Record<string, PlebbitError> = {};

        for (let i = 0; i < providersSorted.length; i++) {
            const pubsubProviderUrl = providersSorted[i];
            try {
                return this.pubsubSubscribeOnProvider(pubsubTopic, handler, pubsubProviderUrl);
            } catch (e: unknown) {
                providerToError[pubsubProviderUrl] = <PlebbitError>e;
            }
        }

        const combinedError = new PlebbitError("ERR_PUBSUB_FAILED_TO_SUBSCRIBE", { pubsubTopic, providerToError });

        this.emitError(combinedError);
        throw combinedError;
    }

    async pubsubUnsubscribeOnProvider(pubsubTopic: string, kuboPubsubRpcUrlOrLibp2pJsKey: string, handler?: PubsubSubscriptionHandler) {
        const pubsubClient =
            this._plebbit.clients.libp2pJsClients[kuboPubsubRpcUrlOrLibp2pJsKey]?.heliaWithKuboRpcClientFunctions ||
            this._plebbit.clients.pubsubKuboRpcClients[kuboPubsubRpcUrlOrLibp2pJsKey]._client;
        if (!pubsubClient) throw new PlebbitError("ERR_INVALID_PUBSUB_PROVIDER", { pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey });

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
        for (const pubsubProviderUrl of remeda.keys.strict(this._plebbit.clients.pubsubKuboRpcClients)) {
            try {
                await this.pubsubUnsubscribeOnProvider(pubsubTopic, pubsubProviderUrl, handler);
            } catch (e) {
                await this._plebbit._stats.recordGatewayFailure(pubsubProviderUrl, "pubsub-unsubscribe");
                //@ts-expect-error
                e.details = { ...e.details, pubsubProviderUrl, pubsubTopic };
                this.emitError(<PlebbitError>e);
            }
        }
    }

    async pubsubPublishOnProvider(pubsubTopic: string, data: PubsubMessage, kuboPubsubRpcUrlOrLibp2pJsKey: string) {
        const log = Logger("plebbit-js:plebbit:pubsubPublish");
        const pubsubClient =
            this._plebbit.clients.libp2pJsClients[kuboPubsubRpcUrlOrLibp2pJsKey]?.heliaWithKuboRpcClientFunctions ||
            this._plebbit.clients.pubsubKuboRpcClients[kuboPubsubRpcUrlOrLibp2pJsKey]._client;
        if (!pubsubClient) throw new PlebbitError("ERR_INVALID_PUBSUB_PROVIDER", { pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey });

        const dataBinary = cborg.encode(data);
        const timeBefore = Date.now();
        try {
            await pubsubClient.pubsub.publish(pubsubTopic, dataBinary);
            this._plebbit._stats.recordGatewaySuccess(kuboPubsubRpcUrlOrLibp2pJsKey, "pubsub-publish", Date.now() - timeBefore); // Awaiting this statement will bug out tests
        } catch (error) {
            //@ts-expect-error
            error.details = { ...error.details, pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey, pubsubTopic };
            await this._plebbit._stats.recordGatewayFailure(kuboPubsubRpcUrlOrLibp2pJsKey, "pubsub-publish");
            throw error;
        }
    }

    async pubsubPublish(pubsubTopic: string, data: PubsubMessage): Promise<void> {
        const log = Logger("plebbit-js:plebbit:client-manager:pubsubPublish");
        const providersSorted = await this._plebbit._stats.sortGatewaysAccordingToScore("pubsub-publish");
        if (providersSorted.length === 0)
            throw new PlebbitError("ERR_NO_PUBSUB_PROVIDERS_AVAILABLE_TO_PUBLISH_OVER_PUBSUB", { pubsubTopic, data });
        const providerToError: Record<string, PlebbitError> = {};

        for (let i = 0; i < providersSorted.length; i++) {
            const pubsubProviderUrl = providersSorted[i];
            try {
                return await this.pubsubPublishOnProvider(pubsubTopic, data, pubsubProviderUrl);
            } catch (e) {
                log.error(`Failed to publish to pubsub topic (${pubsubTopic}) to (${pubsubProviderUrl})`);
                providerToError[pubsubProviderUrl] = <PlebbitError>e;
            }
        }

        const combinedError = new PlebbitError("ERR_PUBSUB_FAILED_TO_PUBLISH", { pubsubTopic, data, providerToError });

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
    ): Promise<{ resText: string | undefined; res: Response; abortError?: PlebbitError }> {
        // Node-fetch will take care of size limits through options.size, while browsers will process stream manually

        const handleError = (e: Error | PlebbitError) => {
            const nodeError = <NodeJS.ErrnoException & { address?: string; port?: number; cause?: unknown }>(<unknown>e);
            if (e instanceof PlebbitError) throw e;
            else if (e instanceof Error && e.message.includes("over limit"))
                throw new PlebbitError("ERR_OVER_DOWNLOAD_LIMIT", { url, options });
            else if (options.signal?.aborted) throw new PlebbitError("ERR_GATEWAY_TIMED_OUT_OR_ABORTED", { url, options });
            else {
                const errorCode =
                    url.includes("/ipfs/") || url.includes(".ipfs.")
                        ? "ERR_FAILED_TO_FETCH_IPFS_VIA_GATEWAY"
                        : url.includes("/ipns/") || url.includes(".ipns.")
                          ? "ERR_FAILED_TO_FETCH_IPNS_VIA_GATEWAY"
                          : "ERR_FAILED_TO_FETCH_GENERIC";
                throw new PlebbitError(errorCode, {
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
                throw new PlebbitError("ERR_OVER_DOWNLOAD_LIMIT", { url, options, res, sizeHeader });

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
                        throw new PlebbitError("ERR_OVER_DOWNLOAD_LIMIT", { url, options });
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

    postFetchGatewayFailure(gatewayUrl: string, loadOpts: OptionsToLoadFromGateway, error: PlebbitError) {}

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
    ): Promise<{ res: Response; resText: string | undefined } | { error: PlebbitError }> {
        const log = Logger("plebbit-js:plebbit:fetchWithGateway");

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

            this._plebbit._stats
                .recordGatewaySuccess(gateway, loadOpts.recordIpfsType, Date.now() - timeBefore)
                .catch((err) => log.error("Failed to report gateway success", err));
            this._handleIfGatewayRedirectsToSubdomainResolution(gateway, loadOpts, resObj.res, log);
            return resObj;
        } catch (e) {
            //@ts-expect-error
            e.details = { ...e.details, url, loadOpts, wasRequestAborted: loadOpts.abortController.signal.aborted };

            this.postFetchGatewayFailure(gateway, loadOpts, <PlebbitError>e);
            this._plebbit._stats
                .recordGatewayFailure(gateway, loadOpts.recordIpfsType)
                .catch((err) => log.error("failed to report gateway error", err));
            return { error: <PlebbitError>e };
        }
    }

    protected _firstResolve(promises: Promise<{ res: Response; resText: string } | { error: PlebbitError }>[]) {
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
        loadOpts: Omit<OptionsToLoadFromGateway, "abortController">
    ): Promise<{ resText: string; res: Response }> {
        const timeoutMs = loadOpts.timeoutMs;
        const concurrencyLimit = 3;

        const queueLimit = pLimit(concurrencyLimit);

        // Only sort if we have more than 3 gateways
        const gatewaysSorted =
            remeda.keys.strict(this._plebbit.clients.ipfsGateways).length <= concurrencyLimit
                ? remeda.keys.strict(this._plebbit.clients.ipfsGateways)
                : await this._plebbit._stats.sortGatewaysAccordingToScore(loadOpts.recordIpfsType);

        const gatewayFetches: GenericGatewayFetch = {};

        const cleanUp = () => {
            queueLimit.clearQueue();
            Object.values(gatewayFetches).map((gateway) => {
                if (!gateway.response && !gateway.error) gateway.abortController.abort();
                clearTimeout(gateway.timeoutId);
            });
        };

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
        const res: { res: { resText: string; res: Response }; i: number } | { value: { error: PlebbitError } }[] = await Promise.race([
            this._firstResolve(gatewayPromises),
            Promise.allSettled(gatewayPromises)
        ]);
        if (Array.isArray(res)) {
            cleanUp();
            const gatewayToError: Record<string, PlebbitError> = {};
            for (let i = 0; i < res.length; i++) if (res[i]["value"]) gatewayToError[gatewaysSorted[i]] = res[i]["value"].error;

            const combinedError =
                loadOpts.recordPlebbitType === "comment"
                    ? new FailedToFetchCommentIpfsFromGatewaysError({ commentCid: loadOpts.root, gatewayToError, loadOpts })
                    : loadOpts.recordPlebbitType === "comment-update"
                      ? new FailedToFetchCommentUpdateFromGatewaysError({ gatewayToError, loadOpts })
                      : loadOpts.recordPlebbitType === "page-ipfs"
                        ? new FailedToFetchPageIpfsFromGatewaysError({ pageCid: loadOpts.root, gatewayToError, loadOpts })
                        : loadOpts.recordPlebbitType === "subplebbit"
                          ? new FailedToFetchSubplebbitFromGatewaysError({ ipnsName: loadOpts.root, gatewayToError, loadOpts })
                          : new FailedToFetchGenericIpfsFromGatewaysError({ cid: loadOpts.root, gatewayToError, loadOpts });

            throw combinedError;
        } else {
            cleanUp();
            return res.res;
        }
    }

    // IPFS P2P methods
    async resolveIpnsToCidP2P(ipnsName: string, loadOpts: { timeoutMs: number }): Promise<string> {
        const ipnsResolveOpts = { nocache: true, recursive: true, ...loadOpts };
        const ipfsClient = this.getIpfsClientWithKuboRpcClientFunctions();

        const performIpnsResolve = async () => {
            const resolvedCidOfIpns: string | undefined = await last(ipfsClient.name.resolve(ipnsName, ipnsResolveOpts));

            if (!resolvedCidOfIpns)
                throw new PlebbitError("ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED", {
                    resolvedCidOfIpns,
                    ipnsName,
                    ipnsResolveOpts
                });

            return CidPathSchema.parse(resolvedCidOfIpns);
        };
        try {
            // Wrap the resolution function with pTimeout because kubo-rpc-client doesn't support timeout for IPNS
            const result = await pTimeout(performIpnsResolve(), {
                milliseconds: loadOpts.timeoutMs,
                message: new PlebbitError("ERR_IPNS_RESOLUTION_P2P_TIMEOUT", {
                    ipnsName,
                    ipnsResolveOpts
                })
            });

            return result;
        } catch (error) {
            //@ts-expect-error
            error.details = { ...error.details, ipnsName, ipnsResolveOpts };
            // Wrap ETIMEDOUT in PlebbitError so _isRetriableErrorWhenLoading recognizes it as retriable
            if (error instanceof Error && "cause" in error && (error.cause as { code?: string })?.code === "ETIMEDOUT") {
                throw new PlebbitError("ERR_FAILED_TO_RESOLVE_IPNS_VIA_IPFS_P2P", {
                    ipnsName,
                    ipnsResolveOpts,
                    error,
                    errorMessage: error.message,
                    errorName: error.name
                });
            }
            throw error;
        }

        throw Error("Should not reach this block in resolveIpnsToCidP2P");
    }

    // TODO rename this to _fetchPathP2P

    async _fetchCidP2P(cidV0: string, loadOpts: { maxFileSizeBytes: number; timeoutMs: number }): Promise<string> {
        const kuboRpcOrHelia = this.getDefaultKuboRpcClientOrHelia();

        const ipfsClient = this.getIpfsClientWithKuboRpcClientFunctions();

        const fetchPromise = async () => {
            const rawData = await all(ipfsClient.cat(cidV0, { length: loadOpts.maxFileSizeBytes, timeout: `${loadOpts.timeoutMs}ms` }));
            const data = uint8ArrayConcat(rawData);
            const fileContent = uint8ArrayToString(data);

            if (typeof fileContent !== "string")
                throw new PlebbitError("ERR_FAILED_TO_FETCH_IPFS_CID_VIA_IPFS_P2P", { cid: cidV0, loadOpts });
            if (data.byteLength === loadOpts.maxFileSizeBytes) {
                const calculatedCid: string = await calculateIpfsHash(fileContent);
                if (calculatedCid !== cidV0)
                    throw new PlebbitError("ERR_OVER_DOWNLOAD_LIMIT", {
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
                message: new PlebbitError("ERR_FETCH_CID_P2P_TIMEOUT", { cid: cidV0, loadOpts })
            });
            return result;
        } catch (e) {
            if (e instanceof PlebbitError) throw e;
            else if (e instanceof Error && e.name === "TimeoutError")
                throw new PlebbitError("ERR_FETCH_CID_P2P_TIMEOUT", { cid: cidV0, error: e, loadOpts });
            else
                throw new PlebbitError("ERR_FAILED_TO_FETCH_IPFS_CID_VIA_IPFS_P2P", {
                    cid: cidV0,
                    error: e,
                    errorMessage: (e as Error)?.message,
                    errorName: (e as Error)?.name,
                    errorCode: (e as { code?: string })?.code,
                    loadOpts
                });
        }
    }

    private async _verifyGatewayResponseMatchesCid(
        gatewayResponseBody: string,
        cid: string,
        loadOpts: Pick<OptionsToLoadFromGateway, "maxFileSizeBytes">
    ) {
        const calculatedCid: string = await calculateIpfsHash(gatewayResponseBody);
        if (gatewayResponseBody.length === loadOpts.maxFileSizeBytes && calculatedCid !== cid)
            throw new PlebbitError("ERR_OVER_DOWNLOAD_LIMIT", { cid, loadOpts, gatewayResponseBody });
        if (calculatedCid !== cid)
            throw new PlebbitError("ERR_CALCULATED_CID_DOES_NOT_MATCH", { calculatedCid, cid, gatewayResponseBody, loadOpts });
    }

    // Resolver methods here

    _getKeyOfCachedDomainTextRecord(domainAddress: string, txtRecord: string) {
        return `${domainAddress}_${txtRecord}`;
    }

    private async _getCachedTextRecord(address: string, txtRecord: "subplebbit-address" | "plebbit-author-address") {
        const cacheKey = this._getKeyOfCachedDomainTextRecord(address, txtRecord);

        const resolveCache: CachedTextRecordResolve | undefined = await this._plebbit._storage.getItem(cacheKey);
        if (remeda.isPlainObject(resolveCache)) {
            const stale = timestamp() - resolveCache.timestampSeconds > 3600; // Only resolve again if cache was stored over an hour ago
            return { stale, ...resolveCache };
        }
        return undefined;
    }

    private async _resolveTextRecordWithCache(
        address: string,
        txtRecord: "subplebbit-address" | "plebbit-author-address"
    ): Promise<string | null> {
        const log = Logger("plebbit-js:client-manager:resolveTextRecord");
        const cachedTextRecord = await this._getCachedTextRecord(address, txtRecord);
        if (cachedTextRecord) {
            if (cachedTextRecord.stale)
                this._resolveViaNameResolvers({ address, txtRecordName: txtRecord })
                    .then((newValue) => {
                        if (typeof newValue === "string") {
                            const cache: CachedTextRecordResolve = { timestampSeconds: timestamp(), valueOfTextRecord: newValue };
                            return this._plebbit._storage.setItem(this._getKeyOfCachedDomainTextRecord(address, txtRecord), cache);
                        }
                    })
                    .then(() => log.trace(`Updated stale text-record of (${address})`))
                    .catch((err) => log.error(`Failed to update stale text record of (${address})`, err));
            return cachedTextRecord.valueOfTextRecord;
        }
        const result = await this._resolveViaNameResolvers({ address, txtRecordName: txtRecord });
        if (typeof result === "string") {
            if (!isIpns(result)) throwWithErrorCode("ERR_RESOLVED_TEXT_RECORD_TO_NON_IPNS", { resolvedTextRecord: result, address });
            const cache: CachedTextRecordResolve = { timestampSeconds: timestamp(), valueOfTextRecord: result };
            await this._plebbit._storage.setItem(this._getKeyOfCachedDomainTextRecord(address, txtRecord), cache);
        }
        return result || null;
    }

    // Name resolver hooks — overridden by PlebbitClientsManager and subclass client managers
    preResolveNameResolver(
        address: string,
        txtRecordName: "subplebbit-address" | "plebbit-author-address",
        resolverKey: string,
        staleCache?: CachedTextRecordResolve
    ) {}
    postResolveNameResolverSuccess(
        address: string,
        txtRecordName: "subplebbit-address" | "plebbit-author-address",
        resolvedValue: string | undefined,
        resolverKey: string,
        staleCache?: CachedTextRecordResolve
    ) {}
    postResolveNameResolverFailure(
        address: string,
        txtRecordName: "subplebbit-address" | "plebbit-author-address",
        resolverKey: string,
        error: Error,
        staleCache?: CachedTextRecordResolve
    ) {}

    private async _resolveViaNameResolvers({
        address,
        txtRecordName,
        staleCache
    }: {
        address: string;
        txtRecordName: "subplebbit-address" | "plebbit-author-address";
        staleCache?: CachedTextRecordResolve;
    }): Promise<string | null> {
        const log = Logger("plebbit-js:client-manager:_resolveViaNameResolvers");
        const nameResolvers = this._plebbit.nameResolvers;
        if (!nameResolvers || nameResolvers.length === 0) {
            throwWithErrorCode("ERR_NO_RESOLVER_FOR_NAME", { address });
        }

        let value: string | undefined;
        let anyResolverCanHandle = false;

        for (const nameResolver of nameResolvers) {
            if (!nameResolver.canResolve({ name: address })) continue;
            anyResolverCanHandle = true;

            this.preResolveNameResolver(address, txtRecordName, nameResolver.key, staleCache);
            try {
                const result = await nameResolver.resolve({ name: address, provider: nameResolver.provider });
                value = result?.publicKey;
            } catch (e) {
                log.error(`Resolver ${nameResolver.key} failed for ${address}`, e);
                this.postResolveNameResolverFailure(address, txtRecordName, nameResolver.key, e as Error, staleCache);
                continue;
            }
            this.postResolveNameResolverSuccess(address, txtRecordName, value, nameResolver.key, staleCache);

            if (value) break;
        }

        if (!anyResolverCanHandle) {
            throwWithErrorCode("ERR_NO_RESOLVER_FOR_NAME", { address });
        }

        return value || null;
    }

    async resolveSubplebbitAddressIfNeeded(subplebbitAddress: string): Promise<string | null> {
        assert(typeof subplebbitAddress === "string", "subplebbitAddress needs to be a string to be resolved");
        if (!isStringDomain(subplebbitAddress)) return subplebbitAddress;
        return this._resolveTextRecordWithCache(subplebbitAddress, "subplebbit-address");
    }

    async clearDomainCache(domainAddress: string, txtRecordName: "subplebbit-address" | "plebbit-author-address") {
        const cacheKey = this._getKeyOfCachedDomainTextRecord(domainAddress, txtRecordName);
        await this._plebbit._storage.removeItem(cacheKey);
    }

    async resolveAuthorAddressIfNeeded(authorAddress: string): Promise<string | null> {
        if (!isStringDomain(authorAddress)) throw new PlebbitError("ERR_AUTHOR_ADDRESS_IS_NOT_A_DOMAIN_OR_B58", { authorAddress });
        return this._resolveTextRecordWithCache(authorAddress, "plebbit-author-address");
    }

    // Misc functions
    emitError(e: PlebbitError) {
        this._plebbit.emit("error", e);
    }

    calculateIpfsCid(content: string) {
        return calculateIpfsCidV0(content);
    }

    protected async _withInflightSubplebbitFetch(
        subAddress: string,
        fetcher: () => Promise<ResultOfFetchingSubplebbit>
    ): Promise<ResultOfFetchingSubplebbit> {
        return this._plebbit._inflightFetchManager.withResource(InflightResourceTypes.SUBPLEBBIT_IPNS, subAddress, fetcher);
    }
}

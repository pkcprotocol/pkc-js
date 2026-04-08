import assert from "assert";
import { calculateIpfsCidV0, hideClassPrivateProps, isAbortError, isIpns, isStringDomain, throwIfAbortSignalAborted } from "../util.js";
import { sha256 } from "js-sha256";
import { getPKCAddressFromPublicKey } from "../signer/util.js";
import { nativeFunctions } from "../runtime/browser/util.js";
import pLimit from "p-limit";
import { FailedToFetchCommentIpfsFromGatewaysError, FailedToFetchCommentUpdateFromGatewaysError, FailedToFetchGenericIpfsFromGatewaysError, FailedToFetchPageIpfsFromGatewaysError, FailedToFetchCommunityFromGatewaysError, PKCError } from "../pkc-error.js";
import Logger from "../logger.js";
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
const createUrlFromPathResolution = (gateway, opts) => {
    const root = opts.recordIpfsType === "ipfs" ? CID.parse(opts.root).toV1().toString() : convertBase58IpnsNameToBase36Cid(opts.root);
    return `${gateway}/${opts.recordIpfsType}/${root}${opts.path ? "/" + opts.path : ""}`;
};
const createUrlFromSubdomainResolution = (gateway, opts) => {
    const gatewayUrl = new URL(gateway);
    const root = opts.recordIpfsType === "ipfs"
        ? CID.parse(opts.root).toV1().toString()
        : opts.recordIpfsType === "ipns"
            ? convertBase58IpnsNameToBase36Cid(opts.root)
            : opts.root;
    return `${gatewayUrl.protocol}//${root}.${opts.recordIpfsType}.${gatewayUrl.host}${opts.path ? "/" + opts.path : ""}`;
};
const GATEWAYS_THAT_SUPPORT_SUBDOMAIN_RESOLUTION = {}; // gateway url -> whether it supports subdomain resolution
export class BaseClientsManager {
    constructor(pkc) {
        this.pubsubProviderSubscriptions = {}; // To keep track of subscriptions of each kubo pubsub provider/helia
        this._pkc = pkc;
        for (const provider of remeda.keys.strict(pkc.clients.pubsubKuboRpcClients))
            this.pubsubProviderSubscriptions[provider] = [];
        for (const provider of remeda.keys.strict(pkc.clients.libp2pJsClients))
            this.pubsubProviderSubscriptions[provider] = [];
        hideClassPrivateProps(this);
    }
    toJSON() {
        return undefined;
    }
    getDefaultPubsubKuboRpcClientOrHelia() {
        const defaultPubsubProviderUrl = remeda.keys.strict(this._pkc.clients.pubsubKuboRpcClients)[0];
        if (defaultPubsubProviderUrl)
            return this._pkc.clients.pubsubKuboRpcClients[defaultPubsubProviderUrl];
        const defaultLibp2pJsClient = remeda.keys.strict(this._pkc.clients.libp2pJsClients)[0];
        if (defaultLibp2pJsClient)
            return this._pkc.clients.libp2pJsClients[defaultLibp2pJsClient];
        throw new PKCError("ERR_NO_DEFAULT_PUBSUB_PROVIDER", {
            pubsubKuboRpcClients: this._pkc.clients.pubsubKuboRpcClients,
            libp2pJsClients: this._pkc.clients.libp2pJsClients
        });
    }
    getDefaultKuboRpcClientOrHelia() {
        const defaultKuboRpcClient = remeda.keys.strict(this._pkc.clients.kuboRpcClients)[0];
        if (defaultKuboRpcClient)
            return this._pkc.clients.kuboRpcClients[defaultKuboRpcClient];
        const defaultLibp2pJsClient = remeda.keys.strict(this._pkc.clients.libp2pJsClients)[0];
        if (defaultLibp2pJsClient)
            return this._pkc.clients.libp2pJsClients[defaultLibp2pJsClient];
        throw new PKCError("ERR_NO_DEFAULT_IPFS_PROVIDER", {
            kuboRpcClients: this._pkc.clients.kuboRpcClients,
            libp2pJsClients: this._pkc.clients.libp2pJsClients
        });
    }
    getDefaultKuboRpcClient() {
        const defaultKuboRpcClient = remeda.keys.strict(this._pkc.clients.kuboRpcClients)[0];
        if (defaultKuboRpcClient)
            return this._pkc.clients.kuboRpcClients[defaultKuboRpcClient];
        throw new PKCError("ERR_NO_DEFAULT_KUBO_RPC_IPFS_PROVIDER", {
            kuboRpcClients: this._pkc.clients.kuboRpcClients,
            libp2pJsClients: this._pkc.clients.libp2pJsClients
        });
    }
    getDefaultKuboPubsubClient() {
        const defaultKuboPubsubClient = remeda.keys.strict(this._pkc.clients.pubsubKuboRpcClients)[0];
        if (defaultKuboPubsubClient)
            return this._pkc.clients.pubsubKuboRpcClients[defaultKuboPubsubClient];
        throw new PKCError("ERR_NO_DEFAULT_KUBO_RPC_PUBSUB_PROVIDER", {
            pubsubKuboRpcClients: this._pkc.clients.pubsubKuboRpcClients
        });
    }
    getIpfsClientWithKuboRpcClientFunctions() {
        const defaultKuboRpcClient = remeda.keys.strict(this._pkc.clients.kuboRpcClients)[0];
        if (defaultKuboRpcClient)
            return this._pkc.clients.kuboRpcClients[defaultKuboRpcClient]._client;
        const defaultLibp2pJsClient = remeda.keys.strict(this._pkc.clients.libp2pJsClients)[0];
        if (defaultLibp2pJsClient)
            return this._pkc.clients.libp2pJsClients[defaultLibp2pJsClient].heliaWithKuboRpcClientFunctions;
        throw new PKCError("ERR_NO_DEFAULT_IPFS_PROVIDER", {
            kuboRpcClients: this._pkc.clients.kuboRpcClients,
            libp2pJsClients: this._pkc.clients.libp2pJsClients
        });
    }
    // Pubsub methods
    async pubsubSubscribeOnProvider(pubsubTopic, handler, kuboPubsubRpcUrlOrLibp2pJsKey) {
        const log = Logger("pkc-js:pkc:client-manager:pubsubSubscribeOnProvider");
        const pubsubClient = this._pkc.clients.libp2pJsClients[kuboPubsubRpcUrlOrLibp2pJsKey]?.heliaWithKuboRpcClientFunctions ||
            this._pkc.clients.pubsubKuboRpcClients[kuboPubsubRpcUrlOrLibp2pJsKey]._client;
        if (!pubsubClient)
            throw new PKCError("ERR_INVALID_PUBSUB_PROVIDER", { pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey });
        const timeBefore = Date.now();
        const handlePubsubError = async (err) => {
            error = err;
            log.error("pubsub callback error, topic", pubsubTopic, "provider url", kuboPubsubRpcUrlOrLibp2pJsKey, "error", err, "Will unsubscribe and re-attempt to subscribe");
            await this._pkc._stats.recordGatewayFailure(kuboPubsubRpcUrlOrLibp2pJsKey, "pubsub-subscribe");
            try {
                await this.pubsubUnsubscribeOnProvider(pubsubTopic, kuboPubsubRpcUrlOrLibp2pJsKey, handler);
            }
            catch (e) {
                log.error("Failed to unsubscribe after onError, topic", pubsubTopic, "provider url", kuboPubsubRpcUrlOrLibp2pJsKey, e);
            }
            await this.pubsubSubscribeOnProvider(pubsubTopic, handler, kuboPubsubRpcUrlOrLibp2pJsKey);
        };
        let error;
        try {
            await pubsubClient.pubsub.subscribe(pubsubTopic, handler, { onError: handlePubsubError });
            if (error)
                throw error;
            await this._pkc._stats.recordGatewaySuccess(kuboPubsubRpcUrlOrLibp2pJsKey, "pubsub-subscribe", Date.now() - timeBefore);
            this.pubsubProviderSubscriptions[kuboPubsubRpcUrlOrLibp2pJsKey].push(pubsubTopic);
        }
        catch (e) {
            //@ts-expect-error
            e.details = { ...e.details, pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey, pubsubTopic };
            if (e.message?.startsWith("Already subscribed to")) {
                this.pubsubProviderSubscriptions[kuboPubsubRpcUrlOrLibp2pJsKey].push(pubsubTopic);
                return;
            }
            await this._pkc._stats.recordGatewayFailure(kuboPubsubRpcUrlOrLibp2pJsKey, "pubsub-subscribe");
            log.error(`Failed to subscribe to pubsub topic (${pubsubTopic}) to (${kuboPubsubRpcUrlOrLibp2pJsKey}) due to error`, e);
            throw e;
        }
    }
    async pubsubSubscribe(pubsubTopic, handler) {
        const providersSorted = await this._pkc._stats.sortGatewaysAccordingToScore("pubsub-subscribe");
        const providerToError = {};
        for (let i = 0; i < providersSorted.length; i++) {
            const pubsubProviderUrl = providersSorted[i];
            try {
                return this.pubsubSubscribeOnProvider(pubsubTopic, handler, pubsubProviderUrl);
            }
            catch (e) {
                providerToError[pubsubProviderUrl] = e;
            }
        }
        const combinedError = new PKCError("ERR_PUBSUB_FAILED_TO_SUBSCRIBE", { pubsubTopic, providerToError });
        this.emitError(combinedError);
        throw combinedError;
    }
    async pubsubUnsubscribeOnProvider(pubsubTopic, kuboPubsubRpcUrlOrLibp2pJsKey, handler) {
        const pubsubClient = this._pkc.clients.libp2pJsClients[kuboPubsubRpcUrlOrLibp2pJsKey]?.heliaWithKuboRpcClientFunctions ||
            this._pkc.clients.pubsubKuboRpcClients[kuboPubsubRpcUrlOrLibp2pJsKey]._client;
        if (!pubsubClient)
            throw new PKCError("ERR_INVALID_PUBSUB_PROVIDER", { pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey });
        try {
            await pubsubClient.pubsub.unsubscribe(pubsubTopic, handler);
            this.pubsubProviderSubscriptions[kuboPubsubRpcUrlOrLibp2pJsKey] = this.pubsubProviderSubscriptions[kuboPubsubRpcUrlOrLibp2pJsKey].filter((subPubsubTopic) => subPubsubTopic !== pubsubTopic);
        }
        catch (e) {
            //@ts-expect-error
            e.details = { ...e.details, pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey, pubsubTopic };
            throw e;
        }
    }
    async pubsubUnsubscribe(pubsubTopic, handler) {
        for (const pubsubProviderUrl of remeda.keys.strict(this._pkc.clients.pubsubKuboRpcClients)) {
            try {
                await this.pubsubUnsubscribeOnProvider(pubsubTopic, pubsubProviderUrl, handler);
            }
            catch (e) {
                await this._pkc._stats.recordGatewayFailure(pubsubProviderUrl, "pubsub-unsubscribe");
                //@ts-expect-error
                e.details = { ...e.details, pubsubProviderUrl, pubsubTopic };
                this.emitError(e);
            }
        }
    }
    async pubsubPublishOnProvider(pubsubTopic, data, kuboPubsubRpcUrlOrLibp2pJsKey) {
        const log = Logger("pkc-js:pkc:pubsubPublish");
        const pubsubClient = this._pkc.clients.libp2pJsClients[kuboPubsubRpcUrlOrLibp2pJsKey]?.heliaWithKuboRpcClientFunctions ||
            this._pkc.clients.pubsubKuboRpcClients[kuboPubsubRpcUrlOrLibp2pJsKey]._client;
        if (!pubsubClient)
            throw new PKCError("ERR_INVALID_PUBSUB_PROVIDER", { pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey });
        const dataBinary = cborg.encode(data);
        const timeBefore = Date.now();
        try {
            await pubsubClient.pubsub.publish(pubsubTopic, dataBinary);
            this._pkc._stats.recordGatewaySuccess(kuboPubsubRpcUrlOrLibp2pJsKey, "pubsub-publish", Date.now() - timeBefore); // Awaiting this statement will bug out tests
        }
        catch (error) {
            //@ts-expect-error
            error.details = { ...error.details, pubsubProviderUrl: kuboPubsubRpcUrlOrLibp2pJsKey, pubsubTopic };
            await this._pkc._stats.recordGatewayFailure(kuboPubsubRpcUrlOrLibp2pJsKey, "pubsub-publish");
            throw error;
        }
    }
    async pubsubPublish(pubsubTopic, data) {
        const log = Logger("pkc-js:pkc:client-manager:pubsubPublish");
        const providersSorted = await this._pkc._stats.sortGatewaysAccordingToScore("pubsub-publish");
        if (providersSorted.length === 0)
            throw new PKCError("ERR_NO_PUBSUB_PROVIDERS_AVAILABLE_TO_PUBLISH_OVER_PUBSUB", { pubsubTopic, data });
        const providerToError = {};
        for (let i = 0; i < providersSorted.length; i++) {
            const pubsubProviderUrl = providersSorted[i];
            try {
                return await this.pubsubPublishOnProvider(pubsubTopic, data, pubsubProviderUrl);
            }
            catch (e) {
                log.error(`Failed to publish to pubsub topic (${pubsubTopic}) to (${pubsubProviderUrl})`);
                providerToError[pubsubProviderUrl] = e;
            }
        }
        const combinedError = new PKCError("ERR_PUBSUB_FAILED_TO_PUBLISH", { pubsubTopic, data, providerToError });
        this.emitError(combinedError);
        throw combinedError;
    }
    // Gateway methods
    async _fetchWithLimit(url, options) {
        // Node-fetch will take care of size limits through options.size, while browsers will process stream manually
        const handleError = (e) => {
            const nodeError = e;
            if (e instanceof PKCError)
                throw e;
            else if (e instanceof Error && e.message.includes("over limit"))
                throw new PKCError("ERR_OVER_DOWNLOAD_LIMIT", { url, options });
            else if (options.signal?.aborted)
                throw new PKCError("ERR_GATEWAY_TIMED_OUT_OR_ABORTED", { url, options });
            else {
                const errorCode = url.includes("/ipfs/") || url.includes(".ipfs.")
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
        let res;
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
            const sizeHeader = res.headers.get("Content-Length");
            if (sizeHeader && Number(sizeHeader) > options.maxFileSizeBytes)
                throw new PKCError("ERR_OVER_DOWNLOAD_LIMIT", { url, options, res, sizeHeader });
            // If getReader is undefined that means node-fetch is used here. node-fetch processes options.size automatically
            if (res?.body?.getReader === undefined)
                return { resText: await res.text(), res };
        }
        catch (e) {
            handleError(e);
        }
        //@ts-expect-error
        if (res?.body?.getReader !== undefined) {
            let totalBytesRead = 0;
            try {
                const reader = res.body.getReader();
                const decoder = new TextDecoder("utf-8");
                let resText = "";
                while (true) {
                    const { done, value } = await reader.read();
                    //@ts-ignore
                    if (value)
                        resText += decoder.decode(value);
                    if (done || !value)
                        break;
                    if (value.length + totalBytesRead > options.maxFileSizeBytes)
                        throw new PKCError("ERR_OVER_DOWNLOAD_LIMIT", { url, options });
                    totalBytesRead += value.length;
                }
                return { resText, res };
            }
            catch (e) {
                handleError(e);
            }
        }
        throw Error("should not reach this block in _fetchWithLimit");
    }
    preFetchGateway(gatewayUrl, loadOpts) { }
    postFetchGatewaySuccess(gatewayUrl, loadOpts) { }
    postFetchGatewayFailure(gatewayUrl, loadOpts, error) { }
    postFetchGatewayAborted(gatewayUrl, loadOpts) { }
    async _fetchFromGatewayAndVerifyIfBodyCorrespondsToProvidedCid(url, loadOpts) {
        loadOpts.log.trace(`Fetching url (${url})`);
        const resObj = await this._fetchWithLimit(url, {
            cache: loadOpts.recordIpfsType === "ipfs" ? "force-cache" : "no-store",
            signal: loadOpts.abortController.signal,
            ...loadOpts
        });
        const shouldVerifyBodyAgainstCid = loadOpts.recordIpfsType === "ipfs" && !loadOpts.path;
        if (shouldVerifyBodyAgainstCid && !resObj.resText)
            throw Error("Can't verify body against cid when there's no body");
        if (shouldVerifyBodyAgainstCid && resObj.resText)
            await this._verifyGatewayResponseMatchesCid(resObj.resText, loadOpts.root, loadOpts);
        return resObj;
    }
    _handleIfGatewayRedirectsToSubdomainResolution(gateway, loadOpts, res, log) {
        if (GATEWAYS_THAT_SUPPORT_SUBDOMAIN_RESOLUTION[gateway])
            return; // already handled, no need to do anything
        if (!res?.redirected)
            return; // if it doesn't redirect to subdomain gateway then the gateway doesn't support subdomain resolution
        const resUrl = new URL(res.url);
        if (resUrl.hostname.includes(`.${loadOpts.recordIpfsType}.`)) {
            log(`Gateway`, gateway, "supports subdomain resolution. Switching url formulation to subdomain resolution");
            GATEWAYS_THAT_SUPPORT_SUBDOMAIN_RESOLUTION[gateway] = true;
        }
    }
    async _fetchWithGateway(gateway, loadOpts) {
        const log = Logger("pkc-js:pkc:fetchWithGateway");
        const url = GATEWAYS_THAT_SUPPORT_SUBDOMAIN_RESOLUTION[gateway]
            ? createUrlFromSubdomainResolution(gateway, loadOpts)
            : createUrlFromPathResolution(gateway, loadOpts);
        this.preFetchGateway(gateway, loadOpts);
        const timeBefore = Date.now();
        try {
            const resObj = await this._fetchFromGatewayAndVerifyIfBodyCorrespondsToProvidedCid(url, loadOpts);
            if (resObj.abortError) {
                if (!loadOpts.abortController.signal.aborted)
                    loadOpts.abortController.abort(resObj.abortError.message);
                throw resObj.abortError;
            }
            await loadOpts.validateGatewayResponseFunc(resObj); // should throw if there's an issue
            this.postFetchGatewaySuccess(gateway, loadOpts);
            this._pkc._stats
                .recordGatewaySuccess(gateway, loadOpts.recordIpfsType, Date.now() - timeBefore)
                .catch((err) => log.error("Failed to report gateway success", err));
            this._handleIfGatewayRedirectsToSubdomainResolution(gateway, loadOpts, resObj.res, log);
            return resObj;
        }
        catch (e) {
            //@ts-expect-error
            e.details = { ...e.details, url, loadOpts, wasRequestAborted: loadOpts.abortController.signal.aborted };
            this.postFetchGatewayFailure(gateway, loadOpts, e);
            this._pkc._stats
                .recordGatewayFailure(gateway, loadOpts.recordIpfsType)
                .catch((err) => log.error("failed to report gateway error", err));
            return { error: e };
        }
    }
    _firstResolve(promises) {
        if (promises.length === 0)
            throw Error("No promises to find the first resolve");
        return new Promise((resolve) => promises.forEach((promise, i) => promise.then((res) => {
            if ("resText" in res)
                resolve({ res, i });
        })));
    }
    async fetchFromMultipleGateways(loadOpts) {
        const timeoutMs = loadOpts.timeoutMs;
        const concurrencyLimit = 3;
        const queueLimit = pLimit(concurrencyLimit);
        // Only sort if we have more than 3 gateways
        const gatewaysSorted = remeda.keys.strict(this._pkc.clients.ipfsGateways).length <= concurrencyLimit
            ? remeda.keys.strict(this._pkc.clients.ipfsGateways)
            : await this._pkc._stats.sortGatewaysAccordingToScore(loadOpts.recordIpfsType);
        const gatewayFetches = {};
        const cleanUp = () => {
            queueLimit.clearQueue();
            Object.values(gatewayFetches).map((gateway) => {
                if (!gateway.response && !gateway.error)
                    gateway.abortController.abort();
                clearTimeout(gateway.timeoutId);
            });
            if (loadOpts.abortSignal)
                loadOpts.abortSignal.removeEventListener("abort", onParentAbort);
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
        const res = await Promise.race([
            this._firstResolve(gatewayPromises),
            Promise.allSettled(gatewayPromises)
        ]);
        if (Array.isArray(res)) {
            cleanUp();
            throwIfAbortSignalAborted(loadOpts.abortSignal);
            const gatewayToError = {};
            for (let i = 0; i < res.length; i++)
                if (res[i]["value"])
                    gatewayToError[gatewaysSorted[i]] = res[i]["value"].error;
            const combinedError = loadOpts.recordPKCType === "comment"
                ? new FailedToFetchCommentIpfsFromGatewaysError({ commentCid: loadOpts.root, gatewayToError, loadOpts })
                : loadOpts.recordPKCType === "comment-update"
                    ? new FailedToFetchCommentUpdateFromGatewaysError({ gatewayToError, loadOpts })
                    : loadOpts.recordPKCType === "page-ipfs"
                        ? new FailedToFetchPageIpfsFromGatewaysError({ pageCid: loadOpts.root, gatewayToError, loadOpts })
                        : loadOpts.recordPKCType === "community"
                            ? new FailedToFetchCommunityFromGatewaysError({ ipnsName: loadOpts.root, gatewayToError, loadOpts })
                            : new FailedToFetchGenericIpfsFromGatewaysError({ cid: loadOpts.root, gatewayToError, loadOpts });
            throw combinedError;
        }
        else {
            cleanUp();
            return res.res;
        }
    }
    // IPFS P2P methods
    async resolveIpnsToCidP2P(ipnsName, loadOpts) {
        throwIfAbortSignalAborted(loadOpts.abortSignal);
        const ipnsResolveOpts = { nocache: true, recursive: true, ...loadOpts };
        const ipfsClient = this.getIpfsClientWithKuboRpcClientFunctions();
        const performIpnsResolve = async () => {
            const resolvedCidOfIpns = await last(ipfsClient.name.resolve(ipnsName, ipnsResolveOpts));
            if (!resolvedCidOfIpns)
                throw new PKCError("ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED", {
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
                message: new PKCError("ERR_IPNS_RESOLUTION_P2P_TIMEOUT", {
                    ipnsName,
                    ipnsResolveOpts
                }),
                signal: loadOpts.abortSignal
            });
            return result;
        }
        catch (error) {
            if (isAbortError(error))
                throw error;
            //@ts-expect-error
            error.details = { ...error.details, ipnsName, ipnsResolveOpts };
            // Wrap ETIMEDOUT in PKCError so _isRetriableErrorWhenLoading recognizes it as retriable
            if (error instanceof Error && "cause" in error && error.cause?.code === "ETIMEDOUT") {
                throw new PKCError("ERR_FAILED_TO_RESOLVE_IPNS_VIA_IPFS_P2P", {
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
    async _fetchCidP2P(cidV0, loadOpts) {
        throwIfAbortSignalAborted(loadOpts.abortSignal);
        const kuboRpcOrHelia = this.getDefaultKuboRpcClientOrHelia();
        const ipfsClient = this.getIpfsClientWithKuboRpcClientFunctions();
        const fetchPromise = async () => {
            const rawData = await all(ipfsClient.cat(cidV0, { length: loadOpts.maxFileSizeBytes, timeout: `${loadOpts.timeoutMs}ms` }));
            const data = uint8ArrayConcat(rawData);
            const fileContent = uint8ArrayToString(data);
            if (typeof fileContent !== "string")
                throw new PKCError("ERR_FAILED_TO_FETCH_IPFS_CID_VIA_IPFS_P2P", { cid: cidV0, loadOpts });
            if (data.byteLength === loadOpts.maxFileSizeBytes) {
                const calculatedCid = await calculateIpfsHash(fileContent);
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
            const result = await pTimeout(fetchPromise(), {
                milliseconds: loadOpts.timeoutMs,
                message: new PKCError("ERR_FETCH_CID_P2P_TIMEOUT", { cid: cidV0, loadOpts }),
                signal: loadOpts.abortSignal
            });
            return result;
        }
        catch (e) {
            if (isAbortError(e))
                throw e;
            if (e instanceof PKCError)
                throw e;
            else if (e instanceof Error && e.name === "TimeoutError")
                throw new PKCError("ERR_FETCH_CID_P2P_TIMEOUT", { cid: cidV0, error: e, loadOpts });
            else
                throw new PKCError("ERR_FAILED_TO_FETCH_IPFS_CID_VIA_IPFS_P2P", {
                    cid: cidV0,
                    error: e,
                    errorMessage: e?.message,
                    errorName: e?.name,
                    errorCode: e?.code,
                    loadOpts
                });
        }
    }
    async _verifyGatewayResponseMatchesCid(gatewayResponseBody, cid, loadOpts) {
        const calculatedCid = await calculateIpfsHash(gatewayResponseBody);
        if (gatewayResponseBody.length === loadOpts.maxFileSizeBytes && calculatedCid !== cid)
            throw new PKCError("ERR_OVER_DOWNLOAD_LIMIT", { cid, loadOpts, gatewayResponseBody });
        if (calculatedCid !== cid)
            throw new PKCError("ERR_CALCULATED_CID_DOES_NOT_MATCH", { calculatedCid, cid, gatewayResponseBody, loadOpts });
    }
    // Resolver methods here
    // Name resolver hooks — overridden by PKCClientsManager and subclass client managers
    preResolveNameResolver(opts) { }
    postResolveNameResolverSuccess(opts) { }
    postResolveNameResolverFailure(opts) { }
    async _resolveViaNameResolvers({ address, resolveType, abortSignal }) {
        const log = Logger("pkc-js:client-manager:_resolveViaNameResolvers");
        const nameResolvers = this._pkc.nameResolvers;
        if (!nameResolvers || nameResolvers.length === 0) {
            throw new PKCError("ERR_NO_RESOLVER_FOR_NAME", { address });
        }
        throwIfAbortSignalAborted(abortSignal);
        let value;
        let anyResolverCanHandle = false;
        for (const nameResolver of nameResolvers) {
            if (!nameResolver.canResolve({ name: address }))
                continue;
            anyResolverCanHandle = true;
            this.preResolveNameResolver({ address, resolveType, resolverKey: nameResolver.key });
            try {
                throwIfAbortSignalAborted(abortSignal);
                const result = await nameResolver.resolve({ name: address, provider: nameResolver.provider, abortSignal });
                throwIfAbortSignalAborted(abortSignal);
                value = result?.publicKey;
            }
            catch (e) {
                const error = isAbortError(e) ? e : e;
                this.postResolveNameResolverFailure({ address, resolveType, resolverKey: nameResolver.key, error });
                if (abortSignal?.aborted)
                    throwIfAbortSignalAborted(abortSignal);
                if (isAbortError(error))
                    throw error;
                log.error(`Resolver ${nameResolver.key} failed for ${address}`, error);
                continue;
            }
            this.postResolveNameResolverSuccess({ address, resolveType, resolverKey: nameResolver.key, resolvedValue: value });
            if (value)
                break;
        }
        if (!anyResolverCanHandle) {
            throw new PKCError("ERR_NO_RESOLVER_FOR_NAME", { address });
        }
        return value || null;
    }
    async resolveCommunityNameIfNeeded({ communityAddress, abortSignal }) {
        assert(typeof communityAddress === "string", "communityAddress needs to be a string to be resolved");
        if (!isStringDomain(communityAddress))
            return communityAddress;
        const result = await this._resolveViaNameResolvers({ address: communityAddress, resolveType: "community", abortSignal });
        if (typeof result === "string" && !isIpns(result))
            throw new PKCError("ERR_RESOLVED_TEXT_RECORD_TO_NON_IPNS", { resolvedTextRecord: result, address: communityAddress });
        return result;
    }
    async resolveAuthorNameIfNeeded({ authorAddress, abortSignal }) {
        if (!isStringDomain(authorAddress))
            throw new PKCError("ERR_AUTHOR_ADDRESS_IS_NOT_A_DOMAIN_OR_B58", { authorAddress });
        const result = await this._resolveViaNameResolvers({ address: authorAddress, resolveType: "author", abortSignal });
        if (typeof result === "string" && !isIpns(result))
            throw new PKCError("ERR_RESOLVED_TEXT_RECORD_TO_NON_IPNS", { resolvedTextRecord: result, address: authorAddress });
        return result;
    }
    // Background author name resolution — fire-and-forget, populates nameResolvedCache
    resolveAuthorNamesInBackground({ authors, onResolved, abortSignal }) {
        const log = Logger("pkc-js:base-client-manager:resolveAuthorNamesInBackground");
        const cache = this._pkc._memCaches.nameResolvedCache;
        // Deduplicate and skip already-cached entries
        const seen = new Set();
        const toResolve = [];
        for (const { authorName, signaturePublicKey } of authors) {
            if (!isStringDomain(authorName))
                continue;
            const cacheKey = sha256(authorName + signaturePublicKey);
            if (seen.has(cacheKey))
                continue;
            seen.add(cacheKey);
            if (typeof cache.get(cacheKey) === "boolean")
                continue;
            toResolve.push({ authorName, signaturePublicKey, cacheKey });
        }
        if (toResolve.length === 0)
            return;
        const limit = pLimit(5);
        const resolveOne = async (entry) => {
            if (abortSignal?.aborted)
                return false;
            try {
                const resolved = await this.resolveAuthorNameIfNeeded({ authorAddress: entry.authorName, abortSignal });
                const signerAddress = await getPKCAddressFromPublicKey(entry.signaturePublicKey);
                const matches = resolved === signerAddress;
                cache.set(entry.cacheKey, matches);
                return true; // newly set
            }
            catch (e) {
                if (isAbortError(e))
                    return false;
                log.error("Failed to resolve author name in background", entry.authorName, e);
                if (e instanceof PKCError && e.code === "ERR_NO_RESOLVER_FOR_NAME") {
                    cache.set(entry.cacheKey, false);
                    return true; // newly set
                }
                // Transient failure — leave undefined for retry on next update
                return false;
            }
        };
        Promise.allSettled(toResolve.map((entry) => limit(() => resolveOne(entry))))
            .then((results) => {
            const anyNewlySet = results.some((r) => r.status === "fulfilled" && r.value === true);
            if (anyNewlySet)
                onResolved();
        })
            .catch((e) => log.error("Unexpected error in resolveAuthorNamesInBackground", e));
    }
    // Misc functions
    emitError(e) {
        this._pkc.emit("error", e);
    }
    calculateIpfsCid(content) {
        return calculateIpfsCidV0(content);
    }
    async _withInflightCommunityFetch(subAddress, fetcher) {
        return this._pkc._inflightFetchManager.withResource(InflightResourceTypes.COMMUNITY_IPNS, subAddress, fetcher);
    }
}
//# sourceMappingURL=base-client-manager.js.map
import retry, { RetryOperation } from "retry";
import {
    OptionsToLoadFromGateway,
    PreResolveNameResolverOptions,
    PostResolveNameResolverSuccessOptions
} from "../clients/base-client-manager.js";
import { PKCClientsManager } from "../pkc/pkc-client-manager.js";
import { FailedToFetchCommunityFromGatewaysError, PKCError } from "../pkc-error.js";
import { ResultOfFetchingCommunity } from "../types.js";
import { NameResolverClient } from "../clients/name-resolver-client.js";
import { RemoteCommunity } from "./remote-community.js";
import * as remeda from "remeda";
import type { CommunityIpfsType, CommunityJson } from "./types.js";
import { getCommunityNameFromWire } from "./community-wire.js";
import { getPKCAddressFromPublicKeySync } from "../signer/util.js";
import Logger from "../logger.js";

import {
    areEquivalentCommunityAddresses,
    hideClassPrivateProps,
    ipnsNameToIpnsOverPubsubTopic,
    isAbortError,
    isStringDomain,
    pubsubTopicToDhtKey,
    throwIfAbortSignalAborted,
    timestamp
} from "../util.js";
import pLimit from "p-limit";
import { parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails, parseJsonWithPKCErrorIfFails } from "../schema/schema-util.js";
import { verifyCommunity } from "../signer/index.js";
import { LimitedSet } from "../general-util/limited-set.js";
import {
    CommunityIpfsGatewayClient,
    CommunityKuboPubsubClient,
    CommunityKuboRpcClient,
    CommunityLibp2pJsClient,
    CommunityPKCRpcStateClient
} from "./community-clients.js";
import { CID } from "kubo-rpc-client";
import { getAuthorDomainFromRuntime } from "../publications/publication-author.js";

type CommunityGatewayFetch = {
    [gatewayUrl: string]: {
        abortController: AbortController;
        promise: Promise<any>;
        cid?: CommunityJson["updateCid"];
        subplebbitRecord?: CommunityIpfsType;
        error?: PKCError;
        timeoutId: any;
        ttl?: number; // ttl in seconds of IPNS record
    };
};

export const MAX_FILE_SIZE_BYTES_FOR_SUBPLEBBIT_IPFS = 1024 * 1024; // 1mb

export class CommunityClientsManager extends PKCClientsManager {
    override clients!: {
        ipfsGateways: { [ipfsGatewayUrl: string]: CommunityIpfsGatewayClient };
        kuboRpcClients: { [kuboRpcClientUrl: string]: CommunityKuboRpcClient };
        pubsubKuboRpcClients: { [pubsubClientUrl: string]: CommunityKuboPubsubClient };
        plebbitRpcClients: Record<string, CommunityPKCRpcStateClient>;
        libp2pJsClients: { [libp2pJsClientUrl: string]: CommunityLibp2pJsClient };
        nameResolvers: { [resolverKey: string]: NameResolverClient };
    };
    private _subplebbit: RemoteCommunity;
    private _suppressUpdatingStateForNameResolution = 0;
    _ipnsLoadingOperation?: RetryOperation = undefined;
    _updateCidsAlreadyLoaded: LimitedSet<string> = new LimitedSet<string>(30); // we will keep track of the last 50 subplebbit update cids that we loaded

    constructor(subplebbit: CommunityClientsManager["_subplebbit"]) {
        super(subplebbit._plebbit);
        this._subplebbit = subplebbit;
        this._initPKCRpcClients();
        hideClassPrivateProps(this);
    }

    protected override _initKuboRpcClients(): void {
        if (this._plebbit.clients.kuboRpcClients)
            for (const ipfsUrl of remeda.keys.strict(this._plebbit.clients.kuboRpcClients))
                this.clients.kuboRpcClients = { ...this.clients.kuboRpcClients, [ipfsUrl]: new CommunityKuboRpcClient("stopped") };
    }

    protected override _initPubsubKuboRpcClients(): void {
        for (const pubsubUrl of remeda.keys.strict(this._plebbit.clients.pubsubKuboRpcClients))
            this.clients.pubsubKuboRpcClients = {
                ...this.clients.pubsubKuboRpcClients,
                [pubsubUrl]: new CommunityKuboPubsubClient("stopped")
            };
    }

    protected override _initLibp2pJsClients(): void {
        if (this._plebbit.clients.libp2pJsClients)
            for (const libp2pJsClientUrl of remeda.keys.strict(this._plebbit.clients.libp2pJsClients))
                this.clients.libp2pJsClients = {
                    ...this.clients.libp2pJsClients,
                    [libp2pJsClientUrl]: new CommunityLibp2pJsClient("stopped")
                };
    }

    protected _initPKCRpcClients() {
        for (const rpcUrl of remeda.keys.strict(this._plebbit.clients.plebbitRpcClients))
            this.clients.plebbitRpcClients = {
                ...this.clients.plebbitRpcClients,
                [rpcUrl]: new CommunityPKCRpcStateClient("stopped")
            };
    }

    override updateKuboRpcState(newState: CommunityKuboRpcClient["state"], kuboRpcClientUrl: string) {
        super.updateKuboRpcState(newState, kuboRpcClientUrl);
    }

    override updateKuboRpcPubsubState(newState: CommunityKuboPubsubClient["state"], pubsubProvider: string) {
        super.updateKuboRpcPubsubState(newState, pubsubProvider);
    }

    override updateGatewayState(newState: CommunityIpfsGatewayClient["state"], gateway: string): void {
        super.updateGatewayState(newState, gateway);
    }

    override updateLibp2pJsClientState(newState: CommunityLibp2pJsClient["state"], libp2pJsClientUrl: string) {
        super.updateLibp2pJsClientState(newState, libp2pJsClientUrl);
    }

    override emitError(e: PKCError): void {
        this._subplebbit.emit("error", e);
    }

    protected override _getStatePriorToResolvingCommunityIpns(): "fetching-subplebbit-ipns" | "fetching-ipns" {
        return "fetching-ipns";
    }

    override preResolveNameResolver(opts: PreResolveNameResolverOptions): void {
        super.preResolveNameResolver(opts);
        if (this._suppressUpdatingStateForNameResolution > 0) return;
        this._subplebbit._setUpdatingStateWithEventEmissionIfNewState("resolving-name");
    }

    override postResolveNameResolverSuccess(opts: PostResolveNameResolverSuccessOptions): void {
        super.postResolveNameResolverSuccess(opts);
        if (!opts.resolvedValue && this._subplebbit.state === "updating") {
            throw new PKCError("ERR_DOMAIN_TXT_RECORD_NOT_FOUND", {
                subplebbitAddress: opts.address,
                textRecord: "bitsocial"
            });
        }
    }

    protected _getCommunityAddressFromInstance(): string {
        return this._subplebbit.address;
    }

    private _areEquivalentCommunityAddresses(addressA: string, addressB: string): boolean {
        return areEquivalentCommunityAddresses(addressA, addressB);
    }

    private _deriveAddressFromWireRecord(subJson: CommunityIpfsType): string {
        // Old records have address in the wire format, new records use name || publicKey
        return getCommunityNameFromWire(subJson as Record<string, unknown>) || getPKCAddressFromPublicKeySync(subJson.signature.publicKey);
    }

    // functions for updatingSubInstance

    private async _retryLoadingCommunityAddress(
        subplebbitAddress: string
    ): Promise<ResultOfFetchingCommunity | { criticalError: Error | PKCError } | { aborted: true }> {
        const log = Logger("pkc-js:remote-community:update:_retryLoadingCommunityIpns");

        return new Promise((resolve) => {
            this._ipnsLoadingOperation!.attempt(async (curAttempt) => {
                log.trace(`Retrying to load subplebbit ${subplebbitAddress} for the ${curAttempt}th time`);
                try {
                    const update = await this.fetchNewUpdateForCommunity(subplebbitAddress);

                    resolve(update);
                } catch (e) {
                    const error = <Error | PKCError>e;
                    if (error.name === "AbortError") return resolve({ aborted: true });
                    //@ts-expect-error
                    error.details = {
                        //@ts-expect-error
                        ...error.details,
                        ipnsPubsubTopic: this._subplebbit.ipnsPubsubTopic,
                        ipnsPubsubTopicRoutingCid: this._subplebbit.ipnsPubsubTopicRoutingCid
                    };
                    if (!this._subplebbit._isRetriableErrorWhenLoading(error)) {
                        // critical error that can't be retried
                        if (error instanceof PKCError)
                            error.details = { ...error.details, countOfLoadAttempts: curAttempt, retriableError: false };
                        resolve({ criticalError: error });
                    } else {
                        // we encountered a retriable error, could be gateways failing to load
                        // does not include gateways returning an old record
                        if (error instanceof PKCError)
                            error.details = { ...error.details, countOfLoadAttempts: curAttempt, retriableError: true };
                        log.trace(
                            `Failed to load Community ${this._subplebbit.address} record for the ${curAttempt}th attempt. We will retry`,
                            error
                        );

                        this._subplebbit._changeStateEmitEventEmitStateChangeEvent({
                            event: { name: "error", args: [error] },
                            newUpdatingState: "waiting-retry"
                        });

                        this._ipnsLoadingOperation!.retry(<Error>e);
                    }
                }
            });
        });
    }

    async updateOnce() {
        const log = Logger("pkc-js:remote-community:update");

        this._ipnsLoadingOperation = retry.operation({ forever: true, factor: 2, maxTimeout: 30000 });
        const subLoadingRes = await this._retryLoadingCommunityAddress(this._subplebbit.address); // will return undefined if no new sub CID is found
        this._ipnsLoadingOperation.stop();

        if (subLoadingRes && "aborted" in subLoadingRes) {
            return;
        } else if (subLoadingRes && "criticalError" in subLoadingRes) {
            // Log individual gateway errors separately to avoid Node.js [Object] truncation
            if (subLoadingRes.criticalError instanceof FailedToFetchCommunityFromGatewaysError) {
                for (const [gatewayUrl, gatewayError] of Object.entries(subLoadingRes.criticalError.details.gatewayToError)) {
                    log.error(`Community ${this._subplebbit.address} gateway ${gatewayUrl} non-retriable error:`, gatewayError);
                }
            }
            log.error(
                `Community ${this._subplebbit.address} encountered a non retriable error while updating, will emit an error event and mark invalid cid to not be loaded again`,
                subLoadingRes.criticalError
            );
            this._subplebbit._changeStateEmitEventEmitStateChangeEvent({
                event: { name: "error", args: [subLoadingRes.criticalError] },
                newUpdatingState: "failed"
            });
        } else if (
            subLoadingRes?.subplebbit &&
            (this._subplebbit.raw.subplebbitIpfs?.updatedAt || 0) < subLoadingRes.subplebbit.updatedAt
        ) {
            this._subplebbit.initCommunityIpfsPropsNoMerge(subLoadingRes.subplebbit);
            this._subplebbit.updateCid = subLoadingRes.cid;
            // If we just discovered a name, trigger background resolution now (don't wait for next loop)
            if (
                !isStringDomain(this._subplebbit.address) &&
                this._subplebbit.name &&
                this._subplebbit.publicKey &&
                typeof this._subplebbit.nameResolved !== "boolean"
            ) {
                this._resolveNameInBackground(this._subplebbit.name);
            }
            log(
                `Remote Community`,
                this._subplebbit.address,
                `received a new update. Will emit an update event with updatedAt`,
                this._subplebbit.updatedAt,
                "that's",
                timestamp() - this._subplebbit.updatedAt!,
                "seconds old"
            );
            this._subplebbit._changeStateEmitEventEmitStateChangeEvent({
                event: { name: "update", args: [this._subplebbit] },
                newUpdatingState: "succeeded"
            });
            this._resolvePageAuthorNamesInBackground();
        } else if (subLoadingRes === undefined) {
            // we loaded a sub record that we already consumed
            // we will retry later
            this._subplebbit._setUpdatingStateWithEventEmissionIfNewState("waiting-retry");
        } else if (subLoadingRes?.subplebbit) {
            this._subplebbit._setUpdatingStateWithEventEmissionIfNewState("succeeded");
        }
    }

    async startUpdatingLoop() {
        const log = Logger("pkc-js:remote-community:update");
        this._subplebbit._createStopAbortController();

        const areWeConnectedToKuboOrHelia =
            Object.keys(this._plebbit.clients.kuboRpcClients).length > 0 || Object.keys(this._plebbit.clients.libp2pJsClients).length > 0;
        const updateInterval = areWeConnectedToKuboOrHelia ? 1000 : this._plebbit.updateInterval; // if we're on helia or kubo we should resolve IPNS every second

        while (this._subplebbit.state === "updating" && !this._subplebbit._getStopAbortSignal()?.aborted) {
            try {
                await this.updateOnce();
            } catch (e) {
                log.error(`Failed to update subplebbit ${this._subplebbit.address} for this iteration, will retry later`, e);
            } finally {
                await new Promise<void>((resolve) => {
                    const stopSignal = this._subplebbit._getStopAbortSignal();
                    if (stopSignal?.aborted) return resolve();
                    const timer = setTimeout(resolve, updateInterval);
                    stopSignal?.addEventListener(
                        "abort",
                        () => {
                            clearTimeout(timer);
                            resolve();
                        },
                        { once: true }
                    );
                });
            }
        }

        this._subplebbit._clearStopAbortController();
        log("Community", this._subplebbit.address, "is no longer updating");
    }

    async stopUpdatingLoop() {
        this._ipnsLoadingOperation?.stop();
        this._updateCidsAlreadyLoaded.clear();
    }

    // fetching subplebbit ipns here

    private async _resolveCommunityNameWithoutUpdatingState({
        communityAddress,
        abortSignal
    }: {
        communityAddress: string;
        abortSignal?: AbortSignal;
    }): Promise<string | null> {
        this._suppressUpdatingStateForNameResolution++;
        try {
            return await this.resolveCommunityNameIfNeeded({ communityAddress, abortSignal });
        } finally {
            this._suppressUpdatingStateForNameResolution--;
        }
    }

    private _resolveNameInBackground(name: string) {
        const log = Logger("pkc-js:community-client-manager:_resolveNameInBackground");
        const setNameResolvedAndEmitUpdate = (newNameResolved: boolean) => {
            if (this._subplebbit.nameResolved === newNameResolved) return;
            this._subplebbit.nameResolved = newNameResolved;
            // Only emit update if the subplebbit has been loaded at least once —
            // otherwise we'd fire a premature "update" before the IPNS fetch completes.
            if (typeof this._subplebbit.updatedAt === "number") {
                this._subplebbit.emit("update", this._subplebbit);
            }
        };
        this._resolveCommunityNameWithoutUpdatingState({
            communityAddress: name,
            abortSignal: this._subplebbit._getStopAbortSignal()
        })
            .then((resolved) => {
                if (resolved && resolved !== this._subplebbit.publicKey) {
                    // Key change detected: name now points to a different key.
                    // Most likely: cached publicKey is stale after community key migration.
                    log("Key migration detected for", name, "old:", this._subplebbit.publicKey, "new:", resolved);
                    const previousPublicKey = this._subplebbit.publicKey;
                    const error = new PKCError("ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY", {
                        communityName: name,
                        previousPublicKey,
                        newPublicKey: resolved
                    });

                    // Clear all data immediately (old data may be from compromised key)
                    this._subplebbit._clearDataForKeyMigration(resolved);
                    this._updateCidsAlreadyLoaded.clear();
                    this._subplebbit.nameResolved = true;

                    // Abort in-flight fetch (using old key) by aborting the stop controller,
                    // then immediately create a new one so the update loop continues.
                    this._subplebbit._abortStopOperations("Key migration: name resolved to different public key");
                    this._subplebbit._createStopAbortController();

                    // Emit update so UI drops stale data right away
                    this._subplebbit.emit("update", this._subplebbit);
                    this._subplebbit.emit("error", error);
                } else if (resolved) {
                    setNameResolvedAndEmitUpdate(true);
                }
                // If resolved is null but subplebbit has a name, the name is not resolving
                if (!resolved && this._subplebbit.name) {
                    setNameResolvedAndEmitUpdate(false);
                }
            })
            .catch((e) => {
                if (e instanceof PKCError && (e.code === "ERR_NO_RESOLVER_FOR_NAME" || e.code === "ERR_DOMAIN_TXT_RECORD_NOT_FOUND")) {
                    // Definitive: either no resolver can handle this TLD, or the domain has no community TXT record.
                    setNameResolvedAndEmitUpdate(false);
                } else {
                    log.trace("Background name resolution failed for", name, e);
                    // Transient failure -- leave nameResolved as undefined
                }
            });
    }

    _resolvePageAuthorNamesInBackground() {
        if (!this._plebbit.resolveAuthorNames) return;
        const pages = this._subplebbit.posts?.pages;
        if (!pages) return;

        const authors: Array<{ authorName: string; signaturePublicKey: string }> = [];
        for (const page of Object.values(pages)) {
            if (!page) continue;
            for (const comment of page.comments) {
                const domain = getAuthorDomainFromRuntime(comment.author);
                if (domain && typeof comment.author.nameResolved !== "boolean") {
                    authors.push({ authorName: domain, signaturePublicKey: comment.signature.publicKey });
                }
            }
        }

        if (authors.length === 0) return;

        this.resolveAuthorNamesInBackground({
            authors,
            onResolved: () => {
                // Silently re-apply cache to all pages — no update emission.
                // Only subplebbit.nameResolved changes should emit updates (handled by _resolveNameInBackground).
                for (const page of Object.values(this._subplebbit.posts?.pages || {})) {
                    if (page) this._subplebbit.posts._applyNameResolvedCacheToPage(page);
                }
            },
            abortSignal: this._subplebbit._getStopAbortSignal()
        });
    }

    async fetchNewUpdateForCommunity(subAddress: string): Promise<ResultOfFetchingCommunity> {
        return this._withInflightCommunityFetch(subAddress, async () => {
            let ipnsName: string | null;
            const isDomain = isStringDomain(subAddress);

            if (
                this._subplebbit.publicKey &&
                (isDomain || (!isDomain && this._subplebbit.name && this._subplebbit.nameResolved === true))
            ) {
                // Once a domain has been verified against a public key, keep fetching through the current public key
                // even if the immutable address on the instance is a raw IPNS key.
                ipnsName = this._subplebbit.publicKey;
                if (isDomain) this._resolveNameInBackground(subAddress);
            } else {
                // Name only or publicKey only: use existing resolution flow
                ipnsName = await this.resolveCommunityNameIfNeeded({
                    communityAddress: subAddress,
                    abortSignal: this._subplebbit._getStopAbortSignal()
                });
            }

            // When loaded by raw IPNS key, verify the record's name claim in background (once)
            if (!isDomain && this._subplebbit.name && this._subplebbit.publicKey && typeof this._subplebbit.nameResolved !== "boolean") {
                this._resolveNameInBackground(this._subplebbit.name);
            }

            if (!ipnsName) throw Error("Failed to resolve subplebbit address to an IPNS name");

            // If the subplebbit address is a domain, we need to update the ipnsName and ipns pubsub props
            // even if we fail to load the IPNS record, so that pubsub can work correctly
            if (this._subplebbit.ipnsName !== ipnsName) {
                this._subplebbit.ipnsName = ipnsName;
                this._subplebbit.ipnsPubsubTopic = ipnsNameToIpnsOverPubsubTopic(ipnsName);
                this._subplebbit.ipnsPubsubTopicRoutingCid = pubsubTopicToDhtKey(this._subplebbit.ipnsPubsubTopic);
            }

            if (this._subplebbit.updateCid) this._updateCidsAlreadyLoaded.add(this._subplebbit.updateCid);

            // This function should fetch CommunityIpfs, parse it and verify its signature
            // Then return CommunityIpfs

            // only exception is if the ipnsRecord.value (ipfs path) has already been loaded and stored in this._updateCidsAlreadyLoaded
            // in that case no need to fetch the subplebbitIpfs, we will return undefined
            this._subplebbit._setUpdatingStateWithEventEmissionIfNewState("fetching-ipns");
            let subRes: ResultOfFetchingCommunity;
            const areWeConnectedToKuboOrHelia =
                Object.keys(this._plebbit.clients.kuboRpcClients).length > 0 ||
                Object.keys(this._plebbit.clients.libp2pJsClients).length > 0;
            if (areWeConnectedToKuboOrHelia) {
                const kuboRpcOrHelia = this.getDefaultKuboRpcClientOrHelia();
                // we're connected to kubo or helia
                try {
                    subRes = await this._fetchCommunityIpnsP2PAndVerify(ipnsName);
                } catch (e) {
                    //@ts-expect-error
                    e.details = {
                        //@ts-expect-error
                        ...e.details,
                        ipnsName,
                        subAddress,
                        ipnsPubsubTopic: this._subplebbit.ipnsPubsubTopic,
                        ipnsPubsubTopicRoutingCid: this._subplebbit.ipnsPubsubTopicRoutingCid
                    };
                    throw e;
                } finally {
                    if ("_helia" in kuboRpcOrHelia) this.updateLibp2pJsClientState("stopped", kuboRpcOrHelia._libp2pJsClientsOptions.key);
                    else this.updateKuboRpcState("stopped", kuboRpcOrHelia.url);
                }
            } else subRes = await this._fetchCommunityFromGateways(ipnsName); // let's use gateways to fetch because we're not connected to kubo or helia
            // States of gateways should be updated by fetchFromMultipleGateways
            // Community records are verified within _fetchCommunityFromGateways

            if (subRes?.subplebbit) {
                // we found a new record that is verified
                // Compute address from wire record (old records have address, new records derive from name/publicKey)
                const recordAddress = this._deriveAddressFromWireRecord(subRes.subplebbit);
                this._plebbit._memCaches.subplebbitForPublishing.set(recordAddress, {
                    encryption: subRes.subplebbit.encryption,
                    pubsubTopic: subRes.subplebbit.pubsubTopic,
                    address: recordAddress,
                    publicKey: getPKCAddressFromPublicKeySync(subRes.subplebbit.signature.publicKey),
                    name: subRes.subplebbit.name
                });
            }
            return subRes;
        });
    }

    private async _fetchCommunityIpnsP2PAndVerify(ipnsName: string): Promise<ResultOfFetchingCommunity> {
        const log = Logger("pkc-js:clients-manager:_fetchCommunityIpnsP2PAndVerify");
        const kuboRpcOrHelia = this.getDefaultKuboRpcClientOrHelia();
        if ("_helia" in kuboRpcOrHelia) {
            this.updateLibp2pJsClientState("fetching-ipns", kuboRpcOrHelia._libp2pJsClientsOptions.key);
        } else this.updateKuboRpcState("fetching-ipns", kuboRpcOrHelia.url);
        const latestCommunityCid = await this.resolveIpnsToCidP2P(ipnsName, {
            timeoutMs: this._plebbit._timeouts["subplebbit-ipns"],
            abortSignal: this._subplebbit._getStopAbortSignal()
        });
        log.trace(`Resolved subplebbit IPNS`, ipnsName, `to CID`, latestCommunityCid);
        if (this._updateCidsAlreadyLoaded.has(latestCommunityCid)) {
            log.trace(
                "Resolved subplebbit IPNS",
                ipnsName,
                "to a cid that we already loaded before. No need to fetch its ipfs",
                latestCommunityCid
            );
            return undefined;
        }

        if ("_helia" in kuboRpcOrHelia) this.updateLibp2pJsClientState("fetching-ipfs", kuboRpcOrHelia._libp2pJsClientsOptions.key);
        else this.updateKuboRpcState("fetching-ipfs", kuboRpcOrHelia.url);
        this._subplebbit._setUpdatingStateWithEventEmissionIfNewState("fetching-ipfs");

        let rawSubJsonString: Awaited<ReturnType<typeof this._fetchCidP2P>>;
        try {
            rawSubJsonString = await this._fetchCidP2P(latestCommunityCid, {
                maxFileSizeBytes: MAX_FILE_SIZE_BYTES_FOR_SUBPLEBBIT_IPFS,
                timeoutMs: this._plebbit._timeouts["subplebbit-ipfs"],
                abortSignal: this._subplebbit._getStopAbortSignal()
            });
        } catch (e) {
            //@ts-expect-error
            e.details = {
                //@ts-expect-error
                ...e.details,
                subplebbitIpnsName: ipnsName,
                ipnsPubsubTopic: this._subplebbit.ipnsPubsubTopic,
                ipnsPubsubTopicRoutingCid: this._subplebbit.ipnsPubsubTopicRoutingCid,
                subplebbitCid: latestCommunityCid
            };
            if (e instanceof PKCError && e.code === "ERR_OVER_DOWNLOAD_LIMIT") this._updateCidsAlreadyLoaded.add(latestCommunityCid);
            throw e;
        }

        this._updateCidsAlreadyLoaded.add(latestCommunityCid);
        try {
            const subIpfs = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(parseJsonWithPKCErrorIfFails(rawSubJsonString));

            const errInRecord = await this._findErrorInCommunityRecord(subIpfs, ipnsName, latestCommunityCid);

            if (errInRecord) throw errInRecord;
            return { subplebbit: subIpfs, cid: latestCommunityCid };
        } catch (e) {
            // invalid subplebbit record
            (e as PKCError).details = {
                ...(e as PKCError).details,
                cidOfSubIpns: latestCommunityCid,
                ipnsPubsubTopic: this._subplebbit.ipnsPubsubTopic,
                ipnsPubsubTopicRoutingCid: this._subplebbit.ipnsPubsubTopicRoutingCid
            };
            throw <PKCError>e;
        }
    }

    private async _fetchCommunityFromGateways(ipnsName: string): Promise<ResultOfFetchingCommunity> {
        const log = Logger("pkc-js:community:fetchCommunityFromGateways");
        const concurrencyLimit = 3;
        const timeoutMs = this._plebbit._timeouts["subplebbit-ipns"];

        const queueLimit = pLimit(concurrencyLimit);

        // Only sort if we have more than 3 gateways
        const gatewaysSorted =
            remeda.keys.strict(this._plebbit.clients.ipfsGateways).length <= concurrencyLimit
                ? remeda.keys.strict(this._plebbit.clients.ipfsGateways)
                : await this._plebbit._stats.sortGatewaysAccordingToScore("ipns");

        // need to handle
        // if all gateways returned the same subplebbit.updateCid
        const gatewayFetches: CommunityGatewayFetch = {};

        for (const gatewayUrl of gatewaysSorted) {
            const abortController = new AbortController();
            const throwIfGatewayRespondsWithInvalidCommunity: OptionsToLoadFromGateway["validateGatewayResponseFunc"] = async (
                gatewayRes
            ) => {
                if (typeof gatewayRes.resText !== "string") throw Error("Gateway response has no body");
                // get ipfs cid of IPNS from header or calculate it
                const calculatedSubCidFromBody = await this.calculateIpfsCid(gatewayRes.resText); // cid v0

                if (this._updateCidsAlreadyLoaded.has(calculatedSubCidFromBody))
                    throw new PKCError("ERR_GATEWAY_ABORTING_LOADING_COMMUNITY_BECAUSE_WE_ALREADY_LOADED_THIS_RECORD", {
                        calculatedSubCidFromBody,
                        ipnsName,
                        ipnsPubsubTopic: this._subplebbit.ipnsPubsubTopic,
                        ipnsPubsubTopicRoutingCid: this._subplebbit.ipnsPubsubTopicRoutingCid,
                        gatewayRes,
                        gatewayUrl
                    });

                this._updateCidsAlreadyLoaded.add(calculatedSubCidFromBody);

                let subIpfs: CommunityIpfsType;
                try {
                    subIpfs = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(parseJsonWithPKCErrorIfFails(gatewayRes.resText));
                } catch (e) {
                    (e as PKCError).details = {
                        ...(e as PKCError).details,
                        cidOfSubIpns: calculatedSubCidFromBody,
                        ipnsPubsubTopic: this._subplebbit.ipnsPubsubTopic,
                        ipnsPubsubTopicRoutingCid: this._subplebbit.ipnsPubsubTopicRoutingCid
                    };
                    throw e;
                }
                const errorWithinRecord = await this._findErrorInCommunityRecord(subIpfs, ipnsName, calculatedSubCidFromBody);
                if (errorWithinRecord) {
                    delete errorWithinRecord["stack"];
                    if (errorWithinRecord.code === "ERR_COMMUNITY_SIGNATURE_IS_INVALID") {
                        const log = Logger("pkc-js:community-client-manager:throwIfGatewayRespondsWithInvalidCommunity");
                        const etag = gatewayRes?.res?.headers?.get("etag");
                        log.error(
                            `Gateway ${gatewayUrl} returned subplebbit record with invalid signature. ` +
                                `Client-computed CID: ${calculatedSubCidFromBody}. ` +
                                `Etag header (Kubo CID): ${etag}. ` +
                                `updatedAt: ${subIpfs.updatedAt}. ` +
                                `Response body: ${gatewayRes.resText}`
                        );
                    }
                    throw errorWithinRecord;
                } else {
                    gatewayFetches[gatewayUrl].subplebbitRecord = subIpfs;
                    gatewayFetches[gatewayUrl].cid = calculatedSubCidFromBody;

                    // Log the TTL from max-age header after successfully setting the subplebbit record
                    const cacheControl = gatewayRes?.res?.headers?.get("cache-control");
                    if (cacheControl) {
                        const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
                        if (maxAgeMatch && maxAgeMatch[1]) {
                            const ttl = parseInt(maxAgeMatch[1]);
                            gatewayFetches[gatewayUrl].ttl = ttl;
                        }
                    }
                }
            };

            const checkResponseHeadersIfOldCid = async (gatewayRes: Response) => {
                const cidOfIpnsFromEtagHeader = gatewayRes?.headers?.get("etag")?.toString();
                // If etag is missing, skip early-abort optimization and let the body be fetched
                if (!cidOfIpnsFromEtagHeader) {
                    return; // Continue to fetch and validate the body normally
                }
                let parsedCid: string;
                try {
                    // clean up W/ prefix and quotes from the etag header
                    parsedCid = CID.parse(cidOfIpnsFromEtagHeader.replace(/^W\//, "").split('"').join("")).toV0().toString();
                } catch (e) {
                    // Malformed etag header - skip optimization and let body be fetched
                    return; // Continue to fetch and validate the body normally
                }
                if (this._updateCidsAlreadyLoaded.has(parsedCid)) {
                    abortController.abort("Aborting subplebbit IPNS request because we already loaded this record");
                    return new PKCError("ERR_GATEWAY_ABORTING_LOADING_COMMUNITY_BECAUSE_WE_ALREADY_LOADED_THIS_RECORD", {
                        cidOfIpnsFromEtagHeader,
                        ipnsName,
                        gatewayRes,
                        gatewayUrl
                    });
                }
            };

            const requestHeaders =
                this._updateCidsAlreadyLoaded.size > 0
                    ? { "If-None-Match": '"' + Array.from(this._updateCidsAlreadyLoaded.values()).join(",") + '"' } // tell the gateway we already loaded these records
                    : undefined;
            gatewayFetches[gatewayUrl] = {
                abortController,
                promise: queueLimit(() =>
                    this._fetchWithGateway(gatewayUrl, {
                        recordIpfsType: "ipns",
                        root: ipnsName,
                        recordPKCType: "subplebbit",
                        validateGatewayResponseFunc: throwIfGatewayRespondsWithInvalidCommunity,
                        abortRequestErrorBeforeLoadingBodyFunc: checkResponseHeadersIfOldCid,
                        abortController,
                        maxFileSizeBytes: MAX_FILE_SIZE_BYTES_FOR_SUBPLEBBIT_IPFS,
                        timeoutMs: this._plebbit._timeouts["subplebbit-ipns"],
                        log,
                        requestHeaders: requestHeaders
                    })
                ),
                timeoutId: setTimeout(
                    () => abortController.abort("Aborting subplebbit IPNS request because it timed out after " + timeoutMs + "ms"),
                    timeoutMs
                )
            };
        }

        const stopSignal = this._subplebbit._getStopAbortSignal();
        const onStopAbort = () => cleanUp();

        const cleanUp = () => {
            queueLimit.clearQueue();
            Object.values(gatewayFetches).forEach((gateway) => {
                if (!gateway.subplebbitRecord && !gateway.error) gateway.abortController.abort("Cleaning up requests for subplebbit");
                clearTimeout(gateway.timeoutId);
            });
            if (stopSignal) stopSignal.removeEventListener("abort", onStopAbort);
        };

        if (stopSignal) {
            throwIfAbortSignalAborted(stopSignal);
            stopSignal.addEventListener("abort", onStopAbort, { once: true });
        }

        const _findRecentCommunity = (): { subplebbit: CommunityIpfsType; cid: string } | undefined => {
            // Try to find a very recent subplebbit
            // If not then go with the most recent subplebbit record after fetching from 3 gateways
            const gatewaysWithSub = remeda.keys.strict(gatewayFetches).filter((gatewayUrl) => gatewayFetches[gatewayUrl].subplebbitRecord);
            if (gatewaysWithSub.length === 0) return undefined;

            const currentUpdatedAt = this._subplebbit.raw.subplebbitIpfs?.updatedAt || 0;

            const totalGateways = gatewaysSorted.length;

            const gatewaysWithError = remeda.keys.strict(gatewayFetches).filter((gatewayUrl) => gatewayFetches[gatewayUrl].error);

            const bestGatewayUrl = <string>(
                remeda.maxBy(gatewaysWithSub, (gatewayUrl) => gatewayFetches[gatewayUrl].subplebbitRecord!.updatedAt)
            );
            const bestGatewayRecordAge = timestamp() - gatewayFetches[bestGatewayUrl].subplebbitRecord!.updatedAt; // how old is the record, relative to now, in seconds

            if (gatewayFetches[bestGatewayUrl].subplebbitRecord!.updatedAt > currentUpdatedAt) {
                const bestSubRecord = gatewayFetches[bestGatewayUrl].subplebbitRecord!;
                log(
                    `Gateway (${bestGatewayUrl}) was able to find a very recent subplebbit (${this._deriveAddressFromWireRecord(bestSubRecord)}) whose IPNS is (${ipnsName}).  The record has updatedAt (${bestSubRecord.updatedAt}) that's ${bestGatewayRecordAge}s old with a TTL of ${gatewayFetches[bestGatewayUrl].ttl} seconds`
                );
                return { subplebbit: bestSubRecord, cid: gatewayFetches[bestGatewayUrl].cid! };
            }

            // We weren't able to find any new subplebbit records
            if (gatewaysWithError.length + gatewaysWithSub.length === totalGateways) return undefined;
        };

        const promisesToIterate = <Promise<{ resText: string; res: Response } | { error: PKCError }>[]>(
            Object.values(gatewayFetches).map((gatewayFetch) => gatewayFetch.promise)
        );

        let suitableCommunity: { subplebbit: CommunityIpfsType; cid: string };
        try {
            suitableCommunity = await new Promise<typeof suitableCommunity>((resolve, reject) =>
                promisesToIterate.map((gatewayPromise, i) =>
                    gatewayPromise
                        .then(async (res) => {
                            if ("error" in res) Object.values(gatewayFetches)[i].error = res.error;
                            const gatewaysWithError = remeda.keys
                                .strict(gatewayFetches)
                                .filter((gatewayUrl) => gatewayFetches[gatewayUrl].error);
                            if (gatewaysWithError.length === gatewaysSorted.length)
                                // All gateways failed
                                reject("All gateways failed to fetch subplebbit record " + ipnsName);

                            const recentCommunity = _findRecentCommunity();
                            if (recentCommunity) {
                                cleanUp();
                                resolve(recentCommunity);
                            }
                        })
                        .catch((err) => reject("One of the gateway promise requests thrown an error, should not happens:" + err))
                )
            );
        } catch {
            cleanUp();
            throwIfAbortSignalAborted(stopSignal);
            const gatewayToError = remeda.mapValues(gatewayFetches, (gatewayFetch) => gatewayFetch.error!);
            const hasGatewayConfirmingCurrentRecord = Object.keys(gatewayFetches)
                .map((gatewayUrl) => gatewayFetches[gatewayUrl].error!)
                .some(
                    (err) =>
                        err.details?.status === 304 ||
                        err.code === "ERR_GATEWAY_ABORTING_LOADING_COMMUNITY_BECAUSE_WE_ALREADY_LOADED_THIS_RECORD"
                );
            if (hasGatewayConfirmingCurrentRecord) return undefined; // any gateway confirmed we already have the latest consumed record

            const combinedError = new FailedToFetchCommunityFromGatewaysError({
                ipnsName,
                gatewayToError,
                subplebbitAddress: this._subplebbit.address,
                ipnsPubsubTopic: this._subplebbit.ipnsPubsubTopic,
                ipnsPubsubTopicRoutingCid: this._subplebbit.ipnsPubsubTopicRoutingCid
            });
            delete combinedError.stack;
            throw combinedError;
        }

        // TODO add punishment for gateway that returns old ipns record
        // TODO add punishment for gateway that returns invalid subplebbit
        return suitableCommunity;
    }

    private async _findErrorInCommunityRecord(
        subJson: CommunityIpfsType,
        ipnsNameOfSub: string,
        cidOfSubIpns: string
    ): Promise<PKCError | undefined> {
        const subInstanceAddress = this._getCommunityAddressFromInstance();
        const recordAddress = this._deriveAddressFromWireRecord(subJson);
        const addressMatchesInstance = this._areEquivalentCommunityAddresses(recordAddress, subInstanceAddress);
        // When address is a domain but we loaded via publicKey fallback, the record's derived address
        // might be the publicKey (if the record has no name field) — also accept that as a match
        const addressMatchesPublicKey = this._subplebbit.publicKey
            ? this._areEquivalentCommunityAddresses(recordAddress, this._subplebbit.publicKey)
            : false;
        // Accept when user loaded by raw IPNS key and the record's signature key matches.
        // Handles: {address: "12D3Koo..."} loads record with name: "plebbit.bso".
        // NOT applied for domain addresses (Scenario C stays rejected).
        const instanceAddressIsDomain = isStringDomain(subInstanceAddress);
        const signatureKeyMatchesIpnsName = !instanceAddressIsDomain
            ? this._areEquivalentCommunityAddresses(getPKCAddressFromPublicKeySync(subJson.signature.publicKey), ipnsNameOfSub)
            : false;
        if (!addressMatchesInstance && !addressMatchesPublicKey && !signatureKeyMatchesIpnsName) {
            // Did the gateway supply us with a different subplebbit's ipns

            const error = new PKCError("ERR_THE_COMMUNITY_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED", {
                addressFromCommunityInstance: subInstanceAddress,
                ipnsName: ipnsNameOfSub,
                addressFromGateway: recordAddress,
                subplebbitIpnsFromGateway: subJson,
                ipnsPubsubTopic: this._subplebbit.ipnsPubsubTopic,
                ipnsPubsubTopicRoutingCid: this._subplebbit.ipnsPubsubTopicRoutingCid,
                cidOfSubIpns
            });
            return error;
        }
        const verificationOpts = {
            subplebbit: subJson,
            subplebbitIpnsName: ipnsNameOfSub,
            resolveAuthorNames: this._plebbit.resolveAuthorNames,
            clientsManager: this,
            validatePages: this._plebbit.validatePages,
            abortSignal: this._subplebbit._getStopAbortSignal()
        };
        const updateValidity = await verifyCommunity(verificationOpts);
        if (!updateValidity.valid) {
            const error = new PKCError("ERR_COMMUNITY_SIGNATURE_IS_INVALID", {
                signatureValidity: updateValidity,
                ipnsPubsubTopic: this._subplebbit.ipnsPubsubTopic,
                ipnsPubsubTopicRoutingCid: this._subplebbit.ipnsPubsubTopicRoutingCid,
                verificationOpts,
                cidOfSubIpns
            });
            return error;
        }
    }
}

import retry, { RetryOperation } from "retry";
import {
    BaseClientsManager,
    OptionsToLoadFromGateway,
    PreResolveNameResolverOptions,
    PostResolveNameResolverSuccessOptions
} from "../clients/base-client-manager.js";
import { PKCClientsManager } from "../pkc/pkc-client-manager.js";
import { FailedToFetchCommunityFromGatewaysError, PKCError } from "../pkc-error.js";
import { ResultOfFetchingCommunity } from "../types.js";
import { NameResolverClient } from "../clients/name-resolver-client.js";
import type { NameResolveCacheOptions } from "../schema.js";
import { RemoteCommunity } from "./remote-community.js";
import { keys, mapValues } from "remeda";
import type { CommunityIpfsType } from "./types.js";
import { getCommunityNameFromWire } from "./community-wire.js";
import { getPKCAddressFromPublicKeySync } from "../signer/util.js";
import Logger from "../logger.js";

import {
    areEquivalentCommunityAddresses,
    fetchAndValidateIpnsRecordFromGateway,
    hideClassPrivateProps,
    ipnsNameToIpnsOverPubsubTopic,
    isAbortError,
    isIpfsPath,
    isIpnsPath,
    isStringDomain,
    pubsubTopicToDhtKey,
    sleepUntilTimeoutOrAbort,
    interruptibleSleep,
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
import { CID } from "multiformats/cid"; // re-sourced from kubo-rpc-client (identical class) to keep kubo off the eager import path
import { getAuthorNameFromRuntime } from "../publications/publication-author.js";

import { type CommunityGatewayFetch, selectWinningGatewayCommunity } from "./community-gateway-selection.js";
import type { Libp2pJsClient } from "../helia/libp2pjsClient.js";
import type { IpnsRecordArrival, IpnsRecordArrivalListener } from "../helia/types.js";

export const MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS = 1024 * 1024; // 1mb

// Floor on how often a timer-fired safety-net tick may force a network revalidation of the
// community's IPNS record. At the production updateInterval (60s) every tick revalidates, so
// this changes nothing there; it only engages for sub-30s intervals (every test pkc runs 500ms),
// where forcing the network on each tick would turn every idle community into a constant
// multi-peer fetcher AND flip the loop's duty cycle from parked-in-waiting-retry to
// mid-fetching-ipns — which is what tripped the browser CI legs' state-sampling assertions
// (post.updatingState races against the community tick's phase). Worst-case staleness after a
// missed push at an aggressive interval is therefore ~30s, still 10x under riding out kubo
// 0.43's default 300s record ttl the way the pre-#311 cache-gated poll did.
const FORCED_IPNS_NETWORK_REVALIDATION_MIN_INTERVAL_MS = 30_000;

export class CommunityClientsManager extends PKCClientsManager {
    override clients!: {
        ipfsGateways: { [ipfsGatewayUrl: string]: CommunityIpfsGatewayClient };
        kuboRpcClients: { [kuboRpcClientUrl: string]: CommunityKuboRpcClient };
        pubsubKuboRpcClients: { [pubsubClientUrl: string]: CommunityKuboPubsubClient };
        pkcRpcClients: Record<string, CommunityPKCRpcStateClient>;
        libp2pJsClients: { [libp2pJsClientUrl: string]: CommunityLibp2pJsClient };
        nameResolvers: { [resolverKey: string]: NameResolverClient };
    };
    private _community: RemoteCommunity;
    private _suppressUpdatingStateForNameResolution = 0;
    _ipnsLoadingOperation?: RetryOperation = undefined;
    _updateCidsAlreadyLoaded: LimitedSet<string> = new LimitedSet<string>(30); // we will keep track of the last 50 community update cids that we loaded

    // Event-driven update loop plumbing (issue #308), used only when the default record resolver
    // is a libp2p-js client. Pending arrivals survive an arrival that lands while updateOnce is
    // mid-flight, so the loop re-runs immediately instead of parking for a full safety-net
    // period and missing the record it was just told about. Pending CIDs / hop targets (not a
    // boolean) because the loop's OWN direct-fetch cache writes fire the arrival listener
    // mid-updateOnce, before the consumed cid (or walked hop) is recorded anywhere — only the
    // park, running after updateOnce, can tell those self-arrivals apart from a genuinely
    // unconsumed push (see _consumePendingIpnsArrivals).
    private _subscribedIpnsArrivalTopics = new Set<string>();
    private _ipnsArrivalListener?: IpnsRecordArrivalListener;
    private _ipnsArrivalClient?: Libp2pJsClient;
    private _pendingIpnsArrivalCids = new Set<string>();
    private _pendingIpnsArrivalHopTargets = new Set<string>();
    // Set when the park ends by its safety-net timer rather than an arrival wake: the tick
    // exists to catch pushes that never arrived, which the routing-layer cache gate by
    // definition cannot observe (the cache still holds the old record, fresh inside its ttl),
    // so the resolve that follows must revalidate against the network (nocache). An
    // arrival-woken cycle keeps the cache read — the arrival IS the newly cached record.
    private _nextResolveRevalidatesNetwork = false;
    // Time of the last resolve that actually forced the network (plus the loop start, whose
    // first updateOnce resolves against the network anyway — no subscription exists yet, so the
    // cache gate is off). Feeds the FORCED_IPNS_NETWORK_REVALIDATION_MIN_INTERVAL_MS floor.
    private _lastForcedIpnsNetworkRevalidationAtMs = 0;
    private _wakeUpdateLoopForIpnsArrival?: () => void;

    constructor(community: CommunityClientsManager["_community"]) {
        super(community._pkc);
        this._community = community;
        this._initPKCRpcClients();
        hideClassPrivateProps(this);
    }

    protected override _initKuboRpcClients(): void {
        if (this._pkc.clients.kuboRpcClients)
            for (const ipfsUrl of keys(this._pkc.clients.kuboRpcClients))
                this.clients.kuboRpcClients = { ...this.clients.kuboRpcClients, [ipfsUrl]: new CommunityKuboRpcClient("stopped") };
    }

    protected override _initPubsubKuboRpcClients(): void {
        for (const pubsubUrl of keys(this._pkc.clients.pubsubKuboRpcClients))
            this.clients.pubsubKuboRpcClients = {
                ...this.clients.pubsubKuboRpcClients,
                [pubsubUrl]: new CommunityKuboPubsubClient("stopped")
            };
    }

    protected override _initLibp2pJsClients(): void {
        if (this._pkc.clients.libp2pJsClients)
            for (const libp2pJsClientUrl of keys(this._pkc.clients.libp2pJsClients))
                this.clients.libp2pJsClients = {
                    ...this.clients.libp2pJsClients,
                    [libp2pJsClientUrl]: new CommunityLibp2pJsClient("stopped")
                };
    }

    protected _initPKCRpcClients() {
        for (const rpcUrl of keys(this._pkc.clients.pkcRpcClients))
            this.clients.pkcRpcClients = {
                ...this.clients.pkcRpcClients,
                [rpcUrl]: new CommunityPKCRpcStateClient("stopped")
            };
    }

    override updateKuboRpcState(newState: CommunityKuboRpcClient["state"], kuboRpcClientUrl: string) {
        super.updateKuboRpcState(newState, kuboRpcClientUrl);
    }

    override updateKuboRpcPubsubState(newState: CommunityKuboPubsubClient["state"], pubsubProvider: string) {
        super.updateKuboRpcPubsubState(newState, pubsubProvider);
    }

    // A read-only community never publishes over pubsub, so its node may have no pubsub provider to
    // report a state for (issue #229). There is nothing to label in that case, not a failure.
    updateKuboRpcPubsubStateIfProviderExists(newState: CommunityKuboPubsubClient["state"]) {
        const pubsubClient = this.getDefaultKuboPubsubClientIfAny();
        if (pubsubClient) this.updateKuboRpcPubsubState(newState, pubsubClient.url);
    }

    override updateGatewayState(newState: CommunityIpfsGatewayClient["state"], gateway: string): void {
        super.updateGatewayState(newState, gateway);
    }

    override updateLibp2pJsClientState(newState: CommunityLibp2pJsClient["state"], libp2pJsClientUrl: string) {
        super.updateLibp2pJsClientState(newState, libp2pJsClientUrl);
    }

    override emitError(e: PKCError): void {
        this._community.emit("error", e);
    }

    protected override _getStatePriorToResolvingCommunityIpns(): "fetching-community-ipns" | "fetching-ipns" {
        return "fetching-ipns";
    }

    override preResolveNameResolver(opts: PreResolveNameResolverOptions): void {
        super.preResolveNameResolver(opts);
        if (this._suppressUpdatingStateForNameResolution > 0) return;
        if (opts.resolveType !== "community") return;
        this._community._setUpdatingStateWithEventEmissionIfNewState("resolving-name");
    }

    override postResolveNameResolverSuccess(opts: PostResolveNameResolverSuccessOptions): void {
        super.postResolveNameResolverSuccess(opts);
        if (!opts.resolvedValue && this._community.state === "updating") {
            throw new PKCError("ERR_DOMAIN_TXT_RECORD_NOT_FOUND", {
                name: opts.address
            });
        }
    }

    protected _getCommunityAddressFromInstance(): string {
        return this._community.address;
    }

    private _areEquivalentCommunityAddresses(addressA: string, addressB: string): boolean {
        return areEquivalentCommunityAddresses(addressA, addressB);
    }

    private _deriveAddressFromWireRecord(communityJson: CommunityIpfsType): string {
        // Old records have address in the wire format, new records use name || publicKey
        return (
            getCommunityNameFromWire(communityJson as Record<string, unknown>) ||
            getPKCAddressFromPublicKeySync(communityJson.signature.publicKey)
        );
    }

    // functions for updatingCommunityInstance

    private async _retryLoadingCommunityAddress(
        communityAddress: string
    ): Promise<ResultOfFetchingCommunity | { criticalError: Error | PKCError } | { aborted: true }> {
        const log = Logger("pkc-js:remote-community:update:_retryLoadingCommunityIpns");

        return new Promise((resolve) => {
            this._ipnsLoadingOperation!.attempt(async (curAttempt) => {
                log.trace(`Retrying to load community ${communityAddress} for the ${curAttempt}th time`);
                try {
                    const update = await this.fetchNewUpdateForCommunity(communityAddress);

                    resolve(update);
                } catch (e) {
                    const error = <Error | PKCError>e;
                    if (error.name === "AbortError") return resolve({ aborted: true });
                    //@ts-expect-error
                    error.details = {
                        //@ts-expect-error
                        ...error.details,
                        ipnsPubsubTopic: this._community.ipnsPubsubTopic,
                        ipnsPubsubTopicRoutingCid: this._community.ipnsPubsubTopicRoutingCid
                    };
                    if (!this._community._isRetriableErrorWhenLoading(error)) {
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
                            `Failed to load Community ${this._community.address} record for the ${curAttempt}th attempt. We will retry`,
                            error
                        );

                        // Gateway signature errors are transient (e.g. stale IPNS cache) — log but don't emit error event
                        const isGatewaySignatureError =
                            error instanceof FailedToFetchCommunityFromGatewaysError &&
                            Object.values(error.details.gatewayToError).every(
                                (gatewayError) =>
                                    gatewayError instanceof PKCError && gatewayError.code === "ERR_COMMUNITY_SIGNATURE_IS_INVALID"
                            );
                        if (isGatewaySignatureError) {
                            log(`Community ${this._community.address} gateway returned invalid signature, silently retrying`);
                            this._community._setUpdatingStateWithEventEmissionIfNewState("waiting-retry");
                        } else {
                            this._community._changeStateEmitEventEmitStateChangeEvent({
                                event: { name: "error", args: [error] },
                                newUpdatingState: "waiting-retry"
                            });
                        }

                        this._ipnsLoadingOperation!.retry(<Error>e);
                    }
                }
            });
        });
    }

    async updateOnce() {
        const log = Logger("pkc-js:remote-community:update");

        // Capture the identity and stop signal this fetch starts under. A key migration mid-fetch
        // (_resolveNameInBackground) switches publicKey and aborts the stop controller, but the
        // abort can't cancel a gateway response whose body was already received; the migration also
        // clears raw.communityIpfs, so the freshness check below would accept the stale old-key
        // record. Discard the result instead of applying it to the migrated community.
        const publicKeyAtFetchStart = this._community.publicKey;
        const stopSignalAtFetchStart = this._community._getStopAbortSignal();

        this._ipnsLoadingOperation = retry.operation({ forever: true, factor: 2, maxTimeout: 30000 });
        const communityLoadingRes = await this._retryLoadingCommunityAddress(this._community.address); // will return undefined if no new community CID is found
        this._ipnsLoadingOperation.stop();

        if (stopSignalAtFetchStart?.aborted || this._community.publicKey !== publicKeyAtFetchStart) {
            log(
                `Community ${this._community.address} fetch result discarded: it was fetched under public key ${publicKeyAtFetchStart} but the community's operations were aborted or its public key changed to ${this._community.publicKey} mid-fetch (key migration)`
            );
            return;
        }

        if (communityLoadingRes && "aborted" in communityLoadingRes) {
            return;
        } else if (communityLoadingRes && "criticalError" in communityLoadingRes) {
            // Log individual gateway errors separately to avoid Node.js [Object] truncation
            if (communityLoadingRes.criticalError instanceof FailedToFetchCommunityFromGatewaysError) {
                for (const [gatewayUrl, gatewayError] of Object.entries(communityLoadingRes.criticalError.details.gatewayToError)) {
                    log.error(`Community ${this._community.address} gateway ${gatewayUrl} non-retriable error:`, gatewayError);
                }
            }
            log.error(
                `Community ${this._community.address} encountered a non retriable error while updating, will emit an error event and mark invalid cid to not be loaded again`,
                communityLoadingRes.criticalError
            );
            this._community._changeStateEmitEventEmitStateChangeEvent({
                event: { name: "error", args: [communityLoadingRes.criticalError] },
                newUpdatingState: "failed"
            });
        } else if (
            communityLoadingRes?.community &&
            (this._community.raw.communityIpfs?.updatedAt || 0) < communityLoadingRes.community.updatedAt
        ) {
            const publicKeyBeforeApply = this._community.publicKey;
            this._community.initCommunityIpfsPropsNoMerge(communityLoadingRes.community);
            this._community.updateCid = communityLoadingRes.cid;
            // Re-anchor (#257): a record whose anchor claim moves the identity (e.g. loaded by
            // addressing the minter, claim recovers the anchor) invalidates any nameResolved verdict
            // computed against the previous identity — the triggers below re-classify against the
            // claimed one.
            if (publicKeyBeforeApply && this._community.publicKey !== publicKeyBeforeApply) this._community.nameResolved = undefined;
            // If we just discovered a name, trigger background resolution now (don't wait for next loop)
            if (
                !isStringDomain(this._community.address) &&
                this._community.name &&
                this._community.publicKey &&
                typeof this._community.nameResolved !== "boolean"
            ) {
                this._resolveNameInBackground(this._community.name);
            } else if (
                isStringDomain(this._community.address) &&
                this._community.publicKey &&
                typeof this._community.nameResolved !== "boolean"
            ) {
                // A domain-addressed community classifies its name right after the record lands: a
                // pre-load domain-vs-publicKey mismatch is deferred inside _resolveNameInBackground,
                // because only the loaded chain can tell a key migration from a delegated community
                // whose TXT record points at its own minter (#257).
                this._resolveNameInBackground(this._community.address);
            }
            log(
                `Remote Community`,
                this._community.address,
                `received a new update. Will emit an update event with updatedAt`,
                this._community.updatedAt,
                "that's",
                timestamp() - this._community.updatedAt!,
                "seconds old"
            );
            this._community._changeStateEmitEventEmitStateChangeEvent({
                event: { name: "update", args: [this._community] },
                newUpdatingState: "succeeded"
            });
            this._resolvePageAuthorNamesInBackground();
        } else if (communityLoadingRes === undefined) {
            // we loaded a community record that we already consumed
            // we will retry later
            this._community._setUpdatingStateWithEventEmissionIfNewState("waiting-retry");
        } else if (communityLoadingRes?.community) {
            this._community._setUpdatingStateWithEventEmissionIfNewState("succeeded");
        }
    }

    async startUpdatingLoop() {
        const log = Logger("pkc-js:remote-community:update");
        this._community._createStopAbortController();

        const areWeConnectedToKuboOrHelia =
            Object.keys(this._pkc.clients.kuboRpcClients).length > 0 || Object.keys(this._pkc.clients.libp2pJsClients).length > 0;
        const defaultIpfsClient = areWeConnectedToKuboOrHelia ? this.getDefaultKuboRpcClientOrHelia() : undefined;
        // Push-driven only for the libp2p-js resolver (issue #308): its routing-layer cache is
        // fed by gossipsub (issue #301), so a localStore write IS the "new record arrived"
        // signal, and the loop only needs a slow jittered safety-net poll for pushes it missed
        // (mesh partition, record published while we had no subscribers). The kubo-RPC resolver
        // keeps the 1s poll: kubo's namesys cache is not observable from here, so pkc has no
        // push signal for it yet (issue #308 tracks giving it the same treatment); gateways
        // already poll at pkc.updateInterval.
        const defaultLibp2pJsClient = defaultIpfsClient && "_helia" in defaultIpfsClient ? defaultIpfsClient : undefined;

        // Arm the arrival subscription BEFORE the first updateOnce: the first cycle spans the
        // resolve, the community IPFS fetch, parsing and signature verification — seconds on a
        // cold client — and a record pushed while it is mid-flight would otherwise fire no
        // listener and be recorded nowhere, waiting for the first safety-net tick (45-75s at
        // the production interval) where the old 1s poll picked it up in a second. The topic is
        // derivable pre-resolve for every non-domain address (ipnsName === address, see
        // _syncIpnsArrivalSubscriptions' fallback); a never-resolved domain address arms right
        // after its first updateOnce in the finally below, as before.
        if (defaultLibp2pJsClient) {
            try {
                this._syncIpnsArrivalSubscriptions(defaultLibp2pJsClient);
            } catch (e) {
                log.error(
                    `Failed to arm IPNS record arrival subscriptions of community ${this._community.address} before its first update`,
                    e
                );
            }
            // The first updateOnce always resolves against the network (no topic subscription
            // exists yet, so the cache gate is off), so the revalidation floor counts from here.
            this._lastForcedIpnsNetworkRevalidationAtMs = Date.now();
        }

        while (this._community.state === "updating" && !this._community._getStopAbortSignal()?.aborted) {
            try {
                await this.updateOnce();
            } catch (e) {
                log.error(`Failed to update community ${this._community.address} for this iteration, will retry later`, e);
            } finally {
                // Re-read the stop signal each iteration; both waits detach their listeners on
                // every outcome so nothing leaks on the long-lived signal (see issue #145).
                if (defaultLibp2pJsClient) {
                    try {
                        this._syncIpnsArrivalSubscriptions(defaultLibp2pJsClient);
                    } catch (e) {
                        log.error(`Failed to sync IPNS record arrival subscriptions of community ${this._community.address}`, e);
                    }
                    // Jittered per iteration so a directory of communities started together does
                    // not run its safety-net polls in lockstep (issue #307).
                    const safetyNetMs = this._pkc.updateInterval * (0.75 + Math.random() * 0.5);
                    await this._sleepUntilIpnsArrivalOrTimeoutOrAbort({ ms: safetyNetMs, signal: this._community._getStopAbortSignal() });
                } else {
                    const updateInterval = areWeConnectedToKuboOrHelia ? 1000 : this._pkc.updateInterval; // if we're on kubo we should resolve IPNS every second
                    await sleepUntilTimeoutOrAbort(updateInterval, this._community._getStopAbortSignal());
                }
            }
        }

        this._clearIpnsArrivalSubscriptions();
        this._community._clearStopAbortController();
        log("Community", this._community.address, "is no longer updating");
    }

    async stopUpdatingLoop() {
        this._ipnsLoadingOperation?.stop();
        this._updateCidsAlreadyLoaded.clear();
        this._clearIpnsArrivalSubscriptions();
    }

    // Wake the update loop when a record NEWER than anything already consumed lands in the
    // routing-layer cache (gossip push, direct-fetch cache write, or fallback fetch — all
    // newer-only writers). A record whose value was already consumed is not news: communities
    // re-publish records with a bumped sequence but an unchanged value — an unchanged /ipfs/
    // CID for a terminal record, an unchanged /ipns/ delegation target for an anchor's record
    // (kubo republishes on a timer, so an undiscriminating hop wake would re-run updateOnce at
    // the anchor's republish cadence — the #308 churn — on every delegated community). The
    // filters here only catch values already recorded; the loop's OWN direct-fetch cache
    // writes fire mid-updateOnce, BEFORE the cid it is consuming reaches
    // _updateCidsAlreadyLoaded (line ~790) / updateCid or the walked hop reaches ipnsHops —
    // those self-arrivals pass here and are dropped by the park's post-updateOnce re-check
    // instead (_consumePendingIpnsArrivals). A hop record delegating OUTSIDE the walked chain
    // is a delegation change and always warrants a walk. Any other value shape is unsupported
    // (resolveIpnsToCidP2P would throw on it), so it cannot advance the loop and wakes nothing.
    private _onIpnsRecordArrival(arrival: IpnsRecordArrival) {
        const value = arrival.record.value;
        if (isIpfsPath(value)) {
            const cid = value.split("/")[2];
            if (this._updateCidsAlreadyLoaded.has(cid) || this._community.updateCid === cid) return;
            this._pendingIpnsArrivalCids.add(cid);
        } else if (isIpnsPath(value)) {
            const hopTarget = value.split("/")[2];
            if (this._community.ipnsHops?.includes(hopTarget)) return;
            this._pendingIpnsArrivalHopTargets.add(hopTarget);
        } else return;
        this._wakeUpdateLoopForIpnsArrival?.();
    }

    // Consume the pending arrivals, dropping every cid the updateOnce that just ran consumed
    // and every hop target on the chain it walked (or that any earlier cycle consumed/walked —
    // a gossip replay). Returns whether anything genuinely new remains, in which case the
    // caller must skip its park and re-run updateOnce now. All pending state is cleared on a
    // true return: the immediate updateOnce re-run is the reaction to it, and keeping it would
    // re-trigger on the next park even when that re-run failed on a non-retriable record (the
    // arrival will not re-fire — the record is already the newest cached one — so a stale
    // entry here would spin the loop hot against a broken record).
    private _consumePendingIpnsArrivals(): boolean {
        for (const cid of this._pendingIpnsArrivalCids)
            if (this._updateCidsAlreadyLoaded.has(cid) || this._community.updateCid === cid) this._pendingIpnsArrivalCids.delete(cid);
        for (const hopTarget of this._pendingIpnsArrivalHopTargets)
            if (this._community.ipnsHops?.includes(hopTarget)) this._pendingIpnsArrivalHopTargets.delete(hopTarget);
        if (this._pendingIpnsArrivalCids.size === 0 && this._pendingIpnsArrivalHopTargets.size === 0) return false;
        this._pendingIpnsArrivalCids.clear();
        this._pendingIpnsArrivalHopTargets.clear();
        return true;
    }

    // Keep the arrival subscriptions in sync with the hops the last resolve walked: one topic
    // per IPNS name in the chain, so a delegated community wakes on a push to ANY hop. Runs
    // before the FIRST updateOnce (so a record pushed mid-first-fetch is not missed) and after
    // every updateOnce, because a key migration or delegation change swaps the hops, and from
    // wherever else the identity is decided (_resyncIpnsArrivalSubscriptionsIfArmed). Before
    // anything resolved, the name the first resolve will walk is derivable for every instance
    // but a never-resolved domain: the pinned publicKey (_pinnedIpnsName) or, failing that, a
    // non-domain address verbatim, exactly as fetchNewUpdateForCommunity seeds ipnsName.
    private _syncIpnsArrivalSubscriptions(client: Libp2pJsClient) {
        if (!this._ipnsArrivalListener) this._ipnsArrivalListener = (arrival) => this._onIpnsRecordArrival(arrival);
        this._ipnsArrivalClient = client;
        const preResolveIpnsName =
            this._community.ipnsName ??
            this._pinnedIpnsName() ??
            (!isStringDomain(this._community.address) ? this._community.address : undefined);
        const ipnsNamesToWatch = this._community.ipnsHops?.length
            ? this._community.ipnsHops
            : preResolveIpnsName
              ? [preResolveIpnsName]
              : [];
        const desiredTopics = new Set(ipnsNamesToWatch.map(ipnsNameToIpnsOverPubsubTopic));
        for (const topic of this._subscribedIpnsArrivalTopics)
            if (!desiredTopics.has(topic)) {
                client.heliaWithKuboRpcClientFunctions.ipnsRecordArrivals.unsubscribe({
                    pubsubTopic: topic,
                    listener: this._ipnsArrivalListener
                });
                this._subscribedIpnsArrivalTopics.delete(topic);
            }
        for (const topic of desiredTopics)
            if (!this._subscribedIpnsArrivalTopics.has(topic)) {
                client.heliaWithKuboRpcClientFunctions.ipnsRecordArrivals.subscribe({
                    pubsubTopic: topic,
                    listener: this._ipnsArrivalListener
                });
                this._subscribedIpnsArrivalTopics.add(topic);
            }
    }

    // Re-derive the arrival subscriptions from the community's current identity, if the update
    // loop armed them. The loop owns their lifetime (armed before its first cycle, cleared when
    // it ends), so a one-shot fetch outside a loop must never create any.
    private _resyncIpnsArrivalSubscriptionsIfArmed() {
        if (!this._ipnsArrivalClient) return;
        try {
            this._syncIpnsArrivalSubscriptions(this._ipnsArrivalClient);
        } catch (e) {
            Logger("pkc-js:remote-community:update").error(
                `Failed to sync IPNS record arrival subscriptions of community ${this._community.address}`,
                e
            );
        }
    }

    private _clearIpnsArrivalSubscriptions() {
        if (this._ipnsArrivalClient && this._ipnsArrivalListener)
            for (const topic of this._subscribedIpnsArrivalTopics)
                this._ipnsArrivalClient.heliaWithKuboRpcClientFunctions.ipnsRecordArrivals.unsubscribe({
                    pubsubTopic: topic,
                    listener: this._ipnsArrivalListener
                });
        this._subscribedIpnsArrivalTopics.clear();
        this._ipnsArrivalClient = undefined;
        this._pendingIpnsArrivalCids.clear();
        this._pendingIpnsArrivalHopTargets.clear();
        this._nextResolveRevalidatesNetwork = false;
    }

    // Park until a pushed record arrival, the (jittered) safety-net timeout, or the stop signal,
    // whichever fires first (interruptibleSleep detaches its timer and abort listener on every
    // outcome, the issue #145 pattern). An arrival that fired while updateOnce was mid-flight is
    // consumed immediately instead of being lost — unless that very updateOnce consumed it (the
    // loop's own cache write reports the record it is fetching before recording it as loaded, so
    // only this post-updateOnce re-check can drop it; see _consumePendingIpnsArrivals).
    private async _sleepUntilIpnsArrivalOrTimeoutOrAbort({ ms, signal }: { ms: number; signal?: AbortSignal }): Promise<void> {
        if (this._consumePendingIpnsArrivals()) {
            // Arrival-driven cycle: the arrival IS the freshly cached record, so the resolve
            // that follows may serve it from the routing-layer cache.
            this._nextResolveRevalidatesNetwork = false;
            return;
        }
        const { promise, wake } = interruptibleSleep({ ms, signal });
        let wokenByArrival = false;
        const wakeForArrival = () => {
            wokenByArrival = true;
            wake();
        };
        this._wakeUpdateLoopForIpnsArrival = wakeForArrival;
        await promise;
        if (this._wakeUpdateLoopForIpnsArrival === wakeForArrival) this._wakeUpdateLoopForIpnsArrival = undefined;
        if (wokenByArrival) {
            // The updateOnce that follows is the reaction to everything pending. Keeping the
            // entries would fast-return the NEXT park into an identical re-run whenever that
            // cycle fails without changing the chain (a hop arrival delegating beyond
            // MAX_IPNS_HOPS is non-retriable and leaves ipnsHops as it was): two error events
            // per push instead of one. Same rule _consumePendingIpnsArrivals applies on a hit.
            this._pendingIpnsArrivalCids.clear();
            this._pendingIpnsArrivalHopTargets.clear();
        }
        // A timer-fired park end is the safety net's tick: it exists precisely for pushes that
        // never arrived, which the cache gate cannot observe — the next resolve must go to the
        // network (see _nextResolveRevalidatesNetwork), bounded by the revalidation floor so a
        // sub-30s updateInterval does not force the network on every tick. The abort outcome
        // also lands here, but the loop exits before another resolve runs, so the flag value is
        // moot.
        this._nextResolveRevalidatesNetwork =
            !wokenByArrival && Date.now() - this._lastForcedIpnsNetworkRevalidationAtMs >= FORCED_IPNS_NETWORK_REVALIDATION_MIN_INTERVAL_MS;
    }

    // fetching community ipns here

    private async _resolveCommunityNameWithoutUpdatingState({
        communityName,
        abortSignal,
        cache
    }: {
        communityName: string;
        abortSignal?: AbortSignal;
        cache?: NameResolveCacheOptions;
    }): Promise<string | null> {
        this._suppressUpdatingStateForNameResolution++;
        try {
            return await this.resolveCommunityNameIfNeeded({ communityName, abortSignal, cache });
        } finally {
            this._suppressUpdatingStateForNameResolution--;
        }
    }

    // The non-anchor hops (minter and any intermediates) of the community's own validated chain, or
    // undefined while no record has been loaded and the chain is unknown: every key the loaded record
    // is known to travel through (resolved hops + the record's signer) minus the identity itself. A
    // non-delegated community with a loaded record answers []. Gated on the loaded record, not on
    // ipnsHops alone: fetchNewUpdateForCommunity seeds a provisional single-hop ipnsHops for domain
    // addresses before anything loads, and that provisional value says nothing about whether the
    // community is delegated. The identity is subtracted rather than hops[0] because a re-anchored
    // instance (loaded by addressing the minter directly, identity from the record's anchor claim)
    // has ipnsHops = [minter] while its identity is the anchor.
    private _nonAnchorHopsOfLoadedChain(): string[] | undefined {
        const loadedRecord = this._community.raw.communityIpfs;
        if (!loadedRecord) return undefined;
        const chainKeys = new Set<string>(this._community.ipnsHops ?? []);
        chainKeys.add(getPKCAddressFromPublicKeySync(loadedRecord.signature.publicKey));
        if (this._community.publicKey) chainKeys.delete(this._community.publicKey);
        return [...chainKeys];
    }

    // Switch the community to the key its name now resolves to: drop every piece of state that
    // described the old key (it may be compromised), point the update loop's push channel at
    // the new key, and restart the in-flight fetch.
    private _applyKeyMigration({ communityName, newPublicKey }: { communityName: string; newPublicKey: string }) {
        const log = Logger("pkc-js:community-client-manager:_applyKeyMigration");
        log("Key migration detected for", communityName, "old:", this._community.publicKey, "new:", newPublicKey);
        const previousPublicKey = this._community.publicKey;
        const error = new PKCError("ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY", {
            communityName,
            previousPublicKey,
            newPublicKey
        });

        // Clear all data immediately (old data may be from compromised key)
        this._community._clearDataForKeyMigration(newPublicKey);
        this._updateCidsAlreadyLoaded.clear();
        this._community.nameResolved = true;
        // The pending arrivals describe the old key's records, and with the loaded set and
        // updateCid just cleared nothing downstream filters them (a wasted old-key cycle). The
        // loop must also watch the NEW key's topic from now on, not from when its record is
        // first fetched: until then an old-key republish would keep waking it (issue #308).
        this._pendingIpnsArrivalCids.clear();
        this._pendingIpnsArrivalHopTargets.clear();
        this._resyncIpnsArrivalSubscriptionsIfArmed();

        // Abort in-flight fetch (using old key) by aborting the stop controller,
        // then immediately create a new one so the update loop continues.
        this._community._abortStopOperations("Key migration: name resolved to different public key");
        this._community._createStopAbortController();

        // Emit update so UI drops stale data right away
        this._community.emit("update", this._community);
        this._community.emit("error", error);
    }

    private _resolveNameInBackground(name: string) {
        const log = Logger("pkc-js:community-client-manager:_resolveNameInBackground");
        const setNameResolvedAndEmitUpdate = (newNameResolved: boolean) => {
            if (this._community.nameResolved === newNameResolved) return;
            this._community.nameResolved = newNameResolved;
            // Only emit update if the community has been loaded at least once —
            // otherwise we'd fire a premature "update" before the IPNS fetch completes.
            if (typeof this._community.updatedAt === "number") {
                this._community.emit("update", this._community);
            }
        };
        this._resolveCommunityNameWithoutUpdatingState({
            communityName: name,
            abortSignal: this._community._getStopAbortSignal(),
            // Background drift detection — 1h staleness window.
            cache: { maxAge: 3600 }
        })
            .then((resolved) => {
                if (resolved && resolved !== this._community.publicKey) {
                    const nonAnchorHops = this._nonAnchorHopsOfLoadedChain();
                    if (nonAnchorHops?.includes(resolved)) {
                        // The name resolves to a non-anchor hop of this community's OWN validated chain
                        // (e.g. its minter): a misconfigured TXT record on a delegated community, not a
                        // key migration. A delegated community's domain must point at the anchor — the
                        // identity readers resolve — the same rule the publisher side enforces in
                        // _assertDomainResolvesCorrectly. Migrating here would silently demote the
                        // community identity to the rotating minter key and wipe its loaded record (#257).
                        log(
                            `Community name ${name} resolves to ${resolved}, a non-anchor hop of the community's own chain, instead of its identity ${this._community.publicKey}. Marking nameResolved false`
                        );
                        setNameResolvedAndEmitUpdate(false);
                        return;
                    }
                    // Key change detected: name now points to a different key.
                    // Most likely: cached publicKey is stale after community key migration.
                    this._applyKeyMigration({ communityName: name, newPublicKey: resolved });
                } else if (resolved) {
                    setNameResolvedAndEmitUpdate(true);
                }
                // If resolved is null but community has a name, the name is not resolving
                if (!resolved && this._community.name) {
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
        if (!this._pkc.resolveAuthorNames) return;
        const pages = this._community.posts?.pages;
        if (!pages) return;

        const authors: Array<{ authorName: string; signaturePublicKey: string }> = [];
        for (const page of Object.values(pages)) {
            if (!page) continue;
            for (const comment of page.comments) {
                const domain = getAuthorNameFromRuntime(comment.author);
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
                // Only community.nameResolved changes should emit updates (handled by _resolveNameInBackground).
                for (const page of Object.values(this._community.posts?.pages || {})) {
                    if (page) this._community.posts._applyNameResolvedCacheToPage(page);
                }
            },
            abortSignal: this._community._getStopAbortSignal()
        });
    }

    // The IPNS name every fetch pins to WITHOUT resolving anything, once one is known: a
    // publicKey given alongside a domain address, a loaded anchor claim, or a verified name.
    // A record with an anchor claim routes through the identity (the anchor chain) no matter
    // how the instance was addressed (#257): the anchor is the rotation-safe pointer, so a
    // reader must never stay pinned to the minter it happened to reach the record through.
    // Shared by fetchNewUpdateForCommunity and the arrival subscription derivation so a
    // domain+publicKey community is watchable before its first resolve, like a raw-key one.
    private _pinnedIpnsName(): string | undefined {
        const isDomain = isStringDomain(this._community.address);
        const hasAnchorClaim = Boolean(this._community.anchor);
        if (
            this._community.publicKey &&
            (isDomain || hasAnchorClaim || (!isDomain && this._community.name && this._community.nameResolved === true))
        )
            return this._community.publicKey;
        return undefined;
    }

    async fetchNewUpdateForCommunity(communityAddress: string): Promise<ResultOfFetchingCommunity> {
        return this._withInflightCommunityFetch(communityAddress, async () => {
            let ipnsName: string | null;
            const isDomain = isStringDomain(communityAddress);

            const pinnedIpnsName = this._pinnedIpnsName();
            if (pinnedIpnsName) {
                // Once a domain has been verified against a public key, keep fetching through the current public key
                // even if the immutable address on the instance is a raw IPNS key.
                ipnsName = pinnedIpnsName;
                if (isDomain) this._resolveNameInBackground(communityAddress);
            } else {
                // Name only or publicKey only: use existing resolution flow
                ipnsName = await this.resolveCommunityNameIfNeeded({
                    communityName: communityAddress,
                    abortSignal: this._community._getStopAbortSignal(),
                    // Subscribe-by-domain can ride the cache for up to 1h.
                    cache: { maxAge: 3600 }
                });
            }

            // When loaded by raw IPNS key, verify the record's name claim in background (once)
            if (!isDomain && this._community.name && this._community.publicKey && typeof this._community.nameResolved !== "boolean") {
                this._resolveNameInBackground(this._community.name);
            }

            if (!ipnsName) throw Error("Failed to resolve community address to an IPNS name");

            // If the community address is a domain, we need to update the ipnsName and ipns pubsub props
            // even if we fail to load the IPNS record, so that pubsub can work correctly
            if (this._community.ipnsName !== ipnsName) {
                this._community.ipnsName = ipnsName;
                // Default to a single-hop chain; the resolution step below replaces this with the
                // full chain ([anchor, ..., terminal]) once the IPNS record(s) are resolved.
                this._community.ipnsHops = [ipnsName];
                this._community.ipnsPubsubTopic = ipnsNameToIpnsOverPubsubTopic(ipnsName);
                this._community.ipnsPubsubTopicRoutingCid = pubsubTopicToDhtKey(this._community.ipnsPubsubTopic);
                // A freshly resolved domain now has a watchable topic: arm it for the rest of this
                // cycle instead of only after updateOnce returns, so a record pushed while the
                // cycle fetches and verifies is recorded rather than dropped at the source.
                this._resyncIpnsArrivalSubscriptionsIfArmed();
            }

            if (this._community.updateCid) this._updateCidsAlreadyLoaded.add(this._community.updateCid);

            // This function should fetch CommunityIpfs, parse it and verify its signature
            // Then return CommunityIpfs

            // only exception is if the ipnsRecord.value (ipfs path) has already been loaded and stored in this._updateCidsAlreadyLoaded
            // in that case no need to fetch the communityIpfs, we will return undefined
            this._community._setUpdatingStateWithEventEmissionIfNewState("fetching-ipns");
            let subRes: ResultOfFetchingCommunity;
            const areWeConnectedToKuboOrHelia =
                Object.keys(this._pkc.clients.kuboRpcClients).length > 0 || Object.keys(this._pkc.clients.libp2pJsClients).length > 0;
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
                        communityAddress,
                        ipnsPubsubTopic: this._community.ipnsPubsubTopic,
                        ipnsPubsubTopicRoutingCid: this._community.ipnsPubsubTopicRoutingCid
                    };
                    throw e;
                } finally {
                    if ("_helia" in kuboRpcOrHelia) this.updateLibp2pJsClientState("stopped", kuboRpcOrHelia._libp2pJsClientsOptions.key);
                    else this.updateKuboRpcState("stopped", kuboRpcOrHelia.url);
                }
            } else subRes = await this._fetchCommunityFromGateways(ipnsName); // let's use gateways to fetch because we're not connected to kubo or helia
            // States of gateways should be updated by fetchFromMultipleGateways
            // Community records are verified within _fetchCommunityFromGateways

            if (subRes?.community) {
                // we found a new record that is verified.
                // Key the cache by the ANCHOR identity (domain or anchor IPNS name), not by the
                // record's signature key — for a delegated community the content is signed by the
                // terminal (minter) key, but the user-facing identity is the anchor. The record's
                // signed anchor claim is the authority (#257): ipnsName is only the name the fetch
                // travelled through, which behind a minter-pointing TXT is the MINTER — caching that
                // as publicKey would make every publication sign to the minter and be rejected. For a
                // non-delegated community (no claim) ipnsName is the identity, unchanged.
                const identityPublicKey = subRes.community.anchor?.publicKey ?? ipnsName;
                const anchorIdentityAddress = subRes.community.name || identityPublicKey;
                this._pkc._memCaches.communityForPublishing.set(anchorIdentityAddress, {
                    encryption: subRes.community.encryption,
                    pubsubTopic: subRes.community.pubsubTopic,
                    address: anchorIdentityAddress,
                    publicKey: identityPublicKey,
                    name: subRes.community.name
                });
            }
            return subRes;
        });
    }

    // True while the libp2p-js resolver's push-channel watchdog vouches for `ipnsName`'s topic
    // (issue #330). A probe failure must never break the update cycle: on any error the answer
    // is "unhealthy", which only costs a network revalidation.
    private _isIpnsPushChannelHealthyForName(libp2pJsClient: Libp2pJsClient, ipnsName: string): boolean {
        try {
            return libp2pJsClient.heliaWithKuboRpcClientFunctions.isIpnsPushChannelHealthy({
                pubsubTopic: ipnsNameToIpnsOverPubsubTopic(ipnsName)
            });
        } catch {
            return false;
        }
    }

    private async _fetchCommunityIpnsP2PAndVerify(ipnsName: string): Promise<ResultOfFetchingCommunity> {
        const log = Logger("pkc-js:clients-manager:_fetchCommunityIpnsP2PAndVerify");
        const kuboRpcOrHelia = this.getDefaultKuboRpcClientOrHelia();
        if ("_helia" in kuboRpcOrHelia) {
            this.updateLibp2pJsClientState("fetching-ipns", kuboRpcOrHelia._libp2pJsClientsOptions.key);
        } else this.updateKuboRpcState("fetching-ipns", kuboRpcOrHelia.url);
        // A cycle woken by the safety-net timer (not by an arrival) exists for pushes that
        // never arrived, which the routing-layer cache gate's ttl check alone cannot observe —
        // it would serve the stale record for its whole remaining ttl (300s at kubo 0.43's
        // default) instead of the max(updateInterval, revalidation floor) the safety net
        // promises. The push-channel watchdog (issue #330) observes exactly that condition
        // though: while the anchor topic has gossipsub subscribers and a signature-valid record
        // arrived within the watchdog window, rebroadcasts and fetch-on-join are demonstrably
        // keeping the cache current, so the forced network revalidation is skipped and the
        // resolve rides the cache gate (each hop of a delegated chain then consults its own
        // topic's health, and the gate itself falls back to per-ttl revalidation the moment a
        // channel degrades — the next armed tick after that forces the network again). No-op
        // for the kubo-RPC resolver, which always resolves with nocache: true.
        const forceNetworkRevalidation =
            this._nextResolveRevalidatesNetwork &&
            !("_helia" in kuboRpcOrHelia && this._isIpnsPushChannelHealthyForName(kuboRpcOrHelia, ipnsName));
        // Consumed by the cycle's FIRST attempt only: updateOnce retries this fetch (forever,
        // with backoff) on retriable errors such as a CID fetch timeout after a successful
        // resolve, and those attempts must ride the cache as the 1s poll's retries did instead
        // of re-resolving over the network on every backoff step.
        this._nextResolveRevalidatesNetwork = false;
        if (forceNetworkRevalidation) this._lastForcedIpnsNetworkRevalidationAtMs = Date.now();
        const { cid: latestCommunityCid, ipnsHops } = await this.resolveIpnsToCidP2P(ipnsName, {
            timeoutMs: this._pkc._timeouts["community-ipns"],
            abortSignal: this._community._getStopAbortSignal(),
            ...(forceNetworkRevalidation ? { nocache: true } : {})
        });
        // ipnsHops[0] is the anchor (== ipnsName), ipnsHops.at(-1) is the terminal name whose
        // record points at the CID, i.e. the key that signs the community content. For a
        // non-delegated community the chain has a single element so terminal === anchor.
        this._community.ipnsHops = ipnsHops;
        const terminalIpnsName = ipnsHops[ipnsHops.length - 1];
        log.trace(`Resolved community IPNS`, ipnsName, `to CID`, latestCommunityCid, `via hops`, ipnsHops);
        if (this._updateCidsAlreadyLoaded.has(latestCommunityCid)) {
            log.trace(
                "Resolved community IPNS",
                ipnsName,
                "to a cid that we already loaded before. No need to fetch its ipfs",
                latestCommunityCid
            );
            return undefined;
        }

        if ("_helia" in kuboRpcOrHelia) this.updateLibp2pJsClientState("fetching-ipfs", kuboRpcOrHelia._libp2pJsClientsOptions.key);
        else this.updateKuboRpcState("fetching-ipfs", kuboRpcOrHelia.url);
        this._community._setUpdatingStateWithEventEmissionIfNewState("fetching-ipfs");

        let rawCommunityJsonString: Awaited<ReturnType<typeof this._fetchCidP2P>>;
        try {
            rawCommunityJsonString = await this._fetchCidP2P(latestCommunityCid, {
                maxFileSizeBytes: MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS,
                timeoutMs: this._pkc._timeouts["community-ipfs"],
                abortSignal: this._community._getStopAbortSignal(),
                bitswapSessionSeedScopeIpnsPubsubTopic: this._community.ipnsPubsubTopic
            });
        } catch (e) {
            //@ts-expect-error
            e.details = {
                //@ts-expect-error
                ...e.details,
                communityIpnsName: ipnsName,
                ipnsPubsubTopic: this._community.ipnsPubsubTopic,
                ipnsPubsubTopicRoutingCid: this._community.ipnsPubsubTopicRoutingCid,
                communityCid: latestCommunityCid
            };
            if (e instanceof PKCError && e.code === "ERR_OVER_DOWNLOAD_LIMIT") this._updateCidsAlreadyLoaded.add(latestCommunityCid);
            throw e;
        }

        this._updateCidsAlreadyLoaded.add(latestCommunityCid);
        try {
            const communityIpfs = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(
                parseJsonWithPKCErrorIfFails(rawCommunityJsonString)
            );

            // Prove the record's anchor claim when this resolution walked no chain that could contradict
            // it (#261), and adopt the proven chain as this community's hops.
            const provenIpnsHops = await this._proveAnchorClaimIfUnwalked({
                communityJson: communityIpfs,
                ipnsHops,
                resolveChainOfClaimedAnchor: async (claimedAnchor) =>
                    (
                        await this.resolveIpnsToCidP2P(claimedAnchor, {
                            timeoutMs: this._pkc._timeouts["community-ipns"],
                            abortSignal: this._community._getStopAbortSignal()
                        })
                    ).ipnsHops
            });
            this._community.ipnsHops = provenIpnsHops;

            const errInRecord = await this._findErrorInCommunityRecord({
                communityJson: communityIpfs,
                communityIpnsHops: provenIpnsHops,
                cidOfCommunityIpns: latestCommunityCid
            });

            if (errInRecord) throw errInRecord;
            return { community: communityIpfs, cid: latestCommunityCid };
        } catch (e) {
            // invalid community record
            (e as PKCError).details = {
                ...(e as PKCError).details,
                cidOfCommunityIpns: latestCommunityCid,
                ipnsPubsubTopic: this._community.ipnsPubsubTopic,
                ipnsPubsubTopicRoutingCid: this._community.ipnsPubsubTopicRoutingCid
            };
            throw <PKCError>e;
        }
    }

    private async _fetchCommunityFromGateways(ipnsName: string): Promise<ResultOfFetchingCommunity> {
        const log = Logger("pkc-js:community:fetchCommunityFromGateways");
        const concurrencyLimit = 3;
        const timeoutMs = this._pkc._timeouts["community-ipns"];

        const queueLimit = pLimit(concurrencyLimit);

        // Only sort if we have more than 3 gateways
        const gatewaysSorted =
            keys(this._pkc.clients.ipfsGateways).length <= concurrencyLimit
                ? keys(this._pkc.clients.ipfsGateways)
                : await this._pkc._stats.sortGatewaysAccordingToScore("ipns");

        // need to handle
        // if all gateways returned the same community.updateCid
        const gatewayFetches: CommunityGatewayFetch = {};

        for (const gatewayUrl of gatewaysSorted) {
            const abortController = new AbortController();
            const throwIfGatewayRespondsWithInvalidCommunity: OptionsToLoadFromGateway["validateGatewayResponseFunc"] = async (
                gatewayRes
            ) => {
                if (typeof gatewayRes.resText !== "string") throw Error("Gateway response has no body");
                // get ipfs cid of IPNS from header or calculate it
                const calculatedCommunityCidFromBody = await this.calculateIpfsCid(gatewayRes.resText); // cid v0

                if (this._updateCidsAlreadyLoaded.has(calculatedCommunityCidFromBody))
                    throw new PKCError("ERR_GATEWAY_ABORTING_LOADING_COMMUNITY_BECAUSE_WE_ALREADY_LOADED_THIS_RECORD", {
                        calculatedCommunityCidFromBody,
                        ipnsName,
                        ipnsPubsubTopic: this._community.ipnsPubsubTopic,
                        ipnsPubsubTopicRoutingCid: this._community.ipnsPubsubTopicRoutingCid,
                        gatewayRes,
                        gatewayUrl
                    });

                this._updateCidsAlreadyLoaded.add(calculatedCommunityCidFromBody);

                let communityIpfs: CommunityIpfsType;
                try {
                    communityIpfs = parseCommunityIpfsSchemaPassthroughWithPKCErrorIfItFails(
                        parseJsonWithPKCErrorIfFails(gatewayRes.resText)
                    );
                } catch (e) {
                    (e as PKCError).details = {
                        ...(e as PKCError).details,
                        cidOfCommunityIpns: calculatedCommunityCidFromBody,
                        ipnsPubsubTopic: this._community.ipnsPubsubTopic,
                        ipnsPubsubTopicRoutingCid: this._community.ipnsPubsubTopicRoutingCid
                    };
                    throw e;
                }
                // Determine the terminal IPNS name (two-tier). For a normal (non-delegated) community
                // the content is signed by the anchor key itself, so no chain walk is needed and the
                // content signature alone secures the (untrusted) gateway response — Tier 1, a single
                // plain GET. Only when the record is signed by a DIFFERENT key (the hallmark of
                // delegation) do we escalate to Tier 2: independently follow & validate the IPNS record
                // chain (anchor -> ... -> terminal) via the same untrusted gateway's ?format=ipns-record
                // path, binding it to the anchor. A gateway cannot forge any hop's signature, so it
                // cannot substitute a different community. See docs/protocol/delegated-ipns.md.
                let terminalIpnsName = ipnsName;
                let ipnsHops: string[] = [ipnsName];
                const recordSignatureAddress = getPKCAddressFromPublicKeySync(communityIpfs.signature.publicKey);
                if (!this._areEquivalentCommunityAddresses(recordSignatureAddress, ipnsName)) {
                    const chain = await this._resolveIpnsChainViaGateway(gatewayUrl, ipnsName, abortController.signal);
                    if (chain.terminalCidV0 !== calculatedCommunityCidFromBody)
                        throw new PKCError("ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID", {
                            reason: "Terminal IPNS record CID does not match the community record served by the gateway",
                            terminalCidFromChain: chain.terminalCidV0,
                            calculatedCommunityCidFromBody,
                            ipnsHops: chain.ipnsHops,
                            ipnsName,
                            gatewayUrl
                        });
                    ipnsHops = chain.ipnsHops;
                    terminalIpnsName = chain.ipnsHops[chain.ipnsHops.length - 1];
                    // The content must be signed by the terminal key the chain ends at.
                    if (!this._areEquivalentCommunityAddresses(recordSignatureAddress, terminalIpnsName))
                        throw new PKCError("ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID", {
                            reason: "Community record signature key does not match the terminal IPNS name of the chain",
                            recordSignatureAddress,
                            terminalIpnsName,
                            ipnsHops,
                            ipnsName,
                            gatewayUrl
                        });
                }
                // Prove the record's anchor claim when the tiering above walked no chain that could
                // contradict it (#261). The walk goes through the SAME untrusted gateway that served
                // the body: it cannot forge a hop's signature, so it cannot manufacture an endorsement.
                ipnsHops = await this._proveAnchorClaimIfUnwalked({
                    communityJson: communityIpfs,
                    ipnsHops,
                    resolveChainOfClaimedAnchor: async (claimedAnchor) =>
                        (await this._resolveIpnsChainViaGateway(gatewayUrl, claimedAnchor, abortController.signal)).ipnsHops
                });
                // Keep the resolved hops attached to THIS gateway's result; the winner (and its
                // matching hops) is chosen later in _findRecentCommunity. Mutating
                // this._community.ipnsHops here would let a slower/losing gateway overwrite it.
                gatewayFetches[gatewayUrl].ipnsHops = ipnsHops;

                const errorWithinRecord = await this._findErrorInCommunityRecord({
                    communityJson: communityIpfs,
                    communityIpnsHops: ipnsHops,
                    cidOfCommunityIpns: calculatedCommunityCidFromBody
                });
                if (errorWithinRecord) {
                    delete errorWithinRecord["stack"];
                    if (errorWithinRecord.code === "ERR_COMMUNITY_SIGNATURE_IS_INVALID") {
                        const log = Logger("pkc-js:community-client-manager:throwIfGatewayRespondsWithInvalidCommunity");
                        const etag = gatewayRes?.res?.headers?.get("etag");
                        log.error(
                            `Gateway ${gatewayUrl} returned community record with invalid signature. ` +
                                `Reason: ${errorWithinRecord.details?.signatureValidity?.reason}. ` +
                                `Client-computed CID: ${calculatedCommunityCidFromBody}. ` +
                                `Etag header (Kubo CID): ${etag}. ` +
                                `updatedAt: ${communityIpfs.updatedAt}. ` +
                                `Response body: ${gatewayRes.resText}`
                        );
                    }
                    throw errorWithinRecord;
                } else {
                    gatewayFetches[gatewayUrl].communityRecord = communityIpfs;
                    gatewayFetches[gatewayUrl].cid = calculatedCommunityCidFromBody;

                    // Log the TTL from max-age header after successfully setting the community record
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
                    abortController.abort("Aborting community IPNS request because we already loaded this record");
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
                        recordPKCType: "community",
                        validateGatewayResponseFunc: throwIfGatewayRespondsWithInvalidCommunity,
                        abortRequestErrorBeforeLoadingBodyFunc: checkResponseHeadersIfOldCid,
                        abortController,
                        maxFileSizeBytes: MAX_FILE_SIZE_BYTES_FOR_COMMUNITY_IPFS,
                        timeoutMs: this._pkc._timeouts["community-ipns"],
                        log,
                        requestHeaders: requestHeaders
                    })
                ),
                timeoutId: setTimeout(
                    () => abortController.abort("Aborting community IPNS request because it timed out after " + timeoutMs + "ms"),
                    timeoutMs
                )
            };
        }

        const stopSignal = this._community._getStopAbortSignal();
        const onStopAbort = () => cleanUp();

        const cleanUp = () => {
            queueLimit.clearQueue();
            Object.values(gatewayFetches).forEach((gateway) => {
                if (!gateway.communityRecord && !gateway.error) gateway.abortController.abort("Cleaning up requests for community");
                clearTimeout(gateway.timeoutId);
            });
            if (stopSignal) stopSignal.removeEventListener("abort", onStopAbort);
        };

        if (stopSignal) {
            throwIfAbortSignalAborted(stopSignal);
            stopSignal.addEventListener("abort", onStopAbort, { once: true });
        }

        const _findRecentCommunity = (): { community: CommunityIpfsType; cid: string } | undefined => {
            // Try to find a very recent community
            // If not then go with the most recent community record after fetching from 3 gateways
            const winner = selectWinningGatewayCommunity({
                gatewayFetches,
                currentUpdatedAt: this._community.raw.communityIpfs?.updatedAt || 0,
                totalGateways: gatewaysSorted.length,
                fallbackIpnsName: ipnsName
            });
            if (!winner) return undefined;

            log(
                `Gateway (${winner.bestGatewayUrl}) was able to find a very recent community (${this._deriveAddressFromWireRecord(winner.community)}) whose IPNS is (${ipnsName}).  The record has updatedAt (${winner.community.updatedAt}) that's ${winner.recordAgeSeconds}s old with a TTL of ${gatewayFetches[winner.bestGatewayUrl].ttl} seconds`
            );
            // Bind ipnsHops to the gateway result we're actually keeping.
            this._community.ipnsHops = winner.ipnsHops;
            return { community: winner.community, cid: winner.cid };
        };

        const promisesToIterate = Object.values(gatewayFetches).map((gatewayFetch) => gatewayFetch.promise);

        let suitableCommunity: { community: CommunityIpfsType; cid: string };
        try {
            suitableCommunity = await new Promise<typeof suitableCommunity>((resolve, reject) =>
                promisesToIterate.map((gatewayPromise, i) =>
                    gatewayPromise
                        .then(async (res) => {
                            if ("error" in res) Object.values(gatewayFetches)[i].error = res.error;
                            const gatewaysWithError = keys(gatewayFetches).filter((gatewayUrl) => gatewayFetches[gatewayUrl].error);
                            if (gatewaysWithError.length === gatewaysSorted.length)
                                // All gateways failed
                                reject("All gateways failed to fetch community record " + ipnsName);

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
            const gatewayToError = mapValues(gatewayFetches, (gatewayFetch) => gatewayFetch.error!);
            const hasGatewayConfirmingCurrentRecord = Object.keys(gatewayFetches)
                .map((gatewayUrl) => gatewayFetches[gatewayUrl].error!)
                .some(
                    (err) =>
                        err.details?.status === 304 ||
                        err.code === "ERR_GATEWAY_ABORTING_LOADING_COMMUNITY_BECAUSE_WE_ALREADY_LOADED_THIS_RECORD"
                );
            if (hasGatewayConfirmingCurrentRecord) {
                // Any gateway confirmed we already have the latest consumed record. The conditional
                // request (If-None-Match -> 304) aborts before the delegated chain walk, so a
                // re-anchored community (#257: identity adopted from the record's anchor claim after
                // reaching it through the minter) would keep the stale single-hop ipnsHops forever —
                // the other transports re-resolve the chain on every poll. Upgrade the chain once:
                // walk it via a confirming gateway and adopt it only if its terminal lands on the very
                // CID we already consumed, so a lying gateway cannot bind us to a different record.
                if (this._community.anchor && this._community.ipnsHops?.[0] !== ipnsName) {
                    const confirmingGatewayUrl = Object.keys(gatewayFetches).find(
                        (gatewayUrl) =>
                            gatewayFetches[gatewayUrl].error?.details?.status === 304 ||
                            gatewayFetches[gatewayUrl].error?.code ===
                                "ERR_GATEWAY_ABORTING_LOADING_COMMUNITY_BECAUSE_WE_ALREADY_LOADED_THIS_RECORD"
                    );
                    if (confirmingGatewayUrl) {
                        // cleanUp() above already cleared every per-gateway timeout, and the raw IPNS
                        // record fetches inside the walk carry no deadline of their own, so stopSignal
                        // alone would let a stalled gateway hold this await (and therefore the whole
                        // update-loop iteration) far past the community-ipns budget every other fetch
                        // in this function respects. Give the walk that same budget. The listener is
                        // removed in the finally rather than composed with AbortSignal.any because
                        // stopSignal lives as long as the community and this runs on every poll.
                        const chainWalkAbortController = new AbortController();
                        const chainWalkTimeoutId = setTimeout(
                            () =>
                                chainWalkAbortController.abort(
                                    "Aborting delegated chain upgrade because it timed out after " + timeoutMs + "ms"
                                ),
                            timeoutMs
                        );
                        const onStopAbortChainWalk = () => chainWalkAbortController.abort(stopSignal?.reason);
                        stopSignal?.addEventListener("abort", onStopAbortChainWalk, { once: true });
                        try {
                            const chain = await this._resolveIpnsChainViaGateway(
                                confirmingGatewayUrl,
                                ipnsName,
                                chainWalkAbortController.signal
                            );
                            if (this._community.updateCid && chain.terminalCidV0 === this._community.updateCid)
                                this._community.ipnsHops = chain.ipnsHops;
                        } catch (chainWalkError) {
                            log.trace(
                                `Failed to upgrade the delegated chain of ${ipnsName} after a confirmed consumed record, will retry next poll`,
                                chainWalkError
                            );
                        } finally {
                            clearTimeout(chainWalkTimeoutId);
                            stopSignal?.removeEventListener("abort", onStopAbortChainWalk);
                        }
                    }
                }
                return undefined;
            }

            const combinedError = new FailedToFetchCommunityFromGatewaysError({
                ipnsName,
                gatewayToError,
                communityAddress: this._community.address,
                ipnsPubsubTopic: this._community.ipnsPubsubTopic,
                ipnsPubsubTopicRoutingCid: this._community.ipnsPubsubTopicRoutingCid
            });
            delete combinedError.stack;
            throw combinedError;
        }

        // TODO add punishment for gateway that returns old ipns record
        // TODO add punishment for gateway that returns invalid community
        return suitableCommunity;
    }

    // Walks a (potentially delegated) IPNS chain via an UNTRUSTED gateway, validating each
    // record's signature against its name (?format=ipns-record). Returns the ordered chain of
    // IPNS names and the terminal /ipfs/ CID. Used only when a gateway-served community record
    // is signed by a key other than the anchor (i.e. a possible delegated chain) — for the
    // common non-delegated case the content signature against the anchor is sufficient and no
    // extra gateway round-trips are made. Mirrors the P2P resolver's hop cap
    // (BaseClientsManager.MAX_IPNS_HOPS): a chain longer than a single anchor -> minter hop is
    // rejected with ERR_IPNS_MAX_HOPS_EXCEEDED, consistent with the kubo RPC / helia paths.
    // See docs/protocol/delegated-ipns.md.
    private async _resolveIpnsChainViaGateway(
        gatewayUrl: string,
        anchorIpnsName: string,
        abortSignal?: AbortSignal
    ): Promise<{ ipnsHops: string[]; terminalCidV0: string }> {
        const ipnsHops: string[] = [anchorIpnsName];
        let currentName = anchorIpnsName;
        // The loop exits only via a return (we hit a terminal /ipfs/ value) or a throw (unsupported
        // value, or too many hops).
        while (true) {
            // Label the hop we're about to validate so any failure (forged/tampered record, bad value,
            // bad CID) names WHICH record was at fault. hop 0 is the anchor; with MAX_IPNS_HOPS === 1
            // the only other hop ever fetched is the minter (the cap below throws before a 3rd hop is
            // fetched), so role is unambiguous: "anchor" or "minter". See docs/protocol/delegated-ipns.md.
            const hopIndex = ipnsHops.length - 1;
            const hopRole = hopIndex === 0 ? "anchor" : "minter";
            const recordContext = { hopRole, hopIndex, anchorIpnsName };
            const record = await fetchAndValidateIpnsRecordFromGateway(gatewayUrl, currentName, { abortSignal, recordContext });
            const value = String(record.value);
            if (isIpnsPath(value)) {
                currentName = value.split("/")[2];
                ipnsHops.push(currentName);
                // ipnsHops.length - 1 is the number of /ipns/ -> /ipns/ hops followed so far.
                if (ipnsHops.length - 1 > BaseClientsManager.MAX_IPNS_HOPS)
                    throw new PKCError("ERR_IPNS_MAX_HOPS_EXCEEDED", {
                        ...recordContext,
                        ipnsHops,
                        maxHops: BaseClientsManager.MAX_IPNS_HOPS,
                        via: "gateway"
                    });
                continue;
            }
            if (isIpfsPath(value)) {
                let terminalCidV0: string;
                try {
                    terminalCidV0 = CID.parse(value.split("/")[2]).toV0().toString();
                } catch (e) {
                    throw new PKCError("ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID", {
                        reason: "Terminal IPNS record value is not a valid CID",
                        ...recordContext,
                        terminalValue: value,
                        ipnsHops
                    });
                }
                return { ipnsHops, terminalCidV0 };
            }
            throw new PKCError("ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID", {
                reason: "IPNS record value is neither an /ipfs/ nor an /ipns/ path",
                ...recordContext,
                unsupportedValue: value,
                ipnsHops
            });
        }
    }

    // A record's anchor claim is only proven by the resolution that fetched it when a delegation hop
    // was actually walked — the chain rule in verifyCommunity then binds the claim to the chain's
    // anchor. A SINGLE-HOP load walks nothing: a reader addressing the minter directly (behind a TXT
    // record pointing at the minter, or by raw key) receives the claim with nothing contradicting it,
    // and the claim is not decoration — it becomes community.publicKey, the ipns-over-pubsub topic,
    // the key of the publish cache and the subject of the nameResolved verdict. Trusting it there
    // would let any minter serve its own content under a well-known community's identity (#261).
    //
    // So prove it: resolve the CLAIMED anchor and require its own chain to end at the key that signed
    // this record. The binding proven is the delegation An -> Mn, not the CID, so an honest claim
    // cannot fail because the minter published a newer record between the two resolutions. On success
    // the proven chain replaces the single-hop one, which is also the chain every later poll produces
    // (a claim re-anchors subsequent fetches through the anchor), so the instance never reports a
    // transient half-chain. See docs/protocol/delegated-ipns.md.
    private async _proveAnchorClaimIfUnwalked({
        communityJson,
        ipnsHops,
        resolveChainOfClaimedAnchor
    }: {
        communityJson: CommunityIpfsType;
        // The chain this resolution walked, [anchor, ..., terminal].
        ipnsHops: string[];
        // Walks the claimed anchor's chain over the SAME transport that served the record, and returns
        // its hops. Throwing here is a transport/validation failure, not a verdict on the claim.
        resolveChainOfClaimedAnchor: (claimedAnchor: string) => Promise<string[]>;
    }): Promise<string[]> {
        const log = Logger("pkc-js:community-client-manager:_proveAnchorClaimIfUnwalked");
        // A walked chain already settles the claim: verifyCommunity accepts it only if it names the
        // chain's anchor. Re-proving a claim that contradicts a walked chain would let a record swap
        // the identity the reader asked for, so this path deliberately does nothing there.
        if (ipnsHops.length > 1) return ipnsHops;
        const claimedAnchor = communityJson.anchor?.publicKey;
        if (!claimedAnchor) return ipnsHops; // not a delegated record
        const loadedName = ipnsHops[0];
        if (this._areEquivalentCommunityAddresses(claimedAnchor, loadedName)) return ipnsHops; // claims the name it was loaded from

        const provenHops = await resolveChainOfClaimedAnchor(claimedAnchor);
        const anchorDelegatesTo = provenHops[provenHops.length - 1];
        if (!this._areEquivalentCommunityAddresses(anchorDelegatesTo, loadedName))
            throw new PKCError("ERR_COMMUNITY_RECORD_ANCHOR_CLAIM_IS_NOT_ENDORSED", {
                claimedAnchor,
                // The key that signed the record and whose IPNS record we loaded it from, i.e. the key
                // the claimed anchor would have to delegate to for the claim to hold.
                recordIpnsName: loadedName,
                anchorDelegatesTo,
                claimedAnchorHops: provenHops,
                communityAddress: this._getCommunityAddressFromInstance(),
                recordSignerAddress: getPKCAddressFromPublicKeySync(communityJson.signature.publicKey)
            });
        log.trace(`Anchor claim of ${loadedName} proven: ${claimedAnchor} delegates to it. Adopting the chain`, provenHops);
        return provenHops;
    }

    private async _findErrorInCommunityRecord({
        communityJson,
        communityIpnsHops,
        cidOfCommunityIpns
    }: {
        communityJson: CommunityIpfsType;
        // The resolved chain [anchor, ..., terminal], single element when not delegated. Both ends are
        // used below and verifyCommunity needs both, so the chain travels whole rather than as two
        // names picked apart by every caller. See docs/protocol/delegated-ipns.md.
        communityIpnsHops: string[];
        cidOfCommunityIpns: string;
    }): Promise<PKCError | undefined> {
        const anchorIpnsName = communityIpnsHops[0];
        const terminalIpnsName = communityIpnsHops[communityIpnsHops.length - 1];
        const communityInstanceAddress = this._getCommunityAddressFromInstance();
        const recordAddress = this._deriveAddressFromWireRecord(communityJson);
        const addressMatchesInstance = this._areEquivalentCommunityAddresses(recordAddress, communityInstanceAddress);
        // When address is a domain but we loaded via publicKey fallback, the record's derived address
        // might be the publicKey (if the record has no name field) — also accept that as a match
        const addressMatchesPublicKey = this._community.publicKey
            ? this._areEquivalentCommunityAddresses(recordAddress, this._community.publicKey)
            : false;
        // Accept when user loaded by raw IPNS key and the record's signature key matches the
        // TERMINAL name of the resolved chain. For a non-delegated community terminal === anchor,
        // so this is the original behaviour. For a delegated community the content is signed by the
        // terminal (minter) key, and the anchor -> terminal binding is guaranteed by the
        // cryptographically-verified IPNS record chain (see docs/protocol/delegated-ipns.md).
        // Handles: {address: "12D3Koo..."} loads record with name: "plebbit.bso".
        // NOT applied for domain addresses (Scenario C stays rejected — a domain load must match
        // the record's name field, not merely its signature key).
        const instanceAddressIsDomain = isStringDomain(communityInstanceAddress);
        const signatureKeyMatchesTerminal = !instanceAddressIsDomain
            ? this._areEquivalentCommunityAddresses(getPKCAddressFromPublicKeySync(communityJson.signature.publicKey), terminalIpnsName)
            : false;
        if (!addressMatchesInstance && !addressMatchesPublicKey && !signatureKeyMatchesTerminal) {
            // Did the gateway supply us with a different community's ipns

            const error = new PKCError("ERR_THE_COMMUNITY_IPNS_RECORD_POINTS_TO_DIFFERENT_ADDRESS_THAN_WE_EXPECTED", {
                // The record's signer matches none of the identities we accept: the address we loaded,
                // the community publicKey (the anchor), or the terminal/minter of the resolved IPNS
                // chain. Either a different community's record was served, or a delegated chain's content
                // is signed by an unexpected key (anchor -> terminal binding broken). The booleans below
                // say which checks failed. For a delegated load the role that should have matched is the
                // "minter" (terminalIpnsName). See docs/protocol/delegated-ipns.md.
                reason: "Community record signer does not match the loaded address, the community publicKey (anchor), or the terminal (minter) IPNS name of the resolved chain",
                recordSignerAddress: recordAddress,
                expectedAnchorOrInstance: communityInstanceAddress,
                communityPublicKey: this._community.publicKey,
                expectedTerminalMinter: terminalIpnsName,
                matchChecks: { addressMatchesInstance, addressMatchesPublicKey, signatureKeyMatchesTerminal },
                isDelegatedChain: anchorIpnsName !== terminalIpnsName,
                addressFromCommunityInstance: communityInstanceAddress,
                ipnsName: anchorIpnsName,
                terminalIpnsName,
                addressFromGateway: recordAddress,
                communityIpnsFromGateway: communityJson,
                ipnsPubsubTopic: this._community.ipnsPubsubTopic,
                ipnsPubsubTopicRoutingCid: this._community.ipnsPubsubTopicRoutingCid,
                cidOfCommunityIpns
            });
            return error;
        }
        // The whole chain: verifyCommunity checks the record signature against the terminal name (the
        // minter in a delegated chain, the anchor itself when not delegated) and the content inside the
        // record against the anchor, which is what that content is labelled with.
        const verificationOpts = {
            community: communityJson,
            communityIpnsHops,
            resolveAuthorNames: this._pkc.resolveAuthorNames,
            clientsManager: this,
            validatePages: this._pkc.validatePages,
            abortSignal: this._community._getStopAbortSignal()
        };
        const updateValidity = await verifyCommunity(verificationOpts);
        if (!updateValidity.valid) {
            const error = new PKCError("ERR_COMMUNITY_SIGNATURE_IS_INVALID", {
                signatureValidity: updateValidity,
                ipnsPubsubTopic: this._community.ipnsPubsubTopic,
                ipnsPubsubTopicRoutingCid: this._community.ipnsPubsubTopicRoutingCid,
                verificationOpts,
                cidOfCommunityIpns
            });
            return error;
        }
    }
}

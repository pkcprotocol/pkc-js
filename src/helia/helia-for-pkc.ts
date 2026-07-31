import { createHelia, libp2pDefaults } from "helia";
import { ipns } from "@helia/ipns";
import { unmarshalIPNSRecord, multihashToIPNSRoutingKey } from "ipns";
import { ipnsValidator } from "ipns/validator";
import { gossipsub } from "@libp2p/gossipsub";
import { identify } from "@libp2p/identify";
import extraLibp2pTransports from "../runtime/node/libp2p-extra-transports.js";
import { CID } from "multiformats/cid";
import { peerIdFromString } from "@libp2p/peer-id";
import { bitswap } from "@helia/block-brokers";
import { createBlockstoreForLibp2pJsClient } from "../runtime/node/blockstore.js";
import { LruBlockstore } from "./lru-blockstore.js";
import { delegatedRoutingV1HttpApiClientContentRouting } from "@helia/delegated-routing-v1-http-api-client";
import { NotFoundError, type AbortOptions } from "@libp2p/interface";
import { unixfs } from "@helia/unixfs";
import { fetch as libp2pFetch } from "@libp2p/fetch";
import { pubsub as createIpnsPubusubRouter } from "@helia/ipns/routing";
import Logger from "../logger.js";
import type { AddResult, NameResolveOptions as KuboNameResolveOptions } from "kubo-rpc-client";
import type { IpfsHttpClientPubsubMessage, ParsedPKCOptions } from "../types.js";

import { EventEmitter } from "events";
import type { HeliaWithLibp2pPubsub } from "./types.js";
import { PKCError } from "../pkc-error.js";
import { Libp2pJsClient } from "./libp2pjsClient.js";
import {
    BITSWAP_SESSION_STALLED_GET_FAILOVER_MS,
    cacheIpnsRecordInPubsubLocalStore,
    connectToPubsubPeers,
    directFetchIpnsRecordFromProviders,
    fetchBlockWithStalledSessionFailover,
    getHeliaDebugContext,
    selectBitswapSessionSeedPeers
} from "./util.js";
import type { IpnsPubsubLocalStore } from "./util.js";
import { createDefaultDialTransportGater } from "./dial-transport-filter.js";
import { ipnsNameToIpnsOverPubsubTopic } from "../util.js";

const log = Logger("pkc-js:libp2p-js");

const libp2pJsClients: Partial<Record<string, Libp2pJsClient>> = {}; // key => pkc.clients.libp2pJsClients[key]
const creatingLibp2pJsClients: Partial<Record<string, Promise<Libp2pJsClient>>> = {};

// TODO need to call ipnsRouter.cancel when our community stops updating
// TODO we may need to remove libp2pJsClients and creatingLibp2pJsClients, I actually don't think they're needed

// Issue #218: the delegated-routing client defaults to concurrentRequests: 4 per router, an
// internal queue that serialized parallel provider lookups — profiling a production-like load
// (65 communities updating in parallel) measured that queueing as ~65% of the median load time
// while the routers themselves answered in <500ms. 32 is the benchmark-validated value: it
// collapsed the lookup phase to a flat ~2.5s for every community with no router-side strain
// (total request volume per burst is unchanged; only burstiness increases).
const DELEGATED_ROUTING_CONCURRENT_REQUESTS = 32;

// TODO can you verify if we're already content who has a specific and we fetch the CID even though http router says it has no providers, it should be able to load the CID
function getDelegatedRoutingFields(routers: string[]) {
    // @helia/delegated-routing-v1-http-api-client 8.x: the raw client returned by
    // delegatedRoutingV1HttpApiClient() no longer exposes the libp2p contentRouting/peerRouting
    // symbols, so putting it in `services` would silently register zero content routers
    // (libp2p then throws NoContentRoutersError on findProviders). Use the dedicated
    // delegatedRoutingV1HttpApiClientContentRouting() factory instead — content routing only,
    // so the peer-routing path (client.getPeers) is never registered.
    const routersObj: Record<string, ReturnType<typeof delegatedRoutingV1HttpApiClientContentRouting>> = {};
    for (let i = 0; i < routers.length; i++) {
        const factory = delegatedRoutingV1HttpApiClientContentRouting({
            url: routers[i],
            concurrentRequests: DELEGATED_ROUTING_CONCURRENT_REQUESTS
        });
        routersObj["delegatedRouting" + i] = (components) => {
            const routing = factory(components);
            // Our HTTP routers only serve provider records — they don't support IPNS get/put.
            // The default implementations would issue doomed HTTP requests (the pre-8.x code
            // prevented this by undefining client.getIPNS/putIPNS), so fail fast instead.
            routing.get = async () => {
                throw new NotFoundError("pkc HTTP routers do not serve IPNS records");
            };
            routing.put = async () => {};

            // libp2p's CompoundContentRouting.findProviders merges EVERY configured router into one
            // async iterator (it-merge), which rejects the whole merged stream the moment ANY single
            // router's iterator throws. So one unreachable router — e.g. a host that's up but whose
            // service is down, returning ECONNREFUSED — aborts findProviders for the entire node,
            // taking down IPNS-over-pubsub warmup and bitswap provider lookups even while other,
            // healthy routers are returning providers (issue #171). Wrap each router so its errors
            // end ITS iterator instead of throwing: a dead/erroring router degrades to "found no
            // providers" (the harmless empty case) rather than poisoning the merged stream. The
            // underlying client already swallows NotFoundError; this additionally covers connection
            // and transport errors. We do not re-throw on abort either — when findProviders is
            // aborted (subscriber found / maxPeers reached / caller signal), ending the iterator is
            // the correct outcome and the caller handles the abort separately.
            const routerUrl = routers[i];
            const originalFindProviders = routing.findProviders.bind(routing);
            routing.findProviders = async function* (cid: CID, options?: AbortOptions) {
                try {
                    yield* originalFindProviders(cid, options);
                } catch (e) {
                    log.trace("Content router", routerUrl, "errored during findProviders; treating it as returning no providers", e);
                }
            };
            return routing;
        };
    }
    return routersObj;
}

export async function createLibp2pJsClientOrUseExistingOne(
    pkcOptions: Required<Pick<ParsedPKCOptions, "httpRoutersOptions">> &
        Pick<ParsedPKCOptions, "dataPath"> &
        NonNullable<ParsedPKCOptions["libp2pJsClientsOptions"]>[number]
): Promise<Libp2pJsClient> {
    if (!pkcOptions.httpRoutersOptions?.length) throw Error("You need to have pkc.httpRouterOptions to set up helia");
    const existingClient = libp2pJsClients[pkcOptions.key];
    if (existingClient) {
        existingClient.countOfUsesOfInstance++;
        return existingClient;
    }

    const creatingClientPromise = creatingLibp2pJsClients[pkcOptions.key];
    if (creatingClientPromise) {
        const client = await creatingClientPromise;
        client.countOfUsesOfInstance++;
        return client;
    }

    creatingLibp2pJsClients[pkcOptions.key] = (async () => {
        // A caller supplying their own heliaOptions.blockstore owns block storage entirely, so skip
        // ours rather than opening a directory or IndexedDB database nothing will read.
        let lruBlockstore: LruBlockstore | undefined;
        let closeBlockstore = async () => {};
        if (!pkcOptions.heliaOptions?.blockstore) {
            const {
                blockstore: childBlockstore,
                persistent,
                defaultMaxBytes,
                close
            } = await createBlockstoreForLibp2pJsClient({
                dataPath: pkcOptions.dataPath,
                key: pkcOptions.key
            });
            closeBlockstore = close;
            // defaultMaxBytes comes from the backend we actually got: falling back to an in-memory
            // store means the cap is a heap budget, not a disk budget, and must be far smaller.
            lruBlockstore = new LruBlockstore(childBlockstore, {
                maxBytes: pkcOptions.blockstoreOptions?.maxBytes ?? defaultMaxBytes,
                lowWaterRatio: pkcOptions.blockstoreOptions?.lowWaterRatio
            });
            // Only a persistent backend can hold blocks we did not put this session. The scan reads
            // every block back to learn its size, so it runs in the background: blocking PKC init on
            // it would add the whole store's read time to the first load. Until it finishes the
            // store may sit over its cap, because we cannot evict what we have not counted yet.
            if (persistent)
                lruBlockstore.rebuildIndex().catch((e) => log.error("Failed to rebuild blockstore index for key", pkcOptions.key, e));
        }

        const heliaLibp2pDefaults = libp2pDefaults();
        const mergedHeliaInit = {
            libp2p: {
                // for now we're overwriting addresses
                addresses: { listen: [] }, // TODO at some point we should use addresses, but right now it gets into an infinite loop with random walk
                peerDiscovery: undefined,
                // helia merges shallowly: setting `transports` overrides defaults entirely, so we re-spread helia's per-environment defaults and append per-runtime extras
                transports: [...(heliaLibp2pDefaults.transports ?? []), ...extraLibp2pTransports],
                // libp2p's ConnectionMonitor pings every peer every 10s; on ping-timeout it
                // aborts the connection (`abortConnectionOnPingFailure` defaults to true).
                // Under our workload the publisher's ping response queues behind block-serving
                // traffic and gets timed out, killing connections mid-fetch. Disable the abort
                // (ping still runs as an RTT signal).
                connectionMonitor: { abortConnectionOnPingFailure: false },
                // By default reject WebRTC + WebTransport dials so browser nodes connect over
                // WebSocket(/WSS). Helia's libp2p defaults set no connectionGater, so nothing
                // upstream is clobbered. Placed BEFORE the spread so a caller can fully override
                // it via libp2pJsClientsOptions[].libp2pOptions.connectionGater (e.g. to re-enable
                // WebRTC/WebTransport, or allow-all in tests).
                connectionGater: createDefaultDialTransportGater(),
                ...pkcOptions.libp2pOptions,
                // Configure connection manager to handle more concurrent streams

                services: {
                    // Helia's libp2pDefaults.services include relay (circuitRelayServer), autoTLS,
                    // upnp, kadDHT, autoNAT, and a delegatedRouting client pointed at public-network
                    // defaults. Spreading all of those in is wrong for a client-side node — we'd be
                    // hosting a circuit relay, doing external TLS issuance, port-forwarding, and
                    // querying the public IPFS network in addition to the routers the user configured.
                    // Keep the service map narrow and explicit. (See review notes 2026-05-08.)
                    identify: identify(),
                    pubsub: gossipsub(),
                    // powers @helia/ipns pubsub fast-path: fetch latest record from new topic peers (PR ipfs/helia#906)
                    fetch: libp2pFetch(),
                    ...getDelegatedRoutingFields(pkcOptions.httpRoutersOptions),
                    ...pkcOptions.libp2pOptions?.services
                }
            },
            // Persistent per runtime (blockstore-fs on node, blockstore-idb in the browser) behind a
            // size-capped LRU. Helia never evicts on its own: every fetched block is written to the
            // blockstore and only `helia.gc()` (pin-based, and we pin nothing) or dropping the whole
            // instance ever removes one, so an unbounded store grows for the life of the process.
            // See pkc-js#240 for the measurement behind the cap.
            blockstore: lruBlockstore,
            blockBrokers: [bitswap()],
            start: false,
            ...pkcOptions.heliaOptions
        } as Libp2pJsClient["_mergedHeliaOptions"];

        const helia = <HeliaWithLibp2pPubsub>await createHelia(mergedHeliaInit);

        // Helia's default content routers are [Libp2pRouter, HTTPGatewayRouter]. We use our own
        // gateway-fan-out logic in base-client-manager, so the HTTP gateway router here is
        // redundant and adds latency. Filter by class name (not index) so a future helia release
        // that re-orders the array can't silently leave the gateway in or drop libp2p routing.
        //@ts-expect-error — helia.routing.routers is internal
        helia.routing.routers = (helia.routing.routers as Array<{ constructor: { name: string } }>).filter(
            (r) => r.constructor.name !== "HTTPGatewayRouter"
        );

        log("Initialized libp2pjs helia with key", pkcOptions.key, "peer id", helia.libp2p.peerId.toString());

        const pubsubEventHandler = new EventEmitter();

        helia.libp2p.services.pubsub.addEventListener("message", (evt) => {
            log.trace(`Event from helia libp2p pubsub: on pubsub topic (string, e.g. community address) ${evt.detail.topic}`);

            //@ts-expect-error
            const msgFormatted: IpfsHttpClientPubsubMessage = { data: evt.detail.data, topic: evt.detail.topic, type: evt.detail.type };
            pubsubEventHandler.emit(evt.detail.topic, msgFormatted);
        });

        const heliaFs = unixfs(helia);

        // @helia/unixfs 7.x (and its ipfs-unixfs-exporter) still run multiformats 13 while our
        // top-level multiformats is 14. The exporter strict-checks CID class identity
        // (`CID.asCID(path) === path || path instanceof CID`), so a CID instance from a different
        // multiformats copy is rejected at runtime with "Path must be string or CID". We therefore
        // never hand heliaFs.cat a CID *object* — only the *string* form. The exporter's string
        // branch (walkPath) parses and walks the whole `<root-cid>/sub/path` with its own
        // multiformats copy in a single pass, so no foreign-copy CID ever crosses the identity
        // check.
        //
        // Crucially we must NOT also pass a sub-path via the `path` option (see cat() below):
        // @helia/unixfs's cat() would then resolve() the sub-path to an intermediate CID *object*
        // and re-enter the exporter with it, tripping the same identity check — which broke every
        // CommentUpdate fetch from a community's postUpdates (`<root>/<bucket>/update`). Passing the
        // full path as one string keeps it on the exporter's string branch. CID.parse of the root
        // segment stays as input validation only. Remove this whole shim once helia ships on
        // multiformats 14.
        type HeliaCatCid = Parameters<(typeof heliaFs)["cat"]>[0];
        const asHeliaCatCid = (ipfsPathOrCid: string): HeliaCatCid => {
            CID.parse(ipfsPathOrCid.split("/")[0]); // validate the root CID; throws on malformed input
            return ipfsPathOrCid as unknown as HeliaCatCid;
        };

        // Issue #189: without a session, every block fetched over bitswap fires its own
        // network.findAndConnect — a findProviders query against ALL configured HTTP routers per
        // block, plus stray dials to whatever providers it discovers mid-fetch. cat() therefore
        // walks each DAG through a bitswap session seeded with already-connected peers: seeded
        // providers get the first targeted WANT-BLOCK immediately, routing is queried once per
        // DAG (the session's initial provider search, which also serves as fallback when seeds
        // don't have the blocks), and per-block wants go only to session peers.
        //
        // Cap seeds below the session's maxProviders (default 5) so the background routing query
        // still tops the session up with independently-discovered providers — seeding all 5 slots
        // would eliminate router traffic entirely but also all discovery redundancy.
        const MAX_BITSWAP_SESSION_SEED_PEERS = 3;
        // scopeIpnsPubsubTopic is the IPNS-over-pubsub record topic of the community whose CID is
        // being fetched (issue #202). Its current subscribers are the best seeds: the community's
        // record server must be subscribed there to serve records on it, and in the pkc topology
        // it provides every block under the community. Stateless by design — a per-name
        // remembered-record-servers list would go stale on disconnect and can point at another
        // community's server in multi-community apps.
        const getBitswapSessionSeedPeers = (scopeIpnsPubsubTopic?: string) => {
            const pubsub = helia.libp2p.services.pubsub;
            return selectBitswapSessionSeedPeers({
                connectedPeers: helia.libp2p.getPeers(),
                scopedPubsubSubscriberPeerIdStrings: scopeIpnsPubsubTopic ? pubsub.getSubscribers(scopeIpnsPubsubTopic).map(String) : [],
                pubsubSubscriberPeerIdStrings: pubsub.getTopics().flatMap((topic) => pubsub.getSubscribers(topic).map(String)),
                maxSeeds: MAX_BITSWAP_SESSION_SEED_PEERS
            });
        };

        // kubo-rpc-client style timeout (a number of ms, or a Go duration string like "30000ms",
        // "30s", "2m", "1h30m") — @helia/unixfs ignores it, but the session MUST be bounded by
        // it: AbstractSession's fallback loop keeps evicting providers and re-querying routing
        // "until the abort signal fires", and _fetchCidP2P's outer pTimeout only abandons the
        // promise without aborting the fetch. A string we can't parse throws instead of silently
        // running unbounded.
        const KUBO_DURATION_UNIT_TO_MS: Record<string, number> = { ns: 1e-6, us: 1e-3, µs: 1e-3, ms: 1, s: 1e3, m: 6e4, h: 3.6e6 };
        const parseKuboStyleTimeoutMs = (timeout: unknown): number | undefined => {
            if (timeout === undefined || timeout === null) return undefined;
            if (typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0) return timeout;
            if (typeof timeout === "string") {
                let totalMs = 0;
                let matchedLength = 0;
                for (const component of timeout.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) {
                    totalMs += parseFloat(component[1]) * KUBO_DURATION_UNIT_TO_MS[component[2]];
                    matchedLength += component[0].length;
                }
                if (matchedLength === timeout.length && totalMs > 0) return totalMs;
            }
            throw new PKCError("ERR_INVALID_KUBO_STYLE_TIMEOUT", { invalidTimeout: timeout });
        };

        // Base delay before re-running a session's provider search after it found zero
        // providers; doubles per attempt (capped at 8s) so a CID nobody provides doesn't
        // hammer the routers with one full fan-out query per retry.
        const SESSION_NO_PROVIDERS_RETRY_BASE_DELAY_MS = 500;

        // The session's zero-providers failure surfaces as InsufficientProvidersError, wrapped
        // by @helia/utils' raceBlockRetrievers in LoadBlockFailedError (an AggregateError) —
        // walk the aggregate/cause chain to recognize it at any depth.
        const isCausedByInsufficientProviders = (error: unknown): boolean => {
            if (!(error instanceof Error)) return false;
            if (error.name === "InsufficientProvidersError") return true;
            if (error instanceof AggregateError && error.errors.some(isCausedByInsufficientProviders)) return true;
            return isCausedByInsufficientProviders((error as { cause?: unknown }).cause);
        };

        // Resolves (never rejects) after ms or as soon as the signal aborts, detaching its
        // timer + abort listener either way.
        const delayAbortable = (ms: number, signal: AbortSignal): Promise<void> =>
            new Promise<void>((resolve) => {
                if (signal.aborted) return resolve();
                const onAbort = () => {
                    clearTimeout(timer);
                    resolve();
                };
                const timer = setTimeout(() => {
                    signal.removeEventListener("abort", onAbort);
                    resolve();
                }, ms);
                signal.addEventListener("abort", onAbort, { once: true });
            });

        const ipnsPubsubRouter = createIpnsPubusubRouter(helia);
        // The router's localStore is where gossipsub-delivered records get cached (handleRecord).
        // It's declared private but is a plain class field at runtime; the direct-fetch path below
        // writes to it to keep the cached-record invariant (issue #210).
        const ipnsPubsubLocalStore = (ipnsPubsubRouter as unknown as { localStore: IpnsPubsubLocalStore }).localStore;
        const ipnsNameResolver = ipns(helia, {
            routers: [ipnsPubsubRouter]
        });

        // @helia/ipns constructs routers as [LocalStoreRouting, HeliaRouting, ...userRouters].
        // We drop LocalStoreRouting because pkc-js never publishes IPNS via @helia/ipns (kubo
        // does that), so the local cache is always empty and just adds a wasted lookup. Keep
        // HeliaRouting (HTTP delegated routing via helia.routing.routers) and our PubSubRouting.
        // Filter by class name so a future @helia/ipns release that re-orders the array can't
        // silently drop our pubsub router.
        ipnsNameResolver.routers = ipnsNameResolver.routers.filter((r) => r?.constructor?.name !== "LocalStoreRouting");

        // Side-channel awaitable warmup: gossipsub's pubsub.subscribe(topic) is sync and returns
        // void, so we can't make it awaitable without breaking @helia/ipns and other internal
        // callers that expect the sync contract. Instead, we expose `warmupForTopic(topic)` and
        // dedupe in-flight warmups via a per-topic Map, so concurrent callers share a single
        // findProviders/dial cycle.
        const WARMUP_MAX_PEERS = 4;
        const warmupPromisesByTopic = new Map<string, Promise<void>>();
        const warmupForTopic = (topic: string, options?: { signal?: AbortSignal }): Promise<void> => {
            if (helia.libp2p.services.pubsub.getSubscribers(topic).length > 0) return Promise.resolve();
            const existing = warmupPromisesByTopic.get(topic);
            if (existing) return existing;
            const p = connectToPubsubPeers({
                helia,
                pubsubTopic: topic,
                maxPeers: WARMUP_MAX_PEERS,
                options,
                log: Logger("pkc-js:helia:pubsub:warmup")
            })
                .then(() => undefined)
                .finally(() => {
                    warmupPromisesByTopic.delete(topic);
                });
            warmupPromisesByTopic.set(topic, p);
            return p;
        };

        const throwIfHeliaIsStoppingOrStopped = () => {
            if (helia.libp2p.status === "stopped" || helia.libp2p.status === "stopping")
                throw new PKCError("ERR_HELIAS_STOPPING_OR_STOPPED", {
                    heliaKey: pkcOptions.key,
                    helia,
                    ...getHeliaDebugContext(helia)
                });
        };

        const heliaWithKuboRpcClientShape: Libp2pJsClient["heliaWithKuboRpcClientFunctions"] = {
            name: {
                resolve: (ipnsName: string, options?: KuboNameResolveOptions) => {
                    // Create an async generator function
                    throwIfHeliaIsStoppingOrStopped();
                    async function* generator() {
                        const currentName = typeof ipnsName === "string" ? ipnsName : (ipnsName as { toString(): string }).toString();
                        const ipnsNameAsPeerId = peerIdFromString(currentName);
                        log.trace("Resolving ipns name", currentName, "with options", options);

                        const ipnsPubsubTopic = ipnsNameToIpnsOverPubsubTopic(ipnsNameAsPeerId.toString());
                        const routingKey = multihashToIPNSRoutingKey(ipnsNameAsPeerId.toMultihash());

                        // Fast path: fetch the record over libp2p/fetch, in parallel, directly from BOTH
                        // the topic's current gossipsub subscribers AND providers freshly discovered from
                        // the HTTP routers — first signature-valid record wins. This skips the
                        // waitForTopicSubscriber floor (up to 10s) that the legacy path below blocks on,
                        // because @helia/ipns's PubSubRouting.get() only fetches from getSubscribers() and
                        // throws when that list is empty. See directFetchIpnsRecordFromProviders.
                        type DirectFetchOutcome =
                            | { attempted: false }
                            | { attempted: true; hit: true; durationMs: number; source: string; peerId: string }
                            | { attempted: true; hit: false; durationMs: number; error?: Error };
                        let directFetchOutcome: DirectFetchOutcome = { attempted: false };
                        {
                            // Subscribe so pushed record updates keep arriving (the legacy router.get() did
                            // this as a side effect). Fire-and-forget warmup lets the gossipsub mesh form for
                            // future pushes; we do NOT await it — the direct fetch does not need the mesh.
                            if (!helia.libp2p.services.pubsub.getTopics().includes(ipnsPubsubTopic))
                                helia.libp2p.services.pubsub.subscribe(ipnsPubsubTopic);
                            void warmupForTopic(ipnsPubsubTopic, options).catch((e) =>
                                log.trace("Fire-and-forget warmup failed for", ipnsPubsubTopic, e)
                            );

                            const directStart = Date.now();
                            try {
                                const direct = await directFetchIpnsRecordFromProviders({
                                    helia,
                                    pubsubTopic: ipnsPubsubTopic,
                                    routingKey,
                                    maxPeers: WARMUP_MAX_PEERS,
                                    validate: ipnsValidator,
                                    options,
                                    log: Logger("pkc-js:helia:ipns:direct-fetch")
                                });
                                if (direct) {
                                    directFetchOutcome = {
                                        attempted: true,
                                        hit: true,
                                        durationMs: direct.durationMs,
                                        source: direct.source,
                                        peerId: direct.peerId
                                    };
                                    // Record already validated inside the helper — unmarshal directly,
                                    // do NOT re-run ipnsValidator.
                                    const record = unmarshalIPNSRecord(direct.recordBytes);
                                    // Direct fetch bypasses the pubsub router's handleRecord, which is
                                    // where gossipsub-delivered records get cached at the routing layer.
                                    // Persist the record there ourselves (newer-only, issue #210) so
                                    // offline/fallback resolves and handleRecord's ipnsSelector see the
                                    // freshest record we hold. Awaited so callers observe the cache as
                                    // soon as this resolve returns; a cache failure must not fail the
                                    // resolve itself.
                                    try {
                                        await cacheIpnsRecordInPubsubLocalStore({
                                            localStore: ipnsPubsubLocalStore,
                                            routingKey,
                                            marshalledRecord: direct.recordBytes
                                        });
                                    } catch (cacheErr) {
                                        log.trace(
                                            "Failed to cache direct-fetched IPNS record at the pubsub routing layer for",
                                            ipnsPubsubTopic,
                                            cacheErr
                                        );
                                    }
                                    yield record.value;
                                    return;
                                }
                                directFetchOutcome = { attempted: true, hit: false, durationMs: Date.now() - directStart };
                            } catch (directErr) {
                                // A caller-initiated abort should surface as-is, not be masked by the
                                // fallback path as ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED.
                                if (options?.signal?.aborted) throw directErr;
                                directFetchOutcome = {
                                    attempted: true,
                                    hit: false,
                                    durationMs: Date.now() - directStart,
                                    error: directErr as Error
                                };
                                log.trace("Direct IPNS fetch path errored for", ipnsPubsubTopic, directErr);
                            }
                        }

                        // Fallback: legacy warmup + router.get() loop.
                        // @helia/ipns 9.2.x pubsub router throws NotFoundError if zero subscribers exist
                        // for the topic at .get() time. Await peer warmup so the resolver sees a populated
                        // subscriber list (the monkey-patched pubsub.subscribe also kicks off warmup,
                        // but fire-and-forget — too late for the first .get()).
                        type WarmupOutcome =
                            | { attempted: false }
                            | { attempted: true; durationMs: number; subscribersAfterWarmup: number }
                            | { attempted: true; durationMs: number; error: PKCError | Error };
                        let warmupOutcome: WarmupOutcome = { attempted: false };
                        if (helia.libp2p.services.pubsub.getSubscribers(ipnsPubsubTopic).length === 0) {
                            const warmupStart = Date.now();
                            try {
                                await warmupForTopic(ipnsPubsubTopic, options);
                                warmupOutcome = {
                                    attempted: true,
                                    durationMs: Date.now() - warmupStart,
                                    subscribersAfterWarmup: helia.libp2p.services.pubsub.getSubscribers(ipnsPubsubTopic).length
                                };
                            } catch (warmupErr) {
                                warmupOutcome = {
                                    attempted: true,
                                    durationMs: Date.now() - warmupStart,
                                    error: warmupErr as Error
                                };
                                log.error("Pre-resolve peer warmup failed for", ipnsPubsubTopic, warmupErr);
                            }
                        }

                        // We resolve a SINGLE hop here (the immediate value of this name's record),
                        // rather than @helia/ipns' resolve() which recurses the whole chain. Recursion
                        // is driven by the caller (resolveIpnsToCidP2P), one hop per call, so that each
                        // IPNS name in a delegated chain gets its own pubsub topic warmed before its
                        // record is fetched — @helia's internal recursion would otherwise try to fetch a
                        // deeper hop's record before its topic has any subscribers and throw NotFoundError.
                        // See docs/protocol/delegated-ipns.md.
                        //
                        // Why call routers directly instead of ipnsNameResolver.resolve():
                        // - @helia/ipns 9.2.x has no public single-hop / non-recursive resolve API.
                        //   resolve() always recurses until it reaches an /ipfs/ value, and its single-hop
                        //   primitive (#findIpnsRecord) is private — so the router layer is the only public
                        //   way to fetch exactly one record.
                        // - resolve()'s ResolveProgressEvents type declares ipns:resolve:success (carrying
                        //   the per-hop IPNSRecord), but those events are never emitted in 9.2.x — only
                        //   routing-level events fire, none carrying a record value or next-hop name. So an
                        //   onProgress listener cannot reconstruct the hop chain either. Empirically pinned
                        //   in test/node/community/helia-ipns-resolve-equivalence.unit.test.ts.
                        // Upstream main has since reworked resolve() into an async generator that yields each
                        // hop's IPNSRecord (ipfs/helia#1041) — that would replace this manual walk and even let
                        // us warm each pubsub topic between yields — but it's unreleased; npm latest 9.2.1 still
                        // collapses the chain to the terminal CID. So the per-hop walk stays for now.
                        // TODO: after the @helia/ipns upgrade, re-check this — once the generator resolve() is
                        // released, replace this router.get + ipnsValidator loop with
                        // `for await (const { record } of ipnsNameResolver.resolve(...))`.
                        // This does NOT bypass an active cache/TTL: all cache-read + TTL logic lives in the
                        // resolver's #findIpnsRecord and is gated on `nocache !== true`, but pkc always
                        // resolves IPNS with nocache:true (see resolveIpnsToCidP2P in base-client-manager),
                        // so that path is inert — the old resolve()-based code skipped it too. IPNS here is
                        // pubsub-only (HTTP routers have getIPNS disabled in getDelegatedRoutingFields), and
                        // the pubsub router's get() never serves from cache; it always queries peers. Record
                        // caching + ipnsSelector happen inside the pubsub router's handleRecord for
                        // gossipsub-delivered records and router.get() fetches; the direct-fetch fast path
                        // above bypasses handleRecord, so it writes the record to the router's localStore
                        // itself (cacheIpnsRecordInPubsubLocalStore, issue #210).
                        let recordBytes: Uint8Array | undefined;
                        const routerErrors: Error[] = [];
                        for (const router of ipnsNameResolver.routers) {
                            try {
                                // validate: false then validate ourselves below — this mirrors exactly what
                                // @helia/ipns' #findIpnsRecord does internally (router.get with validate:false
                                // followed by ipnsValidator), so it is not a deviation from the package.
                                const got = await router.get(routingKey, { ...options, validate: false });
                                if (got) {
                                    recordBytes = got;
                                    break;
                                }
                            } catch (err) {
                                routerErrors.push(err as Error);
                            }
                        }

                        if (!recordBytes)
                            throw new PKCError("ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED", {
                                ipnsName,
                                currentName,
                                ipnsPubsubTopic,
                                ipnsResolveOptions: options,
                                directFetchOutcome,
                                warmupOutcome,
                                routerErrors,
                                subscribersAtResolveTime: helia.libp2p.services.pubsub.getSubscribers(ipnsPubsubTopic).length,
                                httpRouters: pkcOptions.httpRoutersOptions,
                                ...getHeliaDebugContext(helia)
                            });

                        // Validate the record's signature against its routing key before trusting its value.
                        await ipnsValidator(routingKey, recordBytes);
                        const record = unmarshalIPNSRecord(recordBytes);
                        yield record.value;
                    }

                    return generator();
                }
            },
            cat(ipfsPath: string, options) {
                throwIfHeliaIsStoppingOrStopped();
                // Walk the DAG through a per-cat bitswap session seeded with connected peers —
                // see MAX_BITSWAP_SESSION_SEED_PEERS above for the why. UnixFSComponents only
                // needs a blockstore, and blocks fetched through the session land in the same
                // underlying blockstore helia uses, so nothing else changes.
                const rootCid = CID.parse(ipfsPath.split("/")[0]);
                const timeoutMs = parseKuboStyleTimeoutMs(options?.timeout); // throws on unparseable timeout at call time
                // Our own option, not kubo-rpc-client's — strip it so it never reaches unixfs cat.
                const { bitswapSessionSeedScopeIpnsPubsubTopic, ...unixfsCatOptions } = options ?? {};

                return (async function* () {
                    // Bound the fetch's lifetime: honor the caller's signal AND the kubo-style
                    // timeout option, via one internal controller whose listeners/timer are always
                    // detached in the finally below (long-lived caller signals must not accumulate
                    // abort listeners across fetches). Set up inside the generator so the timer
                    // starts on first read, and nothing leaks if the iterable is never iterated.
                    const controller = new AbortController();
                    const callerSignal = options?.signal;
                    const abortFromCallerSignal = () => controller.abort(callerSignal?.reason);
                    if (callerSignal?.aborted) abortFromCallerSignal();
                    else callerSignal?.addEventListener("abort", abortFromCallerSignal, { once: true });
                    const timeoutTimer =
                        timeoutMs !== undefined
                            ? setTimeout(
                                  () => controller.abort(new PKCError("ERR_FETCH_CID_P2P_TIMEOUT", { ipfsPath, timeoutMs })),
                                  timeoutMs
                              )
                            : undefined;
                    try {
                        for (let attempt = 0; ; attempt++) {
                            const session = helia.blockstore.createSession(rootCid, {
                                providers: getBitswapSessionSeedPeers(bitswapSessionSeedScopeIpnsPubsubTopic)
                            });
                            // Issue #218: the session broker waits on a single elected HAVE peer per
                            // block with no stall timeout, so one slow seeder holding the only HAVE
                            // monopolizes the whole fetch. Route every block get through the
                            // stalled-session failover: after the stall window, the session get is
                            // raced against helia.blockstore.get — the non-session bitswap path that
                            // broadcasts the want to all connected peers — and the first block wins.
                            // See fetchBlockWithStalledSessionFailover for the full semantics.
                            const sessionGet = session.get.bind(session);
                            const fallbackGet = helia.blockstore.get.bind(helia.blockstore);
                            session.get = (blockCid, blockGetOptions) =>
                                fetchBlockWithStalledSessionFailover({
                                    cid: blockCid,
                                    sessionGet,
                                    fallbackGet,
                                    stallTimeoutMs:
                                        heliaWithKuboRpcClientShape._bitswapSessionStalledGetFailoverMs ??
                                        BITSWAP_SESSION_STALLED_GET_FAILOVER_MS,
                                    options: blockGetOptions,
                                    log
                                });
                            let yieldedAnyBytes = false;
                            try {
                                // ipfsPath is either a bare cid or a `<root-cid>/sub/path`. Hand the whole
                                // thing to cat as one string and never split out a `path` option — see
                                // asHeliaCatCid above for why the `path` option would re-trip the
                                // exporter's CID identity check.
                                const catIterable = unixfs({ blockstore: session }).cat(asHeliaCatCid(ipfsPath), {
                                    ...unixfsCatOptions,
                                    signal: controller.signal
                                });
                                for await (const chunk of catIterable) {
                                    yieldedAnyBytes = true;
                                    yield chunk;
                                }
                                return;
                            } catch (catError) {
                                // Aborted (caller signal or our timeout): surface the abort reason so
                                // _fetchCidP2P sees ERR_FETCH_CID_P2P_TIMEOUT / the caller's reason
                                // rather than whatever AbortError the exporter threw mid-flight.
                                if (controller.signal.aborted)
                                    throw controller.signal.reason instanceof Error ? controller.signal.reason : catError;
                                // A session fails fast with InsufficientProvidersError when it finds ZERO
                                // providers (no connected peer to seed with + routing returned nothing).
                                // The pre-session broadcast want() would instead keep waiting for a
                                // provider to appear (e.g. a connection formed by a concurrent pubsub
                                // warmup, or a provider record that hasn't propagated to the routers
                                // yet) until the caller's timeout fired. Preserve those semantics: back
                                // off and retry with a fresh session — which re-snapshots connected-peer
                                // seeds and re-queries routing — until the signal/timeout fires. Never
                                // retry after bytes were yielded (the consumer already saw them;
                                // restarting the walk would duplicate output).
                                if (yieldedAnyBytes || !isCausedByInsufficientProviders(catError)) throw catError;
                                log.trace("Bitswap session found no providers for", ipfsPath, "- retrying, attempt", attempt + 1);
                            } finally {
                                // Also cancels the session's background provider top-up query instead of
                                // letting it run until maxProviders providers are found.
                                session.close();
                            }
                            await delayAbortable(
                                Math.min(SESSION_NO_PROVIDERS_RETRY_BASE_DELAY_MS * 2 ** attempt, 8_000),
                                controller.signal
                            );
                            if (controller.signal.aborted) {
                                if (controller.signal.reason instanceof Error) throw controller.signal.reason;
                                throw new PKCError("ERR_FETCH_CID_P2P_TIMEOUT", { ipfsPath, timeoutMs });
                            }
                        }
                    } finally {
                        if (timeoutTimer !== undefined) clearTimeout(timeoutTimer);
                        callerSignal?.removeEventListener("abort", abortFromCallerSignal);
                    }
                })();
            },
            pubsub: {
                ls: async () => helia.libp2p.services.pubsub.getTopics(),
                peers: async (topic, options) => helia.libp2p.services.pubsub.getSubscribers(topic),
                publish: async (topic, data, options) => {
                    throwIfHeliaIsStoppingOrStopped();
                    // Route publish through the mesh, not fanout. Gossipsub fanout selection requires
                    // an outbound gossipsub stream to a topic peer (streamsOutbound check), and that
                    // stream is set up asynchronously after libp2p's connection event — so warmup can
                    // complete (getSubscribers(topic) > 0) while the outbound stream is still
                    // negotiating, leaving res.recipients empty. The mesh path doesn't race because
                    // gossipsub only emits gossipsub:graft once both ends have outbound streams. We
                    // subscribe locally to force a graft, wait for it via waitForMeshPeer (called
                    // inside warmupForTopic), then publish. wasAlreadySubscribed guard prevents
                    // tearing down a subscription owned by another caller.
                    const wasAlreadySubscribed = helia.libp2p.services.pubsub.getTopics().includes(topic);
                    if (!wasAlreadySubscribed) helia.libp2p.services.pubsub.subscribe(topic);
                    try {
                        await warmupForTopic(topic, options);
                        const res = await helia.libp2p.services.pubsub.publish(topic, data);
                        log(
                            "Published new data to pubsub topic (string, e.g. community address)",
                            topic,
                            "Direct gossipsub recipients (libp2p peer IDs, NOT signer/community addresses):",
                            res.recipients.map((p) => p.toString())
                        );
                    } finally {
                        if (!wasAlreadySubscribed) helia.libp2p.services.pubsub.unsubscribe(topic);
                    }
                },
                subscribe: async (topic, handler, options) => {
                    throwIfHeliaIsStoppingOrStopped();
                    //@ts-expect-error
                    pubsubEventHandler.on(topic, handler);
                    // Start warmup BEFORE native subscribe so the caller's abort signal lands
                    // on the promise stored in warmupPromisesByTopic. The monkey-patched
                    // pubsub.subscribe below also fires warmupForTopic, but with no options;
                    // if it ran first the dedup map would hold a signal-less promise and the
                    // caller's signal would be silently dropped. warmupForTopic returns
                    // synchronously up to connectToPubsubPeers's first await, so by the time
                    // its internal mesh-wait runs, the native subscribe call below has already
                    // added us to gossipsub's topic set (mesh edges only form for topics we're
                    // locally subscribed to).
                    const warmupPromise = warmupForTopic(topic, options);
                    helia.libp2p.services.pubsub.subscribe(topic);
                    await warmupPromise;
                },
                unsubscribe: async (topic, handler, options) => {
                    throwIfHeliaIsStoppingOrStopped();
                    //@ts-expect-error
                    pubsubEventHandler.removeListener(topic, handler);
                    if (pubsubEventHandler.listenerCount(topic) === 0) helia.libp2p.services.pubsub.unsubscribe(topic);
                }
            },
            async add(
                entry: Parameters<Libp2pJsClient["heliaWithKuboRpcClientFunctions"]["add"]>[0], // More specific types will be checked internally
                options?: Parameters<Libp2pJsClient["heliaWithKuboRpcClientFunctions"]["add"]>[1]
            ): Promise<AddResult> {
                throw Error("Helia 'add' is not supported at the moment in pkc-js API");
            },
            async stop(options) {
                const clientFromMap = libp2pJsClients[pkcOptions.key];
                if (!clientFromMap) return; // already been stopped
                if (clientFromMap.countOfUsesOfInstance <= 0) return; // stop already in progress or over-released
                clientFromMap.countOfUsesOfInstance--;
                if (clientFromMap.countOfUsesOfInstance === 0) {
                    // Remove from the lookup map BEFORE awaiting helia.stop() so a concurrent
                    // createLibp2pJsClientOrUseExistingOne() can't grab a mid-stopping client.
                    delete libp2pJsClients[pkcOptions.key];

                    // Tear down the IPNS pubsub router's internal subscription state.
                    // PubSubRouting (from @helia/ipns/routing) implements Startable and tracks its
                    // own subscriptions list — without stop() those subscriptions leak past helia.
                    for (const router of ipnsNameResolver.routers) {
                        const lifecycle = router as { stop?: () => void | Promise<void> };
                        if (typeof lifecycle.stop === "function") {
                            try {
                                await lifecycle.stop();
                            } catch (e) {
                                log.error("Error stopping IPNS router", router?.constructor?.name, e);
                            }
                        }
                    }

                    for (const topic of helia.libp2p.services.pubsub.getTopics()) helia.libp2p.services.pubsub.unsubscribe(topic);

                    // Force-reset open transport connections before stopping helia. helia.stop()
                    // closes them gracefully (the TCP transport calls socket.destroySoon(), which waits
                    // for the peer's FIN), so a slow or unresponsive remote peer can leave the underlying
                    // socket lingering in FIN_WAIT for tens of seconds — long enough to keep the Node
                    // process alive past pkc.destroy()'s teardown budget (see test/node/pkc/hanging.pkc.test.ts).
                    // abort() sends RST and destroys the socket immediately, making teardown bounded
                    // regardless of peer responsiveness. This only runs on the final release of the helia
                    // instance (countOfUsesOfInstance === 0), so no other consumer needs these connections.
                    for (const connection of helia.libp2p.getConnections()) {
                        try {
                            connection.abort(new Error("pkc-js libp2p instance is stopping"));
                        } catch (e) {
                            log.error("Error aborting libp2p connection during stop", e);
                        }
                    }

                    try {
                        await helia.stop();
                    } catch (e) {
                        log.error("Error stopping helia", e);
                    }

                    // helia.stop() does not touch the blockstore: blockstore-fs/idb expose
                    // open()/close() rather than the Startable start()/stop() that helia's
                    // start(...) helper looks for, so the file handles and IDB connection are ours
                    // to release.
                    try {
                        await closeBlockstore();
                    } catch (e) {
                        log.error("Error closing blockstore", e);
                    }

                    log("Helia/libp2p-js stopped with key", pkcOptions.key, "and peer id", helia.libp2p.peerId.toString());
                }
            }
        };

        const originalSubscribe = helia.libp2p.services.pubsub.subscribe.bind(helia.libp2p.services.pubsub);

        // Monkey-patch the native pubsub.subscribe so internal callers (notably @helia/ipns) also
        // get peer warmup. Sync return preserves the gossipsub contract; warmup runs fire-and-forget
        // here and shares its in-flight promise with awaitable callers via warmupForTopic's dedup map.
        helia.libp2p.services.pubsub.subscribe = (topic) => {
            throwIfHeliaIsStoppingOrStopped();
            warmupForTopic(topic).catch((err) => log.error("warmup failed for topic", topic, err));
            originalSubscribe(topic);
        };

        const fullInstanceWithOptions = {
            helia,
            heliaWithKuboRpcClientFunctions: heliaWithKuboRpcClientShape,
            heliaUnixfs: heliaFs,
            heliaIpnsRouter: ipnsNameResolver,
            mergedHeliaOptions: mergedHeliaInit,
            countOfUsesOfInstance: 1,
            libp2pJsClientsOptions: pkcOptions,
            key: pkcOptions.key
        };

        const client = new Libp2pJsClient(fullInstanceWithOptions);

        await helia.start();
        log("Helia/libp2p-js started with key", pkcOptions.key, "and peer id", helia.libp2p.peerId.toString());

        libp2pJsClients[pkcOptions.key] = client;

        return client;
    })();

    const createdClientPromise = creatingLibp2pJsClients[pkcOptions.key];
    if (!createdClientPromise) throw new Error("Missing creation promise after initialization");

    try {
        return await createdClientPromise;
    } finally {
        delete creatingLibp2pJsClients[pkcOptions.key];
    }
}

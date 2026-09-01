import { createHeliaLight } from "helia";
import { libp2pDefaults, withLibp2p } from "@helia/libp2p";
import { withBitswap } from "@helia/bitswap";
import { ipns } from "@helia/ipns";
import { unmarshalIPNSRecord, multihashToIPNSRoutingKey } from "ipns";
import type { IPNSRecord } from "ipns";
import { ipnsValidator } from "ipns/validator";
import { gossipsub } from "@libp2p/gossipsub";
import { identify } from "@libp2p/identify";
import extraLibp2pTransports from "../runtime/node/libp2p-extra-transports.js";
import { CID } from "multiformats/cid";
import { sha512 } from "multiformats/hashes/sha2";
import { peerIdFromString } from "@libp2p/peer-id";
import { createBlockstoreForLibp2pJsClient } from "../runtime/node/blockstore.js";
import { LruBlockstore } from "./lru-blockstore.js";
import { delegatedRoutingV1HttpApiClientContentRouting } from "@helia/delegated-routing-v1-http-api-client";
import { NotFoundError, type AbortOptions, type Connection } from "@libp2p/interface";
import { unixfs } from "@helia/unixfs";
import { fetch as libp2pFetch } from "@libp2p/fetch";
import { pubSubIPNSRouting as createIpnsPubusubRouter } from "@helia/ipns";
import Logger from "../logger.js";
import type { AddResult, NameResolveOptions as KuboNameResolveOptions } from "kubo-rpc-client";
import type { IpfsHttpClientPubsubMessage, ParsedPKCOptions } from "../types.js";

import { EventEmitter } from "events";
import type { HeliaWithLibp2pPubsub, IpnsRecordArrivalListener } from "./types.js";
import { PKCError } from "../pkc-error.js";
import { Libp2pJsClient } from "./libp2pjsClient.js";
import {
    BITSWAP_SESSION_STALLED_GET_FAILOVER_MS,
    cacheIpnsRecordInPubsubLocalStore,
    readFreshCachedIpnsRecordFromPubsubLocalStore,
    connectToPubsubPeers,
    directFetchIpnsRecordFromProviders,
    fetchBlockWithStalledSessionFailover,
    getHeliaDebugContext,
    selectBitswapSessionSeedPeers
} from "./util.js";
import type { IpnsPubsubLocalStore } from "./util.js";
import { createDefaultDialTransportGater } from "./dial-transport-filter.js";
import { binaryKeyToPubsubTopic, ipnsNameToIpnsOverPubsubTopic } from "../util.js";

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

// @helia/ipns routers identify themselves through a literal toString() tag ("LocalStoreRouting()",
// "HeliaRouting()", "PubSubRouting()"). Use that, never `constructor.name`: the classes are
// module-private and bundlers mangle their names, which turned the old class-name filter into a
// silent no-op in production builds.
export function ipnsRouterTag(router: unknown): string {
    return String(router);
}

export function isLocalStoreIpnsRouter(router: unknown): boolean {
    return ipnsRouterTag(router) === "LocalStoreRouting()";
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

    // Both are set from inside the factory so that the catch handler after it can tear down
    // whatever got started when the wiring throws part-way through: until the client lands in
    // libp2pJsClients nothing else holds a reference to the node, and a started-but-orphaned
    // libp2p keeps gossipsub heartbeats, bitswap and open sockets alive past pkc.destroy().
    let startedHelia: HeliaWithLibp2pPubsub | undefined;
    let closeBlockstore = async () => {};

    creatingLibp2pJsClients[pkcOptions.key] = (async () => {
        // A caller supplying their own heliaOptions.blockstore owns block storage entirely, so skip
        // ours rather than opening a directory or IndexedDB database nothing will read.
        let lruBlockstore: LruBlockstore | undefined;
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
            ...pkcOptions.heliaOptions
        } as NonNullable<Libp2pJsClient["_mergedHeliaOptions"]>;

        // helia 7's createHelia() composes withHTTP() in: a public trustless-gateway block broker
        // plus public delegated HTTP routers and recursive gateways. We use our own gateway
        // fan-out logic in base-client-manager and only the routers the user configured, so
        // compose the node without any HTTP components (heliaOptions.http is excluded from the
        // schema for that reason): bitswap is the only block broker and libp2p the only content
        // router. withLibp2p applies libp2pDefaults with shallow per-key replace semantics (same
        // as helia 6's createHelia): every key we set above wins outright (in particular our
        // narrow `services` map fully replaces the default one), while keys we leave out
        // (connectionEncrypters, streamMuxers, ...) come from helia's defaults.
        //
        // A caller-supplied heliaOptions.blockBrokers REPLACES bitswap, as it did under helia 6
        // (`init.blockBrokers ?? [bitswap()]`): withBitswap() is additive, so applying it on top of
        // the caller's list would hand a gateway-only/opt-out config bitswap sessions and dials anyway.
        //
        // createHeliaLight registers only sha2-256/identity and dag-pb/raw, where createHelia adds
        // sha2-512 and the dag-cbor/dag-json/json codecs. pkc records are unixfs (dag-pb/raw) so
        // the codecs are not needed, but nothing stops a community from publishing a sha2-512 CID
        // (e.g. `ipfs add --hash sha2-512`) and helia looks the hasher up before the first block
        // fetch, so keep sha2-512 to match what fetched under helia 6.
        const { libp2p: mergedLibp2pInit, bitswap: bitswapInit, blockBrokers: callerBlockBrokers, ...heliaLightInit } = mergedHeliaInit;
        const heliaWithLibp2p = withLibp2p(
            createHeliaLight({
                ...heliaLightInit,
                blockBrokers: callerBlockBrokers,
                hashers: [sha512, ...(heliaLightInit.hashers ?? [])]
            }),
            mergedLibp2pInit ?? {}
        );
        // The composition is typed as helia's default service map (dht, relay, upnp, ...) while our
        // `services` above replaces it; HeliaWithLibp2pPubsub is the narrow map we actually run.
        const helia = <HeliaWithLibp2pPubsub>(
            (<unknown>(callerBlockBrokers === undefined ? withBitswap(heliaWithLibp2p, bitswapInit) : heliaWithLibp2p))
        );

        // helia 7 creates libp2p lazily inside start() — the `helia.libp2p` getter throws
        // NotStartedError until then — so start the node before wiring anything that reads it.
        // Nothing can race the wiring below: no topic is subscribed and no dial is made until
        // this factory returns the client.
        // Assigned before start(): helia 7's start() has no rollback, so if a later mixin throws
        // (e.g. bitswap's network.start() after withLibp2p already started libp2p) the node is
        // half-started and must still be stopped by the catch below.
        startedHelia = helia;
        await helia.start();

        log("Initialized libp2pjs helia with key", pkcOptions.key, "peer id", helia.libp2p.peerId.toString());

        const pubsubEventHandler = new EventEmitter();

        helia.libp2p.services.pubsub.addEventListener("message", (evt) => {
            log.trace(`Event from helia libp2p pubsub: on pubsub topic (string, e.g. community address) ${evt.detail.topic}`);

            //@ts-expect-error
            const msgFormatted: IpfsHttpClientPubsubMessage = { data: evt.detail.data, topic: evt.detail.topic, type: evt.detail.type };
            pubsubEventHandler.emit(evt.detail.topic, msgFormatted);
        });

        const heliaFs = unixfs(helia);

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
        const ipnsNameResolver = ipns(helia, {
            routers: [ipnsPubsubRouter]
        });

        // @helia/ipns constructs routers as [LocalStoreIPNSRouting, HeliaIPNSRouting, ...userRouters]
        // and hands that SAME array to its resolver/publisher/republisher, so it must be mutated in
        // place: reassigning `.routers` only changes what pkc's own loops below iterate, while
        // ipnsNameResolver.resolve() keeps querying (and writing the local cache through) the
        // original list. We drop LocalStoreIPNSRouting because its get() serves whatever the
        // datastore holds with no ttl/EOL judgment of its own: the datastore is no longer empty
        // (gossiped pushes and the issue #210 direct-fetch write land there), and cache reads must
        // instead go through name.resolve's ttl-honoring cache gate (issue #301) so the network
        // fallback loop below stays a NETWORK loop rather than short-circuiting on possibly-stale
        // cache. Keep HeliaIPNSRouting (HTTP delegated routing via helia.routing) and our pubsub
        // router. Match by the router's toString() tag ("LocalStoreRouting()") rather than by
        // `constructor.name`: the class is module-private and bundlers mangle its name (in 5chan's
        // production build it becomes `dMe`), so a class-name match is a silent no-op there. The
        // tag is a string literal and survives minification. Matching by identity (rather than
        // by index) also means a future @helia/ipns release that re-orders the array can't make
        // us drop the wrong router.
        for (let i = ipnsNameResolver.routers.length - 1; i >= 0; i--) {
            if (isLocalStoreIpnsRouter(ipnsNameResolver.routers[i])) ipnsNameResolver.routers.splice(i, 1);
        }

        // The IPNS facade marks itself started (and runs its hourly republisher) from helia's
        // 'start' event, which helia 7 dispatches exactly once at the end of start(), i.e. before the
        // facade existed (its constructor walks helia's components, whose `libp2p` getter throws
        // until start(), so it cannot be built earlier). helia 6 fell back to
        // `libp2p.status === 'started'` and so ran the republisher; that fallback is gone in 7.
        // Nothing in pkc depends on the facade being "started" (resolve() has no started check and
        // pkc walks `routers` directly), so this only keeps helia-6 lifecycle parity for the
        // republisher. start() is on the class but not on the exported IPNS interface.
        (ipnsNameResolver as { start?: () => void }).start?.();
        // The router is Startable but neither helia.start() (blockstore/datastore/routing/brokers
        // only) nor the IPNS facade (republisher only) starts user-supplied routers. Its start()
        // registers the libp2p/fetch topology that fills `fetchPeers`, which gates the
        // subscription-change fast path: fetch the record over /libp2p/fetch from a server that
        // joins the topic after our get() already ran (ipfs/helia#906) and republish it to the
        // topic. NOTE: this path is newly enabled here, not restored. Under helia 6 nothing ever
        // called start() on this router either, so `fetchPeers` stayed empty and the fast path
        // never fired. It is largely redundant with the direct fetch below (issue #210) but bounded
        // (one fetch per subscription-change event, into the router's own queue); its republish
        // goes through raw libp2p pubsub, not pkc's mesh-gated wrapper, so a `could not publish
        // record` error line is possible when no mesh peer exists. stop() is mirrored in stop() below.
        await (ipnsPubsubRouter as { start?: () => void | Promise<void> }).start?.();
        // The router's localStore is where gossipsub-delivered records get cached (handleRecord).
        // It's declared private but is a plain class field at runtime; the direct-fetch path below
        // writes to it to keep the cached-record invariant (issue #210), and the cache gate in
        // name.resolve reads it to serve repeat resolves locally (issue #301).
        const ipnsPubsubLocalStore = (ipnsPubsubRouter as unknown as { localStore: IpnsPubsubLocalStore }).localStore;
        // The router's message listener drops any gossiped record whose topic is not in this
        // private Set, and upstream only populates it inside router.get() — which the direct-fetch
        // fast path below never calls (and which, since @helia/ipns 10, skips the add when the
        // topic is already libp2p-subscribed). name.resolve adds every IPNS topic it subscribes
        // here as well, so pushed records actually reach handleRecord and the localStore
        // (issue #301). Same structural-access pattern as localStore above.
        const ipnsPubsubRouterSubscriptions = (ipnsPubsubRouter as unknown as { subscriptions: Set<string> }).subscriptions;
        // Per-topic time of the last NETWORK fetch that validated a record for that name. Feeds
        // the cache gate's freshness check (issue #301): a refetch that returns bytes identical to
        // the cache never refreshes the localStore's write time, so without this an idle name
        // would re-fetch on every resolve once its record's ttl first expired. Bounded by the set
        // of IPNS names this helia instance resolves (communities the app follows).
        const ipnsRecordNetworkValidatedAtMs = new Map<string, number>();

        // Push signal for IPNS names (issue #308): every accepted-newer record converges on the
        // pubsub router's localStore.put — gossipsub delivery (handleRecord), the direct-fetch
        // cache write (cacheIpnsRecordInPubsubLocalStore), and the fallback router.get() fetch
        // all write through it, and none of them writes a record older than the cached one.
        // Wrapping put therefore yields exactly "a newer record for this name is now held
        // locally", with none of the ordering hazards of listening to raw pubsub messages
        // (which fire before handleRecord has validated and cached the record). The topic key is
        // derivable from the routing key alone: routingKey = '/ipns/' + multihash bytes and the
        // gossip topic is binaryKeyToPubsubTopic(routingKey) — the same encoding the subscriber
        // side derives through ipnsNameToIpnsOverPubsubTopic, so publisher and subscriber cannot
        // silently diverge. A listener failure or an unmarshal failure must never fail the put
        // itself.
        const ipnsRecordArrivalListeners = new Map<string, Set<IpnsRecordArrivalListener>>();
        const originalLocalStorePut = ipnsPubsubLocalStore.put.bind(ipnsPubsubLocalStore);
        ipnsPubsubLocalStore.put = async (routingKey, marshalledRecord, options) => {
            await originalLocalStorePut(routingKey, marshalledRecord, options);
            const pubsubTopic = binaryKeyToPubsubTopic(routingKey);
            const listeners = ipnsRecordArrivalListeners.get(pubsubTopic);
            if (!listeners || listeners.size === 0) return;
            let record: IPNSRecord;
            try {
                record = unmarshalIPNSRecord(marshalledRecord);
            } catch (e) {
                log.error("Failed to unmarshal a cached IPNS record for the arrival listeners of topic", pubsubTopic, e);
                return;
            }
            for (const listener of [...listeners]) {
                try {
                    listener({ pubsubTopic, record });
                } catch (e) {
                    log.error("An IPNS record arrival listener threw for topic", pubsubTopic, e);
                }
            }
        };

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

                        // Cache gate (issue #301): once a name's topic is subscribed, gossiped
                        // records keep the localStore fresh (handleRecord, enabled by the
                        // subscriptions add below), so a repeat resolve is a local read while the
                        // cached record is inside its ttl window — not a fresh multi-peer fetch
                        // race per call. This is what turns the update loop's 1s cadence from
                        // ~150 fetch streams/s at 64 communities into pushes plus one
                        // revalidation per name per ttl. Gated on the topic being subscribed
                        // because freshness relies on the push channel this resolver set up on a
                        // previous call; nocache: true bypasses the cache entirely (explicit
                        // refresh, kubo semantics). A cache read failure must never fail the
                        // resolve, so any error falls through to the network path.
                        if (options?.nocache !== true && helia.libp2p.services.pubsub.getTopics().includes(ipnsPubsubTopic)) {
                            try {
                                const cachedRecord = await readFreshCachedIpnsRecordFromPubsubLocalStore({
                                    localStore: ipnsPubsubLocalStore,
                                    routingKey,
                                    lastNetworkValidatedAtMs: ipnsRecordNetworkValidatedAtMs.get(ipnsPubsubTopic)
                                });
                                if (cachedRecord) {
                                    log.trace("Serving IPNS record for", currentName, "from the routing-layer cache");
                                    yield cachedRecord.value;
                                    return;
                                }
                            } catch (cacheErr) {
                                log.trace(
                                    "Reading the cached IPNS record for",
                                    ipnsPubsubTopic,
                                    "failed, falling through to the network",
                                    cacheErr
                                );
                            }
                        }

                        // Fast path: fetch the record over libp2p/fetch, in parallel, directly from BOTH
                        // the topic's current gossipsub subscribers AND providers freshly discovered from
                        // the HTTP routers — first signature-valid record wins. This skips the
                        // waitForTopicSubscriber floor (up to 10s) that the legacy path below blocks on,
                        // because @helia/ipns's PubSubIPNSRouting.get() only fetches from getSubscribers() and
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
                            // Also register the topic with the pubsub router (issue #301): without
                            // this, its message listener drops every gossiped record for the topic
                            // and the subscription above only ever feeds the mesh, not the cache.
                            // Idempotent, and also heals topics first subscribed via the fallback
                            // router.get() (which since @helia/ipns 10 skips this add when the
                            // topic is already libp2p-subscribed).
                            ipnsPubsubRouterSubscriptions.add(ipnsPubsubTopic);
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
                                    // Stamp the network validation time for the cache gate even when
                                    // the fetched bytes turn out identical to the cache (issue #301):
                                    // identical bytes never refresh the localStore's write time, so
                                    // this stamp is what lets an idle name serve from cache for
                                    // another ttl window after a revalidation.
                                    ipnsRecordNetworkValidatedAtMs.set(ipnsPubsubTopic, Date.now());
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
                        // @helia/ipns 10 reworked resolve() into an async generator that yields one
                        // IPNSResolveResult per hop (ipfs/helia#1041), so a single-hop read is now
                        // technically reachable by taking the first yield. The per-hop walk stays anyway:
                        // - the direct-fetch fast path above (libp2p/fetch from subscribers + freshly
                        //   discovered providers, with the issue #210 cache write) has no equivalent
                        //   inside resolve();
                        // - per-hop pubsub warmup has to happen BEFORE that hop's record is requested, and
                        //   resolve() requests the next hop's record internally as soon as it yields;
                        // - per-router error aggregation below is what the tests and callers report on.
                        // Equivalence of the resolved value with resolve() is pinned in
                        // test/node/community/helia-ipns-resolve-equivalence.unit.test.ts.
                        // This does NOT bypass an active cache/TTL: the cache gate at the top of this
                        // generator (issue #301) is the cache read for this resolver, honoring
                        // `nocache !== true` and the record's ttl the way @helia/ipns' #findIpnsRecord
                        // would. IPNS here is pubsub-only (HTTP routers have getIPNS disabled in
                        // getDelegatedRoutingFields), and the pubsub router's get() never serves from
                        // cache; it always queries peers. Record caching + ipnsSelector happen inside the
                        // pubsub router's handleRecord for gossipsub-delivered records (reachable because
                        // the fast path registers each topic in the router's subscriptions Set) and
                        // router.get() fetches; the direct-fetch fast path above bypasses handleRecord, so
                        // it writes the record to the router's localStore itself
                        // (cacheIpnsRecordInPubsubLocalStore, issue #210).
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
                        // Same freshness stamp as the direct-fetch hit above (issue #301).
                        ipnsRecordNetworkValidatedAtMs.set(ipnsPubsubTopic, Date.now());
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
                // ipfsPath is either a bare cid or a `<root-cid>/sub/path`; derive both parts here, once,
                // so root and sub-path can never disagree. unixfs cat takes the root CID plus the sub-path
                // via the `path` option. (The multiformats 13/14 split that used to force string-only cat
                // input is gone: helia 7 and our tree share a single multiformats copy.)
                const [rootCidString, ...ipfsSubPathSegments] = ipfsPath.split("/");
                const rootCid = CID.parse(rootCidString);
                const ipfsSubPath = ipfsSubPathSegments.length > 0 ? ipfsSubPathSegments.join("/") : undefined;
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
                                // helia 7 sessions take providers as libp2p-key CIDs (or multiaddrs), not PeerIds
                                providers: getBitswapSessionSeedPeers(bitswapSessionSeedScopeIpnsPubsubTopic).map((peerId) =>
                                    peerId.toCID()
                                )
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
                                const catIterable = unixfs({ blockstore: session }).cat(rootCid, {
                                    ...unixfsCatOptions,
                                    path: ipfsSubPath,
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
            ipnsRecordArrivals: {
                subscribe: (pubsubTopic: string, listener: IpnsRecordArrivalListener) => {
                    const listeners = ipnsRecordArrivalListeners.get(pubsubTopic) ?? new Set<IpnsRecordArrivalListener>();
                    listeners.add(listener);
                    ipnsRecordArrivalListeners.set(pubsubTopic, listeners);
                },
                unsubscribe: (pubsubTopic: string, listener: IpnsRecordArrivalListener) => {
                    const listeners = ipnsRecordArrivalListeners.get(pubsubTopic);
                    if (!listeners) return;
                    listeners.delete(listener);
                    if (listeners.size === 0) ipnsRecordArrivalListeners.delete(pubsubTopic);
                }
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

                    // Update loops unsubscribe their own arrival listeners on stop; clearing here
                    // covers loops torn down after the shared client's final release.
                    ipnsRecordArrivalListeners.clear();

                    // Tear down the IPNS pubsub router's internal subscription state.
                    // PubSubIPNSRouting (@helia/ipns) implements Startable and tracks its own
                    // subscriptions list and fetch topology — without stop() those leak past helia.
                    for (const router of ipnsNameResolver.routers) {
                        const lifecycle = router as { stop?: () => void | Promise<void> };
                        if (typeof lifecycle.stop === "function") {
                            try {
                                await lifecycle.stop();
                            } catch (e) {
                                log.error("Error stopping IPNS router", ipnsRouterTag(router), e);
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

        log("Helia/libp2p-js started with key", pkcOptions.key, "and peer id", helia.libp2p.peerId.toString());

        libp2pJsClients[pkcOptions.key] = client;

        return client;
    })().catch(async (creationError) => {
        // The client never reached libp2pJsClients, so stop() can't be called on it: release
        // whatever this factory started before rethrowing (mirrors the final-release path in stop()).
        if (startedHelia) {
            // The `libp2p` getter throws NotStartedError if start() failed before the libp2p mixin
            // ran, in which case there is nothing to abort.
            let connections: Connection[] = [];
            try {
                connections = startedHelia.libp2p.getConnections();
            } catch {}
            for (const connection of connections) {
                try {
                    connection.abort(new Error("pkc-js libp2p instance failed to initialize"));
                } catch (e) {
                    log.error("Error aborting libp2p connection during failed initialization", e);
                }
            }
            try {
                await startedHelia.stop();
            } catch (e) {
                log.error("Error stopping helia after failed initialization", e);
            }
        }
        try {
            await closeBlockstore();
        } catch (e) {
            log.error("Error closing blockstore after failed initialization", e);
        }
        throw creationError;
    });

    const createdClientPromise = creatingLibp2pJsClients[pkcOptions.key];
    if (!createdClientPromise) throw new Error("Missing creation promise after initialization");

    try {
        return await createdClientPromise;
    } finally {
        delete creatingLibp2pJsClients[pkcOptions.key];
    }
}

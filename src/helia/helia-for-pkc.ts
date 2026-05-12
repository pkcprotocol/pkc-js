import { createHelia, libp2pDefaults } from "helia";
import { ipns } from "@helia/ipns";
import { gossipsub } from "@libp2p/gossipsub";
import { identify } from "@libp2p/identify";
import extraLibp2pTransports from "../runtime/node/libp2p-extra-transports.js";
import { CID } from "multiformats/cid";
import { peerIdFromString } from "@libp2p/peer-id";
import { bitswap } from "@helia/block-brokers";
import { MemoryBlockstore } from "blockstore-core";
import { delegatedRoutingV1HttpApiClient } from "@helia/delegated-routing-v1-http-api-client";
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
import { connectToPubsubPeers, getHeliaDebugContext } from "./util.js";
import { ipnsNameToIpnsOverPubsubTopic } from "../util.js";

const log = Logger("pkc-js:libp2p-js");

const libp2pJsClients: Partial<Record<string, Libp2pJsClient>> = {}; // key => pkc.clients.libp2pJsClients[key]
const creatingLibp2pJsClients: Partial<Record<string, Promise<Libp2pJsClient>>> = {};

// TODO need to call ipnsRouter.cancel when our community stops updating
// TODO we may need to remove libp2pJsClients and creatingLibp2pJsClients, I actually don't think they're needed

// TODO can you verify if we're already content who has a specific and we fetch the CID even though http router says it has no providers, it should be able to load the CID
function getDelegatedRoutingFields(routers: string[]) {
    const routersObj: Record<string, ReturnType<typeof delegatedRoutingV1HttpApiClient>> = {};
    for (let i = 0; i < routers.length; i++) {
        const factory = delegatedRoutingV1HttpApiClient({ url: routers[i] });
        routersObj["delegatedRouting" + i] = (components) => {
            const client = factory(components);
            //@ts-expect-error - our routers don't support any of these
            client.getIPNS = client.getPeers = client.putIPNS = undefined;
            return client;
        };
    }
    return routersObj;
}

export async function createLibp2pJsClientOrUseExistingOne(
    pkcOptions: Required<Pick<ParsedPKCOptions, "httpRoutersOptions">> & NonNullable<ParsedPKCOptions["libp2pJsClientsOptions"]>[number]
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
        const heliaLibp2pDefaults = libp2pDefaults();
        const mergedHeliaInit = {
            libp2p: {
                // for now we're overwriting addresses
                addresses: { listen: [] }, // TODO at some point we should use addresses, but right now it gets into an infinite loop with random walk
                peerDiscovery: undefined,
                // helia merges shallowly: setting `transports` overrides defaults entirely, so we re-spread helia's per-environment defaults and append per-runtime extras
                transports: [...(heliaLibp2pDefaults.transports ?? []), ...extraLibp2pTransports],
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
            // MemoryBlockstore: blocks lost on restart, every cold start re-fetches from network.
            // Future optimization: blockstore-fs (Node) / blockstore-idb (browser). Not prioritized
            // - pkc-js is browser-first and per-session usage dominates today.
            blockstore: new MemoryBlockstore(),
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

        const ipnsNameResolver = ipns(helia, {
            routers: [createIpnsPubusubRouter(helia)]
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
                        const ipnsNameAsPeerId = typeof ipnsName === "string" ? peerIdFromString(ipnsName) : ipnsName;
                        log.trace("Resolving ipns name", ipnsName, "with options", options);

                        // @helia/ipns 9.2.x pubsub router throws NotFoundError if zero subscribers exist
                        // for the topic at .get() time. Await peer warmup so the resolver sees a populated
                        // subscriber list (the monkey-patched pubsub.subscribe also kicks off warmup,
                        // but fire-and-forget — too late for the first .get()).
                        const ipnsPubsubTopic = ipnsNameToIpnsOverPubsubTopic(ipnsNameAsPeerId.toString());
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

                        try {
                            const result = await ipnsNameResolver.resolve(ipnsNameAsPeerId.toMultihash(), options);
                            yield result.record.value;
                            return;
                        } catch (err) {
                            const error = <Error>err;
                            if (error.name === "NotFoundError" || error.name === "RecordNotFoundError")
                                throw new PKCError("ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED", {
                                    heliaError: err,
                                    ipnsName,
                                    ipnsPubsubTopic,
                                    ipnsResolveOptions: options,
                                    warmupOutcome,
                                    subscribersAtResolveTime: helia.libp2p.services.pubsub.getSubscribers(ipnsPubsubTopic).length,
                                    httpRouters: pkcOptions.httpRoutersOptions,
                                    ...getHeliaDebugContext(helia)
                                });
                            else throw err;
                        }
                    }

                    return generator();
                }
            },
            cat(ipfsPath: string, options) {
                throwIfHeliaIsStoppingOrStopped();
                // ipfsPath could be a string of cid or ipfs path
                if (ipfsPath.includes("/")) {
                    // it's a path <root-cid>/<path>/
                    const rootCid = ipfsPath.split("/")[0];
                    const path = ipfsPath.split("/").slice(1).join("/");

                    return heliaFs.cat(CID.parse(rootCid), { ...options, path });
                } else {
                    // a cid string
                    return heliaFs.cat(CID.parse(ipfsPath), options);
                }
            },
            pubsub: {
                ls: async () => helia.libp2p.services.pubsub.getTopics(),
                peers: async (topic, options) => helia.libp2p.services.pubsub.getSubscribers(topic),
                publish: async (topic, data, options) => {
                    throwIfHeliaIsStoppingOrStopped();
                    // Gossipsub publish only delivers to MESH peers (not all subscribers). Gate on
                    // mesh-peer count: a peer can be a subscriber but still in fanout / pending-graft.
                    const meshPeerCount = helia.libp2p.services.pubsub.getMeshPeers(topic).length;
                    if (meshPeerCount === 0) {
                        log.trace("pubsub publish: no mesh peers, warming up for topic", topic);
                        await warmupForTopic(topic, options);
                        log.trace("pubsub publish: warmup complete for topic", topic);
                    }

                    const res = await helia.libp2p.services.pubsub.publish(topic, data);
                    log(
                        "Published new data to pubsub topic (string, e.g. community address)",
                        topic,
                        "Direct gossipsub recipients (libp2p peer IDs, NOT signer/community addresses):",
                        res.recipients.map((p) => p.toString())
                    );
                },
                subscribe: async (topic, handler, options) => {
                    throwIfHeliaIsStoppingOrStopped();
                    // Await warmup so the caller's first message arrives on a populated mesh.
                    // The monkey-patched native subscribe (below) also kicks off warmup, but
                    // fire-and-forget; this awaits the same in-flight promise via the dedup map.
                    await warmupForTopic(topic, options);

                    //@ts-expect-error
                    pubsubEventHandler.on(topic, handler);
                    helia.libp2p.services.pubsub.subscribe(topic);
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
                    try {
                        await helia.stop();
                    } catch (e) {
                        log.error("Error stopping helia", e);
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

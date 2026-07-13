import type { HeliaWithLibp2pPubsub } from "./types.js";
import type { PeerId, PeerInfo, PeerUpdate } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import { CID } from "multiformats/cid";
import { ipnsSelector } from "ipns/selector";
import { equals as uint8ArrayEquals } from "uint8arrays/equals";
import Logger from "../logger.js";
import { PKCError } from "../pkc-error.js";
import { pubsubTopicToDhtKeyCid } from "../util.js";

const TOPIC_SUBSCRIBER_WAIT_TIMEOUT_MS = 10_000;
const MESH_PEER_WAIT_TIMEOUT_MS = 3_000;
// Per-peer bound on a single libp2p/fetch request in directFetchIpnsRecordFromProviders. The
// @helia/ipns pubsub router uses 2.5s once a connection exists; we allow a little more because
// our provider-branch fetch can race a still-completing dial.
const DIRECT_FETCH_PER_PEER_TIMEOUT_MS = 5_000;

export interface HeliaDebugContext {
    heliaPeerId: string;
    heliaStatus: HeliaWithLibp2pPubsub["libp2p"]["status"];
    connectedPeerCount: number;
    connections: { peer: string; multiaddr: string; direction: string }[];
}

export function getHeliaDebugContext(helia: HeliaWithLibp2pPubsub): HeliaDebugContext {
    const connections = helia.libp2p.getConnections();
    return {
        heliaPeerId: helia.libp2p.peerId.toString(),
        heliaStatus: helia.libp2p.status,
        connectedPeerCount: connections.length,
        connections: connections.map((c) => ({
            peer: c.remotePeer.toString(),
            multiaddr: String(c.remoteAddr),
            direction: c.direction
        }))
    };
}

interface PeerDialFailure {
    multiaddrs: string[];
    errorName: string;
    errorMessage: string;
    errorStack?: string;
}

// Dial failures that a later-arriving provider record can cure (issue #213). libp2p's
// CompoundContentRouting.findProviders dedupes providers by peer id across routers: the first
// router's record for a peer is the only one ever yielded, and a slower router's record with
// better addrs (e.g. the browser-dialable /tls/ws one) is merged into the peerstore but never
// re-yielded. So a dial that failed because the connection gater denied every addr known at dial
// time (DialDeniedError), or because no valid addrs were known at all (NoValidAddressesError),
// can succeed on a dial-by-id retry once the provider stream has completed — dial-by-id re-reads
// the peerstore, which by then holds the merged addrs, at zero extra router traffic.
const DIAL_ERROR_NAMES_RETRYABLE_AFTER_ADDR_MERGE = new Set(["DialDeniedError", "NoValidAddressesError"]);

function isDialRetryableAfterAddrMerge(error: unknown): boolean {
    return DIAL_ERROR_NAMES_RETRYABLE_AFTER_ADDR_MERGE.has((error as Error)?.name);
}

function multiaddrIsCircuitRelay(addr: Multiaddr): boolean {
    return addr.getComponents().some((component) => component.name === "p2p-circuit");
}

// Per-peer scheduler for the addr-merge retries (issues #213/#215). A peer marked retryable is
// re-attempted the moment new data for it lands in the peerstore ('peer:update' — fired when a
// slower router's merged record or identify contributes addrs), with provider-stream completion
// as the fallback sweep for peers whose update fired before they were marked. Crucially the
// retry NEVER waits for unrelated dials to settle: the old batch pass ran after
// Promise.allSettled over every initial dial, so one slow-to-fail dial (production: 2-5s
// relay-circuit dials, PR #214 benchmark) delayed a retry whose addrs had been sitting in the
// peerstore since the slower router responded (~hundreds of ms). Each peer is retried once;
// runRetry returning "not-ready" releases the slot so a later peer:update can try again.
function createAddrMergeRetryScheduler({
    helia,
    runRetry
}: {
    helia: HeliaWithLibp2pPubsub;
    runRetry: (peerId: PeerId) => Promise<"done" | "not-ready">;
}) {
    const retryablePeers = new Map<string, PeerId>();
    const inFlightOrDone = new Set<string>();
    const retryTasks: Promise<void>[] = [];
    let providerStreamEnded = false;
    let listenerRemoved = false;

    const trigger = (peerId: PeerId): void => {
        const key = peerId.toString();
        if (inFlightOrDone.has(key)) return;
        inFlightOrDone.add(key);
        retryTasks.push(
            runRetry(peerId).then(
                (outcome) => {
                    if (outcome === "not-ready") inFlightOrDone.delete(key);
                },
                () => undefined // runRetry does its own error recording; never reject the task
            )
        );
    };

    const onPeerUpdate = (evt: CustomEvent<PeerUpdate>): void => {
        const peerId = evt.detail.peer.id;
        if (retryablePeers.has(peerId.toString())) trigger(peerId);
    };
    helia.libp2p.addEventListener("peer:update", onPeerUpdate);

    return {
        // Register a peer as curable by a later addr merge. If the provider stream has already
        // ended (all router records merged), retry immediately.
        markRetryable(peerId: PeerId): void {
            retryablePeers.set(peerId.toString(), peerId);
            if (providerStreamEnded) trigger(peerId);
        },
        // The findProviders stream ended (or was aborted): every router's addrs that will ever
        // arrive have been merged. Sweep the peers whose qualifying update fired before they
        // were marked retryable, and stop listening.
        onProviderStreamEnded(): void {
            providerStreamEnded = true;
            for (const peerId of retryablePeers.values()) trigger(peerId);
            if (!listenerRemoved) {
                listenerRemoved = true;
                helia.libp2p.removeEventListener("peer:update", onPeerUpdate);
            }
        },
        retryTasks
    };
}

// Event-based wait for a remote peer to subscribe to `topic` on our gossipsub.
// Resolves the moment gossipsub fires 'subscription-change' for the topic and the
// subscriber list has actually become non-empty, or rejects on timeout/abort.
// Used as both the in-loop abort trigger and the post-loop graft wait by
// connectToPubsubPeers below.
export function waitForTopicSubscriber({
    helia,
    topic,
    timeoutMs,
    abortSignal
}: {
    helia: HeliaWithLibp2pPubsub;
    topic: string;
    timeoutMs: number;
    abortSignal?: AbortSignal;
}): Promise<void> {
    const pubsub = helia.libp2p.services.pubsub;
    if (pubsub.getSubscribers(topic).length > 0) return Promise.resolve();
    if (abortSignal?.aborted) return Promise.reject(new PKCError("ERR_PUBSUB_TOPIC_PEER_WAIT_ABORTED", { topic }));

    return new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            pubsub.removeEventListener("subscription-change", onChange);
            clearInterval(safetyPoll);
            clearTimeout(timer);
            abortSignal?.removeEventListener("abort", onAbort);
        };
        const tryResolve = () => {
            if (pubsub.getSubscribers(topic).length > 0) {
                cleanup();
                resolve();
                return true;
            }
            return false;
        };
        const onChange = (e: CustomEvent<{ peerId: unknown; subscriptions: { topic: string; subscribe: boolean }[] }>) => {
            if (e.detail.subscriptions.some((s) => s.topic === topic && s.subscribe)) tryResolve();
        };
        const onAbort = () => {
            cleanup();
            reject(new PKCError("ERR_PUBSUB_TOPIC_PEER_WAIT_ABORTED", { topic }));
        };
        const timer = setTimeout(() => {
            cleanup();
            reject(new PKCError("ERR_TIMEOUT_WAITING_FOR_PUBSUB_TOPIC_PEERS", { topic, timeoutMs }));
        }, timeoutMs);
        // Defensive safety poll: 'subscription-change' is the primary fast-path trigger, but we
        // also re-check periodically in case the event already fired before this listener attached
        // or gossipsub state and event delivery diverge briefly.
        const safetyPoll = setInterval(tryResolve, 1000);
        pubsub.addEventListener("subscription-change", onChange);
        abortSignal?.addEventListener("abort", onAbort, { once: true });
        // Race-safe re-check: a subscriber may have appeared in the window between the initial
        // check and addEventListener. Without this, we could miss the only event we'll ever get.
        tryResolve();
    });
}

// Event-based wait for gossipsub to GRAFT a peer into our local mesh for `topic`.
// Resolves on the first graft for the topic, on timeout, or on abort. Never rejects —
// callers proceed regardless; the wait is best-effort to avoid the graft-latency race
// where a remote publishes within ~one heartbeat of our subscribe.
function waitForMeshPeer({
    helia,
    topic,
    timeoutMs,
    abortSignal
}: {
    helia: HeliaWithLibp2pPubsub;
    topic: string;
    timeoutMs: number;
    abortSignal?: AbortSignal;
}): Promise<void> {
    const pubsub = helia.libp2p.services.pubsub;
    if (pubsub.getMeshPeers(topic).length > 0) return Promise.resolve();
    if (abortSignal?.aborted) return Promise.resolve();

    return new Promise<void>((resolve) => {
        const cleanup = () => {
            pubsub.removeEventListener("gossipsub:graft", onGraft);
            clearTimeout(timer);
            abortSignal?.removeEventListener("abort", onAbort);
        };
        const tryResolve = () => {
            if (pubsub.getMeshPeers(topic).length > 0) {
                cleanup();
                resolve();
                return true;
            }
            return false;
        };
        const onGraft = (e: CustomEvent<{ topic: string }>) => {
            if (e.detail.topic === topic) tryResolve();
        };
        const onAbort = () => {
            cleanup();
            resolve();
        };
        const timer = setTimeout(() => {
            cleanup();
            resolve();
        }, timeoutMs);
        pubsub.addEventListener("gossipsub:graft", onGraft);
        abortSignal?.addEventListener("abort", onAbort, { once: true });
        // Race-safe re-check: a graft may have fired between the initial check and addEventListener.
        tryResolve();
    });
}

// Ambient peer discovery for gossipsub. js-libp2p's pubsub intentionally does not discover
// topic peers itself; that is the application's responsibility (same pattern Helia and
// js-ipfs use): hash the topic to a CID, contentRouting.findProviders(), then dial.
// See https://github.com/libp2p/js-libp2p/blob/main/doc/CONFIGURATION.md ("ambient peer discovery").
export async function connectToPubsubPeers({
    helia,
    pubsubTopic,
    maxPeers,
    options,
    log
}: {
    helia: HeliaWithLibp2pPubsub;
    pubsubTopic: string;
    maxPeers: number; // how many peers to dial before we stop
    log: Logger;
    options?: { signal?: AbortSignal };
}): Promise<Awaited<ReturnType<typeof helia.libp2p.dial>>[]> {
    const contentCid = pubsubTopicToDhtKeyCid(pubsubTopic);
    const peersWithContent: PeerInfo[] = [];
    const connectedPeersWithContent: Awaited<ReturnType<typeof helia.libp2p.dial>>[] = [];
    const peerDialToError: Record<string, PeerDialFailure> = {};

    // Two separate abort signals:
    //   - findProvidersAbort: stops enqueueing new dials when subscription-change fires
    //     or maxPeers is reached. Combined with the user's signal.
    //   - dialOptions.signal: ONLY the user's signal (e.g. helia.stop()). Dials are NOT
    //     aborted on subscription-change so they keep running in the background and add
    //     themselves to bitswap's peer set via the peer:connected event, giving the
    //     subsequent bitswap fetch more peers to wantBlock from.
    const findProvidersAbort = new AbortController();
    const findProvidersSignal = options?.signal ? AbortSignal.any([options.signal, findProvidersAbort.signal]) : findProvidersAbort.signal;

    // Event-based watcher for a peer subscribing to our topic on gossipsub.
    // Started immediately so we don't miss subscription-change events that fire during the dial loop.
    // When it resolves, abort findProviders so the loop exits cleanly. Dials in flight keep running.
    const subscriberAppearedPromise = waitForTopicSubscriber({
        helia,
        topic: pubsubTopic,
        timeoutMs: TOPIC_SUBSCRIBER_WAIT_TIMEOUT_MS,
        abortSignal: findProvidersSignal
    });
    subscriberAppearedPromise.then(
        () => {
            if (!findProvidersAbort.signal.aborted) {
                log.trace("Aborting findProviders iterator - gossipsub subscription-change observed for topic", pubsubTopic);
                findProvidersAbort.abort();
            }
        },
        () => {
            // The subscriber wait ended without a subscriber (the 10s floor timeout, or the caller's
            // signal). Abort findProviders too: most routers end their own iterator so the for-await
            // below completes on its own, but a black-hole router (accepts the GET, never responds,
            // never closes) never yields and never ends its it-merge source — without this abort the
            // for-await would pull it forever and warmup would hang PAST the floor. The post-loop
            // `await subscriberAppearedPromise` still surfaces the timeout as graftError.
            if (!findProvidersAbort.signal.aborted) {
                log.trace("Aborting findProviders iterator - subscriber wait ended without a subscriber for topic", pubsubTopic);
                findProvidersAbort.abort();
            }
        }
    );

    const findProvidersStart = Date.now();
    // Dials run in parallel — sequential `await dial()` inside the for-await loop blocks
    // on the slowest dial (up to libp2p's per-dial timeout) even after a subscriber has
    // appeared. The findProviders iterator gets aborted on subscription-change so we stop
    // enqueueing, but already-enqueued dials use options?.signal only and continue running
    // even after this function returns — they populate bitswap's peer set as they finish.
    const inflightDialPromises: Promise<void>[] = [];
    const dialOptions = { ...options };
    // Peers whose dial failed only for lack of dialable addrs (see isDialRetryableAfterAddrMerge):
    // re-dialed by id (re-reading the peerstore) the moment a later record/identify merges addrs
    // for them, or at provider-stream completion (issues #213/#215). Dial-by-id keeps the circuit
    // fallback here on purpose: a relayed connection is still useful to warmup (DCUtR upgrade,
    // mesh discovery), unlike in the direct-fetch path.
    const retryScheduler = createAddrMergeRetryScheduler({
        helia,
        runRetry: async (peerId) => {
            if (options?.signal?.aborted) return "done";
            try {
                const conn = await helia.libp2p.dial(peerId, dialOptions);
                connectedPeersWithContent.push(conn);
                log.trace("Addr-merge retry dial connected to peer", peerId.toString());
                return "done";
            } catch (e) {
                // Keep the original failure in peerDialToError; the retry failing adds no
                // information. A still-addr-limited failure releases the retry slot so a later
                // qualifying addr merge can try again.
                log.trace("Addr-merge retry dial failed for peer", peerId.toString(), "due to error", e);
                return isDialRetryableAfterAddrMerge(e) ? "not-ready" : "done";
            }
        }
    });
    try {
        for await (const peer of helia.libp2p.contentRouting.findProviders(contentCid, { ...options, signal: findProvidersSignal })) {
            peersWithContent.push(peer as PeerInfo);
            const dialPromise = (async () => {
                try {
                    // Make sure dial-by-peerId can resolve addresses: not all content routers (notably
                    // delegated-routing-v1-http) auto-merge discovered multiaddrs into the peerstore,
                    // and dial(peerId) without addrs fails with "no addresses for peer".
                    if (peer.multiaddrs?.length) {
                        await helia.libp2p.peerStore.merge(peer.id, { multiaddrs: peer.multiaddrs });
                    }
                    const conn = await helia.libp2p.dial(peer.id, dialOptions); // no-op if already connected
                    connectedPeersWithContent.push(conn);
                    if (connectedPeersWithContent.length >= maxPeers && !findProvidersAbort.signal.aborted) {
                        log.trace("Aborting findProviders after reaching maxPeers", maxPeers);
                        findProvidersAbort.abort();
                    }
                } catch (e) {
                    const err = e as Error;
                    if (isDialRetryableAfterAddrMerge(err)) retryScheduler.markRetryable(peer.id);
                    peerDialToError[peer.id.toString()] = {
                        multiaddrs: peer.multiaddrs.map(String),
                        errorName: err.name,
                        errorMessage: err.message,
                        errorStack: err.stack
                    };
                    log.trace("Failed to dial IPNS-Over-Pubsub peer", peer.id.toString(), "Due to error", e);
                }
            })();
            inflightDialPromises.push(dialPromise);
            if (connectedPeersWithContent.length >= maxPeers) {
                log.trace("Breaking findProviders loop after reaching maxPeers", maxPeers);
                break;
            }
        }
        log.trace("findProviders for", pubsubTopic, "took", Date.now() - findProvidersStart, "ms");
    } catch (e) {
        // findProviders may throw the abort error we caused ourselves — that's fine, fall through.
        if (!findProvidersAbort.signal.aborted) {
            (e as PKCError).details = {
                ...(e as PKCError).details,
                contentCid,
                options,
                maxPeersBeforeWeStopLookingForProviders: maxPeers,
                connectedPeersWithContent,
                peersWithContent,
                peerDialToError,
                ...getHeliaDebugContext(helia)
            };
            throw e;
        }
    }

    // Provider stream ended (all router records merged, or the stream was aborted): sweep any
    // retryable peers not already re-dialed via peer:update, and detach the listener. The
    // retries run in the background like the initial dials — a successful retry fires
    // peer:connected/subscription-change, which resolves the subscriber wait below without
    // delaying it — and crucially they do NOT wait for the initial dials to settle (issue #215):
    // most peer:update-triggered retries have already fired mid-stream, seconds before a slow
    // relay-circuit dial would have released the old batch pass.
    retryScheduler.onProviderStreamEnded();
    inflightDialPromises.push(...retryScheduler.retryTasks);

    // Wait for the gossipsub subscription-change event — this is the signal that bitswap can
    // see at least one peer subscribed to the topic, so the subsequent IPNS resolve won't walk
    // an empty subscriber list. We do NOT await `Promise.allSettled(inflightDialPromises)` —
    // those dials continue running in the background and add peers to bitswap's peer set via
    // `peer:connected` as they complete. They are still aborted by `options.signal` on
    // helia.stop(), so they don't leak across iterations.
    let graftError: Error | null = null;
    try {
        await subscriberAppearedPromise;
    } catch (graftErr) {
        graftError = graftErr as Error;
        log.trace("gossipsub subscription-change did not arrive within timeout after warmup; resolver may still fall back", graftErr);
        // If subscription-change never fired, wait for at least one dial to finish so we have
        // SOMETHING in connectedPeersWithContent before the graft-error fatal check below.
        if (inflightDialPromises.length) {
            await Promise.race(inflightDialPromises).catch(() => {});
        }
    }

    log.trace("Connected to", connectedPeersWithContent.length, "peers (snapshot at subscription-change)", "for content", contentCid);

    // Wait for gossipsub to GRAFT a peer into our local mesh for this topic. subscription-change
    // tells us a remote peer is subscribed, but gossipsub forwards via the mesh, and mesh edges
    // form on heartbeat (default 1s). Without this wait, a publish from the remote node within
    // ~one heartbeat of warmup-return is dropped because the remote hasn't yet processed our
    // SUBSCRIBE or grafted us. Skip when we aren't locally subscribed (publish-only callers use
    // fanout, not mesh, so mesh would never become non-empty).
    const pubsub = helia.libp2p.services.pubsub;
    if (!graftError && pubsub.getTopics().includes(pubsubTopic)) {
        const meshWaitStart = Date.now();
        await waitForMeshPeer({ helia, topic: pubsubTopic, timeoutMs: MESH_PEER_WAIT_TIMEOUT_MS, abortSignal: options?.signal });
        const meshPeerCount = pubsub.getMeshPeers(pubsubTopic).length;
        const waitMs = Date.now() - meshWaitStart;
        if (meshPeerCount === 0) log.trace("Timed out waiting for mesh peers for topic", pubsubTopic, "after", waitMs, "ms");
        else log.trace("Mesh peers count after wait", meshPeerCount, "for topic", pubsubTopic, "took", waitMs, "ms");
    }

    // If the caller's abort signal fired and that's why graftError was set, propagate the
    // abort rather than reporting success. We may have happened to connect to some peers
    // via findProviders before the abort hit, but the caller asked us to stop — best-effort
    // semantics apply to timeouts, not to explicit aborts.
    if (graftError && options?.signal?.aborted) {
        throw graftError;
    }

    // Only treat zero successful dials as fatal when we also failed to observe a subscriber.
    // If a subscriber appeared (e.g. a peer we couldn't dial directly is still in our gossipsub
    // mesh via another path), the warmup achieved its goal even with zero dial successes.
    if (connectedPeersWithContent.length === 0 && graftError) {
        const error = new PKCError("ERR_FAILED_TO_DIAL_ANY_PEERS_PROVIDING_CID", {
            contentCid,
            peerDialToError,
            peersWithContent,
            options,
            graftError,
            ...getHeliaDebugContext(helia)
        });
        log.error(error);
        throw error;
    }

    return connectedPeersWithContent;
}

// Pick which already-connected peers to seed a bitswap session with (issues #189, #202). Seeded
// providers are consumed by @helia/utils' AbstractSession before it queries routing, so a good
// seed means the first WANT-BLOCK goes out immediately and routing is only a background top-up.
// Priority order mirrors "who most likely has the DAG we're about to walk":
//   1. gossipsub subscribers of the fetched community's IPNS-over-pubsub record topic — the
//      community's record server must be subscribed there to serve records on it, and in the
//      pkc topology it provides every block under the community (record, pages, comments,
//      postUpdates); other subscribers are followers that recently fetched the same blocks
//   2. gossipsub subscribers of any other topic we're subscribed to (community-serving peers)
//   3. any other connected peer
// The cap must stay below the session's maxProviders (default 5) so the background routing
// query keeps contributing discovery redundancy instead of being crowded out by seeds.
export function selectBitswapSessionSeedPeers(args: {
    connectedPeers: PeerId[];
    scopedPubsubSubscriberPeerIdStrings: string[]; // subscribers of the fetched community's IPNS record topic
    pubsubSubscriberPeerIdStrings: string[];
    maxSeeds: number;
}): PeerId[] {
    if (args.connectedPeers.length === 0 || args.maxSeeds <= 0) return [];
    const connectedByString = new Map(args.connectedPeers.map((peer) => [peer.toString(), peer]));
    const seeds: PeerId[] = [];
    const seededStrings = new Set<string>();
    const pushIfConnected = (peerIdString: string) => {
        const connectedPeer = connectedByString.get(peerIdString);
        if (connectedPeer && !seededStrings.has(peerIdString)) {
            seededStrings.add(peerIdString);
            seeds.push(connectedPeer);
        }
    };
    args.scopedPubsubSubscriberPeerIdStrings.forEach(pushIfConnected);
    args.pubsubSubscriberPeerIdStrings.forEach(pushIfConnected);
    for (const peer of args.connectedPeers) pushIfConnected(peer.toString());
    return seeds.slice(0, args.maxSeeds);
}

export interface DirectFetchResult {
    recordBytes: Uint8Array; // already passed the injected validator (ipnsValidator)
    peerId: string; // the subscriber/provider that served it
    source: "subscriber" | "provider";
    durationMs: number;
}

// Fetch an IPNS record over the libp2p fetch protocol (`/libp2p/fetch/0.0.1`) directly and in
// parallel from BOTH (a) peers already subscribed to the topic on our gossipsub
// (getSubscribers) and (b) providers freshly discovered from the HTTP routers (findProviders).
// The first signature-valid record wins; the remaining fetches are aborted.
//
// This bypasses the gossipsub subscription handshake that @helia/ipns's PubSubRouting.get()
// waits on: get() only fetches from getSubscribers(topic) and throws NotFoundError when that
// list is empty, which is why the resolve path currently blocks on waitForTopicSubscriber (a
// 10s floor) before it can fetch. The publisher (kubo via go-libp2p-pubsub-router, or another
// helia via registerLookupFunction) answers a fetch request with the current record regardless
// of subscription state, so we can fetch the moment a provider connection opens.
//
// Returns undefined (not throw) when both branches exhaust without a valid record, so the
// caller can fall back to the legacy router.get() path. Throws only when the caller's signal
// aborts with no winner.
export async function directFetchIpnsRecordFromProviders({
    helia,
    pubsubTopic,
    routingKey,
    maxPeers,
    validate,
    options,
    log
}: {
    helia: HeliaWithLibp2pPubsub;
    pubsubTopic: string;
    routingKey: Uint8Array;
    maxPeers: number; // how many freshly discovered providers to attempt before we stop
    validate: (routingKey: Uint8Array, bytes: Uint8Array) => Promise<void>; // inject ipnsValidator
    log: Logger;
    options?: { signal?: AbortSignal; timeoutMs?: number };
}): Promise<DirectFetchResult | undefined> {
    if (options?.signal?.aborted) throw new PKCError("ERR_IPNS_DIRECT_FETCH_ABORTED", { pubsubTopic, ...getHeliaDebugContext(helia) });

    const start = Date.now();
    const fetchService = helia.libp2p.services.fetch;
    const pubsub = helia.libp2p.services.pubsub;
    const contentCid = pubsubTopicToDhtKeyCid(pubsubTopic);

    // Aborted on the first valid record so every losing fetch (and the findProviders iterator)
    // stops promptly rather than running to its own per-peer timeout.
    const resultController = new AbortController();
    let winner: DirectFetchResult | undefined;
    const peerToError: Record<string, { errorName: string; errorMessage: string }> = {};

    const recordErr = (peerId: PeerId, e: unknown) => {
        const err = e as Error;
        peerToError[peerId.toString()] = { errorName: err.name, errorMessage: err.message };
        log.trace("Direct IPNS fetch failed from peer", peerId.toString(), "due to error", e);
    };

    // Fetch + validate from an already-connected peer. check-then-set of `winner` is safe on the
    // single-threaded event loop because there is no await between the guard and the assignment.
    const tryFetchFromPeer = async (peerId: PeerId, source: DirectFetchResult["source"]): Promise<void> => {
        if (resultController.signal.aborted || winner) return;
        // The fetch service's own timeout is fixed at construction, so bound each call via signal.
        const timeoutSignal = AbortSignal.timeout(options?.timeoutMs ?? DIRECT_FETCH_PER_PEER_TIMEOUT_MS);
        const signal = options?.signal
            ? AbortSignal.any([options.signal, resultController.signal, timeoutSignal])
            : AbortSignal.any([resultController.signal, timeoutSignal]);
        try {
            const bytes = await fetchService.fetch(peerId, routingKey, { signal });
            if (bytes == null) {
                log.trace("Peer", peerId.toString(), "did not have IPNS record for topic", pubsubTopic);
                return;
            }
            await validate(routingKey, bytes); // throws on bad signature / wrong routing key
            if (!resultController.signal.aborted && !winner) {
                winner = { recordBytes: bytes, peerId: peerId.toString(), source, durationMs: Date.now() - start };
                resultController.abort();
            }
        } catch (e) {
            recordErr(peerId, e);
        }
    };

    // Subscriber branch: fetch immediately from every peer gossipsub already reports as
    // subscribed (they are connected, so no dial needed).
    const subscriberTasks = pubsub.getSubscribers(pubsubTopic).map((peerId) => tryFetchFromPeer(peerId, "subscriber"));

    // Provider branch: discover providers of the topic CID from the HTTP routers, dial each, then
    // fetch the moment the dial completes. Stop enqueueing after maxPeers dialable providers or on
    // a winner.
    const providerBranch = (async (): Promise<void> => {
        const findProvidersAbort = new AbortController();
        const findProvidersSignal = options?.signal
            ? AbortSignal.any([options.signal, findProvidersAbort.signal, resultController.signal])
            : AbortSignal.any([findProvidersAbort.signal, resultController.signal]);
        const dialFetchTasks: Promise<void>[] = [];
        // Peers with no fetch-usable addr right now (issues #213/#215): gater denied every addr
        // known at dial time, no valid addrs were known at all, or every announced addr is
        // /p2p-circuit (a relayed connection cannot serve /libp2p/fetch — it fails with
        // LimitedConnectionError — so we never dial those here). All are curable the same way: a
        // slower router's record for the deduped peer merges better addrs into the peerstore.
        // Retried the moment that merge fires peer:update, dialing ONLY the direct addrs so the
        // dial cannot fall back to a circuit addr and burn seconds on a connection the fetch
        // cannot use.
        const retryScheduler = createAddrMergeRetryScheduler({
            helia,
            runRetry: async (peerId) => {
                if (winner || resultController.signal.aborted || options?.signal?.aborted) return "done";
                const peerData = await helia.libp2p.peerStore.get(peerId).catch(() => undefined);
                const directAddrs = (peerData?.addresses ?? [])
                    .map(({ multiaddr }) => multiaddr)
                    .filter((addr) => !multiaddrIsCircuitRelay(addr));
                // No fetch-usable addr yet: release the slot so a later qualifying merge retries.
                if (directAddrs.length === 0 || !(await helia.libp2p.isDialable(directAddrs))) return "not-ready";
                try {
                    const dialSignal = options?.signal
                        ? AbortSignal.any([options.signal, resultController.signal])
                        : resultController.signal;
                    // Peerstore addrs are usually bare; the /p2p suffix associates the dial with
                    // the peer so libp2p's per-peer dedupe/existing-connection reuse applies.
                    const dialTargets = directAddrs.map((addr) => {
                        const components = addr.getComponents();
                        return components[components.length - 1]?.name === "p2p" ? addr : addr.encapsulate(`/p2p/${peerId.toString()}`);
                    });
                    await helia.libp2p.dial(dialTargets, { signal: dialSignal }); // no-op if already connected
                    await tryFetchFromPeer(peerId, "provider");
                } catch (e) {
                    recordErr(peerId, e);
                }
                return "done";
            }
        });
        let attempted = 0;
        try {
            for await (const peer of helia.libp2p.contentRouting.findProviders(contentCid, { ...options, signal: findProvidersSignal })) {
                if (resultController.signal.aborted) break;
                // Providers whose announced addrs are all undialable must not consume one of the
                // maxPeers attempt slots (issue #188): in a browser with a WSS-only connection
                // gater, some routers consistently serve records with only tcp/quic addrs (or none)
                // and answer fast, so their instantly-failing dials would otherwise burn every slot
                // and force the caller back onto the ~10s legacy warmup path. We still dial them —
                // the peerstore may know dialable addrs the record lacks — but only providers with
                // at least one dialable announced addr count toward maxPeers. isDialable is a local
                // check (gater + transport match), not a network round-trip.
                const announcedAddrs = (peer as PeerInfo).multiaddrs ?? [];
                // Circuit-only provider (issue #215): never dial it here — /libp2p/fetch cannot
                // run over the limited relayed connection the dial would produce, so the dial
                // only burns 2-5s. Merge its addrs (useful to warmup/identify, and a later direct
                // addr must land on the same peerstore entry) and park it in the retry set: if a
                // slower router or identify ever contributes a direct addr, it is dialed then.
                // Does not consume a maxPeers slot for the same reason gater-denied providers
                // don't (issue #188).
                if (announcedAddrs.length > 0 && announcedAddrs.every(multiaddrIsCircuitRelay)) {
                    await helia.libp2p.peerStore.merge(peer.id, { multiaddrs: announcedAddrs }).catch(() => undefined);
                    log.trace("Skipping dial to circuit-only provider", peer.id.toString(), "for topic", pubsubTopic);
                    retryScheduler.markRetryable(peer.id);
                    continue;
                }
                const hasDialableAddr = announcedAddrs.length > 0 && (await helia.libp2p.isDialable(announcedAddrs));
                dialFetchTasks.push(
                    (async () => {
                        try {
                            // Not all routers merge discovered multiaddrs into the peerstore, so dial-by-id
                            // could otherwise fail with "no addresses for peer" (mirrors connectToPubsubPeers).
                            if ((peer as PeerInfo).multiaddrs?.length)
                                await helia.libp2p.peerStore.merge(peer.id, { multiaddrs: (peer as PeerInfo).multiaddrs });
                            // Bind the dial to the winner signal too, so a losing dial is cancelled the
                            // moment another peer wins rather than running to its own timeout and delaying
                            // Promise.allSettled(dialFetchTasks) below.
                            const dialSignal = options?.signal
                                ? AbortSignal.any([options.signal, resultController.signal])
                                : resultController.signal;
                            await helia.libp2p.dial(peer.id, { signal: dialSignal }); // no-op if already connected
                            await tryFetchFromPeer(peer.id, "provider");
                        } catch (e) {
                            if (isDialRetryableAfterAddrMerge(e)) retryScheduler.markRetryable(peer.id);
                            recordErr(peer.id, e);
                        }
                    })()
                );
                if (hasDialableAddr && ++attempted >= maxPeers) {
                    findProvidersAbort.abort();
                    break;
                }
            }
        } catch (e) {
            // findProviders may throw the abort we caused ourselves (winner found / maxPeers). Any
            // genuine error is non-fatal here: the subscriber branch may still win, and on total
            // exhaustion we return undefined so the caller falls back to router.get().
            if (!findProvidersSignal.aborted) log.trace("findProviders errored during direct IPNS fetch for topic", pubsubTopic, e);
        }
        // Provider stream ended (all router records merged, or the stream was aborted): sweep
        // any retryable peers not already re-dialed via peer:update BEFORE waiting for the
        // initial dials — a slow-to-settle dial (e.g. 2-5s relay-circuit) must not delay a retry
        // whose addrs have been in the peerstore for seconds (issue #215). Most retries have
        // already fired mid-stream, the moment the slower router's merge fired peer:update.
        retryScheduler.onProviderStreamEnded();
        await Promise.allSettled(dialFetchTasks);
        // Drain retry tasks (they can grow while draining: a late initial-dial failure after
        // stream end triggers its retry inline) so no in-flight fetch/dial leaks past return.
        while (retryScheduler.retryTasks.length > 0) {
            await Promise.allSettled(retryScheduler.retryTasks.splice(0));
        }
    })();

    // Await both branches so no in-flight fetch/dial leaks past return.
    await Promise.allSettled([...subscriberTasks, providerBranch]);

    if (winner) {
        log.trace("Direct IPNS fetch won from", winner.source, winner.peerId, "in", winner.durationMs, "ms for topic", pubsubTopic);
        return winner;
    }

    // If the caller aborted us and nobody won, surface the abort rather than a silent miss.
    if (options?.signal?.aborted)
        throw new PKCError("ERR_IPNS_DIRECT_FETCH_ABORTED", { pubsubTopic, peerToError, ...getHeliaDebugContext(helia) });

    return undefined;
}

// The subset of @helia/ipns's internal localStore (local-store.js) the direct-fetch path needs.
// The pubsub router exposes it as a plain class field at runtime but declares it private, so
// callers access it through this structural type.
export interface IpnsPubsubLocalStore {
    has(routingKey: Uint8Array, options?: { signal?: AbortSignal }): Promise<boolean>;
    get(routingKey: Uint8Array, options?: { signal?: AbortSignal }): Promise<{ record: Uint8Array; created: Date }>;
    put(routingKey: Uint8Array, marshalledRecord: Uint8Array, options?: { signal?: AbortSignal }): Promise<void>;
}

// Persist a validated IPNS record at the pubsub routing layer (issue #210). The pubsub router's
// handleRecord only caches records that arrive over gossipsub or through its own router.get()
// fetch, so a direct-fetch win (directFetchIpnsRecordFromProviders) would otherwise leave the
// datastore empty or stale: offline/fallback resolves and handleRecord's ipnsSelector comparison
// would then act on older state than the freshest record we just validated. Mirrors
// handleRecord's newer-only semantics (minus the gossipsub re-publish): an identical or older
// record than the cached one is never written. The caller must have validated the record.
export async function cacheIpnsRecordInPubsubLocalStore({
    localStore,
    routingKey,
    marshalledRecord
}: {
    localStore: IpnsPubsubLocalStore;
    routingKey: Uint8Array;
    marshalledRecord: Uint8Array;
}): Promise<void> {
    if (await localStore.has(routingKey)) {
        const { record: currentRecord } = await localStore.get(routingKey);
        if (uint8ArrayEquals(currentRecord, marshalledRecord)) return;
        // ipnsSelector returns the index of the best record: 0 means the cached one is newer
        if (ipnsSelector(routingKey, [currentRecord, marshalledRecord]) === 0) return;
    }
    await localStore.put(routingKey, marshalledRecord);
}

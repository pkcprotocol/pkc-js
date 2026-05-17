import type { HeliaWithLibp2pPubsub } from "./types.js";
import type { PeerInfo } from "@libp2p/interface";
import { CID } from "multiformats/cid";
import Logger from "../logger.js";
import { PKCError } from "../pkc-error.js";
import { pubsubTopicToDhtKeyCid } from "../util.js";

const TOPIC_SUBSCRIBER_WAIT_TIMEOUT_MS = 10_000;

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
            // swallow timeout/abort — handled in the post-loop await below
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

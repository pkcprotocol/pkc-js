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

    // Single abort signal feeds both findProviders and the topic-subscriber wait.
    const abortController = new AbortController();
    const combinedSignal = options?.signal ? AbortSignal.any([options.signal, abortController.signal]) : abortController.signal;

    // Event-based watcher for a peer subscribing to our topic on gossipsub.
    // Started immediately so we don't miss subscription-change events that fire during the dial loop.
    // When it resolves, abort findProviders so the loop exits cleanly.
    const subscriberAppearedPromise = waitForTopicSubscriber({
        helia,
        topic: pubsubTopic,
        timeoutMs: TOPIC_SUBSCRIBER_WAIT_TIMEOUT_MS,
        abortSignal: combinedSignal
    });
    subscriberAppearedPromise.then(
        () => {
            if (!abortController.signal.aborted) {
                log.trace("Aborting findProviders iterator - gossipsub subscription-change observed for topic", pubsubTopic);
                abortController.abort();
            }
        },
        () => {
            // swallow timeout/abort — handled in the post-loop await below
        }
    );

    try {
        const findProvidersLabel = `findProviders:${pubsubTopic}`;
        console.time(findProvidersLabel);
        for await (const peer of helia.libp2p.contentRouting.findProviders(contentCid, { ...options, signal: combinedSignal })) {
            peersWithContent.push(peer as PeerInfo);
            try {
                const conn = await helia.libp2p.dial(peer.id, options); // no-op if already connected
                connectedPeersWithContent.push(conn);
                if (connectedPeersWithContent.length >= maxPeers) {
                    log.trace("Breaking findProviders loop after reaching maxPeers", maxPeers);
                    break;
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
        }
        console.timeEnd(findProvidersLabel);
    } catch (e) {
        // findProviders may throw the abort error we caused ourselves — that's fine, fall through.
        if (!abortController.signal.aborted) {
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

    log.trace("Connected to", connectedPeersWithContent.length, "peers", "for content", contentCid);

    if (connectedPeersWithContent.length === 0) {
        const error = new PKCError("ERR_FAILED_TO_DIAL_ANY_PEERS_PROVIDING_CID", {
            contentCid,
            peerDialToError,
            peersWithContent,
            options,
            ...getHeliaDebugContext(helia)
        });
        log.error(error);
        throw error;
    }

    // Post-loop graft wait: if findProviders exhausted or maxPeers was reached before
    // any subscription-change event arrived, wait now so the immediately-following IPNS
    // resolve doesn't walk an empty subscriber list and throw RecordNotFoundError.
    try {
        await subscriberAppearedPromise;
    } catch (graftErr) {
        log.trace("gossipsub subscription-change did not arrive within timeout after warmup; resolver may still fall back", graftErr);
        // best-effort — don't surface as a warmup failure, let the resolver attempt anyway.
    }

    return connectedPeersWithContent;
}

import type { HeliaWithLibp2pPubsub } from "./types.js";
import type { PeerId, PeerInfo } from "@libp2p/interface";
import { CID } from "multiformats/cid";
import Logger from "@pkc/pkc-logger";
import { PlebbitError } from "../plebbit-error.js";
import { pubsubTopicToDhtKeyCid } from "../util.js";

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
    // TODO need to check if this hangs or not
    const contentCid = pubsubTopicToDhtKeyCid(pubsubTopic);
    const peersWithContent: PeerInfo[] = [];
    const connectedPeersWithContent: Awaited<ReturnType<typeof helia.libp2p.dial>>[] = [];
    const peerDialToError: Record<string, Error> = {};

    // Create an abort controller to handle hanging findProviders
    const abortController = new AbortController();
    const combinedSignal = options?.signal ? AbortSignal.any([options.signal, abortController.signal]) : abortController.signal;

    let shouldStop = false;
    // Set up periodic check for pubsub subscribers
    const checkInterval = setInterval(() => {
        if (helia.libp2p.services.pubsub.getSubscribers(pubsubTopic).length > 0 && !abortController.signal.aborted) {
            log.trace("Aborting findProviders iterator - found pubsub subscribers for topic", pubsubTopic);
            abortController.abort();
            shouldStop = true;
        }
    }, 100); // Check every 100ms

    try {
        const findProvidersLabel = `findProviders:${pubsubTopic}`;
        console.time(findProvidersLabel);
        for await (const peer of helia.libp2p.contentRouting.findProviders(contentCid, { ...options, signal: combinedSignal })) {
            if (shouldStop) {
                log.trace("Breaking findProviders loop due to shouldStop flag (pubsub subscribers found)");
                break;
            }
            peersWithContent.push(peer as PeerInfo);
            try {
                const conn = await helia.libp2p.dial(peer.id, options); // will be a no-op if we're already connected
                // if it succeeds, means we can connect to this peer

                connectedPeersWithContent.push(conn);
                if (helia.libp2p.services.pubsub.getSubscribers(pubsubTopic).length > 0) {
                    shouldStop = true;
                    log.trace("Breaking findProviders loop after successful dial and finding pubsub subscribers");
                    break;
                }
                if (connectedPeersWithContent.length >= maxPeers) {
                    log.trace("Breaking findProviders loop after reaching maxPeers", maxPeers);
                    shouldStop = true;
                    break;
                }
            } catch (e) {
                peerDialToError[peer.id.toString()] = e as Error;
                log.trace("Failed to dial IPNS-Over-Pubsub peer", peer.id.toString(), "Due to error", e);
            }
        }
        console.timeEnd(findProvidersLabel);
    } catch (e) {
        (e as PlebbitError).details = {
            ...(e as PlebbitError).details,
            contentCid,
            options,
            maxPeersBeforeWeStopLookingForProviders: maxPeers,
            connectedPeersWithContent,
            peersWithContent,
            peerDialToError
        };
        throw e;
    } finally {
        clearInterval(checkInterval);
    }

    log.trace("Connected to", connectedPeersWithContent.length, "peers", "for content", contentCid);
    if (connectedPeersWithContent.length === 0) {
        const error = new PlebbitError("ERR_FAILED_TO_DIAL_ANY_PEERS_PROVIDING_CID", {
            contentCid,
            peerDialToError,
            peersWithContent,
            options
        });
        log.error(error);
        throw error;
    } else return connectedPeersWithContent;
}

export async function waitForTopicPeers(helia: HeliaWithLibp2pPubsub, topic: string, minPeers = 1, timeoutMs = 10000): Promise<PeerId[]> {
    // after connecting to peers, we need to get the peers from the pubsub service
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
        const subscribers = helia.libp2p.services.pubsub.getSubscribers(topic);
        if (subscribers.length >= minPeers) {
            return subscribers;
        }

        // Wait 100ms before checking again
        await new Promise((resolve) => setTimeout(resolve, 100));
    }

    throw new PlebbitError("ERR_TIMEOUT_WAITING_FOR_PUBSUB_TOPIC_PEERS", {
        topic,
        minPeers,
        timeoutMs
    });
}

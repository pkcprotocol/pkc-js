import type { HeliaWithLibp2pPubsub } from "./types.js";
import type { PeerId } from "@libp2p/interface";
import Logger from "../logger.js";
export declare function connectToPubsubPeers({ helia, pubsubTopic, maxPeers, options, log }: {
    helia: HeliaWithLibp2pPubsub;
    pubsubTopic: string;
    maxPeers: number;
    log: Logger;
    options?: {
        signal?: AbortSignal;
    };
}): Promise<Awaited<ReturnType<typeof helia.libp2p.dial>>[]>;
export declare function waitForTopicPeers(helia: HeliaWithLibp2pPubsub, topic: string, minPeers?: number, timeoutMs?: number): Promise<PeerId[]>;

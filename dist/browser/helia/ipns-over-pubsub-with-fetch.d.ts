import { GetOptions as ipnsGetOptions, IPNSRouting, PutOptions } from "@helia/ipns/routing";
import type { Fetch } from "@libp2p/fetch";
import { peerIdFromString } from "@libp2p/peer-id";
import type { HeliaWithLibp2pPubsub } from "./types.js";
export type PKCIpnsGetOptions = ipnsGetOptions & {
    ipnsName: string;
};
type PeerId = ReturnType<typeof peerIdFromString>;
export declare class IpnsFetchRouter implements IPNSRouting {
    fetchedIpnsRecordBefore: Record<string, boolean>;
    _helia: HeliaWithLibp2pPubsub;
    _fetchService: Fetch;
    constructor(helia: HeliaWithLibp2pPubsub);
    put(routingKey: Uint8Array, marshaledRecord: Uint8Array, options?: PutOptions): Promise<void>;
    private _fetchFromPeer;
    _handleFetchingFromSubscribedPubsubPeers({ routingKey, topic, pubsubSubscribers, options }: {
        routingKey: Uint8Array;
        topic: string;
        pubsubSubscribers: PeerId[];
        options: PKCIpnsGetOptions & {
            signal: AbortSignal;
            abortController: AbortController;
        };
    }): Promise<Uint8Array>;
    _handleFetchingFromProviders({ routingKey, topic, options }: {
        routingKey: Uint8Array;
        topic: string;
        options: PKCIpnsGetOptions & {
            signal: AbortSignal;
            abortController: AbortController;
        };
    }): Promise<Uint8Array>;
    get(routingKey: Uint8Array, options: PKCIpnsGetOptions): Promise<Uint8Array>;
}
export declare function createIpnsFetchRouter(helia: HeliaWithLibp2pPubsub): IPNSRouting;
export {};

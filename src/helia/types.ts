import type { createHelia } from "helia";
import type { KuboRpcClient } from "../types.js";
import type { PubsubRoutingComponents } from "@helia/ipns/routing";
import type { GossipSub } from "@libp2p/gossipsub";
import type { Fetch } from "@libp2p/fetch";

export interface HeliaWithKuboRpcClientFunctions extends Pick<NonNullable<KuboRpcClient["_client"]>, "add" | "cat" | "pubsub" | "stop"> {
    add: KuboRpcClient["_client"]["add"];
    name: Pick<KuboRpcClient["_client"]["name"], "resolve">;
    // cat accepts one extra option on top of kubo-rpc-client's: the IPNS-over-pubsub record
    // topic of the community whose CID is being fetched, used to scope bitswap session seed
    // peers to that community's subscribers (issue #202). Kubo-rpc-client callers never pass it.
    // Method syntax (not an arrow-function property) so the implementation's narrower string
    // ipfsPath stays assignable via bivariant parameter checking, same as the original Pick.
    cat(
        ipfsPath: Parameters<KuboRpcClient["_client"]["cat"]>[0],
        options?: Parameters<KuboRpcClient["_client"]["cat"]>[1] & { bitswapSessionSeedScopeIpnsPubsubTopic?: string }
    ): ReturnType<KuboRpcClient["_client"]["cat"]>;
    pubsub: KuboRpcClient["_client"]["pubsub"];
    stop: KuboRpcClient["_client"]["stop"];
}

type baseHelia = Awaited<ReturnType<typeof createHelia>>;

// `getMeshPeers` is on the @libp2p/gossipsub concrete class but the package's public `GossipSub`
// interface omits it (it lives in the non-exported `./gossipsub` subpath). We use it for the
// publish gate, so add it to the typed shape here rather than casting at every call site.
type GossipSubWithMeshPeers = GossipSub & { getMeshPeers(topic: string): string[] };

export interface HeliaWithLibp2pPubsub extends baseHelia {
    libp2p: baseHelia["libp2p"] & {
        services: baseHelia["libp2p"]["services"] & {
            pubsub: PubsubRoutingComponents["libp2p"]["services"]["pubsub"] & GossipSubWithMeshPeers;
            // The libp2p fetch service (`/libp2p/fetch/0.0.1`) is configured in helia-for-pkc.ts
            // (`fetch: libp2pFetch()`) and powers @helia/ipns's pubsub fast-path. We call it
            // directly to fetch IPNS records from known providers/subscribers, so type it here
            // rather than casting at the call site.
            fetch: Fetch;
        };
    };
}

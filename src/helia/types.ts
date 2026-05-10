import type { createHelia } from "helia";
import type { KuboRpcClient } from "../types.js";
import type { PubsubRoutingComponents } from "@helia/ipns/routing";
import type { GossipSub } from "@libp2p/gossipsub";

export interface HeliaWithKuboRpcClientFunctions extends Pick<NonNullable<KuboRpcClient["_client"]>, "add" | "cat" | "pubsub" | "stop"> {
    add: KuboRpcClient["_client"]["add"];
    name: Pick<KuboRpcClient["_client"]["name"], "resolve">;
    cat: KuboRpcClient["_client"]["cat"];
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
        };
    };
}

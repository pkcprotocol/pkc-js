import type { createHeliaLight } from "helia";
import type { HeliaWithLibp2p } from "@helia/libp2p";
import type { ServiceMap } from "@libp2p/interface";
import type { KuboRpcClient } from "../types.js";
import type { PubsubRoutingComponents } from "@helia/ipns";
import type { GossipSub } from "@libp2p/gossipsub";
import type { Fetch } from "@libp2p/fetch";
import type { Identify } from "@libp2p/identify";
import type { IPNSRecord } from "ipns";

// A validated IPNS record newer than the locally held one just landed in the routing-layer cache
// for `pubsubTopic` — via a gossipsub push (handleRecord), the direct-fetch cache write, or a
// fallback router.get() fetch. All three converge on the pubsub router's localStore.put, which is
// where these arrivals are observed (issue #308).
export interface IpnsRecordArrival {
    pubsubTopic: string;
    record: IPNSRecord;
}
export type IpnsRecordArrivalListener = (arrival: IpnsRecordArrival) => void;

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
    // Push signal for IPNS names (issue #308), pkc-only with no kubo-rpc-client equivalent: the
    // community update loop subscribes per IPNS pubsub topic to react to pushed records instead
    // of polling name.resolve every second. Listeners fire AFTER the record is validated and
    // persisted in the routing-layer cache, so a resolve issued from a listener observes it.
    ipnsRecordArrivals: {
        subscribe(args: { pubsubTopic: string; listener: IpnsRecordArrivalListener }): void;
        unsubscribe(args: { pubsubTopic: string; listener: IpnsRecordArrivalListener }): void;
    };
    // Test-only override of BITSWAP_SESSION_STALLED_GET_FAILOVER_MS, read by cat() at each block
    // get. The issue #189 guard test (at most one routing query per DAG) sets it beyond its own
    // timeout: on slow CI runners a block can legitimately stall, and the failover's broadcast
    // want runs a routing query the test would miscount as a per-block leak. Production code
    // never sets it.
    _bitswapSessionStalledGetFailoverMs?: number;
}

// `getMeshPeers` is on the @libp2p/gossipsub concrete class but the package's public `GossipSub`
// interface omits it (it lives in the non-exported `./gossipsub` subpath). We use it for the
// publish gate, so add it to the typed shape here rather than casting at every call site.
type GossipSubWithMeshPeers = GossipSub & { getMeshPeers(topic: string): string[] };

// The libp2p services helia-for-pkc.ts actually configures. helia's own composition types the
// node with DefaultLibp2pServices (dht, relay, upnp, autoNAT, keychain, ...) but our `services`
// map fully replaces that default, so those would type-check and be undefined at runtime. The
// ServiceMap index signature covers the per-router `delegatedRoutingN` entries and anything a
// caller adds via libp2pOptions.services, as `unknown` (i.e. narrow before use).
export interface PkcLibp2pServices extends ServiceMap {
    identify: Identify;
    pubsub: PubsubRoutingComponents["libp2p"]["services"]["pubsub"] & GossipSubWithMeshPeers;
    // The libp2p fetch service (`/libp2p/fetch/0.0.1`) is configured in helia-for-pkc.ts
    // (`fetch: libp2pFetch()`) and powers @helia/ipns's pubsub fast-path. We call it
    // directly to fetch IPNS records from known providers/subscribers, so type it here
    // rather than casting at the call site.
    fetch: Fetch;
}

// createHeliaLight + withLibp2p (+ withBitswap, which adds no members): the composition
// helia-for-pkc.ts builds, without helia's HTTP components.
export type HeliaWithLibp2pPubsub = ReturnType<typeof createHeliaLight> & HeliaWithLibp2p<PkcLibp2pServices>;

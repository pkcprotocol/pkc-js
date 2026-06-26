import { describe, it, expect, beforeEach } from "vitest";
import {
    isBrowserDialableAddr,
    reprovideConnectionCidsIfBrowserAddrsChanged
} from "../../../dist/node/runtime/node/community/local-community/reprovide-on-address-change.js";
import type {
    AddressChangeReprovidable,
    ReprovideKuboRpcClient
} from "../../../dist/node/runtime/node/community/local-community/reprovide-on-address-change.js";

// Pure unit test (no kubo / no PKC). Pins down the publisher-side behaviour that keeps browsers able to
// connect: when the node's browser-dialable (WSS/WebRTC) self-addresses rotate, the connection-critical
// CIDs must be re-provided so the address-rewriter proxy re-injects the fresh addresses into the HTTP
// routers. A pure-TCP/quic address change must NOT trigger a re-provide (browsers can't dial those).

// Three valid CIDv1 strings standing in for updateCid / pubsubTopicRoutingCid / ipnsPubsubTopicRoutingCid.
const UPDATE_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const PUBSUB_ROUTING_CID = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";
const IPNS_PUBSUB_ROUTING_CID = "bafybeiczsscdsbs7ffqz55asqdf3smv6klcw3gofszvwlyarci47bgf354";

const PEER_ID = "12D3KooWBy7Vn1ofw2Rou8PMVuTpfNUMfQjcGZb6T8aZ3X2D6oQg";
const TCP_ADDR = `/ip4/1.2.3.4/tcp/4001`;
const WSS_ADDR_A = `/dns4/example-a.libp2p.direct/tcp/443/tls/ws`;
const WSS_ADDR_B = `/dns4/example-b.libp2p.direct/tcp/443/tls/ws`;
const WEBRTC_ADDR = `/ip4/1.2.3.4/udp/4001/webrtc-direct/certhash/uEiAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`;

function makeClient(initialIdAddrs: string[]): {
    client: ReprovideKuboRpcClient;
    provideCalls: string[];
    setIdAddrs: (a: string[]) => void;
} {
    let idAddrs = initialIdAddrs;
    const provideCalls: string[] = [];
    const client: ReprovideKuboRpcClient = {
        id: async () => ({
            id: { toString: () => PEER_ID },
            addresses: idAddrs.map((a) => ({ toString: () => `${a}/p2p/${PEER_ID}` }))
        }),
        swarm: {
            addrs: async () => []
        },
        routing: {
            provide: async function* (cid) {
                provideCalls.push(cid.toString());
                // yield nothing
            }
        }
    };
    return { client, provideCalls, setIdAddrs: (a: string[]) => (idAddrs = a) };
}

function makeCommunity(client: ReprovideKuboRpcClient): AddressChangeReprovidable {
    return {
        address: "test.community",
        updateCid: UPDATE_CID,
        pubsubTopicRoutingCid: PUBSUB_ROUTING_CID,
        ipnsPubsubTopicRoutingCid: IPNS_PUBSUB_ROUTING_CID,
        _lastProvidedBrowserDialableSelfAddrs: undefined,
        _clientsManager: {
            getDefaultKuboRpcClient: () => ({ _client: client })
        }
    };
}

describe("isBrowserDialableAddr", () => {
    it("keeps WSS and WebRTC addresses", () => {
        expect(isBrowserDialableAddr(WSS_ADDR_A)).toBe(true);
        expect(isBrowserDialableAddr(WEBRTC_ADDR)).toBe(true);
    });
    it("rejects plain TCP/QUIC addresses a browser cannot dial", () => {
        expect(isBrowserDialableAddr(TCP_ADDR)).toBe(false);
        expect(isBrowserDialableAddr("/ip4/1.2.3.4/udp/4001/quic-v1")).toBe(false);
    });
});

describe("reprovideConnectionCidsIfBrowserAddrsChanged", () => {
    let client: ReprovideKuboRpcClient;
    let provideCalls: string[];
    let setIdAddrs: (a: string[]) => void;
    let community: AddressChangeReprovidable;

    beforeEach(() => {
        ({ client, provideCalls, setIdAddrs } = makeClient([TCP_ADDR, WSS_ADDR_A]));
        community = makeCommunity(client);
    });

    it("establishes a baseline on the first observation without re-providing", async () => {
        const res = await reprovideConnectionCidsIfBrowserAddrsChanged(community);
        expect(res.reprovided).toBe(false);
        expect(provideCalls).toEqual([]);
        expect(community._lastProvidedBrowserDialableSelfAddrs).toEqual([WSS_ADDR_A]);
    });

    it("does not re-provide when the browser-dialable addresses are unchanged", async () => {
        await reprovideConnectionCidsIfBrowserAddrsChanged(community); // baseline
        const res = await reprovideConnectionCidsIfBrowserAddrsChanged(community);
        expect(res.reprovided).toBe(false);
        expect(provideCalls).toEqual([]);
    });

    it("re-provides the connection-critical CIDs when a WSS address rotates", async () => {
        await reprovideConnectionCidsIfBrowserAddrsChanged(community); // baseline with WSS_ADDR_A
        setIdAddrs([TCP_ADDR, WSS_ADDR_B]); // AutoTLS WSS rotated
        const res = await reprovideConnectionCidsIfBrowserAddrsChanged(community);
        expect(res.reprovided).toBe(true);
        expect(provideCalls).toEqual([UPDATE_CID, PUBSUB_ROUTING_CID, IPNS_PUBSUB_ROUTING_CID]);
        expect(community._lastProvidedBrowserDialableSelfAddrs).toEqual([WSS_ADDR_B]);
    });

    it("re-provides when a WebRTC address appears", async () => {
        await reprovideConnectionCidsIfBrowserAddrsChanged(community); // baseline
        setIdAddrs([TCP_ADDR, WSS_ADDR_A, WEBRTC_ADDR]);
        const res = await reprovideConnectionCidsIfBrowserAddrsChanged(community);
        expect(res.reprovided).toBe(true);
        expect(provideCalls).toEqual([UPDATE_CID, PUBSUB_ROUTING_CID, IPNS_PUBSUB_ROUTING_CID]);
    });

    it("does NOT re-provide when only a non-browser-dialable (TCP) address changes", async () => {
        await reprovideConnectionCidsIfBrowserAddrsChanged(community); // baseline
        setIdAddrs(["/ip4/9.9.9.9/tcp/4001", WSS_ADDR_A]); // TCP changed, WSS same
        const res = await reprovideConnectionCidsIfBrowserAddrsChanged(community);
        expect(res.reprovided).toBe(false);
        expect(provideCalls).toEqual([]);
    });

    it("skips CIDs that are not yet known (e.g. updateCid before first publish)", async () => {
        community.updateCid = undefined;
        await reprovideConnectionCidsIfBrowserAddrsChanged(community); // baseline
        setIdAddrs([TCP_ADDR, WSS_ADDR_B]);
        const res = await reprovideConnectionCidsIfBrowserAddrsChanged(community);
        expect(res.reprovided).toBe(true);
        expect(provideCalls).toEqual([PUBSUB_ROUTING_CID, IPNS_PUBSUB_ROUTING_CID]);
    });

    it("force re-provides even when addresses are unchanged", async () => {
        await reprovideConnectionCidsIfBrowserAddrsChanged(community); // baseline
        const res = await reprovideConnectionCidsIfBrowserAddrsChanged(community, true);
        expect(res.reprovided).toBe(true);
        expect(provideCalls).toEqual([UPDATE_CID, PUBSUB_ROUTING_CID, IPNS_PUBSUB_ROUTING_CID]);
    });
});

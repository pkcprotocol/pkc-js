import { describe, it, expect, beforeEach } from "vitest";
import {
    isBrowserDialableAddr,
    normalizeSelfAddrsForProvider,
    reprovideConnectionCidsIfBrowserAddrsChanged
} from "../../../dist/node/runtime/node/community/local-community/reprovide-on-address-change.js";
import type {
    AddressChangeReprovidable,
    ReprovideKuboRpcClient
} from "../../../dist/node/runtime/node/community/local-community/reprovide-on-address-change.js";

// Pure unit test (no kubo / no PKC). Pins down the publisher-side behaviour that keeps browsers able to
// connect: when the node's browser-dialable (WSS/WebRTC) self-addresses rotate, the connection-critical
// CIDs must be re-provided so the HTTP routers carry the fresh addresses. A pure-TCP/quic address change
// must NOT trigger a re-provide (browsers can't dial those).
//
// The connection-critical CIDs are the two *never-changing* pubsub-topic routing CIDs (challenge topic +
// ipns-over-pubsub topic). updateCid is intentionally NOT here: it rotates every <=15 min and is re-provided
// with fresh addresses on every publish, so it is already self-healing.

// Two valid CIDv1 strings standing in for pubsubTopicRoutingCid / ipnsPubsubTopicRoutingCid.
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

    it("re-provides the pubsub routing CIDs when a WSS address rotates", async () => {
        await reprovideConnectionCidsIfBrowserAddrsChanged(community); // baseline with WSS_ADDR_A
        setIdAddrs([TCP_ADDR, WSS_ADDR_B]); // AutoTLS WSS rotated
        const res = await reprovideConnectionCidsIfBrowserAddrsChanged(community);
        expect(res.reprovided).toBe(true);
        expect(provideCalls).toEqual([PUBSUB_ROUTING_CID, IPNS_PUBSUB_ROUTING_CID]);
        expect(community._lastProvidedBrowserDialableSelfAddrs).toEqual([WSS_ADDR_B]);
    });

    it("re-provides when a WebRTC address appears", async () => {
        await reprovideConnectionCidsIfBrowserAddrsChanged(community); // baseline
        setIdAddrs([TCP_ADDR, WSS_ADDR_A, WEBRTC_ADDR]);
        const res = await reprovideConnectionCidsIfBrowserAddrsChanged(community);
        expect(res.reprovided).toBe(true);
        expect(provideCalls).toEqual([PUBSUB_ROUTING_CID, IPNS_PUBSUB_ROUTING_CID]);
    });

    it("does NOT re-provide when only a non-browser-dialable (TCP) address changes", async () => {
        await reprovideConnectionCidsIfBrowserAddrsChanged(community); // baseline
        setIdAddrs(["/ip4/9.9.9.9/tcp/4001", WSS_ADDR_A]); // TCP changed, WSS same
        const res = await reprovideConnectionCidsIfBrowserAddrsChanged(community);
        expect(res.reprovided).toBe(false);
        expect(provideCalls).toEqual([]);
    });

    it("skips routing CIDs that are not yet known", async () => {
        community.pubsubTopicRoutingCid = undefined;
        await reprovideConnectionCidsIfBrowserAddrsChanged(community); // baseline
        setIdAddrs([TCP_ADDR, WSS_ADDR_B]);
        const res = await reprovideConnectionCidsIfBrowserAddrsChanged(community);
        expect(res.reprovided).toBe(true);
        expect(provideCalls).toEqual([IPNS_PUBSUB_ROUTING_CID]);
    });
});

// Moved here from the deleted test/node/kubo-address-rewriter.unit.test.ts: the helper used to live on
// the address rewriter proxy, and now lives next to its only remaining caller.
describe("normalizeSelfAddrsForProvider", () => {
    const NORMALIZE_PEER_ID = "12D3KooWLNoZZe8n3UtsvRUcRPa4gmWLZsb5mF9Auns9NBhKXV9x";
    const WSS_BASE = "/dns4/89-36-231-48.k51qzi5uqu5dk3d0w8k7950ie0sbol9jr8i1fd3dzflsm2n0pvtypbd2ydmxtz.libp2p.direct/tcp/4001/tls/ws";
    const WEBRTC_BASE = "/ip4/89.36.231.48/udp/4001/webrtc-direct/certhash/uEiCanSXSJpjWxic9SBulYAKbexD5MitQemB-RUJJkC2BDw";

    it("strips the trailing /p2p/<peerId> suffix", () => {
        expect(normalizeSelfAddrsForProvider([`${WSS_BASE}/p2p/${NORMALIZE_PEER_ID}`], NORMALIZE_PEER_ID)).toEqual([WSS_BASE]);
        expect(normalizeSelfAddrsForProvider([`${WEBRTC_BASE}/p2p/${NORMALIZE_PEER_ID}`], NORMALIZE_PEER_ID)).toEqual([WEBRTC_BASE]);
    });

    it("dedupes the `ipfs id` (/p2p-suffixed) and `swarm addrs` (bare) forms into one", () => {
        // mirrors the real union: id() returns /p2p-suffixed, swarm.addrs() returns bare
        const raw = [`${WSS_BASE}/p2p/${NORMALIZE_PEER_ID}`, `${WEBRTC_BASE}/p2p/${NORMALIZE_PEER_ID}`, WSS_BASE, WEBRTC_BASE];
        expect(normalizeSelfAddrsForProvider(raw, NORMALIZE_PEER_ID)).toEqual([WSS_BASE, WEBRTC_BASE]);
    });

    it("leaves transport-only addrs (no /p2p) untouched", () => {
        const raw = ["/ip4/89.36.231.48/tcp/4001", "/ip4/89.36.231.48/udp/4001/quic-v1"];
        expect(normalizeSelfAddrsForProvider(raw, NORMALIZE_PEER_ID)).toEqual(raw);
    });

    it("only strips this node's own trailing peer id, not a different one", () => {
        const otherPeer = "12D3KooWRPuT67gVCnaoEMt6w3DuvtkusUz2EdXYuiUUpEkm88nC";
        const addr = `${WSS_BASE}/p2p/${otherPeer}`;
        expect(normalizeSelfAddrsForProvider([addr], NORMALIZE_PEER_ID)).toEqual([addr]);
    });

    it("returns an empty array for empty input", () => {
        expect(normalizeSelfAddrsForProvider([], NORMALIZE_PEER_ID)).toEqual([]);
    });
});

import { describe, it, expect } from "vitest";
import { normalizeSelfAddrsForProvider } from "../../dist/node/runtime/node/addresses-rewriter-proxy-server.js";

const PEER_ID = "12D3KooWLNoZZe8n3UtsvRUcRPa4gmWLZsb5mF9Auns9NBhKXV9x";
const WSS_BASE = "/dns4/89-36-231-48.k51qzi5uqu5dk3d0w8k7950ie0sbol9jr8i1fd3dzflsm2n0pvtypbd2ydmxtz.libp2p.direct/tcp/4001/tls/ws";
const WEBRTC_BASE = "/ip4/89.36.231.48/udp/4001/webrtc-direct/certhash/uEiCanSXSJpjWxic9SBulYAKbexD5MitQemB-RUJJkC2BDw";

describe("normalizeSelfAddrsForProvider", () => {
    it("strips the trailing /p2p/<peerId> suffix", () => {
        expect(normalizeSelfAddrsForProvider([`${WSS_BASE}/p2p/${PEER_ID}`], PEER_ID)).toEqual([WSS_BASE]);
        expect(normalizeSelfAddrsForProvider([`${WEBRTC_BASE}/p2p/${PEER_ID}`], PEER_ID)).toEqual([WEBRTC_BASE]);
    });

    it("dedupes the `ipfs id` (/p2p-suffixed) and `swarm addrs` (bare) forms into one", () => {
        // mirrors the real union: id() returns /p2p-suffixed, swarm.addrs() returns bare
        const raw = [`${WSS_BASE}/p2p/${PEER_ID}`, `${WEBRTC_BASE}/p2p/${PEER_ID}`, WSS_BASE, WEBRTC_BASE];
        expect(normalizeSelfAddrsForProvider(raw, PEER_ID)).toEqual([WSS_BASE, WEBRTC_BASE]);
    });

    it("leaves transport-only addrs (no /p2p) untouched", () => {
        const raw = ["/ip4/89.36.231.48/tcp/4001", "/ip4/89.36.231.48/udp/4001/quic-v1"];
        expect(normalizeSelfAddrsForProvider(raw, PEER_ID)).toEqual(raw);
    });

    it("only strips this node's own trailing peer id, not a different one", () => {
        const otherPeer = "12D3KooWRPuT67gVCnaoEMt6w3DuvtkusUz2EdXYuiUUpEkm88nC";
        const addr = `${WSS_BASE}/p2p/${otherPeer}`;
        expect(normalizeSelfAddrsForProvider([addr], PEER_ID)).toEqual([addr]);
    });

    it("returns an empty array for empty input", () => {
        expect(normalizeSelfAddrsForProvider([], PEER_ID)).toEqual([]);
    });
});

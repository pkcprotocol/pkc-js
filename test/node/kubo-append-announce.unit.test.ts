import { describe, it, expect } from "vitest";
import { selectBrowserDialableAddrsToAppendAnnounce } from "../../dist/node/runtime/node/setup-kubo-http-routers.js";

// Unit test for the kubo#11369 workaround: from `ipfs id` addresses, pick the node's own
// public browser-dialable transports (webrtc-direct/certhash + AutoTLS /tls/ws) that kubo
// withholds from provider records, so pkc-js can force-announce them via AppendAnnounce.
const PEER = "12D3KooWGu4BNg4SqXRgDdnL5tiqUAD7aaMNTxSgnp8sfAo718Tt";

describe("selectBrowserDialableAddrsToAppendAnnounce (kubo#11369 workaround)", () => {
    it("selects the node's public webrtc-direct/certhash and AutoTLS /tls/ws, strips /p2p, dedupes", () => {
        const wss = `/dns4/89-36-231-48.k51qzi5uqu5diszlj48aqp4kldhv4m84b9cnfy9cwf1lgz3yobt98djpepn4ab.libp2p.direct/tcp/4001/tls/ws`;
        const webrtc = `/ip4/89.36.231.48/udp/4001/webrtc-direct/certhash/uEiCGYtKZoGvQeZsFO4gvYJA_yaO0M-VpdDPOlt5YjFNhSw`;
        const idAddrs = [
            `${wss}/p2p/${PEER}`,
            `${webrtc}/p2p/${PEER}`,
            `${webrtc}/p2p/${PEER}`, // duplicate -> deduped
            `/ip4/89.36.231.48/tcp/4001/p2p/${PEER}`, // not browser-dialable
            `/ip4/89.36.231.48/udp/4001/quic-v1/p2p/${PEER}`, // not browser-dialable
            `/ip4/89.36.231.48/udp/4001/quic-v1/webtransport/certhash/uEiA/certhash/uEiB/p2p/${PEER}` // already announced by kubo
        ];
        const r = selectBrowserDialableAddrsToAppendAnnounce(idAddrs);
        expect(r.webrtcDirect).to.deep.equal([webrtc]);
        expect(r.wss).to.deep.equal([wss]);
        expect(r.all).to.deep.equal([webrtc, wss]); // webrtc-direct first, then wss; deduped; tcp/quic/webtransport excluded
    });

    it("excludes private / loopback / link-local / CGNAT addresses", () => {
        const r = selectBrowserDialableAddrsToAppendAnnounce([
            `/ip4/192.168.0.10/udp/4001/webrtc-direct/certhash/uEiPRIV`,
            `/ip4/10.1.2.3/udp/4001/webrtc-direct/certhash/uEiPRIV`,
            `/ip4/172.17.0.1/udp/4001/webrtc-direct/certhash/uEiPRIV`,
            `/ip4/127.0.0.1/udp/4001/webrtc-direct/certhash/uEiLOOP`,
            `/ip4/169.254.1.2/udp/4001/webrtc-direct/certhash/uEiLINK`,
            `/ip4/100.100.0.1/udp/4001/webrtc-direct/certhash/uEiCGNAT`,
            `/ip6/::1/udp/4001/webrtc-direct/certhash/uEiLOOP6`
        ]);
        expect(r.all).to.deep.equal([]);
    });

    it("excludes webrtc-direct without a certhash (undialable from a browser)", () => {
        const r = selectBrowserDialableAddrsToAppendAnnounce([`/ip4/89.36.231.48/udp/4001/webrtc-direct`]);
        expect(r.all).to.deep.equal([]);
    });

    it("recognizes the IP+SNI AutoTLS WSS form via the libp2p.direct domain", () => {
        const addr = `/ip4/194.11.226.35/tcp/4001/tls/sni/peer.libp2p.direct/ws`;
        const r = selectBrowserDialableAddrsToAppendAnnounce([`${addr}/p2p/${PEER}`]);
        expect(r.wss).to.deep.equal([addr]);
    });

    it("does not classify a non-/ws libp2p.direct address as WSS (would falsely satisfy wssPresent)", () => {
        // Only `.../tls/ws` and `.../tls/sni/<*.libp2p.direct>/ws` are browser-dialable WSS. A
        // libp2p.direct address that isn't a websocket must not be picked, or it would prematurely
        // stop the retry loop before the real AutoTLS /ws address lands.
        const r = selectBrowserDialableAddrsToAppendAnnounce([
            `/dns4/peer.libp2p.direct/tcp/4001/p2p/${PEER}`,
            `/dnsaddr/peer.libp2p.direct/p2p/${PEER}`
        ]);
        expect(r.wss).to.deep.equal([]);
        expect(r.all).to.deep.equal([]);
    });

    it("returns empty when there are no browser-dialable public addresses", () => {
        const r = selectBrowserDialableAddrsToAppendAnnounce([
            `/ip4/89.36.231.48/tcp/4001`,
            `/ip4/89.36.231.48/udp/4001/quic-v1`,
            `/ip4/89.36.231.48/udp/4001/quic-v1/webtransport/certhash/uEiA/certhash/uEiB`
        ]);
        expect(r.all).to.deep.equal([]);
    });
});

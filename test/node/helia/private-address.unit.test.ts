import { describe, it, expect } from "vitest";
import { multiaddr } from "@multiformats/multiaddr";
import { multiaddrIsPrivateOrLoopback } from "../../../dist/node/helia/util.js";

// Issue #475: providers whose dialable addrs are all private or loopback are dialed after public ones.
// These are the address shapes NAT'd seeders in VMs put in their router records (QEMU user-mode
// networking gives guests 10.0.2.15 and fec0::/10 site-local addrs), plus the public ones that must
// not be mistaken for private.
describe("multiaddrIsPrivateOrLoopback", () => {
    const privateAddrs = [
        "/ip4/127.0.0.1/udp/4001/quic-v1/webtransport",
        "/ip6/::1/udp/4001/quic-v1/webtransport",
        "/ip4/10.0.2.15/udp/4001/quic-v1/webtransport",
        "/ip4/10.66.85.7/udp/4001/quic-v1/webtransport",
        "/ip4/192.168.1.10/tcp/4001/ws",
        "/ip4/100.64.1.1/tcp/4001/ws",
        "/ip6/fec0::4ba:550:1228:cca/udp/4001/quic-v1/webtransport",
        "/ip6/fd00::1/udp/4001/quic-v1/webtransport",
        "/ip6/fe80::1/udp/4001/quic-v1/webtransport",
        "/dns4/localhost/tcp/4001/ws"
    ];
    const publicAddrs = [
        "/ip4/89.36.231.48/udp/443/quic-v1/webtransport",
        "/ip6/2a01:4f8::1/udp/4001/quic-v1/webtransport",
        "/dns4/seeder.example.com/tcp/443/tls/ws"
    ];

    for (const addr of privateAddrs)
        it(`treats ${addr} as private`, () => {
            expect(multiaddrIsPrivateOrLoopback(multiaddr(addr))).to.equal(true);
        });

    for (const addr of publicAddrs)
        it(`treats ${addr} as public`, () => {
            expect(multiaddrIsPrivateOrLoopback(multiaddr(addr))).to.equal(false);
        });
});

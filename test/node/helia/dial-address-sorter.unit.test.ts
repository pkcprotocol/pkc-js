import { describe, it, expect, afterEach } from "vitest";
import { multiaddr } from "@multiformats/multiaddr";
import type { Address } from "@libp2p/interface";
import { pkcDialAddressSorter } from "../../../dist/node/helia/dial-address-sorter.js";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";

// libp2p dials a peer's addresses one at a time, with a 6 s limit per address and 10 s per dial. Some
// consumer networks drop IPv4 UDP to port 4001, so a WebTransport address on IPv4 UDP 4001 that sorts
// first costs a full per-address timeout before a working one is tried (pkc-js#475). The pkc sorter
// keeps libp2p's default order and only breaks ties between UDP addresses: UDP 443 first, then IPv6,
// then everything else.

const CERTHASH = "certhash/uEiAQk5I5LfDHFiqGeL85eF7IvNU3TL7KKSDv9ZN3oZRZjw";
const wt = (host: string, port: number) => `${host}/udp/${port}/quic-v1/webtransport/${CERTHASH}`;

const WSS = "/dns4/seeder.example.com/tcp/443/tls/ws";
const WT_IP4_4001 = wt("/ip4/1.2.3.4", 4001);
const WT_IP4_443 = wt("/ip4/1.2.3.4", 443);
const WT_IP6_4001 = wt("/ip6/2a01:4f8::1", 4001);
const WT_IP6_443 = wt("/ip6/2a01:4f8::1", 443);
const WEBRTC_DIRECT = `/ip4/1.2.3.4/udp/4001/webrtc-direct/${CERTHASH}`;
const RELAYED_WT = `${WT_IP6_443}/p2p/12D3KooWBy7Vn1ofw2Rou8PMVuTpfNUMfQjcGZb6T8aZ3X2D6oQg/p2p-circuit`;
const PRIVATE_WT_443 = wt("/ip4/192.168.1.10", 443);

const toAddress = (addr: string, isCertified = false): Address => ({ multiaddr: multiaddr(addr), isCertified });
const sortAddrs = (addrs: string[]) =>
    addrs
        .map((a) => toAddress(a))
        .sort(pkcDialAddressSorter)
        .map((a) => a.multiaddr.toString());

describe("pkcDialAddressSorter", () => {
    it("tries WebTransport on UDP 443, then IPv6, and leaves IPv4 UDP 4001 last", () => {
        expect(sortAddrs([WT_IP4_4001, WT_IP6_4001, WT_IP4_443, WT_IP6_443])).toEqual([WT_IP6_443, WT_IP4_443, WT_IP6_4001, WT_IP4_4001]);
    });

    it("keeps WSS ahead of every WebTransport address", () => {
        expect(sortAddrs([WT_IP6_443, WT_IP4_4001, WSS])).toEqual([WSS, WT_IP6_443, WT_IP4_4001]);
    });

    it("keeps libp2p's own rules ahead of the port preference", () => {
        // public before private, relayed last, both even when the private/relayed one is on UDP 443
        expect(sortAddrs([PRIVATE_WT_443, WT_IP4_4001])).toEqual([WT_IP4_4001, PRIVATE_WT_443]);
        expect(sortAddrs([RELAYED_WT, WT_IP4_4001])).toEqual([WT_IP4_4001, RELAYED_WT]);
    });

    it("keeps libp2p's transport order between different UDP transports", () => {
        // libp2p's reliableTransportsFirst puts WebRTC-direct before WebTransport; the port preference only
        // breaks ties inside one transport rank
        expect(sortAddrs([WT_IP4_443, WEBRTC_DIRECT])).toEqual([WEBRTC_DIRECT, WT_IP4_443]);
    });

    it("keeps certified addresses ahead, as libp2p's default sorter does", () => {
        const sorted = [toAddress(WT_IP4_443), toAddress(WT_IP4_4001, true)].sort(pkcDialAddressSorter);
        expect(sorted.map((a) => a.multiaddr.toString())).toEqual([WT_IP4_4001, WT_IP4_443]);
    });

    it("returns 0 for two addresses of equal preference", () => {
        expect(pkcDialAddressSorter(toAddress(WT_IP4_4001), toAddress(wt("/ip4/5.6.7.8", 4001)))).toBe(0);
    });
});

describe("pkcDialAddressSorter wiring into the libp2p-js helia client", () => {
    const clientsToStop: Libp2pJsClient[] = [];
    let keyCounter = 0;

    const getConnectionManager = (client: Libp2pJsClient) =>
        (client._mergedHeliaOptions?.libp2p as { connectionManager?: { addressSorter?: unknown } } | undefined)?.connectionManager;

    const createClient = (libp2pOptions: Record<string, unknown>) =>
        createLibp2pJsClientOrUseExistingOne({
            key: `dial-address-sorter-test-${keyCounter++}`,
            httpRoutersOptions: ["http://localhost:1"], // never reached; required only so setup doesn't throw
            libp2pOptions,
            heliaOptions: {}
        }) as Promise<Libp2pJsClient>;

    afterEach(async () => {
        while (clientsToStop.length) await clientsToStop.pop()!.heliaWithKuboRpcClientFunctions.stop();
    });

    it("sets the pkc sorter by default", async () => {
        const client = await createClient({});
        clientsToStop.push(client);
        expect(getConnectionManager(client)?.addressSorter).to.equal(pkcDialAddressSorter);
    });

    it("lets a caller replace it via libp2pOptions.connectionManager", async () => {
        const callerSorter = () => 0 as const;
        const client = await createClient({ connectionManager: { addressSorter: callerSorter } });
        clientsToStop.push(client);
        expect(getConnectionManager(client)?.addressSorter).to.equal(callerSorter);
    });
});

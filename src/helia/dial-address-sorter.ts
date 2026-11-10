import type { Address, AddressSorter } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";
import { circuitRelayAddressesLast, loopbackAddressLast, publicAddressesFirst, reliableTransportsFirst } from "@libp2p/utils";

// libp2p dials a peer's addresses one at a time, with a per-address timeout (6 s) inside a per-dial
// timeout (10 s). Some consumer networks drop IPv4 UDP to port 4001, so when a WebTransport address on
// IPv4 UDP 4001 sorts first the dial burns a whole per-address timeout before trying one that works
// (#475). This sorter keeps libp2p's default order (loopback last, public first, relayed last,
// certified first, then TCP > WSS > WS > WebRTC > WebRTC-direct > WebTransport) and only breaks the
// remaining ties between UDP addresses: UDP 443 first (the port networks have most reason to allow,
// since HTTP/3 uses it), then IPv6, then IPv4 on any other port.

function udpPreference(multiaddr: Multiaddr): number | undefined {
    const components = multiaddr.getComponents();
    const udp = components.find((component) => component.name === "udp");
    if (!udp) return undefined;
    if (udp.value === "443") return 0;
    const family = components[0]?.name;
    return family === "ip6" || family === "dns6" ? 1 : 2;
}

function certifiedAddressesFirst(a: Address, b: Address): -1 | 0 | 1 {
    if (a.isCertified && !b.isCertified) return -1;
    if (!a.isCertified && b.isCertified) return 1;
    return 0;
}

function isIp6(multiaddr: Multiaddr): boolean {
    const family = multiaddr.getComponents()[0]?.name;
    return family === "ip6" || family === "dns6";
}

function preferredUdpAddressesFirst(a: Multiaddr, b: Multiaddr): -1 | 0 | 1 {
    const preferenceA = udpPreference(a);
    const preferenceB = udpPreference(b);
    if (preferenceA === undefined || preferenceB === undefined) return 0;
    if (preferenceA !== preferenceB) return preferenceA < preferenceB ? -1 : 1;
    // same port class: IPv6 first, so a client on a network that filters IPv4 UDP still connects first try
    const ip6A = isIp6(a);
    const ip6B = isIp6(b);
    if (ip6A && !ip6B) return -1;
    if (!ip6A && ip6B) return 1;
    return 0;
}

export const pkcDialAddressSorter: AddressSorter = (a, b) =>
    loopbackAddressLast(a.multiaddr, b.multiaddr) ||
    publicAddressesFirst(a.multiaddr, b.multiaddr) ||
    circuitRelayAddressesLast(a.multiaddr, b.multiaddr) ||
    certifiedAddressesFirst(a, b) ||
    reliableTransportsFirst(a.multiaddr, b.multiaddr) ||
    preferredUdpAddressesFirst(a.multiaddr, b.multiaddr);

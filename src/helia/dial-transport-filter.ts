import type { ConnectionGater } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";

// By default pkc-js dials peers over WebSocket(/WSS), TCP and WebTransport. WebRTC dials are rejected:
// in the browser they add long, often-failing connection-establishment paths (STUN/ICE, SDP munging,
// certhash rotation) that slow down loads (#166). WebTransport is allowed (#475): it needs no
// certificate authority, so a seeder stays reachable from browsers when its WSS certificate does not
// (as in the 2026-10-31 AutoTLS outage). The browser build registers the transport; Node has none, so
// allowing it there changes nothing. Callers can override the gater via
// `libp2pJsClientsOptions[].libp2pOptions.connectionGater` (see createLibp2pJsClientOrUseExistingOne).
//
// These are multiaddr protocol/component names as reported by Multiaddr.getComponents():
//   - "webrtc"        => /webrtc          (browser-to-browser / relayed WebRTC)
//   - "webrtc-direct" => /webrtc-direct   (server-reachable WebRTC, certhash-based)
export const DENIED_DIAL_TRANSPORTS_BY_DEFAULT = ["webrtc", "webrtc-direct"] as const;

export function multiaddrUsesDeniedTransport(multiaddr: Multiaddr): boolean {
    const componentNames = multiaddr.getComponents().map((component) => component.name);
    return DENIED_DIAL_TRANSPORTS_BY_DEFAULT.some((deniedProto) => componentNames.includes(deniedProto));
}

// A connectionGater that rejects dialing any multiaddr using WebRTC, leaving WebSocket/TCP/WebTransport
// dials untouched. Helia's libp2p defaults (node + browser) do NOT set a connectionGater, so wiring
// this in does not clobber any upstream gating behaviour.
export function createDefaultDialTransportGater(): Required<Pick<ConnectionGater, "denyDialMultiaddr">> {
    return {
        // Returning true prevents the dial.
        denyDialMultiaddr: (multiaddr: Multiaddr) => multiaddrUsesDeniedTransport(multiaddr)
    };
}

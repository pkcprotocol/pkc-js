import type { ConnectionGater } from "@libp2p/interface";
import type { Multiaddr } from "@multiformats/multiaddr";

// By default pkc-js only dials peers over WebSocket(/WSS) and TCP. WebRTC and WebTransport
// dials are rejected: in the browser they add long, often-failing connection-establishment
// paths (STUN/ICE, certhash rotation) that slow down loads, while WebSocket gives a direct,
// reliable transport. Callers that genuinely want WebRTC/WebTransport can override the gater
// via `libp2pJsClientsOptions[].libp2pOptions.connectionGater` (see createLibp2pJsClientOrUseExistingOne).
//
// These are multiaddr protocol/component names as reported by Multiaddr.getComponents():
//   - "webrtc"        => /webrtc          (browser-to-browser / relayed WebRTC)
//   - "webrtc-direct" => /webrtc-direct   (server-reachable WebRTC, certhash-based)
//   - "webtransport"  => /webtransport
export const DENIED_DIAL_TRANSPORTS_BY_DEFAULT = ["webrtc", "webrtc-direct", "webtransport"] as const;

export function multiaddrUsesDeniedTransport(multiaddr: Multiaddr): boolean {
    const componentNames = multiaddr.getComponents().map((component) => component.name);
    return DENIED_DIAL_TRANSPORTS_BY_DEFAULT.some((deniedProto) => componentNames.includes(deniedProto));
}

// A connectionGater that rejects dialing any multiaddr using WebRTC or WebTransport, leaving
// WebSocket/TCP/etc. dials untouched. Helia's libp2p defaults (node + browser) do NOT set a
// connectionGater, so wiring this in does not clobber any upstream gating behaviour.
export function createDefaultDialTransportGater(): Required<Pick<ConnectionGater, "denyDialMultiaddr">> {
    return {
        // Returning true prevents the dial. We never deny WebSocket/TCP here, so those keep working.
        denyDialMultiaddr: (multiaddr: Multiaddr) => multiaddrUsesDeniedTransport(multiaddr)
    };
}

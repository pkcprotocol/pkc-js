import type { Libp2pOptions } from "libp2p";
import { webTransport } from "@libp2p/webtransport";

// Appended to helia's browser transports (WebSockets, WebRTC, WebRTC-direct, circuit relay). WebTransport
// reaches a kubo node through the certhash it announces, with no certificate authority involved (#475).
// Browsers without WebTransport (or without serverCertificateHashes) are skipped by the transport's
// dialFilter, so it is harmless there. Never import this file from Node code: @libp2p/webtransport needs
// the browser WebTransport API.
const extraLibp2pTransports: NonNullable<Libp2pOptions["transports"]> = [webTransport()];

export default extraLibp2pTransports;

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";
import { isRunningInBrowser } from "../../../dist/node/test/test-util.js";
import Logger from "@pkcprotocol/pkc-logger";

const testLog = Logger({ namespace: "pkc-js:test:webtransport-dialable" });

// pkc-js#475: browsers dial seeders over WSS and WebTransport. WebTransport needs both the transport
// (browser build only, @libp2p/webtransport crashes on import in Node) and a gater that allows it.
// isDialable() checks both without opening a connection, so this needs no network.

const PEER_ID = "12D3KooWBy7Vn1ofw2Rou8PMVuTpfNUMfQjcGZb6T8aZ3X2D6oQg";
const WEBTRANSPORT_ADDR = `/ip4/1.2.3.4/udp/443/quic-v1/webtransport/certhash/uEiAQk5I5LfDHFiqGeL85eF7IvNU3TL7KKSDv9ZN3oZRZjw/certhash/uEiDxAAP4p5uGp5KZiQzw385mk5sKr-RNPSTI2FNe-djMQQ/p2p/${PEER_ID}`;
const WSS_ADDR = `/dns4/seeder.example.com/tcp/443/tls/ws/p2p/${PEER_ID}`;
const WEBRTC_DIRECT_ADDR = `/ip4/1.2.3.4/udp/4001/webrtc-direct/certhash/uEiAQk5I5LfDHFiqGeL85eF7IvNU3TL7KKSDv9ZN3oZRZjw/p2p/${PEER_ID}`;

describe("libp2p-js client transports (pkc-js#475)", () => {
    let client: Libp2pJsClient;

    beforeAll(async () => {
        client = (await createLibp2pJsClientOrUseExistingOne({
            key: `webtransport-dialable-test-${Date.now()}`,
            httpRoutersOptions: ["http://localhost:1"], // never reached; required only so setup doesn't throw
            libp2pOptions: {},
            heliaOptions: {},
            log: testLog
        })) as Libp2pJsClient;
    });

    afterAll(async () => {
        await client?.heliaWithKuboRpcClientFunctions.stop();
    });

    it("can dial WSS", async () => {
        expect(await client.heliaNode.libp2p.isDialable(multiaddr(WSS_ADDR))).to.equal(true);
    });

    it("can dial WebTransport in a browser that has it, and not in Node", async () => {
        const browserHasWebTransport =
            isRunningInBrowser() && typeof (globalThis as { WebTransport?: unknown }).WebTransport === "function";
        expect(await client.heliaNode.libp2p.isDialable(multiaddr(WEBTRANSPORT_ADDR))).to.equal(browserHasWebTransport);
    });

    // An insecure origin (plain http that is not localhost) has no WebTransport global, since browsers expose it
    // only in a secure context. @libp2p/webtransport checks the global on every dial, so such a node must skip
    // WebTransport addresses and still dial WSS (#581).
    it("skips WebTransport and still dials WSS when the WebTransport global is missing", async () => {
        const globals = globalThis as { WebTransport?: unknown };
        const originalWebTransport = globals.WebTransport;
        Object.defineProperty(globalThis, "WebTransport", { value: undefined, configurable: true, writable: true });
        try {
            expect(await client.heliaNode.libp2p.isDialable(multiaddr(WEBTRANSPORT_ADDR))).to.equal(false);
            expect(await client.heliaNode.libp2p.isDialable(multiaddr(WSS_ADDR))).to.equal(true);
        } finally {
            Object.defineProperty(globalThis, "WebTransport", { value: originalWebTransport, configurable: true, writable: true });
        }
    });

    it("does not dial WebRTC-direct (denied by default, #166)", async () => {
        expect(await client.heliaNode.libp2p.isDialable(multiaddr(WEBRTC_DIRECT_ADDR))).to.equal(false);
    });
});

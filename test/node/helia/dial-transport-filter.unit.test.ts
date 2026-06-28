import { describe, it, expect, afterEach } from "vitest";
import { multiaddr } from "@multiformats/multiaddr";
import {
    DENIED_DIAL_TRANSPORTS_BY_DEFAULT,
    multiaddrUsesDeniedTransport,
    createDefaultDialTransportGater
} from "../../../dist/node/helia/dial-transport-filter.js";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { ConnectionGater } from "@libp2p/interface";

// _mergedHeliaOptions.libp2p is typed as `Libp2pOptions | Libp2p`, so narrow it to the option shape we set.
const getMergedConnectionGater = (client: Libp2pJsClient): ConnectionGater | undefined =>
    (client._mergedHeliaOptions?.libp2p as { connectionGater?: ConnectionGater } | undefined)?.connectionGater;

// Pure (offline) coverage for the default dial-transport gater: pkc-js rejects WebRTC and
// WebTransport dials so browser nodes connect over WebSocket(/WSS). See src/helia/dial-transport-filter.ts.
describe("Default dial-transport gater (reject WebRTC + WebTransport)", () => {
    const allowedMultiaddrs = [
        "/ip4/1.2.3.4/tcp/4001/ws", // plain WebSocket
        "/dns4/example.com/tcp/443/wss", // secure WebSocket
        "/ip4/1.2.3.4/tcp/4001", // plain TCP
        "/dns4/example.com/tcp/443/tls/ws", // WSS spelled as tls+ws
        "/ip4/1.2.3.4/tcp/4001/ws/p2p-circuit" // relay reached over WebSocket
    ];

    const deniedMultiaddrs = [
        "/ip4/1.2.3.4/udp/4001/webrtc-direct", // server-reachable WebRTC
        "/ip4/1.2.3.4/udp/4001/webrtc", // WebRTC
        "/ip4/1.2.3.4/udp/4001/quic-v1/webtransport", // WebTransport
        "/ip4/1.2.3.4/tcp/4001/ws/p2p-circuit/webrtc" // relayed WebRTC, even though the relay hop is WebSocket
    ];

    it("lists exactly the WebRTC/WebTransport protocol names", () => {
        expect([...DENIED_DIAL_TRANSPORTS_BY_DEFAULT]).to.deep.equal(["webrtc", "webrtc-direct", "webtransport"]);
    });

    for (const addr of allowedMultiaddrs)
        it(`allows dialing ${addr}`, () => {
            expect(multiaddrUsesDeniedTransport(multiaddr(addr))).to.equal(false);
        });

    for (const addr of deniedMultiaddrs)
        it(`denies dialing ${addr}`, () => {
            expect(multiaddrUsesDeniedTransport(multiaddr(addr))).to.equal(true);
        });

    it("createDefaultDialTransportGater().denyDialMultiaddr mirrors multiaddrUsesDeniedTransport", () => {
        const gater = createDefaultDialTransportGater();
        expect(gater.denyDialMultiaddr(multiaddr("/ip4/1.2.3.4/tcp/4001/ws"))).to.equal(false);
        expect(gater.denyDialMultiaddr(multiaddr("/ip4/1.2.3.4/udp/4001/webrtc-direct"))).to.equal(true);
    });
});

// Wiring + override coverage. Builds a real libp2p-js helia client (no test server needed: it only
// starts a local node and never dials). Helia is identical regardless of the pkc RPC config, so run once.
describeSkipIfRpc("Default dial-transport gater wiring into the libp2p-js helia client", () => {
    const clientsToStop: Libp2pJsClient[] = [];
    let keyCounter = 0;

    const createClient = (libp2pOptions: Record<string, unknown>) =>
        createLibp2pJsClientOrUseExistingOne({
            // unique key per call so each test gets its own helia instance instead of a refcounted shared one
            key: `dial-transport-filter-test-${keyCounter++}`,
            httpRoutersOptions: ["http://localhost:1"], // never reached; required only so setup doesn't throw
            libp2pOptions,
            heliaOptions: {}
        }) as Promise<Libp2pJsClient>;

    afterEach(async () => {
        // countOfUsesOfInstance starts at 1, so a single stop() tears the instance down.
        while (clientsToStop.length) await clientsToStop.pop()!.heliaWithKuboRpcClientFunctions.stop();
    });

    it("uses the default WebRTC/WebTransport-rejecting gater when none is supplied", async () => {
        const client = await createClient({});
        clientsToStop.push(client);
        const gater = getMergedConnectionGater(client);
        expect(typeof gater?.denyDialMultiaddr).to.equal("function");
        expect(await gater!.denyDialMultiaddr!(multiaddr("/ip4/1.2.3.4/udp/4001/webrtc-direct"))).to.equal(true);
        expect(await gater!.denyDialMultiaddr!(multiaddr("/ip4/1.2.3.4/tcp/4001/ws"))).to.equal(false);
    });

    it("lets a caller override the default gater via libp2pOptions.connectionGater", async () => {
        // An allow-all gater, e.g. to re-enable WebRTC/WebTransport dialing.
        const allowAll = { denyDialMultiaddr: async () => false };
        const client = await createClient({ connectionGater: allowAll });
        clientsToStop.push(client);
        const gater = getMergedConnectionGater(client);
        expect(gater).to.equal(allowAll);
        expect(await gater!.denyDialMultiaddr!(multiaddr("/ip4/1.2.3.4/udp/4001/webrtc-direct"))).to.equal(false);
    });
});

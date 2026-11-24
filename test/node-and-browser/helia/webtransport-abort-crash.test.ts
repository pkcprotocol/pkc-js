import { describe, it, expect } from "vitest";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";
import { isRunningInBrowser } from "../../../dist/node/test/test-util.js";

// pkc-js#495: Chromium kills the tab (renderer SIGSEGV) when a WebTransport stream has a write
// pending, then writer.abort(), then WebTransport.close() run in one synchronous task.
// @libp2p/webtransport does exactly that on connection.abort() (libp2p/js-libp2p#3699), and pkc-js's
// teardown unsubscribes every pubsub topic (queuing gossipsub writes) and then aborts every connection.
// So without the close shim in src/runtime/browser/webtransport-close-shim.ts, stopping a client that
// holds a WebTransport connection ends this whole browser run with "Browser connection was closed"
// instead of a failed assertion.
//
// The WebTransport peer is the test server's dedicated kubo node (webTransportNodeArgs in
// test/server/test-server.js).

const WEBTRANSPORT_KUBO_API = "http://localhost:15007/api/v0";
const ROUNDS = 3;

// Browser only: Node has no WebTransport transport (@libp2p/webtransport needs the browser API).
const describeIfBrowserWithWebTransport =
    isRunningInBrowser() && typeof (globalThis as { WebTransport?: unknown }).WebTransport === "function" ? describe : describe.skip;

async function kuboRpc<T>(path: string): Promise<T> {
    const res = await fetch(`${WEBTRANSPORT_KUBO_API}/${path}`, { method: "POST" });
    if (!res.ok) throw new Error(`kubo ${path} answered HTTP ${res.status}`);
    return (await res.json()) as T;
}

async function fetchKuboWebTransportAddr(): Promise<{ peerId: string; addr: string }> {
    const { ID: peerId } = await kuboRpc<{ ID: string }>("id");
    const { Strings: listenAddrs } = await kuboRpc<{ Strings: string[] }>("swarm/addrs/listen");
    const webTransportAddr = listenAddrs.find((addr) => addr.includes("/webtransport/certhash/"));
    if (!webTransportAddr) throw new Error(`The test server's WebTransport kubo node listens on no WebTransport address: ${listenAddrs}`);
    return { peerId, addr: `${webTransportAddr}/p2p/${peerId}` };
}

async function waitUntil(predicate: () => boolean, { timeoutMs, what }: { timeoutMs: number; what: string }): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

describeIfBrowserWithWebTransport("stopping a client that holds a WebTransport connection (pkc-js#495)", () => {
    it(`keeps the page alive through unsubscribe, then abort of every connection (${ROUNDS} rounds)`, async () => {
        const kubo = await fetchKuboWebTransportAddr();

        for (let round = 1; round <= ROUNDS; round++) {
            const client = (await createLibp2pJsClientOrUseExistingOne({
                key: `webtransport-abort-crash-test-${Date.now()}-${round}`,
                httpRoutersOptions: ["http://localhost:1"], // never reached; required only so setup doesn't throw
                libp2pOptions: {},
                heliaOptions: {}
            })) as Libp2pJsClient;
            const libp2p = client.heliaNode.libp2p;

            const connection = await libp2p.dial(multiaddr(kubo.addr));
            expect(connection.remoteAddr.toString()).to.include("/webtransport");

            // gossipsub must have its stream to kubo open, otherwise unsubscribe() has nothing to write to
            libp2p.services.pubsub.subscribe(`webtransport-abort-crash-topic-${round}`);
            await waitUntil(() => libp2p.services.pubsub.getPeers().some((peer) => peer.toString() === kubo.peerId), {
                timeoutMs: 20000,
                what: "gossipsub to open its stream to the WebTransport kubo node"
            });

            // The final release: unsubscribes every topic, then aborts every connection in the same task.
            // Chromium without the shim dies here.
            await client.heliaWithKuboRpcClientFunctions.stop();
            expect(libp2p.getConnections()).to.have.length(0);
        }
    });
});

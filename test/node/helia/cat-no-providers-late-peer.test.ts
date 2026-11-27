import { afterEach, expect, it } from "vitest";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import { MockHttpRouter } from "../../../dist/node/runtime/node/test/mock-http-router.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";
import Logger from "@pkcprotocol/pkc-logger";

const testLog = Logger({ namespace: "pkc-js:test:cat-no-providers-late-peer" });

// Issue #562: cat() of a CID that no router lists and no connected peer has fails its bitswap
// session with "no providers" and then sleeps 0.5s, 1s, 2s, 4s, 8s... between attempts. Each attempt
// snapshots the connected peers when it starts, so a peer holding the block that connects DURING a
// sleep is not asked for it until the sleep ends. With the community connect running in parallel
// with the comment fetch, that idle gap is what decides the load time.
//
// Setup: the block lives only on the test server's kubo node. The client's only router is an empty
// mock router, so the client starts with no peers and no providers. cat() starts, and the test dials
// the kubo node at 4.5s, inside the 4s sleep that runs from about 3.5s to 7.5s. The block must arrive
// shortly after the connection opens rather than at the next attempt.
//
// Client-side libp2p only and config-independent, so it runs once under non-RPC.
const KUBO_API_URL = "http://localhost:15001/api/v0";
const DIAL_AT_MS = 4_500;
// Unfixed, the block arrives about 3s after the connect (when the 4s sleep ends). A block round
// trip to a local kubo node is a few milliseconds, so 1.5s is a loose bound for CI.
const MAX_MS_FROM_CONNECT_TO_BLOCK = 1_500;

// Client-side libp2p only and config-independent: under RPC the fetch runs on the server, so there is nothing to test here.
describeSkipIfRpc("cat() with no providers picks up a peer that connects mid-backoff (issue #562)", () => {
    const routers: MockHttpRouter[] = [];
    const clients: Libp2pJsClient[] = [];

    afterEach(async () => {
        while (clients.length) await clients.pop()!.heliaWithKuboRpcClientFunctions.stop();
        while (routers.length) await routers.pop()!.destroy();
    });

    it("delivers the block shortly after the peer connects, not at the next retry attempt", async () => {
        const content = `issue-562-late-peer-${Date.now()}-${Math.random()}`;
        const form = new FormData();
        form.append("file", new Blob([content]));
        const addRes = await fetch(`${KUBO_API_URL}/add?pin=false`, { method: "POST", body: form });
        expect(addRes.ok, "kubo add should succeed").to.be.true;
        const cid = ((await addRes.json()) as { Hash: string }).Hash;

        const idRes = await fetch(`${KUBO_API_URL}/id`, { method: "POST" });
        const kuboAddresses = ((await idRes.json()) as { Addresses: string[] }).Addresses;
        const kuboWsAddress = kuboAddresses.find((address) => address.startsWith("/ip4/127.0.0.1/") && address.includes("/ws/"));
        expect(kuboWsAddress, "the test kubo node should listen on a loopback WebSocket address").to.be.a("string");

        const router = new MockHttpRouter();
        await router.start();
        routers.push(router);
        const client = (await createLibp2pJsClientOrUseExistingOne({
            key: `cat-no-providers-late-peer-${Math.random()}`,
            httpRoutersOptions: [router.url],
            libp2pOptions: { connectionGater: { denyDialMultiaddr: async () => false } },
            heliaOptions: {},
            log: testLog
        })) as Libp2pJsClient;
        clients.push(client);
        expect(client._helia.libp2p.getConnections().length, "the client must start with no connections").to.equal(0);

        const startedAt = Date.now();
        const catPromise = (async () => {
            const chunks: Uint8Array[] = [];
            for await (const chunk of client.heliaWithKuboRpcClientFunctions.cat(cid, { timeout: "30s" })) chunks.push(chunk);
            return { text: Buffer.concat(chunks).toString(), finishedAtMs: Date.now() - startedAt };
        })();
        // Observe a rejection early so a failure before the dial is not reported as unhandled
        catPromise.catch(() => {});

        await new Promise((resolve) => setTimeout(resolve, DIAL_AT_MS));
        await client._helia.libp2p.dial(multiaddr(kuboWsAddress!));
        const connectedAtMs = Date.now() - startedAt;

        const { text, finishedAtMs } = await catPromise;
        const msFromConnectToBlock = finishedAtMs - connectedAtMs;
        console.log(
            `[issue-562] late peer: connected at ${connectedAtMs}ms, block arrived at ${finishedAtMs}ms (${msFromConnectToBlock}ms after the connect)`
        );
        expect(text).to.equal(content);
        expect(
            msFromConnectToBlock,
            `the block should arrive within ${MAX_MS_FROM_CONNECT_TO_BLOCK}ms of the peer connecting (took ${msFromConnectToBlock}ms)`
        ).to.be.lessThan(MAX_MS_FROM_CONNECT_TO_BLOCK);
    }, 60_000);
});

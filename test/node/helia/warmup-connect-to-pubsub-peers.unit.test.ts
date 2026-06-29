import { afterEach, describe, expect, it } from "vitest";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import { connectToPubsubPeers } from "../../../dist/node/helia/util.js";
import { MockHttpRouter } from "../../../dist/node/runtime/node/test/mock-http-router.js";
import { pubsubTopicToDhtKeyCid } from "../../../dist/node/util.js";
import Logger from "../../../dist/node/logger.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";

// Warmup-level coverage for src/helia/util.ts connectToPubsubPeers — the production consumer of the
// content-routing layer that the findProviders fault-tolerance suite (content-router-fault-tolerance.unit.test.ts)
// does NOT exercise. connectToPubsubPeers is what IPNS-over-pubsub warmup actually runs: it
// findProviders(topicCid), dials each provider in parallel, and resolves the moment a remote peer's
// gossipsub subscription-change for the topic is observed — OR, failing that, blocks up to the
// hardcoded 10s TOPIC_SUBSCRIBER_WAIT_TIMEOUT_MS floor before giving up.
//
// The router-mix benchmark (.temp/router-mix-benchmark.mjs) showed the content-routing layer itself is
// already fast and order-independent (~250ms to first dialable provider regardless of router order or
// count, post-#171). So the remaining client-side speed lever is THIS layer: a community whose only
// reachable record is undialable (e.g. a router announcing tcp/quic-only, or the dialable peer being
// down) makes warmup eat the full 10s floor, while a community with one dialable+up subscriber returns
// in well under a second. These tests pin both ends: a dialable subscriber is found fast and is NOT
// slowed by black-hole / undialable noise, and the 10s floor is the bound (and the only knob) for the
// no-dialable-peer case.
//
// Heavier than the findProviders suite: it needs a STARTED node-under-test plus a real second gossipsub
// node that listens on /ws and subscribes to the topic, so the dial actually produces a
// subscription-change. Client-side libp2p only and config-independent, so it runs once under non-RPC.
describeSkipIfRpc("connectToPubsubPeers warmup (issue #171 follow-up)", () => {
    // Mirrors TOPIC_SUBSCRIBER_WAIT_TIMEOUT_MS in src/helia/util.ts (not exported). Warmup blocks up to
    // this long when it never observes a topic subscriber.
    const TOPIC_SUBSCRIBER_WAIT_TIMEOUT_MS = 10_000;
    // A successful warmup (dialable subscriber found) must finish far below the floor. Generous enough
    // for CI jitter on a dial + identify + gossipsub subscription exchange between two local nodes,
    // while still proving we did NOT wait the 10s floor.
    const FAST_WARMUP_MAX_MS = 7_000;

    const log = Logger("pkc-js:test:warmup");
    const clientsToStop: Libp2pJsClient[] = [];
    const startedRouters: MockHttpRouter[] = [];
    let keyCounter = 0;

    const newPeerIdStr = async () => peerIdFromPrivateKey(await generateKeyPair("Ed25519")).toString();

    afterEach(async () => {
        // countOfUsesOfInstance starts at 1, so a single stop() tears each helia instance down.
        while (clientsToStop.length) await clientsToStop.pop()!.heliaWithKuboRpcClientFunctions.stop();
        while (startedRouters.length) {
            try {
                await startedRouters.pop()!.destroy();
            } catch {
                // already destroyed
            }
        }
    });

    // Build a libp2p-js helia node. `listen` makes it bind a WebSocket listener (so it can be dialed and
    // serve as the subscriber); the node-under-test stays listen-less (the production default). The dummy
    // router keeps creation from throwing and is never expected to serve anything.
    const createNode = async (opts: { listen?: boolean; routers?: string[] } = {}): Promise<Libp2pJsClient> => {
        const client = (await createLibp2pJsClientOrUseExistingOne({
            key: `warmup-${keyCounter++}`,
            httpRoutersOptions: opts.routers ?? ["http://localhost:1"],
            libp2pOptions: opts.listen ? { addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] } } : {},
            heliaOptions: {}
        })) as Libp2pJsClient;
        clientsToStop.push(client);
        return client;
    };

    // Stand up a real gossipsub node that subscribes to `topic` and listens on /ws, then return the
    // provider record (peerId + dialable ws multiaddrs) that a router should serve for it. We subscribe
    // via the GossipSub PROTOTYPE method, bypassing the instance-level subscribe monkey-patch that
    // helia-for-pkc installs (it would kick off this helper node's OWN findProviders/10s-wait warmup
    // against its dummy router and leak a timer past test teardown).
    const startSubscriberNode = async (topic: string): Promise<{ ID: string; Addrs: string[] }> => {
        const sub = await createNode({ listen: true });
        const pubsub = sub._helia.libp2p.services.pubsub;
        Object.getPrototypeOf(pubsub).subscribe.call(pubsub, topic);
        const wsAddrs = sub._helia.libp2p
            .getMultiaddrs()
            .map((m) => m.toString())
            .filter((a) => a.includes("/ws"))
            // Strip the /p2p/<id> suffix so the record looks like a real delegated-routing record (ID + bare Addrs).
            .map((a) => a.replace(/\/p2p\/[^/]+$/, ""));
        expect(wsAddrs.length, "subscriber must expose at least one ws multiaddr").to.be.greaterThan(0);
        return { ID: sub._helia.libp2p.peerId.toString(), Addrs: wsAddrs };
    };

    const startRouterServing = async (cid: string, provider: { ID: string; Addrs: string[] }): Promise<string> => {
        const router = new MockHttpRouter();
        await router.start();
        startedRouters.push(router);
        router.addProviderForTesting(cid, provider);
        return router.url;
    };

    const startBlackHoleRouter = async (): Promise<string> => {
        const router = new MockHttpRouter({ faultMode: "blackHole" });
        await router.start();
        startedRouters.push(router);
        return router.url;
    };

    const topicFor = (suffix: string) => `warmup-test-topic-${suffix}-${keyCounter}`;

    // The happy path: one router serving a dialable, subscribed peer. Warmup must dial it, observe the
    // gossipsub subscription-change, and return in well under the 10s floor with the peer connected.
    it("returns well under the 10s floor when a dialable subscriber is found", async () => {
        const topic = topicFor("fast");
        const cid = pubsubTopicToDhtKeyCid(topic).toString();
        const subscriber = await startSubscriberNode(topic);
        const routerUrl = await startRouterServing(cid, subscriber);
        const node = await createNode({ routers: [routerUrl] });

        const start = Date.now();
        const connections = await connectToPubsubPeers({ helia: node._helia, pubsubTopic: topic, maxPeers: 4, log });
        const elapsed = Date.now() - start;

        expect(elapsed, `warmup took ${elapsed}ms, expected well under the ${TOPIC_SUBSCRIBER_WAIT_TIMEOUT_MS}ms floor`).to.be.lessThan(
            FAST_WARMUP_MAX_MS
        );
        expect(connections.length, "should have connected to the dialable subscriber").to.be.greaterThan(0);
        expect(node._helia.libp2p.services.pubsub.getSubscribers(topic).map((p) => p.toString())).to.include(subscriber.ID);
    });

    // The core fault-tolerance-for-speed claim at the warmup layer: a black-hole router (accepts then
    // never replies) and a router serving only an UNDIALABLE record (a peer at a closed port) must not
    // drag warmup toward the 10s floor when ONE router also serves a dialable, subscribed peer. The
    // black hole's findProviders request is cancelled on subscription-change; the undialable dial fails
    // fast; the dialable subscriber still resolves warmup quickly.
    it("a black-hole + undialable-only fleet does not push warmup toward the floor when one dialable subscriber exists", async () => {
        const topic = topicFor("noise");
        const cid = pubsubTopicToDhtKeyCid(topic).toString();
        const subscriber = await startSubscriberNode(topic);
        const deadPeerId = await newPeerIdStr();

        const blackHoleUrl = await startBlackHoleRouter();
        const undialableUrl = await startRouterServing(cid, { ID: deadPeerId, Addrs: ["/ip4/127.0.0.1/tcp/1/ws"] }); // port 1 refuses
        const goodUrl = await startRouterServing(cid, subscriber);
        // Black hole + undialable listed FIRST so any "wait for earlier routers/providers" bug surfaces.
        const node = await createNode({ routers: [blackHoleUrl, undialableUrl, goodUrl] });

        const start = Date.now();
        const connections = await connectToPubsubPeers({ helia: node._helia, pubsubTopic: topic, maxPeers: 4, log });
        const elapsed = Date.now() - start;

        expect(
            elapsed,
            `warmup took ${elapsed}ms despite noise, expected well under the ${TOPIC_SUBSCRIBER_WAIT_TIMEOUT_MS}ms floor`
        ).to.be.lessThan(FAST_WARMUP_MAX_MS);
        const connectedPeers = connections.map((c) => c.remotePeer.toString());
        expect(connectedPeers, "should have connected to the dialable subscriber, not the dead peer").to.include(subscriber.ID);
        expect(connectedPeers).to.not.include(deadPeerId);
    });

    // The floor itself, and the size of the win from a dialable peer. When the only record is undialable
    // (peer at a closed port) and no subscriber ever appears, warmup is bounded by — and pays in full —
    // the ~10s TOPIC_SUBSCRIBER_WAIT_TIMEOUT_MS, then throws ERR_FAILED_TO_DIAL_ANY_PEERS_PROVIDING_CID.
    // Adding a single dialable subscriber collapses that to well under a second. This is the lever: the
    // floor is what a stuck warmup costs, and it is the only client-side knob for the no-dialable case.
    it("is bounded by the ~10s floor when no provider is dialable, and a dialable subscriber beats it by a wide margin", async () => {
        // Leg 1: undialable-only record, no subscriber → pays the floor and throws.
        const floorTopic = topicFor("floor");
        const floorCid = pubsubTopicToDhtKeyCid(floorTopic).toString();
        const deadPeerId = await newPeerIdStr();
        const undialableUrl = await startRouterServing(floorCid, { ID: deadPeerId, Addrs: ["/ip4/127.0.0.1/tcp/1/ws"] });
        const floorNode = await createNode({ routers: [undialableUrl] });

        const floorStart = Date.now();
        let floorThrew: Error | null = null;
        try {
            await connectToPubsubPeers({ helia: floorNode._helia, pubsubTopic: floorTopic, maxPeers: 4, log });
        } catch (e) {
            floorThrew = e as Error;
        }
        const floorElapsed = Date.now() - floorStart;

        expect(floorThrew, "warmup with no dialable peer should throw after the floor").to.not.equal(null);
        expect((floorThrew as Error & { code?: string }).code ?? floorThrew!.message).to.contain(
            "ERR_FAILED_TO_DIAL_ANY_PEERS_PROVIDING_CID"
        );
        // Pays roughly the full floor: at least ~9s (allowing scheduler slack below the 10s nominal),
        // and not wildly beyond it (no extra stall stacked on top).
        expect(floorElapsed, `floor leg took ${floorElapsed}ms`).to.be.greaterThan(TOPIC_SUBSCRIBER_WAIT_TIMEOUT_MS - 1_500);
        expect(floorElapsed, `floor leg took ${floorElapsed}ms`).to.be.lessThan(TOPIC_SUBSCRIBER_WAIT_TIMEOUT_MS + 4_000);

        // Leg 2: same shape but with a dialable subscriber added → returns far below the floor.
        const fastTopic = topicFor("floor-fast");
        const fastCid = pubsubTopicToDhtKeyCid(fastTopic).toString();
        const subscriber = await startSubscriberNode(fastTopic);
        const goodUrl = await startRouterServing(fastCid, subscriber);
        const fastNode = await createNode({ routers: [goodUrl] });

        const fastStart = Date.now();
        const connections = await connectToPubsubPeers({ helia: fastNode._helia, pubsubTopic: fastTopic, maxPeers: 4, log });
        const fastElapsed = Date.now() - fastStart;

        expect(connections.length).to.be.greaterThan(0);
        expect(fastElapsed, `fast leg took ${fastElapsed}ms`).to.be.lessThan(FAST_WARMUP_MAX_MS);
        // The dialable peer beat the floor by a wide margin — this is the speed delta the floor governs.
        expect(fastElapsed).to.be.lessThan(floorElapsed - 3_000);
    });

    // The floor must also BOUND a router whose findProviders iterator never ends — a true black hole
    // (accepts the GET, never responds, never closes). Such a router never yields and never ends its
    // it-merge source, so the for-await over findProviders only terminates if something aborts it. The
    // subscriber-wait timeout (the floor) is that something: on timeout, warmup must abort findProviders
    // and give up, not pull the black hole's iterator forever. Regression guard — before the fix the
    // floor-timeout path did NOT abort findProvidersAbort, so this hung well past the floor.
    it("does not hang past the floor when the only router is a black hole and no subscriber appears", async () => {
        const topic = topicFor("blackhole-floor");
        const blackHoleUrl = await startBlackHoleRouter();
        const node = await createNode({ routers: [blackHoleUrl] });

        // Watchdog > floor (10s) + generous teardown. Hitting it means warmup hung on the black hole.
        const HANG_WATCHDOG_MS = 20_000;
        const ac = new AbortController();
        let hung = false;
        const start = Date.now();
        const outcome = await Promise.race([
            connectToPubsubPeers({ helia: node._helia, pubsubTopic: topic, maxPeers: 4, log, options: { signal: ac.signal } })
                .then(() => "returned" as const)
                .catch((e: Error) => e),
            new Promise<"hung">((resolve) =>
                setTimeout(() => {
                    hung = true;
                    resolve("hung");
                }, HANG_WATCHDOG_MS)
            )
        ]);
        const elapsed = Date.now() - start;
        // Unblock any still-pending lookup (matters on the pre-fix hang) so afterEach teardown completes.
        ac.abort();

        expect(hung, `warmup did not terminate within ${HANG_WATCHDOG_MS}ms — the black hole hung the findProviders loop`).to.equal(false);
        expect(elapsed, `warmup took ${elapsed}ms`).to.be.lessThan(TOPIC_SUBSCRIBER_WAIT_TIMEOUT_MS + 4_000);
        // With no dialable peer it gives up at the floor the same way the undialable case does.
        const outcomeErr = outcome as Error & { code?: string };
        expect(outcomeErr?.code ?? outcomeErr?.message ?? "").to.contain("ERR_FAILED_TO_DIAL_ANY_PEERS_PROVIDING_CID");
    });
});

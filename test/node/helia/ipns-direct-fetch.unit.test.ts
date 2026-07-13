import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { circuitRelayServer } from "@libp2p/circuit-relay-v2";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import { directFetchIpnsRecordFromProviders } from "../../../dist/node/helia/util.js";
import { MockHttpRouter } from "../../../dist/node/runtime/node/test/mock-http-router.js";
import { ipnsNameToIpnsOverPubsubTopic, pubsubTopicToDhtKeyCid } from "../../../dist/node/util.js";
import Logger from "../../../dist/node/logger.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { createIPNSRecord, marshalIPNSRecord, multihashToIPNSRoutingKey } from "ipns";
import { ipnsValidator } from "ipns/validator";
import { CID } from "multiformats/cid";
import { equals as uint8ArrayEquals } from "uint8arrays/equals";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";
import type { Multiaddr } from "@multiformats/multiaddr";

// Coverage for directFetchIpnsRecordFromProviders (src/helia/util.ts) — the IPNS resolution fast
// path (issue #185). It fetches the record over libp2p/fetch, in parallel, directly from BOTH the
// topic's current gossipsub subscribers AND providers freshly discovered from the HTTP routers,
// returning the first signature-valid record. This skips the waitForTopicSubscriber floor (up to
// 10s) that @helia/ipns's PubSubRouting.get() forces because get() only fetches from
// getSubscribers() and throws when that list is empty.
//
// Like the warmup suite, this stands up a STARTED node-under-test plus a real second libp2p node
// that listens on /ws and serves the record over the fetch protocol. Client-side libp2p only and
// config-independent (the helper never touches Kubo or the PKC RPC server — it operates purely on
// the local helia/libp2p instance), so it runs once under non-RPC via describeSkipIfRpc.
describeSkipIfRpc("directFetchIpnsRecordFromProviders (issue #185)", () => {
    // A successful direct fetch (dialable provider/subscriber found) must finish far below the 10s
    // waitForTopicSubscriber floor that the legacy path pays — this is the whole point of the fast
    // path. Generous for CI jitter on a dial + fetch between two local nodes.
    const FAST_FETCH_MAX_MS = 7_000;

    const log = Logger("pkc-js:test:direct-fetch");
    const clientsToStop: Libp2pJsClient[] = [];
    const startedRouters: MockHttpRouter[] = [];
    let keyCounter = 0;

    afterEach(async () => {
        while (clientsToStop.length) await clientsToStop.pop()!.heliaWithKuboRpcClientFunctions.stop();
        while (startedRouters.length) {
            try {
                await startedRouters.pop()!.destroy();
            } catch {
                // already destroyed
            }
        }
    });

    // A "tarpit" peer for issue #215: a raw TCP server that accepts connections and never speaks,
    // so a libp2p /ws dial to it hangs (the WebSocket upgrade request is never answered) until
    // connectionManager.addressDialTimeout aborts it. Stands in for the production relay-circuit
    // dials that take 2-5s to fail (PR #214 benchmark) — a dial that is SLOW to settle, unlike the
    // instantly-failing gater-denied dials the #213 tests use.
    const tarpitServers: net.Server[] = [];
    const tarpitSockets: net.Socket[] = [];
    const startTarpitWsAddr = async (): Promise<string> => {
        const server = net.createServer((socket) => {
            tarpitSockets.push(socket);
        });
        tarpitServers.push(server);
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as net.AddressInfo).port;
        return `/ip4/127.0.0.1/tcp/${port}/ws`;
    };

    afterEach(async () => {
        while (tarpitSockets.length) tarpitSockets.pop()!.destroy();
        while (tarpitServers.length) {
            const server = tarpitServers.pop()!;
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    const createNode = async (
        opts: {
            listen?: boolean;
            routers?: string[];
            libp2pOptions?: Parameters<typeof createLibp2pJsClientOrUseExistingOne>[0]["libp2pOptions"];
        } = {}
    ): Promise<Libp2pJsClient> => {
        const client = (await createLibp2pJsClientOrUseExistingOne({
            key: `direct-fetch-${keyCounter++}`,
            httpRoutersOptions: opts.routers ?? ["http://localhost:1"],
            libp2pOptions: {
                ...(opts.listen ? { addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] } } : {}),
                ...opts.libp2pOptions
            },
            heliaOptions: {}
        })) as Libp2pJsClient;
        clientsToStop.push(client);
        return client;
    };

    // Build a fresh IPNS name + a validly-signed record for it, plus everything derived from it.
    const makeRecord = async (valuePath = "/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi") => {
        const privateKey = await generateKeyPair("Ed25519");
        const ipnsPeerId = peerIdFromPrivateKey(privateKey);
        const record = await createIPNSRecord(privateKey, CID.parse(valuePath.replace("/ipfs/", "")), 1n, 60 * 60 * 1000);
        const marshalled = marshalIPNSRecord(record);
        const routingKey = multihashToIPNSRoutingKey(ipnsPeerId.toMultihash());
        const topic = ipnsNameToIpnsOverPubsubTopic(ipnsPeerId.toString());
        const cid = pubsubTopicToDhtKeyCid(topic).toString();
        return { privateKey, ipnsPeerId, record, marshalled, routingKey, topic, cid };
    };

    // Stand up a real libp2p node that listens on /ws and serves `recordToServe` for `routingKey`
    // over the fetch protocol. pkc nodes already register a `/ipns/` lookup (via @helia/ipns), so we
    // unregister it and register our own that returns the pre-built record. If `subscribeTopic` is
    // given, the node also subscribes to that topic (via the GossipSub PROTOTYPE method, bypassing
    // helia-for-pkc's instance-level subscribe monkey-patch so it does not kick off its OWN warmup).
    const startPublisherNode = async (args: {
        routingKey: Uint8Array;
        recordToServe: Uint8Array | undefined;
        subscribeTopic?: string;
    }): Promise<{ client: Libp2pJsClient; ID: string; Addrs: string[] }> => {
        const client = await createNode({ listen: true });
        const fetchService = client._helia.libp2p.services.fetch;
        fetchService.unregisterLookupFunction("/ipns/");
        fetchService.registerLookupFunction("/ipns/", async (key: Uint8Array) => {
            if (args.recordToServe && uint8ArrayEquals(key, args.routingKey)) return args.recordToServe;
            return undefined;
        });

        if (args.subscribeTopic) {
            const pubsub = client._helia.libp2p.services.pubsub;
            Object.getPrototypeOf(pubsub).subscribe.call(pubsub, args.subscribeTopic);
        }

        const wsAddrs = client._helia.libp2p
            .getMultiaddrs()
            .map((m) => m.toString())
            .filter((a) => a.includes("/ws"))
            .map((a) => a.replace(/\/p2p\/[^/]+$/, ""));
        expect(wsAddrs.length, "publisher must expose at least one ws multiaddr").to.be.greaterThan(0);
        return { client, ID: client._helia.libp2p.peerId.toString(), Addrs: wsAddrs };
    };

    const startRouterServing = async (cid: string, provider: { ID: string; Addrs: string[] }): Promise<string> => {
        const router = new MockHttpRouter();
        await router.start();
        startedRouters.push(router);
        router.addProviderForTesting(cid, provider);
        return router.url;
    };

    // Provider fast path: the publisher is reachable ONLY via a router provider record and is NOT a
    // gossipsub subscriber. The helper must dial it and fetch the record via libp2p/fetch, well under
    // the 10s subscriber-wait floor — proving the subscription handshake is skipped.
    it("fetches from a freshly discovered provider without waiting for a gossipsub subscription", async () => {
        const { routingKey, marshalled, topic, cid } = await makeRecord();
        const publisher = await startPublisherNode({ routingKey, recordToServe: marshalled });
        const routerUrl = await startRouterServing(cid, publisher);
        const node = await createNode({ routers: [routerUrl] });

        // Sanity: the publisher is NOT yet a subscriber from the node's view — this is the provider path.
        expect(node._helia.libp2p.services.pubsub.getSubscribers(topic).map((p) => p.toString())).to.not.include(publisher.ID);

        const start = Date.now();
        const result = await directFetchIpnsRecordFromProviders({
            helia: node._helia,
            pubsubTopic: topic,
            routingKey,
            maxPeers: 4,
            validate: ipnsValidator,
            log
        });
        const elapsed = Date.now() - start;

        expect(result, "should have fetched a record from the provider").to.not.equal(undefined);
        expect(result!.source).to.equal("provider");
        expect(result!.peerId).to.equal(publisher.ID);
        expect(uint8ArrayEquals(result!.recordBytes, marshalled), "served record bytes must match").to.equal(true);
        expect(elapsed, `direct fetch took ${elapsed}ms, expected well under the 10s floor`).to.be.lessThan(FAST_FETCH_MAX_MS);
    });

    // Issue #188: undialable providers must not consume maxPeers attempt slots. In a browser with
    // a WSS-only connection gater, some routers consistently serve provider records whose addrs
    // are all tcp/quic (no WSS). Those dials fail instantly with DialDeniedError, but each one
    // used to count toward maxPeers (4), so when the first 4 providers yielded were undialable
    // the provider branch exhausted itself without a single real fetch attempt and resolution
    // fell back to the ~10s legacy warmup path. Reproduce with a ws-only gater on the
    // node-under-test and a router that yields maxPeers tcp-only providers BEFORE the one real
    // ws publisher: the publisher must still be dialed and its record fetched.
    it("does not count undialable (gater-denied) providers toward maxPeers (issue #188)", async () => {
        const maxPeers = 4;
        const { routingKey, marshalled, topic, cid } = await makeRecord();
        const publisher = await startPublisherNode({ routingKey, recordToServe: marshalled });

        const router = new MockHttpRouter();
        await router.start();
        startedRouters.push(router);
        // MockHttpRouter serves providers newest-first, so seed the dialable publisher FIRST and
        // the undialable providers AFTER: the node-under-test then discovers all maxPeers
        // undialable providers before the publisher, mirroring production where fast routers
        // serving records without WSS addrs are yielded first.
        router.addProviderForTesting(cid, publisher);
        for (let i = 0; i < maxPeers; i++) {
            const fakePeerId = peerIdFromPrivateKey(await generateKeyPair("Ed25519")).toString();
            router.addProviderForTesting(cid, { ID: fakePeerId, Addrs: [`/ip4/127.0.0.1/tcp/${40100 + i}`] });
        }

        // Mirror the browser's WSS-only connection gater: deny any multiaddr without a ws/wss
        // component, so the tcp-only providers fail instantly with DialDeniedError.
        const node = await createNode({
            routers: [router.url],
            libp2pOptions: {
                connectionGater: {
                    denyDialMultiaddr: (multiaddr: Multiaddr) =>
                        !multiaddr.getComponents().some((component) => component.name === "ws" || component.name === "wss")
                }
            }
        });

        const start = Date.now();
        const result = await directFetchIpnsRecordFromProviders({
            helia: node._helia,
            pubsubTopic: topic,
            routingKey,
            maxPeers,
            validate: ipnsValidator,
            log
        });
        const elapsed = Date.now() - start;

        expect(
            result,
            "the dialable publisher must still be fetched from even when maxPeers undialable providers are yielded first"
        ).to.not.equal(undefined);
        expect(result!.source).to.equal("provider");
        expect(result!.peerId).to.equal(publisher.ID);
        expect(uint8ArrayEquals(result!.recordBytes, marshalled), "served record bytes must match").to.equal(true);
        expect(elapsed, `direct fetch took ${elapsed}ms, expected well under the 10s floor`).to.be.lessThan(FAST_FETCH_MAX_MS);
    });

    // Issue #213: when multiple routers serve records for the SAME peer, libp2p's
    // CompoundContentRouting.findProviders dedupes by peer id — the first router's record is the
    // only one ever yielded. A slower router's record with BETTER addrs (the browser-dialable
    // /ws one) is merged into the peerstore but never yielded, so if the fast router's record
    // had its WSS addrs stripped (in prod: an old router build strips dns4/WSS from every
    // record), the one dial fails instantly with DialDeniedError and the record is never
    // fetched even though a dialable addr is sitting in the peerstore moments later.
    // The helper must retry dial-by-id (which re-reads the peerstore) after the provider
    // stream completes, so the slower router's merged addrs get used.
    it("retries a gater-denied provider after a slower router contributes dialable addrs (issue #213)", async () => {
        const { routingKey, marshalled, topic, cid } = await makeRecord();
        const publisher = await startPublisherNode({ routingKey, recordToServe: marshalled });

        // Fast router: serves the publisher's peer id with its WSS addr stripped (tcp-only),
        // mirroring the poisoned production router. Responds immediately.
        const fastPoisonedRouter = new MockHttpRouter();
        await fastPoisonedRouter.start();
        startedRouters.push(fastPoisonedRouter);
        fastPoisonedRouter.addProviderForTesting(cid, { ID: publisher.ID, Addrs: ["/ip4/127.0.0.1/tcp/40199"] });

        // Slow router: serves the SAME peer with its real /ws addrs after a delay, so the
        // poisoned record deterministically wins the first (denied) dial and the good record
        // only ever reaches the peerstore via the compound router's merge (never yielded).
        const slowGoodRouter = new MockHttpRouter({ providerGetDelayMs: 800 });
        await slowGoodRouter.start();
        startedRouters.push(slowGoodRouter);
        slowGoodRouter.addProviderForTesting(cid, publisher);

        // Mirror the browser's WSS-only connection gater, so the tcp-only record is undialable.
        const node = await createNode({
            routers: [fastPoisonedRouter.url, slowGoodRouter.url],
            libp2pOptions: {
                connectionGater: {
                    denyDialMultiaddr: (multiaddr: Multiaddr) =>
                        !multiaddr.getComponents().some((component) => component.name === "ws" || component.name === "wss")
                }
            }
        });

        const start = Date.now();
        const result = await directFetchIpnsRecordFromProviders({
            helia: node._helia,
            pubsubTopic: topic,
            routingKey,
            maxPeers: 4,
            validate: ipnsValidator,
            log
        });
        const elapsed = Date.now() - start;

        expect(
            result,
            "the record must be fetched via a retry dial once the slower router's dialable addrs are in the peerstore"
        ).to.not.equal(undefined);
        expect(result!.source).to.equal("provider");
        expect(result!.peerId).to.equal(publisher.ID);
        expect(uint8ArrayEquals(result!.recordBytes, marshalled), "served record bytes must match").to.equal(true);
        expect(elapsed, `direct fetch took ${elapsed}ms, expected well under the 10s floor`).to.be.lessThan(FAST_FETCH_MAX_MS);
    });

    // Issue #215 (follow-up to #213): the retry pass must be gated on the provider STREAM
    // completing (that is when every router's addrs are merged into the peerstore), NOT on every
    // initial dial settling. The PR #214 benchmark showed the production 6-router mix gains no
    // latency from the retry because relay-circuit dials take 2-5s to fail, and the retry waits
    // for them via Promise.allSettled(dialFetchTasks) even though the addrs it needs were merged
    // seconds earlier. Reproduce with the #213 fast-poisoned/slow-good router pair PLUS a tarpit
    // provider whose dial only settles at addressDialTimeout: the record must still be fetched at
    // provider-stream-completion time (~SLOW_ROUTER_DELAY_MS), well before the tarpit dial settles.
    it("retry of a gater-denied provider is not delayed by an unrelated slow dial still in flight (issue #215)", async () => {
        const SLOW_ROUTER_DELAY_MS = 800; // provider stream completes here — all addrs merged
        const TARPIT_DIAL_SETTLE_MS = 5_000; // connectionManager.addressDialTimeout — when the tarpit dial fails
        const RETRY_UNGATED_MAX_MS = 3_500; // between the two: red waits for the tarpit (~5.2s), green needs only the stream (~1.2s)

        const { routingKey, marshalled, topic, cid } = await makeRecord();
        const publisher = await startPublisherNode({ routingKey, recordToServe: marshalled });

        // Fast router: the publisher with its WSS addr stripped (tcp-only, gater-denied → enters
        // the retry set) plus the tarpit peer (dialable /ws addr, dial hangs until timeout).
        const fastPoisonedRouter = new MockHttpRouter();
        await fastPoisonedRouter.start();
        startedRouters.push(fastPoisonedRouter);
        fastPoisonedRouter.addProviderForTesting(cid, { ID: publisher.ID, Addrs: ["/ip4/127.0.0.1/tcp/40199"] });
        const tarpitPeerId = peerIdFromPrivateKey(await generateKeyPair("Ed25519")).toString();
        fastPoisonedRouter.addProviderForTesting(cid, { ID: tarpitPeerId, Addrs: [await startTarpitWsAddr()] });

        // Slow router: the SAME publisher with its real /ws addrs — merged into the peerstore at
        // ~SLOW_ROUTER_DELAY_MS when the provider stream completes (deduped, never yielded).
        const slowGoodRouter = new MockHttpRouter({ providerGetDelayMs: SLOW_ROUTER_DELAY_MS });
        await slowGoodRouter.start();
        startedRouters.push(slowGoodRouter);
        slowGoodRouter.addProviderForTesting(cid, publisher);

        const node = await createNode({
            routers: [fastPoisonedRouter.url, slowGoodRouter.url],
            libp2pOptions: {
                connectionGater: {
                    denyDialMultiaddr: (multiaddr: Multiaddr) =>
                        !multiaddr.getComponents().some((component) => component.name === "ws" || component.name === "wss")
                },
                // Bound the tarpit dial deterministically: it has a single addr, and the
                // per-address timeout applies even when the dial carries its own abort signal.
                connectionManager: { addressDialTimeout: TARPIT_DIAL_SETTLE_MS }
            }
        });

        const start = Date.now();
        const result = await directFetchIpnsRecordFromProviders({
            helia: node._helia,
            pubsubTopic: topic,
            routingKey,
            maxPeers: 4,
            validate: ipnsValidator,
            log
        });
        const elapsed = Date.now() - start;

        expect(result, "the record must be fetched via the retry dial despite the tarpit dial still hanging").to.not.equal(undefined);
        expect(result!.source).to.equal("provider");
        expect(result!.peerId).to.equal(publisher.ID);
        expect(uint8ArrayEquals(result!.recordBytes, marshalled), "served record bytes must match").to.equal(true);
        expect(
            elapsed,
            `direct fetch took ${elapsed}ms: the retry needs only the completed provider stream (~${SLOW_ROUTER_DELAY_MS}ms), so ` +
                `taking ~${TARPIT_DIAL_SETTLE_MS}ms means the retry pass is gated on the unrelated tarpit dial settling (issue #215)`
        ).to.be.lessThan(RETRY_UNGATED_MAX_MS);
    });

    // Issue #215: a provider whose ONLY addrs are /p2p-circuit must not be dialed by the
    // direct-fetch path at all. /libp2p/fetch over a limited (relayed) connection always fails
    // with LimitedConnectionError, so the dial can never produce a record — it only burns 2-5s
    // (the production relay dials measured in the PR #214 benchmark) and, today, delays the
    // issue #213 retry pass that waits for it to settle. The dial outcome is irrelevant here
    // (the relay is dead so it fails fast): the assertion is that no dial is ATTEMPTED.
    it("does not dial a provider whose only addrs are p2p-circuit (issue #215)", async () => {
        const { routingKey, marshalled, topic, cid } = await makeRecord();
        const publisher = await startPublisherNode({ routingKey, recordToServe: marshalled });

        const router = new MockHttpRouter();
        await router.start();
        startedRouters.push(router);
        router.addProviderForTesting(cid, publisher);
        const relayPeerId = peerIdFromPrivateKey(await generateKeyPair("Ed25519")).toString();
        const circuitOnlyPeerId = peerIdFromPrivateKey(await generateKeyPair("Ed25519")).toString();
        router.addProviderForTesting(cid, {
            ID: circuitOnlyPeerId,
            Addrs: [`/ip4/127.0.0.1/tcp/1/ws/p2p/${relayPeerId}/p2p-circuit`]
        });

        const node = await createNode({ routers: [router.url] });
        const dialSpy = vi.spyOn(node._helia.libp2p, "dial");

        const result = await directFetchIpnsRecordFromProviders({
            helia: node._helia,
            pubsubTopic: topic,
            routingKey,
            maxPeers: 4,
            validate: ipnsValidator,
            log
        });

        expect(result, "the dialable publisher must still be fetched from").to.not.equal(undefined);
        expect(result!.peerId).to.equal(publisher.ID);

        const dialedTargets = dialSpy.mock.calls.flatMap(([target]) => (Array.isArray(target) ? target : [target])).map(String);
        expect(
            dialedTargets.some((target) => target === circuitOnlyPeerId || target.includes(`/p2p/${circuitOnlyPeerId}`)),
            `a p2p-circuit-only provider must not be dialed in the direct-fetch path (fetch over a limited connection always ` +
                `fails with LimitedConnectionError); dialed targets: ${dialedTargets.join(", ")}`
        ).to.equal(false);
    });

    // Issue #215 green path: a circuit-only provider is parked (not dialed), but the moment a
    // slower router's record merges a DIRECT addr for the same (deduped) peer into the peerstore,
    // it must be dialed — with the direct addr only, never the circuit one — and the record
    // fetched. This is the "retry-on-addr-update instead of hard skip" half of the policy: the
    // companion test above pins that a circuit-only provider with no later direct addr is never
    // dialed at all.
    it("dials a parked circuit-only provider once a slower router contributes a direct addr (issue #215)", async () => {
        const { routingKey, marshalled, topic, cid } = await makeRecord();
        const publisher = await startPublisherNode({ routingKey, recordToServe: marshalled });

        // Fast router: the publisher announced ONLY via a (dead) relay.
        const fastCircuitOnlyRouter = new MockHttpRouter();
        await fastCircuitOnlyRouter.start();
        startedRouters.push(fastCircuitOnlyRouter);
        const relayPeerId = peerIdFromPrivateKey(await generateKeyPair("Ed25519")).toString();
        fastCircuitOnlyRouter.addProviderForTesting(cid, {
            ID: publisher.ID,
            Addrs: [`/ip4/127.0.0.1/tcp/1/ws/p2p/${relayPeerId}/p2p-circuit`]
        });

        // Slow router: the SAME publisher with its real /ws addrs — merged into the peerstore
        // when it responds (deduped, never yielded), which must trigger the parked peer's dial.
        const slowGoodRouter = new MockHttpRouter({ providerGetDelayMs: 800 });
        await slowGoodRouter.start();
        startedRouters.push(slowGoodRouter);
        slowGoodRouter.addProviderForTesting(cid, publisher);

        const node = await createNode({ routers: [fastCircuitOnlyRouter.url, slowGoodRouter.url] });
        const dialSpy = vi.spyOn(node._helia.libp2p, "dial");

        const start = Date.now();
        const result = await directFetchIpnsRecordFromProviders({
            helia: node._helia,
            pubsubTopic: topic,
            routingKey,
            maxPeers: 4,
            validate: ipnsValidator,
            log
        });
        const elapsed = Date.now() - start;

        expect(result, "the record must be fetched once the direct addr lands in the peerstore").to.not.equal(undefined);
        expect(result!.source).to.equal("provider");
        expect(result!.peerId).to.equal(publisher.ID);
        expect(uint8ArrayEquals(result!.recordBytes, marshalled), "served record bytes must match").to.equal(true);
        expect(elapsed, `direct fetch took ${elapsed}ms, expected well under the 10s floor`).to.be.lessThan(FAST_FETCH_MAX_MS);

        // The dial that connected must have used the direct addr only — the circuit addr must
        // never appear in any dial target for the publisher.
        const publisherDialTargets = dialSpy.mock.calls
            .flatMap(([target]) => (Array.isArray(target) ? target : [target]))
            .map(String)
            .filter((target) => target === publisher.ID || target.includes(`/p2p/${publisher.ID}`));
        expect(publisherDialTargets.length, "the parked provider must have been dialed after the addr merge").to.be.greaterThan(0);
        expect(
            publisherDialTargets.some((target) => target.includes("p2p-circuit")),
            `no dial target for the publisher may include the circuit addr; targets: ${publisherDialTargets.join(", ")}`
        ).to.equal(false);
    });

    // Issue #215 / CodeRabbit on PR #214: the retry set matches dial failures by ERROR NAME, and
    // the tests so far only pinned "DialDeniedError". This pins the second name,
    // "NoValidAddressesError": libp2p throws it when every known addr is filtered out BEFORE the
    // gater runs — for a record whose addrs all use transports the node does not have. That is
    // exactly what a browser (no tcp/quic transports) sees on a tcp/quic-only record; this Node
    // client has no QUIC transport, so a quic-v1-only record reproduces it. If a libp2p upgrade
    // renames the error, the retry silently stops firing for this failure mode and this test
    // goes red. (An addr-less record cannot reproduce this: routers, including MockHttpRouter,
    // drop providers without addrs.) The dial-count assertion proves the failing initial dial
    // actually happened, so the test cannot pass vacuously via the slow router's own record.
    it("retries a provider whose record only has untransportable addrs after a slower router contributes dialable ones (issue #215)", async () => {
        const { routingKey, marshalled, topic, cid } = await makeRecord();
        const publisher = await startPublisherNode({ routingKey, recordToServe: marshalled });

        // Fast router: the publisher's peer id with only a quic-v1 addr (no QUIC transport here).
        const fastEmptyRouter = new MockHttpRouter();
        await fastEmptyRouter.start();
        startedRouters.push(fastEmptyRouter);
        fastEmptyRouter.addProviderForTesting(cid, { ID: publisher.ID, Addrs: ["/ip4/127.0.0.1/udp/40199/quic-v1"] });

        // Slow router: the SAME publisher with its real /ws addrs.
        const slowGoodRouter = new MockHttpRouter({ providerGetDelayMs: 800 });
        await slowGoodRouter.start();
        startedRouters.push(slowGoodRouter);
        slowGoodRouter.addProviderForTesting(cid, publisher);

        const node = await createNode({ routers: [fastEmptyRouter.url, slowGoodRouter.url] });
        const dialSpy = vi.spyOn(node._helia.libp2p, "dial");

        const start = Date.now();
        const result = await directFetchIpnsRecordFromProviders({
            helia: node._helia,
            pubsubTopic: topic,
            routingKey,
            maxPeers: 4,
            validate: ipnsValidator,
            log
        });
        const elapsed = Date.now() - start;

        expect(result, "the record must be fetched via a retry once the slower router's addrs are merged").to.not.equal(undefined);
        expect(result!.source).to.equal("provider");
        expect(result!.peerId).to.equal(publisher.ID);
        expect(uint8ArrayEquals(result!.recordBytes, marshalled), "served record bytes must match").to.equal(true);
        expect(elapsed, `direct fetch took ${elapsed}ms, expected well under the 10s floor`).to.be.lessThan(FAST_FETCH_MAX_MS);

        const publisherDialTargets = dialSpy.mock.calls
            .flatMap(([target]) => (Array.isArray(target) ? target : [target]))
            .map(String)
            .filter((target) => target === publisher.ID || target.includes(`/p2p/${publisher.ID}`));
        expect(
            publisherDialTargets.length,
            `expected the failing initial dial-by-id AND the retry dial (NoValidAddressesError path); targets: ${publisherDialTargets.join(", ")}`
        ).to.be.greaterThanOrEqual(2);
    });

    // Issue #215: the retry must fire off the peerstore merge (libp2p 'peer:update'), NOT off
    // provider-stream completion — a black-hole router (accepts the GET, never responds, never
    // closes) keeps the compound findProviders stream open indefinitely, so a retry gated on the
    // stream ending would never fire (and this test would time out). With the peer:update
    // trigger, the retry fires the moment the slow router's record merges, while the loop is
    // still pulling the black hole; the winning fetch then aborts findProviders and the call
    // returns.
    it("retries via the peerstore merge even while a black-hole router keeps the provider stream open (issue #215)", async () => {
        const { routingKey, marshalled, topic, cid } = await makeRecord();
        const publisher = await startPublisherNode({ routingKey, recordToServe: marshalled });

        const fastPoisonedRouter = new MockHttpRouter();
        await fastPoisonedRouter.start();
        startedRouters.push(fastPoisonedRouter);
        fastPoisonedRouter.addProviderForTesting(cid, { ID: publisher.ID, Addrs: ["/ip4/127.0.0.1/tcp/40199"] });

        const slowGoodRouter = new MockHttpRouter({ providerGetDelayMs: 800 });
        await slowGoodRouter.start();
        startedRouters.push(slowGoodRouter);
        slowGoodRouter.addProviderForTesting(cid, publisher);

        const blackHoleRouter = new MockHttpRouter({ faultMode: "blackHole" });
        await blackHoleRouter.start();
        startedRouters.push(blackHoleRouter);

        const node = await createNode({
            routers: [fastPoisonedRouter.url, slowGoodRouter.url, blackHoleRouter.url],
            libp2pOptions: {
                connectionGater: {
                    denyDialMultiaddr: (multiaddr: Multiaddr) =>
                        !multiaddr.getComponents().some((component) => component.name === "ws" || component.name === "wss")
                }
            }
        });

        const start = Date.now();
        const result = await directFetchIpnsRecordFromProviders({
            helia: node._helia,
            pubsubTopic: topic,
            routingKey,
            maxPeers: 4,
            validate: ipnsValidator,
            log
        });
        const elapsed = Date.now() - start;

        expect(result, "the record must be fetched despite the black-hole router keeping the stream open").to.not.equal(undefined);
        expect(result!.source).to.equal("provider");
        expect(result!.peerId).to.equal(publisher.ID);
        expect(elapsed, `direct fetch took ${elapsed}ms, expected well under the 10s floor`).to.be.lessThan(3_500);
    });

    // Issue #215 premise pin: the reason circuit-only providers are skipped in this path is that
    // /libp2p/fetch cannot run over a limited (relayed) connection — libp2p refuses to open the
    // protocol stream. This test asserts that with a REAL relay: if a libp2p upgrade or config
    // change ever makes this fetch succeed (e.g. @libp2p/fetch registering with
    // runOnLimitedConnection, see issue #215), this test goes red and the skip policy must be
    // re-evaluated — a relayed fetch would then be a usable last-resort tier.
    it("libp2p/fetch over a limited (relayed) connection fails with LimitedConnectionError (issue #215 premise)", async () => {
        const { routingKey, marshalled } = await makeRecord();

        // Relay: a pkc node with the circuit-relay-v2 server service added, listening on /ws.
        const relay = await createNode({ listen: true, libp2pOptions: { services: { relay: circuitRelayServer() } } });
        const relayWsAddr = relay._helia.libp2p
            .getMultiaddrs()
            .map((m) => m.toString())
            .find((a) => a.includes("/ws/"));
        expect(relayWsAddr, "relay must expose a ws multiaddr (with /p2p suffix)").to.not.equal(undefined);

        // Publisher: reachable ONLY via the relay (no direct listen addr), serving the record
        // over the fetch protocol like a real record host would.
        const publisher = await createNode({ libp2pOptions: { addresses: { listen: [`${relayWsAddr}/p2p-circuit`] } } });
        const fetchService = publisher._helia.libp2p.services.fetch;
        fetchService.unregisterLookupFunction("/ipns/");
        fetchService.registerLookupFunction("/ipns/", async (key: Uint8Array) => {
            if (uint8ArrayEquals(key, routingKey)) return marshalled;
            return undefined;
        });

        // Wait for the relay reservation: the publisher's multiaddrs gain the /p2p-circuit addr.
        const deadline = Date.now() + FAST_FETCH_MAX_MS;
        const circuitAddrOf = () =>
            publisher._helia.libp2p
                .getMultiaddrs()
                .map((m) => m.toString())
                .find((a) => a.includes("/p2p-circuit"));
        while (Date.now() < deadline && !circuitAddrOf()) await new Promise((r) => setTimeout(r, 100));
        const circuitAddr = circuitAddrOf();
        expect(circuitAddr, "publisher must obtain a relay reservation (/p2p-circuit multiaddr)").to.not.equal(undefined);

        // Dial the publisher THROUGH the relay: the resulting connection is limited.
        const node = await createNode({});
        const connection = await node._helia.libp2p.dial(publisher._helia.libp2p.getMultiaddrs());
        expect(connection.limits, "a relayed connection must be limited (data/duration caps)").to.not.equal(undefined);

        // The fetch protocol must refuse to run over it.
        let threw: Error | null = null;
        try {
            await node._helia.libp2p.services.fetch.fetch(publisher._helia.libp2p.peerId, routingKey);
        } catch (e) {
            threw = e as Error;
        }
        expect(threw, "fetch over a limited connection should have thrown").to.not.equal(null);
        expect(threw!.name).to.equal("LimitedConnectionError");
    });

    // Subscriber branch: the publisher is already in getSubscribers(topic) and there is NO router
    // record. The helper must still fetch from it — proving both sources are queried in parallel.
    it("fetches from a peer already in getSubscribers when no router record exists", async () => {
        const { routingKey, marshalled, topic } = await makeRecord();
        const publisher = await startPublisherNode({ routingKey, recordToServe: marshalled, subscribeTopic: topic });
        // Dummy router (localhost:1) serves nothing, so the provider branch finds no providers.
        const node = await createNode({ routers: ["http://localhost:1"] });

        // Establish the connection so gossipsub exchanges subscriptions and reports the publisher as
        // a subscriber. Dial by the publisher's full multiaddrs (they include the /p2p/<id> suffix).
        await node._helia.libp2p.dial(publisher.client._helia.libp2p.getMultiaddrs());

        const deadline = Date.now() + FAST_FETCH_MAX_MS;
        while (
            Date.now() < deadline &&
            !node._helia.libp2p.services.pubsub.getSubscribers(topic).some((p) => p.toString() === publisher.ID)
        )
            await new Promise((r) => setTimeout(r, 100));
        expect(
            node._helia.libp2p.services.pubsub.getSubscribers(topic).map((p) => p.toString()),
            "publisher should be a known subscriber before we fetch"
        ).to.include(publisher.ID);

        const result = await directFetchIpnsRecordFromProviders({
            helia: node._helia,
            pubsubTopic: topic,
            routingKey,
            maxPeers: 4,
            validate: ipnsValidator,
            log
        });

        expect(result, "should have fetched a record from the subscriber").to.not.equal(undefined);
        expect(result!.source).to.equal("subscriber");
        expect(result!.peerId).to.equal(publisher.ID);
        expect(uint8ArrayEquals(result!.recordBytes, marshalled)).to.equal(true);
    });

    // A provider that serves a record whose signature does NOT match the requested routing key must
    // be discarded by the validation gate — the helper must not return a poisoned value.
    it("discards a record that fails signature validation and returns undefined", async () => {
        const { routingKey, topic, cid } = await makeRecord();
        // A validly-signed record, but for a DIFFERENT name — ipnsValidator(routingKey, ...) will reject it.
        const foreign = await makeRecord();
        const publisher = await startPublisherNode({ routingKey, recordToServe: foreign.marshalled });
        const routerUrl = await startRouterServing(cid, publisher);
        const node = await createNode({ routers: [routerUrl] });

        const result = await directFetchIpnsRecordFromProviders({
            helia: node._helia,
            pubsubTopic: topic,
            routingKey,
            maxPeers: 4,
            validate: ipnsValidator,
            log
        });

        expect(result, "a bad-signature record must not win").to.equal(undefined);
    });

    // When no source has the record (provider dials but its fetch returns undefined), the helper
    // returns undefined so the caller can fall back to the legacy router.get() path.
    it("returns undefined when the discovered provider does not have the record", async () => {
        const { routingKey, topic, cid } = await makeRecord();
        const publisher = await startPublisherNode({ routingKey, recordToServe: undefined }); // lookup always misses
        const routerUrl = await startRouterServing(cid, publisher);
        const node = await createNode({ routers: [routerUrl] });

        const result = await directFetchIpnsRecordFromProviders({
            helia: node._helia,
            pubsubTopic: topic,
            routingKey,
            maxPeers: 4,
            validate: ipnsValidator,
            log
        });

        expect(result).to.equal(undefined);
    });

    // A pre-aborted caller signal must surface promptly as ERR_IPNS_DIRECT_FETCH_ABORTED, not hang.
    it("throws ERR_IPNS_DIRECT_FETCH_ABORTED promptly when the caller signal is already aborted", async () => {
        const { routingKey, topic, cid } = await makeRecord();
        const publisher = await startPublisherNode({ routingKey, recordToServe: (await makeRecord()).marshalled });
        const routerUrl = await startRouterServing(cid, publisher);
        const node = await createNode({ routers: [routerUrl] });

        const start = Date.now();
        let threw: (Error & { code?: string }) | null = null;
        try {
            await directFetchIpnsRecordFromProviders({
                helia: node._helia,
                pubsubTopic: topic,
                routingKey,
                maxPeers: 4,
                validate: ipnsValidator,
                log,
                options: { signal: AbortSignal.abort() }
            });
        } catch (e) {
            threw = e as Error & { code?: string };
        }
        const elapsed = Date.now() - start;

        expect(threw, "should have thrown on a pre-aborted signal").to.not.equal(null);
        expect(threw!.code ?? threw!.message).to.contain("ERR_IPNS_DIRECT_FETCH_ABORTED");
        expect(elapsed, `abort should be prompt, took ${elapsed}ms`).to.be.lessThan(FAST_FETCH_MAX_MS);
    });
});

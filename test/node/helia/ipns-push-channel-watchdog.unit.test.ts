import { afterEach, describe, expect, it } from "vitest";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import { MockHttpRouter } from "../../../dist/node/runtime/node/test/mock-http-router.js";
import { ipnsNameToIpnsOverPubsubTopic, pubsubTopicToDhtKeyCid } from "../../../dist/node/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { createIPNSRecord, marshalIPNSRecord, multihashToIPNSRoutingKey, unmarshalIPNSRecord } from "ipns";
import { pubSubIPNSRouting } from "@helia/ipns";
import { CID } from "multiformats/cid";
import { equals as uint8ArrayEquals } from "uint8arrays/equals";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";
import type { IpnsPubsubLocalStore } from "../../../dist/node/helia/util.js";
import type { PeerId } from "@libp2p/interface";

// Push-channel watchdog suite for issue #330: the ipns-pubsub-router spec's model is
// fetch-on-join plus gossip (kubo's go-libp2p-pubsub-router rebroadcasts its best record on the
// topic every 10 minutes and never refetches on a timer), so a subscribed name whose push
// channel is demonstrably alive must serve resolves from the cached record indefinitely, not
// revalidate over the network once per record-ttl window. "Demonstrably alive" is the watchdog:
// the topic has at least one gossipsub subscriber AND a signature-valid record arrived within
// the watchdog window (default 15 min = 1.5x kubo's rebroadcast interval), where an arrival is
// a gossiped record (identical rebroadcast bytes included), a record accepted into the local
// store from any path, or a validated network fetch. When the watchdog trips or the topic has
// no subscribers, the resolver falls back to the exact per-ttl revalidation behavior of issues
// #301/#307 (pinned by the fetch-call-count suite's zero-subscriber test).
//
// Written red-first: before the fix the two watchdog tests failed (the cache gate served only
// within the record ttl and refetched after it regardless of push-channel health), while the
// fetch-on-join pin and the nocache contract test passed before and after. The
// `_ipnsPushChannel` accesses go through a widening cast so the suite also runs (red) against a
// pre-fix dist where the field does not exist.
//
// Like the direct-fetch suite, this stands up a STARTED node-under-test plus real second libp2p
// nodes that listen on /ws and serve records over the fetch protocol. Client-side libp2p only
// and config-independent (never touches Kubo or the PKC RPC server), so it runs once under
// non-RPC via describeSkipIfRpc.
describeSkipIfRpc("IPNS push-channel watchdog (issue #330)", () => {
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

    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    type ClientWithPushChannel = Libp2pJsClient & { _ipnsPushChannel?: { watchdogMs: number } };

    const createNode = async (opts: { listen?: boolean; routers?: string[] } = {}): Promise<Libp2pJsClient> => {
        const client = (await createLibp2pJsClientOrUseExistingOne({
            key: `push-watchdog-${keyCounter++}`,
            httpRoutersOptions: opts.routers ?? ["http://localhost:1"],
            libp2pOptions: {
                ...(opts.listen ? { addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] } } : {})
            },
            heliaOptions: {}
        })) as Libp2pJsClient;
        clientsToStop.push(client);
        return client;
    };

    // Two distinct valid CIDv1 values so a resolve/cache read identifies WHICH record it came from.
    const VALUE_CID_SEQ1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    const VALUE_CID_SEQ2 = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

    const makeIpnsIdentity = async () => {
        const privateKey = await generateKeyPair("Ed25519");
        const ipnsPeerId = peerIdFromPrivateKey(privateKey);
        const routingKey = multihashToIPNSRoutingKey(ipnsPeerId.toMultihash());
        const topic = ipnsNameToIpnsOverPubsubTopic(ipnsPeerId.toString());
        const cid = pubsubTopicToDhtKeyCid(topic).toString();
        return { privateKey, ipnsPeerId, routingKey, topic, cid };
    };
    type IpnsIdentity = Awaited<ReturnType<typeof makeIpnsIdentity>>;

    // `ttlMs` becomes the record's ttl field: the window the pre-#330 cache gate serves within
    // (jittered to 0.75-1.0x), kept SHORT here so the suite can outlive it in seconds.
    const makeMarshalledRecord = async (identity: IpnsIdentity, valueCid: string, sequence: bigint, ttlMs: number): Promise<Uint8Array> =>
        marshalIPNSRecord(
            await createIPNSRecord(identity.privateKey, CID.parse(valueCid), sequence, 60 * 60 * 1000, {
                ttlNs: BigInt(ttlMs) * 1_000_000n
            })
        );

    // A real libp2p node that listens on /ws, serves `recordToServe` for `routingKey` over the
    // fetch protocol (counting every lookup it answers for that key), and subscribes to the topic
    // (via the GossipSub PROTOTYPE method, bypassing helia-for-pkc's instance-level subscribe
    // monkey-patch so it does not kick off its own warmup) so it can gossip on it and count as a
    // topic subscriber for the node-under-test's push-channel health check.
    const startPublisherNode = async (args: { routingKey: Uint8Array; recordToServe: Uint8Array; topic: string }) => {
        const client = await createNode({ listen: true });
        let fetchCount = 0;
        const fetchService = client._helia.libp2p.services.fetch;
        fetchService.unregisterLookupFunction("/ipns/");
        fetchService.registerLookupFunction("/ipns/", async (key: Uint8Array) => {
            if (!uint8ArrayEquals(key, args.routingKey)) return undefined;
            fetchCount++;
            return args.recordToServe;
        });
        const pubsub = client._helia.libp2p.services.pubsub;
        Object.getPrototypeOf(pubsub).subscribe.call(pubsub, args.topic);

        const wsAddrs = client._helia.libp2p
            .getMultiaddrs()
            .map((m) => m.toString())
            .filter((a) => a.includes("/ws"))
            .map((a) => a.replace(/\/p2p\/[^/]+$/, ""));
        expect(wsAddrs.length, "publisher must expose at least one ws multiaddr").to.be.greaterThan(0);
        return {
            client,
            ID: client._helia.libp2p.peerId.toString(),
            Addrs: wsAddrs,
            getFetchCount: () => fetchCount
        };
    };

    const startRouterServing = async (cid: string, provider: { ID: string; Addrs: string[] }): Promise<string> => {
        const router = new MockHttpRouter();
        await router.start();
        startedRouters.push(router);
        router.addProviderForTesting(cid, provider);
        return router.url;
    };

    // Drain name.resolve's async generator and return the final yielded value (an /ipfs/ path).
    const resolveOnce = async (node: Libp2pJsClient, ipnsName: string, options?: { nocache?: boolean }): Promise<string> => {
        const values: string[] = [];
        for await (const value of node.heliaWithKuboRpcClientFunctions.name.resolve(ipnsName, options)) values.push(value);
        expect(values.length, "name.resolve must yield at least one value").to.be.greaterThan(0);
        return values[values.length - 1];
    };

    // Wait until both nodes report each other as subscribers of `topic` — the health check's
    // "topic has subscribers" half, and the precondition for gossip delivery.
    const waitForMutualSubscription = async (a: Libp2pJsClient, b: Libp2pJsClient, topic: string): Promise<void> => {
        const seenBy = (viewer: Libp2pJsClient, target: Libp2pJsClient) =>
            viewer._helia.libp2p.services.pubsub.getSubscribers(topic).some((p) => p.toString() === target._helia.libp2p.peerId.toString());
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !(seenBy(a, b) && seenBy(b, a))) await sleep(200);
        expect(seenBy(a, b) && seenBy(b, a), "both nodes must see each other as topic subscribers").to.equal(true);
    };

    // Publish `data` on `topic` from `from` until `to`'s pubsub layer actually RECEIVES a message
    // on that topic, and return the receive time. Guards the rebroadcast tests against failing
    // for the wrong reason: after this returns the record demonstrably arrived at the node.
    const publishUntilReceived = async (args: {
        from: Libp2pJsClient;
        to: Libp2pJsClient;
        topic: string;
        data: Uint8Array;
    }): Promise<{ receivedAtMs: number }> => {
        let receivedAtMs: number | undefined;
        const onMessage = (evt: CustomEvent<{ topic: string }>) => {
            if (evt.detail.topic === args.topic && receivedAtMs === undefined) receivedAtMs = Date.now();
        };
        args.to._helia.libp2p.services.pubsub.addEventListener("message", onMessage);
        try {
            const deadline = Date.now() + 20_000;
            while (receivedAtMs === undefined && Date.now() < deadline) {
                try {
                    await args.from._helia.libp2p.services.pubsub.publish(args.topic, args.data);
                } catch {
                    // gossipsub throws NoPeersSubscribedToTopic until the mesh forms; keep retrying
                }
                await sleep(300);
            }
            expect(receivedAtMs, "the gossiped record must arrive at the node's pubsub layer").to.not.equal(undefined);
            return { receivedAtMs: receivedAtMs! };
        } finally {
            args.to._helia.libp2p.services.pubsub.removeEventListener("message", onMessage);
        }
    };

    // Read the record cached at the node's pubsub routing layer (same structural-access pattern
    // src uses: a fresh PubSubIPNSRouting wraps the SAME helia datastore).
    const readCachedRecordSequence = async (node: Libp2pJsClient, routingKey: Uint8Array): Promise<bigint | undefined> => {
        const localStore = (pubSubIPNSRouting(node._helia) as unknown as { localStore: IpnsPubsubLocalStore }).localStore;
        if (!(await localStore.has(routingKey))) return undefined;
        const { record } = await localStore.get(routingKey);
        return unmarshalIPNSRecord(record).sequence;
    };

    // The core issue #330 pin. A name whose topic HAS a live subscriber and whose record was
    // network-confirmed moments ago (the cold resolve's own fetch opens the trust window) must
    // keep serving resolves from cache PAST the record's ttl with zero further fetch calls.
    // Before the fix the cache gate refetches on the first resolve after ttl expiry no matter
    // what, which at N communities is the once-per-name-per-minute churn measured in the PR #331
    // baseline (138 calls per 5 minutes at 32 names).
    it("serves resolves past the record ttl with zero fetch calls while the push channel is healthy (issue #330)", async () => {
        const TTL_MS = 3_000;
        const identity = await makeIpnsIdentity();
        const record = await makeMarshalledRecord(identity, VALUE_CID_SEQ1, 1n, TTL_MS);
        const publisher = await startPublisherNode({ routingKey: identity.routingKey, recordToServe: record, topic: identity.topic });
        const routerUrl = await startRouterServing(identity.cid, publisher);
        const node = await createNode({ routers: [routerUrl] });

        const firstValue = await resolveOnce(node, identity.ipnsPeerId.toString());
        expect(firstValue).to.contain(VALUE_CID_SEQ1);
        const ttlExpiredAt = Date.now() + TTL_MS;
        await waitForMutualSubscription(node, publisher.client, identity.topic);
        const fetchesAfterFirstResolve = publisher.getFetchCount();
        expect(fetchesAfterFirstResolve, "the cold resolve must fetch over the network").to.be.greaterThan(0);

        // Well past the FULL (unjittered) ttl: expired for every jitter factor.
        await sleep(ttlExpiredAt + 600 - Date.now());
        for (let i = 0; i < 2; i++) {
            const value = await resolveOnce(node, identity.ipnsPeerId.toString());
            expect(value).to.contain(VALUE_CID_SEQ1);
        }
        expect(
            publisher.getFetchCount(),
            "a resolve past the record ttl must NOT refetch while the topic has a subscriber and a record was confirmed within the watchdog window (issue #330)"
        ).to.equal(fetchesAfterFirstResolve);
    });

    // The watchdog's two edges, with the window shrunk to seconds via the test hook. An
    // identical-bytes rebroadcast (what kubo's go-libp2p-pubsub-router emits every 10 minutes
    // when nothing changes) must EXTEND the serve window: the router's #handleRecord returns
    // before localStore.put on identical bytes, so this pins that arrivals are stamped from the
    // raw (validated) gossip message, not only from accepted-newer cache writes. And once the
    // channel then stays silent past the watchdog, the resolver must fall back to network
    // revalidation instead of serving a possibly-stale record forever.
    it("an identical-bytes rebroadcast keeps serving from cache past the watchdog, and silence past it revalidates (issue #330)", async () => {
        const TTL_MS = 2_000;
        const WATCHDOG_MS = 4_000;
        const identity = await makeIpnsIdentity();
        const record = await makeMarshalledRecord(identity, VALUE_CID_SEQ1, 1n, TTL_MS);
        const publisher = await startPublisherNode({ routingKey: identity.routingKey, recordToServe: record, topic: identity.topic });
        const routerUrl = await startRouterServing(identity.cid, publisher);
        const node = await createNode({ routers: [routerUrl] });
        const pushChannel = (node as ClientWithPushChannel)._ipnsPushChannel;
        if (pushChannel) pushChannel.watchdogMs = WATCHDOG_MS;

        const firstValue = await resolveOnce(node, identity.ipnsPeerId.toString());
        expect(firstValue).to.contain(VALUE_CID_SEQ1);
        const networkConfirmedAtMs = Date.now();
        await waitForMutualSubscription(node, publisher.client, identity.topic);
        const fetchesAfterFirstResolve = publisher.getFetchCount();

        // Rebroadcast the SAME bytes ~1s before the fetch-opened watchdog window would close.
        await sleep(networkConfirmedAtMs + WATCHDOG_MS - 1_000 - Date.now());
        const { receivedAtMs } = await publishUntilReceived({
            from: publisher.client,
            to: node,
            topic: identity.topic,
            data: record
        });

        // Past the watchdog as measured from the cold resolve's fetch, past the ttl many times
        // over, but within the watchdog as measured from the rebroadcast: must still be served
        // from cache. (The margin keeps this point at least 1s clear of the rebroadcast-opened
        // window's close even on a slow runner.)
        await sleep(networkConfirmedAtMs + WATCHDOG_MS + 1_000 - Date.now());
        expect(Date.now() - receivedAtMs).to.be.lessThan(WATCHDOG_MS - 1_000);
        const rebroadcastValue = await resolveOnce(node, identity.ipnsPeerId.toString());
        expect(rebroadcastValue).to.contain(VALUE_CID_SEQ1);
        expect(
            publisher.getFetchCount(),
            "an identical-bytes rebroadcast must keep the push channel healthy: no refetch while the last arrival is inside the watchdog window (issue #330)"
        ).to.equal(fetchesAfterFirstResolve);

        // Now let the channel go silent past the watchdog: the resolver must revalidate over the
        // network again (and only then), restoring the pre-#330 ttl behavior as the fallback.
        await sleep(receivedAtMs + WATCHDOG_MS + 600 - Date.now());
        const postSilenceValue = await resolveOnce(node, identity.ipnsPeerId.toString());
        expect(postSilenceValue).to.contain(VALUE_CID_SEQ1);
        expect(
            publisher.getFetchCount(),
            "silence past the watchdog must trip the resolver back to network revalidation"
        ).to.be.greaterThan(fetchesAfterFirstResolve);
    });

    // Fetch-on-join pin: the fix RELIES on @helia/ipns's PubSubIPNSRouting subscription-change
    // fast path (started since the helia 7 migration) to sync state on topology change, per the
    // ipns-pubsub-router spec ("whenever A notices any node that has connected to it and
    // subscribed to t it should run the Fetch protocol"). A peer that joins the topic holding a
    // NEWER record must have that record fetched from it and cached WITHOUT any resolve call. If
    // an @helia/ipns upgrade breaks this path, serving from cache while the mesh looks alive
    // would ride topology changes blind, so this must go red.
    it("a newer record held by a peer that joins the topic is fetched and cached without a resolve (issue #330)", async () => {
        const TTL_MS = 60_000;
        const identity = await makeIpnsIdentity();
        const seq1 = await makeMarshalledRecord(identity, VALUE_CID_SEQ1, 1n, TTL_MS);
        const publisher = await startPublisherNode({ routingKey: identity.routingKey, recordToServe: seq1, topic: identity.topic });
        const routerUrl = await startRouterServing(identity.cid, publisher);
        const node = await createNode({ routers: [routerUrl] });

        const firstValue = await resolveOnce(node, identity.ipnsPeerId.toString());
        expect(firstValue).to.contain(VALUE_CID_SEQ1);
        expect(await readCachedRecordSequence(node, identity.routingKey), "the cold resolve must cache seq 1").to.equal(1n);

        // The joiner: a fresh node whose OWN pubsub-router localStore (the default "/ipns/" fetch
        // lookup registered inside helia-for-pkc serves from it) is seeded with the seq 2 record.
        const joiner = await createNode({ listen: true });
        const joinerLocalStore = (pubSubIPNSRouting(joiner._helia) as unknown as { localStore: IpnsPubsubLocalStore }).localStore;
        const seq2 = await makeMarshalledRecord(identity, VALUE_CID_SEQ2, 2n, TTL_MS);
        await joinerLocalStore.put(identity.routingKey, seq2);

        // Connect first and wait until the node's pubsub router has the joiner in its fetch
        // topology (fetchPeers fills on identify discovering the fetch protocol) — the
        // subscription-change handler ignores peers it cannot fetch from, so subscribing before
        // this point would race identify and flake.
        await node._helia.libp2p.dial(joiner._helia.libp2p.getMultiaddrs());
        const nodePubsubRouter = node._heliaIpnsRouter.routers.find((r) => String(r) === "PubSubRouting()") as unknown as
            | { fetchPeers: { has(peerId: PeerId): boolean } }
            | undefined;
        expect(nodePubsubRouter, "the node's IPNS facade must carry the pubsub router").to.not.equal(undefined);
        const joinerPeerId = joiner._helia.libp2p.peerId;
        const topologyDeadline = Date.now() + 10_000;
        while (Date.now() < topologyDeadline && !nodePubsubRouter!.fetchPeers.has(joinerPeerId)) await sleep(100);
        expect(nodePubsubRouter!.fetchPeers.has(joinerPeerId), "the joiner must enter the fetch topology").to.equal(true);

        // NOW the joiner subscribes: the node's router must react to the subscription-change by
        // fetching the record from it and caching the newer seq 2 — no resolve call involved.
        const joinerPubsub = joiner._helia.libp2p.services.pubsub;
        Object.getPrototypeOf(joinerPubsub).subscribe.call(joinerPubsub, identity.topic);

        const cacheDeadline = Date.now() + 10_000;
        let cachedSequence = await readCachedRecordSequence(node, identity.routingKey);
        while (Date.now() < cacheDeadline && cachedSequence !== 2n) {
            await sleep(200);
            cachedSequence = await readCachedRecordSequence(node, identity.routingKey);
        }
        expect(cachedSequence, "the record held by the joining peer must be fetched and cached (fetch-on-join)").to.equal(2n);
    });

    // Contract pin, green before and after the fix: nocache: true must bypass cache serving even
    // while the push channel is healthy, mirroring kubo semantics — explicit refresh always hits
    // the network.
    it("nocache: true still fetches over the network while the push channel is healthy", async () => {
        const TTL_MS = 60_000;
        const identity = await makeIpnsIdentity();
        const record = await makeMarshalledRecord(identity, VALUE_CID_SEQ1, 1n, TTL_MS);
        const publisher = await startPublisherNode({ routingKey: identity.routingKey, recordToServe: record, topic: identity.topic });
        const routerUrl = await startRouterServing(identity.cid, publisher);
        const node = await createNode({ routers: [routerUrl] });

        const firstValue = await resolveOnce(node, identity.ipnsPeerId.toString());
        expect(firstValue).to.contain(VALUE_CID_SEQ1);
        await waitForMutualSubscription(node, publisher.client, identity.topic);
        const fetchesAfterFirstResolve = publisher.getFetchCount();

        const nocacheValue = await resolveOnce(node, identity.ipnsPeerId.toString(), { nocache: true });
        expect(nocacheValue).to.contain(VALUE_CID_SEQ1);
        expect(
            publisher.getFetchCount(),
            "nocache: true must bypass the healthy-channel cache serving and fetch over the network"
        ).to.be.greaterThan(fetchesAfterFirstResolve);
    });
});

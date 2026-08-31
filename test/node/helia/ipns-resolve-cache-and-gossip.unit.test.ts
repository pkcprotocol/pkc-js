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

// Repro suite for issue #301: the community update loop re-resolves IPNS over the network every
// second per community, while records pushed over the IPNS gossipsub topic never reach the local
// cache that a repeat resolve could serve from. The intended architecture (and upstream
// @helia/ipns's own design) is "fetch the record once over libp2p/fetch, then rely on gossipsub
// pushes": name.resolve subscribes to the topic and the pubsub router's handleRecord is supposed
// to keep its localStore fresh from gossiped records, so a repeat resolve of a subscribed name
// should be a local read, not a fresh multi-peer fetch race.
//
// Today both halves are broken:
// 1. name.resolve (src/helia/helia-for-pkc.ts) runs directFetchIpnsRecordFromProviders on every
//    call. Nothing ever reads the localStore, so each of the update loop's 1s iterations pays a
//    full network fetch per community (the measured ~150 fetch streams/s at 64 communities).
// 2. The gossip-to-cache leg is dead: the pubsub router's message listener drops any message
//    whose topic is not in its private `subscriptions` Set, and that Set is only populated inside
//    router.get() (the legacy fallback). The fast path subscribes via libp2p directly, so
//    gossiped record pushes arrive at the node and are then discarded. Only direct-fetch results
//    reach the cache (cacheIpnsRecordInPubsubLocalStore, issue #210).
//
// Expected outcome on master: the three "(issue #301)" tests FAIL (they pin the desired
// fetch-once-then-listen behavior); the nocache contract test passes and must stay green after
// the fix so explicit cache bypass keeps working.
//
// Like the direct-fetch suite, this stands up a STARTED node-under-test plus a real second libp2p
// node serving the record over the fetch protocol. Client-side libp2p only and config-independent
// (never touches Kubo or the PKC RPC server), so it runs once under non-RPC via describeSkipIfRpc.
describeSkipIfRpc("IPNS resolve cache and gossipsub push (issue #301)", () => {
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

    const createNode = async (opts: { listen?: boolean; routers?: string[] } = {}): Promise<Libp2pJsClient> => {
        const client = (await createLibp2pJsClientOrUseExistingOne({
            key: `resolve-cache-${keyCounter++}`,
            httpRoutersOptions: opts.routers ?? ["http://localhost:1"],
            libp2pOptions: {
                ...(opts.listen ? { addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] } } : {})
            },
            heliaOptions: {}
        })) as Libp2pJsClient;
        clientsToStop.push(client);
        return client;
    };

    // Two distinct valid CIDv1 values so a resolve result identifies WHICH record it came from.
    const VALUE_CID_SEQ1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
    const VALUE_CID_SEQ2 = "bafybeihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku";

    // A fresh IPNS name plus everything derived from it. Records for the same name are minted
    // separately (makeMarshalledRecord) so a test can gossip a NEWER record for a name it
    // already served an older record for.
    const makeIpnsIdentity = async () => {
        const privateKey = await generateKeyPair("Ed25519");
        const ipnsPeerId = peerIdFromPrivateKey(privateKey);
        const routingKey = multihashToIPNSRoutingKey(ipnsPeerId.toMultihash());
        const topic = ipnsNameToIpnsOverPubsubTopic(ipnsPeerId.toString());
        const cid = pubsubTopicToDhtKeyCid(topic).toString();
        return { privateKey, ipnsPeerId, routingKey, topic, cid };
    };
    type IpnsIdentity = Awaited<ReturnType<typeof makeIpnsIdentity>>;

    const makeMarshalledRecord = async (identity: IpnsIdentity, valueCid: string, sequence: bigint): Promise<Uint8Array> =>
        marshalIPNSRecord(await createIPNSRecord(identity.privateKey, CID.parse(valueCid), sequence, 60 * 60 * 1000));

    // A real libp2p node that listens on /ws and serves a (mutable) record for `routingKey` over
    // the fetch protocol, counting every lookup it answers for that key. The counter is the
    // network-traffic oracle: it grows if and only if the node-under-test fetched the record over
    // the network. If `subscribeTopic` is given the node also subscribes (via the GossipSub
    // PROTOTYPE method, bypassing helia-for-pkc's instance-level subscribe monkey-patch so it
    // does not kick off its own warmup), so it can later gossip records on the topic.
    const startPublisherNode = async (args: { routingKey: Uint8Array; subscribeTopic?: string }) => {
        const client = await createNode({ listen: true });
        let servedRecord: Uint8Array | undefined;
        let fetchCount = 0;
        const fetchService = client._helia.libp2p.services.fetch;
        fetchService.unregisterLookupFunction("/ipns/");
        fetchService.registerLookupFunction("/ipns/", async (key: Uint8Array) => {
            if (uint8ArrayEquals(key, args.routingKey)) {
                fetchCount++;
                return servedRecord;
            }
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
        return {
            client,
            ID: client._helia.libp2p.peerId.toString(),
            Addrs: wsAddrs,
            setServedRecord: (record: Uint8Array) => {
                servedRecord = record;
            },
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

    // Read the record cached at the pubsub routing layer for `routingKey`, or undefined when the
    // cache is empty. A fresh PubSubIPNSRouting instance wraps the SAME helia datastore as the one
    // inside helia-for-pkc (this is the exact access pattern src uses for the issue #210 write),
    // so its localStore reads the node's real cache.
    const localStoreByNode = new Map<Libp2pJsClient, IpnsPubsubLocalStore>();
    const readCachedRecordSequence = async (node: Libp2pJsClient, routingKey: Uint8Array): Promise<bigint | undefined> => {
        let localStore = localStoreByNode.get(node);
        if (!localStore) {
            localStore = (pubSubIPNSRouting(node._helia) as unknown as { localStore: IpnsPubsubLocalStore }).localStore;
            localStoreByNode.set(node, localStore);
        }
        if (!(await localStore.has(routingKey))) return undefined;
        const { record } = await localStore.get(routingKey);
        return unmarshalIPNSRecord(record).sequence;
    };
    afterEach(() => localStoreByNode.clear());

    // Wait until both nodes report each other as subscribers of `topic`, i.e. gossipsub has
    // exchanged subscriptions over the live connection and a publish can be delivered.
    const waitForMutualSubscription = async (a: Libp2pJsClient, b: Libp2pJsClient, topic: string): Promise<void> => {
        const seenBy = (viewer: Libp2pJsClient, target: Libp2pJsClient) =>
            viewer._helia.libp2p.services.pubsub.getSubscribers(topic).some((p) => p.toString() === target._helia.libp2p.peerId.toString());
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline && !(seenBy(a, b) && seenBy(b, a))) await sleep(200);
        expect(seenBy(a, b) && seenBy(b, a), "both nodes must see each other as topic subscribers").to.equal(true);
    };

    // Publish `data` on `topic` from `from` until `to`'s pubsub layer actually RECEIVES a message
    // on that topic. This guards the gossip tests against failing for the wrong reason: after this
    // returns, the record demonstrably arrived at the node, so a stale cache can only mean the
    // routing layer dropped it.
    const publishUntilReceived = async (args: {
        from: Libp2pJsClient;
        to: Libp2pJsClient;
        topic: string;
        data: Uint8Array;
    }): Promise<void> => {
        let received = false;
        const onMessage = (evt: CustomEvent<{ topic: string }>) => {
            if (evt.detail.topic === args.topic) received = true;
        };
        args.to._helia.libp2p.services.pubsub.addEventListener("message", onMessage);
        try {
            const deadline = Date.now() + 20_000;
            while (!received && Date.now() < deadline) {
                try {
                    await args.from._helia.libp2p.services.pubsub.publish(args.topic, args.data);
                } catch {
                    // gossipsub throws NoPeersSubscribedToTopic until the mesh forms; keep retrying
                }
                await sleep(300);
            }
            expect(received, "the gossiped record must arrive at the node's pubsub layer").to.equal(true);
        } finally {
            args.to._helia.libp2p.services.pubsub.removeEventListener("message", onMessage);
        }
    };

    // The core churn pin. After a resolve has fetched, validated, and cached the record (issue
    // #210 write) and left the topic subscribed, resolving the same name again must be served
    // locally: the publisher must see ZERO additional fetch lookups. On master every resolve runs
    // the direct-fetch race unconditionally, so the counter grows with each call. This is the
    // per-iteration network cost the update loop pays per community per second.
    it("serves a repeat resolve of a subscribed, cached name locally instead of re-fetching (issue #301)", async () => {
        const identity = await makeIpnsIdentity();
        const publisher = await startPublisherNode({ routingKey: identity.routingKey });
        publisher.setServedRecord(await makeMarshalledRecord(identity, VALUE_CID_SEQ1, 1n));
        const routerUrl = await startRouterServing(identity.cid, publisher);
        const node = await createNode({ routers: [routerUrl] });

        const firstValue = await resolveOnce(node, identity.ipnsPeerId.toString());
        expect(firstValue, "first resolve must return the served record's value").to.contain(VALUE_CID_SEQ1);
        const fetchesAfterFirstResolve = publisher.getFetchCount();
        expect(fetchesAfterFirstResolve, "the first (cold) resolve must fetch over the network").to.be.greaterThan(0);

        // The preconditions of "rely on the subscription from here on" hold: the topic is
        // subscribed and the validated record is in the routing-layer cache.
        expect(node._helia.libp2p.services.pubsub.getTopics(), "resolve must leave the ipns topic subscribed").to.include(identity.topic);
        expect(await readCachedRecordSequence(node, identity.routingKey), "resolve must cache the fetched record").to.equal(1n);

        for (let i = 0; i < 2; i++) {
            const repeatValue = await resolveOnce(node, identity.ipnsPeerId.toString());
            expect(repeatValue, "repeat resolve must still return the record's value").to.contain(VALUE_CID_SEQ1);
        }
        expect(
            publisher.getFetchCount(),
            "a repeat resolve of a subscribed name with a fresh cached record must not fetch over the network again"
        ).to.equal(fetchesAfterFirstResolve);
    });

    // The gossip-to-cache pin. A newer record pushed over the topic after a fast-path resolve
    // must reach the routing-layer cache (handleRecord's job, newest-wins via ipnsSelector). On
    // master the router's message listener drops it: its private `subscriptions` Set is only
    // populated by router.get(), which the fast path never calls, so the push is received by
    // gossipsub and then discarded, and the cache stays at seq 1.
    it("caches a newer record gossiped on the topic after a fast-path resolve (issue #301)", async () => {
        const identity = await makeIpnsIdentity();
        const publisher = await startPublisherNode({ routingKey: identity.routingKey, subscribeTopic: identity.topic });
        publisher.setServedRecord(await makeMarshalledRecord(identity, VALUE_CID_SEQ1, 1n));
        const routerUrl = await startRouterServing(identity.cid, publisher);
        const node = await createNode({ routers: [routerUrl] });

        const firstValue = await resolveOnce(node, identity.ipnsPeerId.toString());
        expect(firstValue).to.contain(VALUE_CID_SEQ1);
        expect(await readCachedRecordSequence(node, identity.routingKey), "resolve must cache the fetched record").to.equal(1n);

        await waitForMutualSubscription(node, publisher.client, identity.topic);
        const seq2Record = await makeMarshalledRecord(identity, VALUE_CID_SEQ2, 2n);
        await publishUntilReceived({ from: publisher.client, to: node, topic: identity.topic, data: seq2Record });

        // The push arrived at the node; the routing layer must cache it (the write may be async,
        // so poll briefly before judging).
        const deadline = Date.now() + 5_000;
        let cachedSequence = await readCachedRecordSequence(node, identity.routingKey);
        while (Date.now() < deadline && cachedSequence !== 2n) {
            await sleep(200);
            cachedSequence = await readCachedRecordSequence(node, identity.routingKey);
        }
        expect(cachedSequence, "a record gossiped on the subscribed topic must reach the routing-layer cache").to.equal(2n);
    });

    // The end-to-end pin: the user-visible consequence of the two gaps above. The publisher keeps
    // serving the STALE seq 1 record over libp2p/fetch but gossips a NEWER seq 2 record on the
    // topic. A resolve after the push must surface seq 2's value. On master it never does: each
    // resolve re-fetches seq 1 from the network and the gossiped seq 2 is dropped, which is
    // exactly why the update loop can burn ~150 fetch streams/s without ever being fresher than
    // plain fetch-on-demand.
    it("resolves to the newest gossiped record instead of re-fetching a stale one (issue #301)", async () => {
        const identity = await makeIpnsIdentity();
        const publisher = await startPublisherNode({ routingKey: identity.routingKey, subscribeTopic: identity.topic });
        publisher.setServedRecord(await makeMarshalledRecord(identity, VALUE_CID_SEQ1, 1n));
        const routerUrl = await startRouterServing(identity.cid, publisher);
        const node = await createNode({ routers: [routerUrl] });

        const firstValue = await resolveOnce(node, identity.ipnsPeerId.toString());
        expect(firstValue).to.contain(VALUE_CID_SEQ1);

        await waitForMutualSubscription(node, publisher.client, identity.topic);
        const seq2Record = await makeMarshalledRecord(identity, VALUE_CID_SEQ2, 2n);
        await publishUntilReceived({ from: publisher.client, to: node, topic: identity.topic, data: seq2Record });

        // Poll resolve: once the pushed record is honored, the newest value must win (the cache
        // write may land asynchronously after receipt, hence the retry loop).
        const deadline = Date.now() + 8_000;
        let value = await resolveOnce(node, identity.ipnsPeerId.toString());
        while (Date.now() < deadline && !value.includes(VALUE_CID_SEQ2)) {
            await sleep(500);
            value = await resolveOnce(node, identity.ipnsPeerId.toString());
        }
        expect(value, "resolve must surface the newest (gossiped) record, not the stale re-fetched one").to.contain(VALUE_CID_SEQ2);
    });

    // Contract pin for the fix, green on master: nocache: true must BYPASS any cache and fetch
    // over the network, mirroring kubo and @helia/ipns semantics. Whatever cache-serving the
    // issue #301 fix introduces must keep an explicit refresh possible, or "refresh" buttons and
    // deliberate cache-busting callers silently go stale.
    it("nocache: true still fetches the record over the network when a cached record exists", async () => {
        const identity = await makeIpnsIdentity();
        const publisher = await startPublisherNode({ routingKey: identity.routingKey });
        publisher.setServedRecord(await makeMarshalledRecord(identity, VALUE_CID_SEQ1, 1n));
        const routerUrl = await startRouterServing(identity.cid, publisher);
        const node = await createNode({ routers: [routerUrl] });

        const firstValue = await resolveOnce(node, identity.ipnsPeerId.toString());
        expect(firstValue).to.contain(VALUE_CID_SEQ1);
        expect(await readCachedRecordSequence(node, identity.routingKey), "resolve must cache the fetched record").to.equal(1n);
        const fetchesAfterFirstResolve = publisher.getFetchCount();

        const nocacheValue = await resolveOnce(node, identity.ipnsPeerId.toString(), { nocache: true });
        expect(nocacheValue).to.contain(VALUE_CID_SEQ1);
        expect(publisher.getFetchCount(), "nocache: true must bypass the cached record and fetch over the network").to.be.greaterThan(
            fetchesAfterFirstResolve
        );
    });
});

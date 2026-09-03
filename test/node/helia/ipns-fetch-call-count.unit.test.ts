import { afterEach, describe, expect, it } from "vitest";
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

// Fetch-protocol call-count pins for the IPNS resolution path (issues #329 and #330). The #329
// evidence measured 389 libp2p/fetch calls to ONE peer in ~3.5 minutes at 64 updating
// communities; this suite counts every /ipns/ fetch lookup a record host actually answers (the
// network-traffic oracle, same pattern as the issue #301 suite) and pins the per-race and
// per-ttl-window bounds so the volume cannot silently regress toward those numbers:
//
// - one direct-fetch race asks each DISTINCT peer exactly once (subscriber branch + provider
//   branch, no branch may ask a peer twice on its own);
// - a peer that is BOTH a topic subscriber and a router provider is asked at most twice per race
//   (today exactly twice, one call per branch; the issue #329 fix must tighten this to once);
// - the resolve path pays exactly ONE fetch round per name per record-ttl window and ZERO inside
//   the window (the cache gate, issues #301/#307). Per issue #330 this once-per-window
//   revalidation itself deviates from the ipns-pubsub-router spec (fetch-on-join + gossip, no
//   timer refetch), so the spec-alignment fix should tighten the post-expiry bound from one round
//   to zero for a subscribed name with a healthy mesh.
//
// Like the direct-fetch suite, this stands up a STARTED node-under-test plus real second libp2p
// nodes that listen on /ws and serve the record over the fetch protocol. Client-side libp2p only
// and config-independent (never touches Kubo or the PKC RPC server), so it runs once under
// non-RPC via describeSkipIfRpc.
describeSkipIfRpc("IPNS fetch-protocol call counts (issues #329/#330)", () => {
    const log = Logger("pkc-js:test:fetch-call-count");
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
            key: `fetch-call-count-${keyCounter++}`,
            httpRoutersOptions: opts.routers ?? ["http://localhost:1"],
            libp2pOptions: {
                ...(opts.listen ? { addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] } } : {})
            },
            heliaOptions: {}
        })) as Libp2pJsClient;
        clientsToStop.push(client);
        return client;
    };

    const VALUE_CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

    // A fresh IPNS name + a validly-signed record for it. `ttlMs` becomes the record's ttl field,
    // which is what the resolve path's cache gate serves within (jittered to 0.75-1.0x, issue
    // #307), so the ttl-window test can use a short window instead of the 60s production default.
    const makeRecord = async (opts: { ttlMs?: number } = {}) => {
        const privateKey = await generateKeyPair("Ed25519");
        const ipnsPeerId = peerIdFromPrivateKey(privateKey);
        const record = await createIPNSRecord(
            privateKey,
            CID.parse(VALUE_CID),
            1n,
            60 * 60 * 1000,
            opts.ttlMs !== undefined ? { ttlNs: BigInt(opts.ttlMs) * 1_000_000n } : undefined
        );
        const marshalled = marshalIPNSRecord(record);
        const routingKey = multihashToIPNSRoutingKey(ipnsPeerId.toMultihash());
        const topic = ipnsNameToIpnsOverPubsubTopic(ipnsPeerId.toString());
        const cid = pubsubTopicToDhtKeyCid(topic).toString();
        return { privateKey, ipnsPeerId, record, marshalled, routingKey, topic, cid };
    };

    // A real libp2p node that listens on /ws and serves `recordToServe` for `routingKey` over the
    // fetch protocol, counting every /ipns/ lookup it answers for that key. `lookupDelayMs` holds
    // each answer open so that when a race asks the same peer from two branches, BOTH calls are
    // demonstrably in flight before the first one returns and the counter deterministically sees
    // both (a fast answer would let the winner check skip the second branch and hide the issue
    // #329 duplicate). If `subscribeTopic` is given, the node also subscribes to that topic (via
    // the GossipSub PROTOTYPE method, bypassing helia-for-pkc's instance-level subscribe
    // monkey-patch so it does not kick off its own warmup).
    const startPublisherNode = async (args: {
        routingKey: Uint8Array;
        recordToServe: Uint8Array;
        subscribeTopic?: string;
        lookupDelayMs?: number;
    }) => {
        const client = await createNode({ listen: true });
        let fetchCount = 0;
        const fetchService = client._helia.libp2p.services.fetch;
        fetchService.unregisterLookupFunction("/ipns/");
        fetchService.registerLookupFunction("/ipns/", async (key: Uint8Array) => {
            if (!uint8ArrayEquals(key, args.routingKey)) return undefined;
            fetchCount++;
            if (args.lookupDelayMs) await sleep(args.lookupDelayMs);
            return args.recordToServe;
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

    // Dial `publisher` from `node` and wait until gossipsub reports it as a subscriber of `topic`,
    // so the subscriber branch of a subsequent race deterministically includes it.
    const connectUntilSeenAsSubscriber = async (
        node: Libp2pJsClient,
        publisher: { client: Libp2pJsClient; ID: string },
        topic: string
    ): Promise<void> => {
        await node._helia.libp2p.dial(publisher.client._helia.libp2p.getMultiaddrs());
        const deadline = Date.now() + 15_000;
        while (
            Date.now() < deadline &&
            !node._helia.libp2p.services.pubsub.getSubscribers(topic).some((p) => p.toString() === publisher.ID)
        )
            await sleep(100);
        expect(
            node._helia.libp2p.services.pubsub.getSubscribers(topic).map((p) => p.toString()),
            "publisher must be a known subscriber before the race starts"
        ).to.include(publisher.ID);
    };

    // Both branches of one race, distinct peers: the subscriber branch asks the subscribed peer,
    // the provider branch asks the router-discovered peer, and neither branch may ask its peer
    // more than once. The slow lookups keep both calls in flight until both are counted, so a
    // regression that re-asks a peer within one branch (e.g. the issue #215 addr-merge retry
    // re-fetching a peer that already answered) shows up as a count above 1.
    it("one direct-fetch race asks each distinct peer exactly once", async () => {
        const { routingKey, marshalled, topic, cid } = await makeRecord();
        const subscriberPeer = await startPublisherNode({ routingKey, recordToServe: marshalled, subscribeTopic: topic, lookupDelayMs: 1_000 });
        const providerPeer = await startPublisherNode({ routingKey, recordToServe: marshalled, lookupDelayMs: 1_000 });
        const routerUrl = await startRouterServing(cid, providerPeer);
        const node = await createNode({ routers: [routerUrl] });
        await connectUntilSeenAsSubscriber(node, subscriberPeer, topic);

        const result = await directFetchIpnsRecordFromProviders({
            helia: node._helia,
            pubsubTopic: topic,
            routingKey,
            maxPeers: 4,
            validate: ipnsValidator,
            log
        });

        expect(result, "the race must produce a record").to.not.equal(undefined);
        expect(subscriberPeer.getFetchCount(), "the subscriber peer must be asked exactly once").to.equal(1);
        expect(providerPeer.getFetchCount(), "the provider peer must be asked exactly once").to.equal(1);
    });

    // Issue #329: a peer that is BOTH a topic subscriber and a router provider is asked by both
    // branches concurrently, so today it deterministically answers TWO lookups per race (the slow
    // lookup guarantees the second call starts before the first returns, exactly like a real peer
    // answering under network latency; the loser is then aborted). The at-most-2 bound is the
    // "not going overboard" guard: a third call would mean a NEW duplication source on top of
    // #329. The #329 fix (per-race attempted-peer set) must tighten this assertion to exactly 1.
    it("a peer that is both subscriber and provider is asked at most twice per race (issue #329)", async () => {
        const { routingKey, marshalled, topic, cid } = await makeRecord();
        const publisher = await startPublisherNode({ routingKey, recordToServe: marshalled, subscribeTopic: topic, lookupDelayMs: 1_000 });
        const routerUrl = await startRouterServing(cid, publisher);
        const node = await createNode({ routers: [routerUrl] });
        await connectUntilSeenAsSubscriber(node, publisher, topic);

        const result = await directFetchIpnsRecordFromProviders({
            helia: node._helia,
            pubsubTopic: topic,
            routingKey,
            maxPeers: 4,
            validate: ipnsValidator,
            log
        });

        expect(result, "the race must produce a record").to.not.equal(undefined);
        expect(publisher.getFetchCount(), "the dual-role peer must be asked at least once").to.be.greaterThanOrEqual(1);
        expect(
            publisher.getFetchCount(),
            "a peer that is both subscriber and provider must not be asked more than once per branch (issue #329 caps this at 2; its fix tightens it to 1)"
        ).to.be.lessThanOrEqual(2);
    });

    // Drain name.resolve's async generator and return the final yielded value (an /ipfs/ path).
    const resolveOnce = async (node: Libp2pJsClient, ipnsName: string): Promise<string> => {
        const values: string[] = [];
        for await (const value of node.heliaWithKuboRpcClientFunctions.name.resolve(ipnsName)) values.push(value);
        expect(values.length, "name.resolve must yield at least one value").to.be.greaterThan(0);
        return values[values.length - 1];
    };

    // The steady-state cost pin for the update loop (issue #330). With the cache gate in place
    // (issues #301/#307), a name's network cost must be exactly one fetch round per record-ttl
    // window: the cold resolve fetches once, every resolve inside the (jittered, 0.75-1.0x ttl)
    // window is a local cache read with ZERO fetch calls, the first resolve after expiry
    // revalidates with exactly ONE more call, and the revalidation opens a fresh window. This is
    // what bounds N updating communities to N fetch rounds per ttl window instead of the
    // per-second churn of issue #301 or the 389-calls-per-peer volume of issue #329. Per issue
    // #330 the post-expiry revalidation itself deviates from the ipns-pubsub-router spec
    // (fetch-on-join + gossip, no timer refetch): the spec-alignment fix should tighten the
    // post-expiry delta below from 1 to 0 for a subscribed name with a healthy mesh.
    it("the resolve path pays exactly one fetch round per name per ttl window (issue #330)", async () => {
        const TTL_MS = 5_000; // effective serve window after jitter: 3750-5000ms
        const { routingKey, marshalled, topic, cid, ipnsPeerId } = await makeRecord({ ttlMs: TTL_MS });
        const publisher = await startPublisherNode({ routingKey, recordToServe: marshalled });
        const routerUrl = await startRouterServing(cid, publisher);
        const node = await createNode({ routers: [routerUrl] });

        // Cold resolve: one fetch round against the single provider = exactly one call.
        const firstValue = await resolveOnce(node, ipnsPeerId.toString());
        const windowOpenedAt = Date.now();
        expect(firstValue, "the cold resolve must return the served record's value").to.contain(VALUE_CID);
        expect(publisher.getFetchCount(), "the cold resolve must fetch exactly once from the only peer").to.equal(1);
        expect(node._helia.libp2p.services.pubsub.getTopics(), "resolve must leave the ipns topic subscribed").to.include(topic);

        // Inside the serve window (well under the 3750ms jitter floor): local reads, zero calls.
        for (let i = 0; i < 3; i++) {
            const repeatValue = await resolveOnce(node, ipnsPeerId.toString());
            expect(repeatValue).to.contain(VALUE_CID);
        }
        expect(publisher.getFetchCount(), "resolves inside the ttl window must make zero fetch calls").to.equal(1);
        expect(Date.now() - windowOpenedAt, "the in-window resolves must have finished under the jitter floor").to.be.lessThan(3_000);

        // Past the full (unjittered) ttl the window has expired for every jitter factor: the next
        // resolve must revalidate with exactly one more call, and only one.
        await sleep(windowOpenedAt + TTL_MS + 600 - Date.now());
        const postExpiryValue = await resolveOnce(node, ipnsPeerId.toString());
        expect(postExpiryValue).to.contain(VALUE_CID);
        expect(publisher.getFetchCount(), "the first resolve after ttl expiry must revalidate with exactly one fetch call").to.equal(2);

        // The revalidation stamped a fresh window (even though the refetched bytes were identical
        // to the cache): the next resolve is a local read again.
        const reopenedValue = await resolveOnce(node, ipnsPeerId.toString());
        expect(reopenedValue).to.contain(VALUE_CID);
        expect(publisher.getFetchCount(), "a resolve right after the revalidation must make zero fetch calls").to.equal(2);
    });
});

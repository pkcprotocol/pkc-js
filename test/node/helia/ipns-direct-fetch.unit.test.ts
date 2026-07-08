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

    const createNode = async (opts: { listen?: boolean; routers?: string[] } = {}): Promise<Libp2pJsClient> => {
        const client = (await createLibp2pJsClientOrUseExistingOne({
            key: `direct-fetch-${keyCounter++}`,
            httpRoutersOptions: opts.routers ?? ["http://localhost:1"],
            libp2pOptions: opts.listen ? { addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] } } : {},
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

import { afterEach, expect, it, vi } from "vitest";
import { multiaddr } from "@multiformats/multiaddr";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";

// Issue #602. @libp2p/gossipsub keeps a per-peer memory budget for the topics a peer subscribes to
// (maxTopicBytesPerPeer, about 1 KiB per topic). Subscriptions past the budget are ignored, and the peer
// is then never picked as a publish recipient for those topics. With gossipsub's 1 MiB default a client
// remembered about 1000 topics per peer, so a node hosting or seeding more communities than that (each
// has a pubsub topic and an IPNS record topic) silently lost part of its topics on every client.
//
// Client-side libp2p only: two in-process nodes, no Kubo and no PKC RPC server, so it runs once under
// non-RPC via describeSkipIfRpc.
describeSkipIfRpc("gossipsub per-peer topic budget (issue #602)", () => {
    // Over gossipsub's 1 MiB default (about 1000 topics), under the 8 MiB pkc-js sets (about 8000)
    const TOPIC_COUNT = 1100;
    const clientsToStop: Libp2pJsClient[] = [];
    let keyCounter = 0;

    afterEach(async () => {
        while (clientsToStop.length) await clientsToStop.pop()!.heliaWithKuboRpcClientFunctions.stop();
    });

    const createNode = async (opts: { listen?: boolean } = {}): Promise<Libp2pJsClient> => {
        const client = (await createLibp2pJsClientOrUseExistingOne({
            key: `topic-budget-${Date.now()}-${keyCounter++}`,
            httpRoutersOptions: ["http://localhost:1"],
            libp2pOptions: opts.listen ? { addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] } } : {},
            heliaOptions: {}
        })) as Libp2pJsClient;
        clientsToStop.push(client);
        return client;
    };

    it(`remembers all ${TOPIC_COUNT} topics of one peer, and publishes to it on the last of them`, async () => {
        const peerWithManyTopics = await createNode({ listen: true });
        const topics = Array.from({ length: TOPIC_COUNT }, (_, i) => `issue-602-topic-${i}`);
        const peerPubsub = peerWithManyTopics._helia.libp2p.services.pubsub;
        // the GossipSub prototype method, bypassing helia-for-pkc's subscribe patch that starts a warmup per topic
        for (const topic of topics) Object.getPrototypeOf(peerPubsub).subscribe.call(peerPubsub, topic);

        const client = await createNode();
        const peerId = peerWithManyTopics._helia.libp2p.peerId;
        const wsAddr = peerWithManyTopics._helia.libp2p
            .getMultiaddrs()
            .map((m) => m.toString())
            .find((a) => a.includes("/ws"));
        expect(wsAddr, "the peer must listen on a ws multiaddr").to.be.a("string");
        await client._helia.libp2p.dial(multiaddr(wsAddr!));

        const clientPubsub = client._helia.libp2p.services.pubsub;
        const topicsThePeerIsKnownFor = () =>
            topics.filter((topic) => clientPubsub.getSubscribers(topic).some((subscriber) => subscriber.equals(peerId))).length;
        await vi.waitFor(() => expect(topicsThePeerIsKnownFor()).to.equal(TOPIC_COUNT), { timeout: 20000, interval: 100 });

        // A topic past the old budget: the peer has to be a recipient of a publish to it
        const lastTopic = topics[TOPIC_COUNT - 1];
        const { recipients } = await Object.getPrototypeOf(clientPubsub).publish.call(
            clientPubsub,
            lastTopic,
            new TextEncoder().encode("hi")
        );
        expect(recipients.map(String)).to.include(peerId.toString());
    });
});

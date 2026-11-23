import { afterEach, expect, it, vi } from "vitest";
import { multiaddr } from "@multiformats/multiaddr";
import { gossipsub } from "@libp2p/gossipsub";
import {
    createLibp2pJsClientOrUseExistingOne,
    GOSSIPSUB_MAX_SUBSCRIPTIONS_PER_MESSAGE,
    GOSSIPSUB_MAX_TOPIC_BYTES_PER_PEER
} from "../../../dist/node/helia/helia-for-pkc.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";

type Libp2pOptions = Parameters<typeof createLibp2pJsClientOrUseExistingOne>[0]["libp2pOptions"];

// Issue #602. @libp2p/gossipsub bounds what it keeps of a peer's topic subscriptions in two ways:
//  - maxTopicBytesPerPeer, a memory budget of about 1 KiB per topic. Subscriptions past it are ignored one by one,
//    and the peer is then never picked as a publish recipient for those topics. gossipsub's default is 1 MiB, about
//    1000 topics.
//  - decodeRpcLimits.maxSubscriptions, how many subscriptions one message may carry. A message over it is rejected
//    whole, and a peer announces all its topics in one message on connect, so with gossipsub's default of 5000 a
//    peer with more topics than that is known for none of them.
// A node hosting or seeding communities has two topics per community (pubsub and IPNS record), so both defaults were
// within reach. pkc-js sets 8 MiB and 65536.
//
// Client-side libp2p only: in-process nodes, no Kubo and no PKC RPC server, so it runs once under non-RPC via
// describeSkipIfRpc.
describeSkipIfRpc("gossipsub limits on a peer's topic subscriptions (issue #602)", () => {
    const clientsToStop: Libp2pJsClient[] = [];
    let keyCounter = 0;

    afterEach(async () => {
        while (clientsToStop.length) await clientsToStop.pop()!.heliaWithKuboRpcClientFunctions.stop();
    });

    const createNode = async (libp2pOptions: Libp2pOptions = {}): Promise<Libp2pJsClient> => {
        const client = (await createLibp2pJsClientOrUseExistingOne({
            key: `topic-budget-${Date.now()}-${keyCounter++}`,
            httpRoutersOptions: ["http://localhost:1"],
            libp2pOptions,
            heliaOptions: {}
        })) as Libp2pJsClient;
        clientsToStop.push(client);
        return client;
    };

    // Starts a peer subscribed to topicCount topics and connects a client created with clientLibp2pOptions to it.
    // topicsKnown() is how many of those topics the client has the peer down as a subscriber of.
    const connectClientToPeerWithTopics = async (topicCount: number, clientLibp2pOptions: Libp2pOptions = {}) => {
        const peer = await createNode({ addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] } });
        const topics = Array.from({ length: topicCount }, (_, i) => `issue-602-topic-${i}`);
        const peerPubsub = peer._helia.libp2p.services.pubsub;
        // the GossipSub prototype method, bypassing helia-for-pkc's subscribe patch that starts a warmup per topic
        for (const topic of topics) Object.getPrototypeOf(peerPubsub).subscribe.call(peerPubsub, topic);

        const client = await createNode(clientLibp2pOptions);
        const peerId = peer._helia.libp2p.peerId;
        const wsAddr = peer._helia.libp2p
            .getMultiaddrs()
            .map((m) => m.toString())
            .find((a) => a.includes("/ws"));
        expect(wsAddr, "the peer must listen on a ws multiaddr").to.be.a("string");
        await client._helia.libp2p.dial(multiaddr(wsAddr!));

        const clientPubsub = client._helia.libp2p.services.pubsub;
        const topicsKnown = () =>
            topics.filter((topic) => clientPubsub.getSubscribers(topic).some((subscriber) => subscriber.equals(peerId))).length;
        const publishOn = async (topic: string): Promise<string[]> => {
            const { recipients } = await Object.getPrototypeOf(clientPubsub).publish.call(
                clientPubsub,
                topic,
                new TextEncoder().encode("hi")
            );
            return recipients.map(String);
        };
        return { topics, peerId: peerId.toString(), topicsKnown, publishOn };
    };

    const waitForTopicsKnown = (topicsKnown: () => number, expected: number) =>
        vi.waitFor(() => expect(topicsKnown()).to.equal(expected), { timeout: 30000, interval: 100 });

    it("remembers all topics of a peer with 1100, past gossipsub's default budget, and publishes to it on the last of them", async () => {
        const { topics, peerId, topicsKnown, publishOn } = await connectClientToPeerWithTopics(1100);
        await waitForTopicsKnown(topicsKnown, 1100);
        expect(await publishOn(topics[1099])).to.include(peerId);
    });

    it("remembers all topics of a peer with 6000, past gossipsub's default of 5000 subscriptions per message", async () => {
        const { topics, peerId, topicsKnown, publishOn } = await connectClientToPeerWithTopics(6000);
        await waitForTopicsKnown(topicsKnown, 6000);
        expect(await publishOn(topics[5999])).to.include(peerId);
    });

    it("past the budget it keeps what fits, it does not lose the whole peer", async () => {
        const topicCount = 9000;
        expect(topicCount).to.be.lessThan(GOSSIPSUB_MAX_SUBSCRIPTIONS_PER_MESSAGE);
        const { topicsKnown } = await connectClientToPeerWithTopics(topicCount);
        // each topic costs its length plus 1 KiB, so the budget admits somewhat fewer than budget / 1 KiB topics
        const mostTheBudgetAdmits = GOSSIPSUB_MAX_TOPIC_BYTES_PER_PEER / 1024;
        await vi.waitFor(() => expect(topicsKnown()).to.be.greaterThan(mostTheBudgetAdmits * 0.9), { timeout: 30000, interval: 100 });
        expect(topicsKnown()).to.be.lessThan(mostTheBudgetAdmits);
    });

    // What the README tells an app to do when it connects to peers with more topics than the defaults cover
    it("a caller's libp2pOptions.services.pubsub replaces the default service and its limits", async () => {
        const callerPubsub = gossipsub({
            maxTopicBytesPerPeer: 64 * 1024 * 1024,
            decodeRpcLimits: {
                maxSubscriptions: GOSSIPSUB_MAX_SUBSCRIPTIONS_PER_MESSAGE,
                maxMessages: 5000,
                maxIhaveMessageIDs: 5000,
                maxIwantMessageIDs: 5000,
                maxControlMessages: 5000,
                maxIdontwantMessageIDs: 512,
                maxPeerInfos: 16
            }
        });
        const { topics, peerId, topicsKnown, publishOn } = await connectClientToPeerWithTopics(9000, {
            services: { pubsub: callerPubsub }
        });
        await waitForTopicsKnown(topicsKnown, 9000);
        expect(await publishOn(topics[8999])).to.include(peerId);
    });
});

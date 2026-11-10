// Regression (PR #503 review): with a single libp2p-js client, _getPubsubProviders() lists it twice, so
// both the publish loop and the no-response retry can subscribe the same challenge handler on the same
// key a second time. kubo-rpc-client rejects that second subscribe (the client manager reads it as
// "already subscribed"), but the helia shim's subscribe added the handler to its topic emitter again.
// Unsubscribe then removes one copy while the client manager forgets every entry for the topic, so the
// leftover copy kept gossipsub subscribed and the publication reachable for the life of the PKC.
//
// Drives the client manager against the real shim (forceMockPubsub: false; the mock pubsub client
// replaces the shim and rejects duplicates like kubo does). Only subscribe and unsubscribe are used,
// so no gossipsub peer has to be reachable for the topic.
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mockPKCWithHeliaConfig, generateMockPost } from "../../../../dist/node/test/test-util.js";
import signers from "../../../fixtures/signers.js";
import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";

describe("libp2p-js single provider: subscribing the same handler twice is undone by one unsubscribe", () => {
    let pkc: PKCType;

    beforeAll(async () => {
        pkc = await mockPKCWithHeliaConfig({ forceMockPubsub: false });
    });

    afterAll(async () => {
        await pkc?.destroy();
    });

    it("the topic is no longer subscribed in gossipsub after pubsubUnsubscribe()", async () => {
        const libp2pJsKey = Object.keys(pkc.clients.libp2pJsClients)[0];
        const libp2pJsClient = pkc.clients.libp2pJsClients[libp2pJsKey];
        const gossipsubTopics = () => libp2pJsClient._helia.libp2p.services.pubsub.getTopics();
        const post = await generateMockPost({ communityAddress: signers[0].address, pkc });
        const clientsManager = post._clientsManager;
        const topic = signers[0].address;
        const handler = () => {};

        // What the single-provider retry does: providers are [key, key]
        await clientsManager.pubsubSubscribeOnProvider(topic, handler, libp2pJsKey);
        await clientsManager.pubsubSubscribeOnProvider(topic, handler, libp2pJsKey);
        const subscribedBeforeUnsubscribe = gossipsubTopics().includes(topic);

        await clientsManager.pubsubUnsubscribe(topic, handler);

        expect({ subscribedBeforeUnsubscribe, subscribedAfterUnsubscribe: gossipsubTopics().includes(topic) }).toEqual({
            subscribedBeforeUnsubscribe: true,
            subscribedAfterUnsubscribe: false
        });
    });
});

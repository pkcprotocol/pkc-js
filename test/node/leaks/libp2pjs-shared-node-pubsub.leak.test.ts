// Leak suite (#496): a pkc.pubsubSubscribe() topic must not outlive that PKC's destroy() on a shared helia node.
import { it, expect } from "vitest";
import { mockPKCWithHeliaConfig } from "../../../dist/node/test/test-util.js";

// it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
// starts failing once the leak is fixed: remove the .fails then.

it.fails("libp2p-js: a topic subscribed by PKC A is unsubscribed when A is destroyed, while PKC B keeps the shared node", async () => {
    const key = `leak-shared-helia-${Date.now()}`;
    const libp2pJsClientsOptions = [{ key, libp2pOptions: { connectionGater: { denyDialMultiaddr: async () => false } } }];
    const pkcA = await mockPKCWithHeliaConfig({ forceMockPubsub: false, pkcOptions: { libp2pJsClientsOptions } });
    const pkcB = await mockPKCWithHeliaConfig({ forceMockPubsub: false, pkcOptions: { libp2pJsClientsOptions } });
    try {
        const helia = pkcB.clients.libp2pJsClients[key]._helia;
        expect(pkcA.clients.libp2pJsClients[key]._helia).toBe(helia); // really shared
        const topic = (await pkcA.createSigner()).address;
        const topicsBefore = helia.libp2p.services.pubsub.getTopics().length;
        // Not awaited to the end of the mesh warmup: nobody else is on this topic. The registration is synchronous
        const subscribing = pkcA.pubsubSubscribe(topic).catch(() => {});
        await Promise.race([subscribing, new Promise((resolve) => setTimeout(resolve, 3000))]);
        const subscribedWhileAlive = helia.libp2p.services.pubsub.getTopics().includes(topic);
        await pkcA.destroy();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect({
            subscribedWhileAlive,
            stillSubscribedAfterDestroyOfA: helia.libp2p.services.pubsub.getTopics().includes(topic),
            topicsAdded: helia.libp2p.services.pubsub.getTopics().length - topicsBefore,
            sharedNodeStatus: helia.libp2p.status
        }).toEqual({ subscribedWhileAlive: true, stillSubscribedAfterDestroyOfA: false, topicsAdded: 0, sharedNodeStatus: "started" });
    } finally {
        await pkcB.destroy();
    }
});

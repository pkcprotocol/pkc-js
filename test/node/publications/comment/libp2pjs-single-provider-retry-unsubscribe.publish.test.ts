// Regression (PR #503 review): with a single libp2p-js client, _getPubsubProviders() lists it twice, so
// both the publish loop and the no-response retry can subscribe the same challenge handler on the same
// key a second time. kubo-rpc-client rejects that second subscribe (the client manager reads it as
// "already subscribed"), but the helia shim's subscribe added the handler to its topic emitter again.
// Unsubscribe then removes one copy while the client manager forgets every entry for the topic, so the
// leftover copy kept gossipsub subscribed and the publication reachable for the life of the PKC.
//
// Drives the client manager against the real shim (forceMockPubsub: false; the mock pubsub client
// replaces the shim and rejects duplicates like kubo does). Only subscribe and unsubscribe are used, and the
// first test reports a topic subscriber so the shim skips its peer warmup: no gossipsub peer has to be reachable.
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
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
        const pubsub = libp2pJsClient._helia.libp2p.services.pubsub;
        const realGetSubscribers = pubsub.getSubscribers.bind(pubsub);
        const getSubscribersSpy = vi
            .spyOn(pubsub, "getSubscribers")
            .mockImplementation((t) => (t === topic ? [libp2pJsClient._helia.libp2p.peerId] : realGetSubscribers(t)));

        try {
            // What the single-provider retry does: providers are [key, key]
            await clientsManager.pubsubSubscribeOnProvider(topic, handler, libp2pJsKey);
            await clientsManager.pubsubSubscribeOnProvider(topic, handler, libp2pJsKey);
        } finally {
            getSubscribersSpy.mockRestore();
        }
        const subscribedBeforeUnsubscribe = gossipsubTopics().includes(topic);

        await clientsManager.pubsubUnsubscribe(topic, handler);

        expect({ subscribedBeforeUnsubscribe, subscribedAfterUnsubscribe: gossipsubTopics().includes(topic) }).toEqual({
            subscribedBeforeUnsubscribe: true,
            subscribedAfterUnsubscribe: false
        });
    });

    // PR #503 review: the shim registers the handler and subscribes gossipsub before awaiting the peer warmup.
    // When the warmup failed both stayed behind, so with the duplicate check above a retry of the same handler
    // was rejected as "Already subscribed", which the client manager reads as success, and warmup never ran again
    it("a subscribe whose warmup fails leaves nothing subscribed, so a retry runs the warmup again", async () => {
        const libp2pJsKey = Object.keys(pkc.clients.libp2pJsClients)[0];
        const helia = pkc.clients.libp2pJsClients[libp2pJsKey]._helia;
        const post = await generateMockPost({ communityAddress: signers[0].address, pkc });
        const clientsManager = post._clientsManager;
        // A topic nobody subscribes to, so the shim has to run the warmup instead of returning early
        const topic = (await pkc.createSigner()).address;
        const handler = () => {};

        const routerError = new Error("mocked content router failure");
        const findProvidersSpy = vi.spyOn(helia.libp2p.contentRouting, "findProviders").mockImplementation(async function* () {
            throw routerError;
        });
        try {
            const firstAttempt = await clientsManager.pubsubSubscribeOnProvider(topic, handler, libp2pJsKey).then(
                () => "resolved",
                (e: Error) => e.message
            );
            const subscribedAfterFailedWarmup = helia.libp2p.services.pubsub.getTopics().includes(topic);
            const retry = await clientsManager.pubsubSubscribeOnProvider(topic, handler, libp2pJsKey).then(
                () => "resolved",
                (e: Error) => e.message
            );

            expect({ firstAttempt, subscribedAfterFailedWarmup, retry, warmups: findProvidersSpy.mock.calls.length }).toEqual({
                firstAttempt: routerError.message,
                subscribedAfterFailedWarmup: false,
                retry: routerError.message,
                warmups: 2
            });
        } finally {
            findProvidersSpy.mockRestore();
            await clientsManager.pubsubUnsubscribe(topic, handler).catch(() => {});
        }
    });
});

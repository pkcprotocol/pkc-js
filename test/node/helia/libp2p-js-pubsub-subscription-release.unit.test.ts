import { afterEach, expect, it } from "vitest";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import { BaseClientsManager } from "../../../dist/node/clients/base-client-manager.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PeerId } from "@libp2p/interface";

// BaseClientsManager.pubsubUnsubscribe releases a topic on the libp2p-js providers it subscribed it on
// (#503). helia's pubsub.unsubscribe() threw ERR_HELIAS_STOPPING_OR_STOPPED on a stopping or stopped
// node before dropping the handler, so a publication that ended after its helia node stopped (for
// example one whose subscribe resolved after destroy()) had that routine cleanup emitted as an error
// and kept the topic in pubsubProviderSubscriptions. kubo-rpc-client's unsubscribe is local and never
// throws there.
//
// Client-side libp2p only (an offline node, unreachable HTTP router, no kubo), so it runs once under
// non-RPC via describeSkipIfRpc.
describeSkipIfRpc("libp2p-js pubsub subscriptions are released when unsubscribed", () => {
    const clientsToStop: Libp2pJsClient[] = [];
    let counter = 0;

    afterEach(async () => {
        while (clientsToStop.length) await clientsToStop.pop()!.heliaWithKuboRpcClientFunctions.stop();
    });

    const setup = async () => {
        const key = `pubsub-subscription-release-${counter++}`;
        const client = (await createLibp2pJsClientOrUseExistingOne({
            key,
            httpRoutersOptions: ["http://localhost:1"],
            libp2pOptions: {},
            heliaOptions: {}
        })) as Libp2pJsClient;
        clientsToStop.push(client);
        const pubsub = client.heliaNode.libp2p.services.pubsub;
        const topic = `pubsub-subscription-release-topic-${counter}`;

        // Make the warmup succeed without a network: it resolves at once when the topic already has
        // a subscriber.
        const remotePeer = peerIdFromPrivateKey(await generateKeyPair("Ed25519"));
        const originalGetSubscribers = pubsub.getSubscribers.bind(pubsub);
        pubsub.getSubscribers = (t: string): PeerId[] => (t === topic ? [remotePeer] : originalGetSubscribers(t));

        return { key, client, topic };
    };

    const createClientsManagerFor = ({ key, client }: { key: string; client: Libp2pJsClient }) => {
        const errors: Error[] = [];
        const pkcStub = {
            clients: { pubsubKuboRpcClients: {}, libp2pJsClients: { [key]: client } },
            _stats: { recordGatewaySuccess: async () => {}, recordGatewayFailure: async () => {} },
            emit: (_event: string, error: Error) => errors.push(error)
        };
        return { clientsManager: new BaseClientsManager(pkcStub as unknown as PKC), errors };
    };

    it("pubsubUnsubscribe after the libp2p-js node stopped drops the handler without emitting an error", async () => {
        const { key, client, topic } = await setup();
        const { clientsManager, errors } = createClientsManagerFor({ key, client });
        const handler = (): void => {};

        await clientsManager.pubsubSubscribeOnProvider(topic, handler, key);
        clientsToStop.splice(clientsToStop.indexOf(client), 1);
        await client.heliaWithKuboRpcClientFunctions.stop();

        await clientsManager.pubsubUnsubscribe(topic, handler);

        expect(errors.map((e) => e.message)).to.deep.equal([]);
        expect(clientsManager.pubsubProviderSubscriptions[key]).to.not.include(topic);
    });
});

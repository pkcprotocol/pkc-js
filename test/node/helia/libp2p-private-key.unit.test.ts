import { describe, it, expect, afterEach } from "vitest";
import { createLibp2pJsClientOrUseExistingOne } from "../../../dist/node/helia/helia-for-pkc.js";
import type { Libp2pJsClient } from "../../../dist/node/helia/libp2pjsClient.js";

// Which key the libp2p-js node starts with. pkc-js generates one itself so the node never touches the libp2p
// keychain (it needs WebCrypto), except when the caller brings a datastore, which may persist the node's key.
// Builds real libp2p-js helia clients (no test server needed: each only starts a local node and never dials).
describe("libp2p-js client private key", () => {
    const runningClients: Libp2pJsClient[] = [];
    let keyCounter = 0;

    const createClient = async (heliaOptions: Record<string, unknown>) => {
        const client = (await createLibp2pJsClientOrUseExistingOne({
            // unique key per call so each client gets its own helia instance instead of a refcounted shared one
            key: `libp2p-private-key-test-${keyCounter++}`,
            httpRoutersOptions: ["http://localhost:1"], // never reached; required only so setup doesn't throw
            libp2pOptions: {},
            heliaOptions
        })) as Libp2pJsClient;
        runningClients.push(client);
        return client;
    };

    const stopClient = async (client: Libp2pJsClient) => {
        runningClients.splice(runningClients.indexOf(client), 1);
        // countOfUsesOfInstance starts at 1, so a single stop() tears the instance down.
        await client.heliaWithKuboRpcClientFunctions.stop();
    };

    const peerIdOf = (client: Libp2pJsClient) => client._helia.libp2p.peerId.toString();

    afterEach(async () => {
        while (runningClients.length) await stopClient(runningClients[0]);
    });

    it("starts each client with a new peer id by default", async () => {
        const first = await createClient({});
        const second = await createClient({});
        expect(peerIdOf(first)).to.not.equal(peerIdOf(second));
    });

    it("keeps the peer id stored in a caller-supplied datastore across restarts", async () => {
        // Borrow an in-memory datastore from a throwaway client; it outlives the client that created it.
        const throwaway = await createClient({});
        const datastore = throwaway._helia.datastore;
        await stopClient(throwaway);

        const first = await createClient({ datastore });
        const peerId = peerIdOf(first);
        await stopClient(first);

        const restarted = await createClient({ datastore });
        expect(peerIdOf(restarted)).to.equal(peerId);
    });
});

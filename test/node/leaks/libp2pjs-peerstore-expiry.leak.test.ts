// Leak suite (#496): peers that expired in the libp2p peer store must not stay in the node's datastore.
import { it, expect, vi } from "vitest";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { multiaddr } from "@multiformats/multiaddr";
import { mockPKCWithHeliaConfig } from "../../../dist/node/test/test-util.js";

// it.fails: this is a known leak with no fix yet (#516). The body asserts the clean behaviour, so the test
// starts failing once the leak is fixed: remove the .fails then.

const PEERS = 20;

it.fails(`libp2p-js: ${PEERS} peers never seen again are gone from the datastore 7 hours later`, async () => {
    const pkc = await mockPKCWithHeliaConfig({ forceMockPubsub: false });
    const helia = Object.values(pkc.clients.libp2pJsClients)[0]._helia;
    const countPeerKeys = async () => {
        let count = 0;
        for await (const _ of helia.datastore.queryKeys({ prefix: "/peers" })) count++;
        return count;
    };
    try {
        const before = await countPeerKeys();
        for (let i = 0; i < PEERS; i++) {
            const peerId = peerIdFromPrivateKey(await generateKeyPair("Ed25519"));
            await helia.libp2p.peerStore.merge(peerId, { multiaddrs: [multiaddr(`/ip4/10.0.0.${i + 1}/tcp/4001/ws`)] });
        }
        const afterMerge = await countPeerKeys();
        // Past MAX_PEER_AGE (6 h) and MAX_ADDRESS_AGE (1 h): every one of them is expired by the store's own rule
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(Date.now() + 7 * 60 * 60 * 1000);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        const sevenHoursLater = await countPeerKeys();
        vi.useRealTimers();
        expect({ added: afterMerge - before, leftAfterExpiry: sevenHoursLater - before }).toEqual({ added: PEERS, leftAfterExpiry: 0 });
    } finally {
        vi.useRealTimers();
        await pkc.destroy();
    }
});

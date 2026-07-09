import { describe, expect, it } from "vitest";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { PeerId } from "@libp2p/interface";
import { selectBitswapSessionSeedPeers } from "../../../dist/node/helia/util.js";

// Unit coverage for the seed-selection helper behind the per-DAG bitswap sessions (issue #189).
// The integration behavior (one routing query per DAG, seeded fetch with routing blinded) is
// covered in test/node-and-browser/helia/helia.test.ts; this pins the pure ordering/dedupe/cap
// logic: recent IPNS record servers first, then pubsub subscribers, then any other connected
// peer — all restricted to currently-connected peers.
describe("selectBitswapSessionSeedPeers (issue #189)", () => {
    const newPeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair("Ed25519"));

    it("returns empty when there are no connected peers, regardless of candidates", async () => {
        const disconnectedRecordServer = await newPeerId();
        expect(
            selectBitswapSessionSeedPeers({
                connectedPeers: [],
                pubsubSubscriberPeerIdStrings: [disconnectedRecordServer.toString()],
                recentIpnsRecordServerPeerIdStrings: [disconnectedRecordServer.toString()],
                maxSeeds: 3
            })
        ).to.deep.equal([]);
    });

    it("orders seeds: record servers, then pubsub subscribers, then remaining connected peers", async () => {
        const recordServer = await newPeerId();
        const subscriber = await newPeerId();
        const plainConnected = await newPeerId();
        const seeds = selectBitswapSessionSeedPeers({
            connectedPeers: [plainConnected, subscriber, recordServer],
            pubsubSubscriberPeerIdStrings: [subscriber.toString()],
            recentIpnsRecordServerPeerIdStrings: [recordServer.toString()],
            maxSeeds: 3
        });
        expect(seeds.map(String)).to.deep.equal([recordServer.toString(), subscriber.toString(), plainConnected.toString()]);
    });

    it("ignores record servers and subscribers that are no longer connected", async () => {
        const disconnectedRecordServer = await newPeerId();
        const connectedPeer = await newPeerId();
        const seeds = selectBitswapSessionSeedPeers({
            connectedPeers: [connectedPeer],
            pubsubSubscriberPeerIdStrings: [disconnectedRecordServer.toString()],
            recentIpnsRecordServerPeerIdStrings: [disconnectedRecordServer.toString()],
            maxSeeds: 3
        });
        expect(seeds.map(String)).to.deep.equal([connectedPeer.toString()]);
    });

    it("dedupes a peer that appears in multiple tiers", async () => {
        const recordServerAndSubscriber = await newPeerId();
        const seeds = selectBitswapSessionSeedPeers({
            connectedPeers: [recordServerAndSubscriber],
            pubsubSubscriberPeerIdStrings: [recordServerAndSubscriber.toString()],
            recentIpnsRecordServerPeerIdStrings: [recordServerAndSubscriber.toString()],
            maxSeeds: 3
        });
        expect(seeds.map(String)).to.deep.equal([recordServerAndSubscriber.toString()]);
    });

    it("caps the result at maxSeeds, dropping the lowest-priority tier first", async () => {
        const recordServerA = await newPeerId();
        const recordServerB = await newPeerId();
        const subscriber = await newPeerId();
        const plainConnected = await newPeerId();
        const seeds = selectBitswapSessionSeedPeers({
            connectedPeers: [plainConnected, subscriber, recordServerB, recordServerA],
            pubsubSubscriberPeerIdStrings: [subscriber.toString()],
            // most recent first — recordServerA served a record more recently than recordServerB
            recentIpnsRecordServerPeerIdStrings: [recordServerA.toString(), recordServerB.toString()],
            maxSeeds: 3
        });
        expect(seeds.map(String)).to.deep.equal([recordServerA.toString(), recordServerB.toString(), subscriber.toString()]);
    });
});

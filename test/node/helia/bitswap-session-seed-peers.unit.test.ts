import { describe, expect, it } from "vitest";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import type { PeerId } from "@libp2p/interface";
import { selectBitswapSessionSeedPeers } from "../../../dist/node/helia/util.js";

// Unit coverage for the seed-selection helper behind the per-DAG bitswap sessions (issues #189,
// #202). The integration behavior (one routing query per DAG, seeded fetch with routing blinded,
// scope plumbing from the fetch call sites) is covered in
// test/node-and-browser/helia/helia.test.ts; this pins the pure ordering/dedupe/cap logic:
// subscribers of the fetched community's IPNS record topic first (its record server must be
// subscribed there to serve records, and by construction provides every block under the
// community), then subscribers of any other subscribed topic, then any other connected peer —
// all restricted to currently-connected peers.
describe("selectBitswapSessionSeedPeers (issues #189, #202)", () => {
    const newPeerId = async (): Promise<PeerId> => peerIdFromPrivateKey(await generateKeyPair("Ed25519"));

    it("returns empty when there are no connected peers, regardless of candidates", async () => {
        const disconnectedSubscriber = await newPeerId();
        expect(
            selectBitswapSessionSeedPeers({
                connectedPeers: [],
                scopedPubsubSubscriberPeerIdStrings: [disconnectedSubscriber.toString()],
                pubsubSubscriberPeerIdStrings: [disconnectedSubscriber.toString()],
                maxSeeds: 3
            })
        ).to.deep.equal([]);
    });

    it("orders seeds: scoped-topic subscribers, then other subscribers, then remaining connected peers", async () => {
        const scopedSubscriber = await newPeerId();
        const otherTopicSubscriber = await newPeerId();
        const plainConnected = await newPeerId();
        const seeds = selectBitswapSessionSeedPeers({
            connectedPeers: [plainConnected, otherTopicSubscriber, scopedSubscriber],
            scopedPubsubSubscriberPeerIdStrings: [scopedSubscriber.toString()],
            // the unscoped list contains subscribers of ALL subscribed topics, scoped ones included
            pubsubSubscriberPeerIdStrings: [otherTopicSubscriber.toString(), scopedSubscriber.toString()],
            maxSeeds: 3
        });
        expect(seeds.map(String)).to.deep.equal([scopedSubscriber.toString(), otherTopicSubscriber.toString(), plainConnected.toString()]);
    });

    it("a scoped-topic subscriber outranks an earlier-listed subscriber of another topic", async () => {
        const scopedSubscriber = await newPeerId();
        const otherTopicSubscriber = await newPeerId();
        const seeds = selectBitswapSessionSeedPeers({
            connectedPeers: [otherTopicSubscriber, scopedSubscriber],
            scopedPubsubSubscriberPeerIdStrings: [scopedSubscriber.toString()],
            pubsubSubscriberPeerIdStrings: [otherTopicSubscriber.toString(), scopedSubscriber.toString()],
            maxSeeds: 1
        });
        expect(seeds.map(String)).to.deep.equal([scopedSubscriber.toString()]);
    });

    it("falls back to subscriber-then-connected ordering when no scope is given", async () => {
        const subscriber = await newPeerId();
        const plainConnected = await newPeerId();
        const seeds = selectBitswapSessionSeedPeers({
            connectedPeers: [plainConnected, subscriber],
            scopedPubsubSubscriberPeerIdStrings: [],
            pubsubSubscriberPeerIdStrings: [subscriber.toString()],
            maxSeeds: 3
        });
        expect(seeds.map(String)).to.deep.equal([subscriber.toString(), plainConnected.toString()]);
    });

    it("ignores scoped subscribers and other subscribers that are no longer connected", async () => {
        const disconnectedScopedSubscriber = await newPeerId();
        const connectedPeer = await newPeerId();
        const seeds = selectBitswapSessionSeedPeers({
            connectedPeers: [connectedPeer],
            scopedPubsubSubscriberPeerIdStrings: [disconnectedScopedSubscriber.toString()],
            pubsubSubscriberPeerIdStrings: [disconnectedScopedSubscriber.toString()],
            maxSeeds: 3
        });
        expect(seeds.map(String)).to.deep.equal([connectedPeer.toString()]);
    });

    it("dedupes a peer that appears in multiple tiers", async () => {
        const scopedAndUnscopedSubscriber = await newPeerId();
        const seeds = selectBitswapSessionSeedPeers({
            connectedPeers: [scopedAndUnscopedSubscriber],
            scopedPubsubSubscriberPeerIdStrings: [scopedAndUnscopedSubscriber.toString()],
            pubsubSubscriberPeerIdStrings: [scopedAndUnscopedSubscriber.toString()],
            maxSeeds: 3
        });
        expect(seeds.map(String)).to.deep.equal([scopedAndUnscopedSubscriber.toString()]);
    });

    it("caps the result at maxSeeds, dropping the lowest-priority tier first", async () => {
        const scopedSubscriberA = await newPeerId();
        const scopedSubscriberB = await newPeerId();
        const otherTopicSubscriber = await newPeerId();
        const plainConnected = await newPeerId();
        const seeds = selectBitswapSessionSeedPeers({
            connectedPeers: [plainConnected, otherTopicSubscriber, scopedSubscriberB, scopedSubscriberA],
            scopedPubsubSubscriberPeerIdStrings: [scopedSubscriberA.toString(), scopedSubscriberB.toString()],
            pubsubSubscriberPeerIdStrings: [otherTopicSubscriber.toString()],
            maxSeeds: 3
        });
        expect(seeds.map(String)).to.deep.equal([
            scopedSubscriberA.toString(),
            scopedSubscriberB.toString(),
            otherTopicSubscriber.toString()
        ]);
    });
});

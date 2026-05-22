// Unit tests for src/runtime/node/community/local-community/pubsub.ts.
// The two helpers are thin wrappers over the kubo pubsub client; we stub
// _clientsManager and assert the early-return / topic-derivation behaviour.
// Real pubsub end-to-end behaviour is covered by the integration suite under
// test/node/community/.

import { describe, it, expect, vi } from "vitest";
import {
    listenToIncomingRequests,
    providePubsubTopicRoutingCidsIfNeeded
} from "../../../../dist/node/runtime/node/community/local-community/pubsub.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";

describe("pubsub: listenToIncomingRequests", () => {
    it("subscribes to the community pubsub topic when not already subscribed", async () => {
        const ls = vi.fn().mockResolvedValue([]);
        const pubsubUnsubscribe = vi.fn().mockResolvedValue(undefined);
        const pubsubSubscribe = vi.fn().mockResolvedValue(undefined);
        const updateKuboRpcPubsubState = vi.fn();
        const handleChallengeExchange = (): undefined => undefined;

        const community = {
            address: "community.bso",
            pubsubTopic: "pubsub-topic",
            handleChallengeExchange,
            _clientsManager: {
                getDefaultKuboPubsubClient: () => ({ _client: { pubsub: { ls } }, url: "http://localhost:5001" }),
                pubsubUnsubscribe,
                pubsubSubscribe,
                updateKuboRpcPubsubState
            }
        } as unknown as LocalCommunity;

        await listenToIncomingRequests(community);

        expect(pubsubUnsubscribe).toHaveBeenCalledWith("pubsub-topic", handleChallengeExchange);
        expect(pubsubSubscribe).toHaveBeenCalledWith("pubsub-topic", handleChallengeExchange);
        expect(updateKuboRpcPubsubState).toHaveBeenCalledWith("waiting-challenge-requests", "http://localhost:5001");
    });

    it("skips subscribing when the kubo node already reports the topic as subscribed", async () => {
        const pubsubUnsubscribe = vi.fn();
        const pubsubSubscribe = vi.fn();
        const community = {
            address: "community.bso",
            pubsubTopic: "pubsub-topic",
            handleChallengeExchange: (): undefined => undefined,
            _clientsManager: {
                getDefaultKuboPubsubClient: () => ({
                    _client: { pubsub: { ls: vi.fn().mockResolvedValue(["pubsub-topic"]) } },
                    url: "http://localhost:5001"
                }),
                pubsubUnsubscribe,
                pubsubSubscribe,
                updateKuboRpcPubsubState: vi.fn()
            }
        } as unknown as LocalCommunity;

        await listenToIncomingRequests(community);

        expect(pubsubUnsubscribe).not.toHaveBeenCalled();
        expect(pubsubSubscribe).not.toHaveBeenCalled();
    });

    it("falls back to community.address when pubsubTopic is unset", async () => {
        const pubsubSubscribe = vi.fn();
        const community = {
            address: "fallback.bso",
            pubsubTopic: undefined,
            handleChallengeExchange: (): undefined => undefined,
            _clientsManager: {
                getDefaultKuboPubsubClient: () => ({
                    _client: { pubsub: { ls: vi.fn().mockResolvedValue([]) } },
                    url: "http://localhost:5001"
                }),
                pubsubUnsubscribe: vi.fn(),
                pubsubSubscribe,
                updateKuboRpcPubsubState: vi.fn()
            }
        } as unknown as LocalCommunity;

        await listenToIncomingRequests(community);

        expect(pubsubSubscribe).toHaveBeenCalledWith("fallback.bso", expect.any(Function));
    });
});

describe("pubsub: providePubsubTopicRoutingCidsIfNeeded", () => {
    it("early-returns when the last provide happened within the reprovide interval", async () => {
        const getDefaultKuboRpcClient = vi.fn();
        const community = {
            address: "community.bso",
            pubsubTopic: "topic",
            ipnsPubsubTopic: "ipns-topic",
            // 1 ms ago -> well within the 6h reprovide window
            _lastPubsubTopicRoutingProvideAt: Date.now() - 1,
            _clientsManager: { getDefaultKuboRpcClient }
        } as unknown as LocalCommunity;

        await providePubsubTopicRoutingCidsIfNeeded(community);

        expect(getDefaultKuboRpcClient).not.toHaveBeenCalled();
    });

    it("early-returns when there are no topics to provide", async () => {
        const getDefaultKuboRpcClient = vi.fn();
        // pubsubTopicWithfallback returns `pubsubTopic || address`, so both must be falsy
        // (and ipnsPubsubTopic undefined) for topics.length to be 0.
        const community = {
            address: undefined,
            pubsubTopic: undefined,
            ipnsPubsubTopic: undefined,
            _lastPubsubTopicRoutingProvideAt: undefined,
            _clientsManager: { getDefaultKuboRpcClient }
        } as unknown as LocalCommunity;

        await providePubsubTopicRoutingCidsIfNeeded(community);
        expect(getDefaultKuboRpcClient).not.toHaveBeenCalled();
    });

    it("forces a provide when force=true, bypassing the throttle", async () => {
        // Throw from getDefaultKuboRpcClient so we don't need to fake the entire kubo
        // block-put/provide stack. Reaching this throw proves the throttle was bypassed —
        // a throttled call would early-return before touching _clientsManager.
        const getClient = vi.fn().mockImplementation(() => {
            throw new Error("reached kubo client");
        });
        const community = {
            address: "force.bso",
            pubsubTopic: "force-topic",
            ipnsPubsubTopic: undefined,
            _lastPubsubTopicRoutingProvideAt: Date.now(),
            _clientsManager: { getDefaultKuboRpcClient: getClient }
        } as unknown as LocalCommunity;

        await expect(providePubsubTopicRoutingCidsIfNeeded(community, true)).rejects.toThrow("reached kubo client");
        expect(getClient).toHaveBeenCalled();
    });
});

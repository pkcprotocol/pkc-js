// Unit tests for src/runtime/node/community/local-community/pubsub.ts.
// The two helpers are thin wrappers over the kubo pubsub client; we stub
// _clientsManager and assert the early-return / topic-derivation behaviour.
// Real pubsub end-to-end behaviour is covered by the integration suite under
// test/node/community/.

import { describe, it, expect, vi, afterEach } from "vitest";

// Stub out the block-put/pin/provide stack so the tests below can assert WHICH topics get provided
// without faking the whole kubo API. Every other test in this file early-returns or throws before
// reaching it, so the stub is inert for them.
const { provideMock } = vi.hoisted(() => ({
    provideMock: vi.fn(async (_args: { pubsubTopic: string }): Promise<void> => undefined)
}));
vi.mock("../../../../dist/node/util.js", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return { ...actual, retryKuboBlockPutPinAndProvidePubsubTopic: provideMock };
});

import {
    listenToIncomingRequests,
    providePubsubTopicRoutingCidsIfNeeded
} from "../../../../dist/node/runtime/node/community/local-community/pubsub.js";
import { SHARED_KUBO_READ_TIMEOUT_MS } from "../../../../dist/node/clients/shared-pubsub-topic-list.js";
import { invalidateSharedPubsubTopicList } from "../../../../dist/node/clients/shared-pubsub-topic-list.js";
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
            _pkc: { publishInterval: 20_000 },
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
            _pkc: { publishInterval: 20_000 },
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

    // Since issue #229 the fallback is the signer address, never community.address: an absent topic
    // on the wire means the challenge exchange is disabled, so the address must not stand in for one.
    it("falls back to the signer address when pubsubTopic is unset", async () => {
        const pubsubSubscribe = vi.fn();
        const community = {
            address: "fallback.bso",
            pubsubTopic: undefined,
            signer: { address: "signer-address" },
            handleChallengeExchange: (): undefined => undefined,
            _pkc: { publishInterval: 20_000 },
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

        expect(pubsubSubscribe).toHaveBeenCalledWith("signer-address", expect.any(Function));
    });

    it("does not subscribe when settings.disablePubsubChallengeExchange is on", async () => {
        const pubsubSubscribe = vi.fn();
        const pubsubUnsubscribe = vi.fn();
        const community = {
            address: "readonly.bso",
            pubsubTopic: "pubsub-topic",
            signer: { address: "signer-address" },
            settings: { disablePubsubChallengeExchange: true },
            handleChallengeExchange: (): undefined => undefined,
            _pkc: { publishInterval: 20_000 },
            _clientsManager: {
                // the disabled path takes the tolerant getter, since a node hosting only read-only
                // communities may have no pubsub provider configured at all
                getDefaultKuboPubsubClientIfAny: () => ({
                    _client: { pubsub: { ls: vi.fn().mockResolvedValue([]) } },
                    url: "http://localhost:5001"
                }),
                pubsubUnsubscribe,
                pubsubSubscribe,
                updateKuboRpcPubsubState: vi.fn()
            }
        } as unknown as LocalCommunity;

        await listenToIncomingRequests(community);

        expect(pubsubSubscribe).not.toHaveBeenCalled();
        expect(pubsubUnsubscribe).not.toHaveBeenCalled();
    });

    it("returns without touching pubsub when the exchange is disabled and no provider is configured", async () => {
        const pubsubSubscribe = vi.fn();
        const pubsubUnsubscribe = vi.fn();
        const community = {
            address: "readonly.bso",
            pubsubTopic: "pubsub-topic",
            signer: { address: "signer-address" },
            settings: { disablePubsubChallengeExchange: true },
            handleChallengeExchange: (): undefined => undefined,
            _pkc: { publishInterval: 20_000 },
            _clientsManager: {
                getDefaultKuboPubsubClientIfAny: (): undefined => undefined,
                getDefaultKuboPubsubClient: (): never => {
                    throw new Error("the disabled path must not demand a pubsub provider");
                },
                pubsubUnsubscribe,
                pubsubSubscribe,
                updateKuboRpcPubsubState: vi.fn()
            }
        } as unknown as LocalCommunity;

        await listenToIncomingRequests(community);

        expect(pubsubSubscribe).not.toHaveBeenCalled();
        expect(pubsubUnsubscribe).not.toHaveBeenCalled();
    });

    // pubsubTopic can change while the community is started. kubo is shared with every other community
    // on the node, so the topic we joined last is the only one we may drop.
    it("drops the previously joined topic when pubsubTopic changes", async () => {
        const pubsubSubscribe = vi.fn();
        const pubsubUnsubscribe = vi.fn();
        const handleChallengeExchange = (): undefined => undefined;
        const community = {
            address: "changed.bso",
            pubsubTopic: "new-topic",
            signer: { address: "signer-address" },
            settings: {},
            _subscribedChallengePubsubTopic: "old-topic",
            handleChallengeExchange,
            _pkc: { publishInterval: 20_000 },
            _clientsManager: {
                getDefaultKuboPubsubClient: () => ({
                    _client: { pubsub: { ls: vi.fn().mockResolvedValue(["old-topic"]) } },
                    url: "http://localhost:5001"
                }),
                pubsubUnsubscribe,
                pubsubSubscribe,
                updateKuboRpcPubsubState: vi.fn()
            }
        } as unknown as LocalCommunity;

        await listenToIncomingRequests(community);

        expect(pubsubUnsubscribe).toHaveBeenCalledWith("old-topic", handleChallengeExchange);
        expect(pubsubSubscribe).toHaveBeenCalledWith("new-topic", handleChallengeExchange);
        expect(community._subscribedChallengePubsubTopic).to.equal("new-topic");
    });

    it("unsubscribes when the setting is toggled on while the topic is still joined", async () => {
        const pubsubSubscribe = vi.fn();
        const pubsubUnsubscribe = vi.fn();
        const handleChallengeExchange = (): undefined => undefined;
        const community = {
            address: "readonly.bso",
            pubsubTopic: "pubsub-topic",
            signer: { address: "signer-address" },
            settings: { disablePubsubChallengeExchange: true },
            handleChallengeExchange,
            _pkc: { publishInterval: 20_000 },
            _clientsManager: {
                getDefaultKuboPubsubClientIfAny: () => ({
                    _client: { pubsub: { ls: vi.fn().mockResolvedValue(["pubsub-topic"]) } },
                    url: "http://localhost:5001"
                }),
                pubsubUnsubscribe,
                pubsubSubscribe,
                updateKuboRpcPubsubState: vi.fn()
            }
        } as unknown as LocalCommunity;

        await listenToIncomingRequests(community);

        expect(pubsubUnsubscribe).toHaveBeenCalledWith("pubsub-topic", handleChallengeExchange);
        expect(pubsubSubscribe).not.toHaveBeenCalled();
    });
});

// Issue #576: every started community asked kubo for its whole subscription list at the start of every cycle, so a
// node with N communities made N calls per publishInterval, each decoding a list of N topics.
describe("pubsub: listenToIncomingRequests shares the node's subscription list", () => {
    const communityOnSharedNode = ({
        topic,
        pubsubClient,
        publishInterval
    }: {
        topic: string;
        pubsubClient: { _client: { pubsub: { ls: () => Promise<string[]> } }; url: string };
        publishInterval: number;
    }) =>
        ({
            address: topic,
            pubsubTopic: topic,
            _subscribedChallengePubsubTopic: topic,
            handleChallengeExchange: (): undefined => undefined,
            _pkc: { publishInterval },
            _clientsManager: {
                getDefaultKuboPubsubClient: () => pubsubClient,
                pubsubUnsubscribe: vi.fn(),
                pubsubSubscribe: vi.fn(),
                updateKuboRpcPubsubState: vi.fn()
            }
        }) as unknown as LocalCommunity;

    it("calls pubsub.ls() once for all the communities of a node within one cycle", async () => {
        const topics = Array.from({ length: 50 }, (_, i) => `topic-${i}`);
        const ls = vi.fn(async () => topics);
        const pubsubClient = { _client: { pubsub: { ls } }, url: "http://localhost:5001" };
        const communities = topics.map((topic) => communityOnSharedNode({ topic, pubsubClient, publishInterval: 20_000 }));

        // half of them overlap, the other half run one after the other, as staggered cycles do
        await Promise.all(communities.slice(0, 25).map((community) => listenToIncomingRequests(community)));
        for (const community of communities.slice(25)) await listenToIncomingRequests(community);

        expect(ls).toHaveBeenCalledTimes(1);
        for (const community of communities) {
            expect(community._clientsManager.pubsubSubscribe).not.toHaveBeenCalled();
            expect(community._clientsManager.pubsubUnsubscribe).not.toHaveBeenCalled();
        }
    });

    // Every community of the node waits on the one request, so a request that never answers would hold them all
    it("gives the shared pubsub.ls() a timeout, and a read that failed is not kept for the next cycle", async () => {
        const ls = vi.fn<(options?: { timeout?: number }) => Promise<string[]>>();
        ls.mockRejectedValueOnce(new Error("the request timed out")).mockResolvedValue(["topic-a"]);
        const pubsubClient = { _client: { pubsub: { ls } }, url: "http://localhost:5001" };
        const community = communityOnSharedNode({ topic: "topic-a", pubsubClient, publishInterval: 20_000 });

        await expect(listenToIncomingRequests(community)).rejects.toThrow("the request timed out");
        await listenToIncomingRequests(community);

        expect(ls).toHaveBeenCalledTimes(2);
        for (const [options] of ls.mock.calls) expect(options?.timeout).to.equal(SHARED_KUBO_READ_TIMEOUT_MS);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("reads the list again once it is older than a quarter of the publishInterval", async () => {
        vi.useFakeTimers();
        const ls = vi.fn(async () => ["topic-a"]);
        const pubsubClient = { _client: { pubsub: { ls } }, url: "http://localhost:5001" };
        const community = communityOnSharedNode({ topic: "topic-a", pubsubClient, publishInterval: 20_000 });

        await listenToIncomingRequests(community);
        vi.advanceTimersByTime(4_999);
        await listenToIncomingRequests(community);
        expect(ls).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(1);
        await listenToIncomingRequests(community);
        expect(ls).toHaveBeenCalledTimes(2);
    });

    // A list read before a subscribe does not have the new topic: acting on it would tear the fresh
    // subscription down and join again.
    it("does not reuse a list read before a subscribe or unsubscribe on the node", async () => {
        const ls = vi.fn(async () => ["topic-a"]);
        const pubsubClient = { _client: { pubsub: { ls } }, url: "http://localhost:5001" };
        const community = communityOnSharedNode({ topic: "topic-a", pubsubClient, publishInterval: 20_000 });

        await listenToIncomingRequests(community);
        invalidateSharedPubsubTopicList(pubsubClient._client);
        await listenToIncomingRequests(community);

        expect(ls).toHaveBeenCalledTimes(2);
    });

    it("does not join a request that was already out when the node's subscriptions changed", async () => {
        let resolveFirst!: (topics: string[]) => void;
        const ls = vi
            .fn<() => Promise<string[]>>()
            .mockImplementationOnce(() => new Promise<string[]>((resolve) => (resolveFirst = resolve)))
            .mockResolvedValue(["topic-a"]);
        const pubsubClient = { _client: { pubsub: { ls } }, url: "http://localhost:5001" };
        const community = communityOnSharedNode({ topic: "topic-a", pubsubClient, publishInterval: 20_000 });

        const before = listenToIncomingRequests(community);
        invalidateSharedPubsubTopicList(pubsubClient._client);
        await listenToIncomingRequests(community); // asked after the change: served by its own request
        expect(ls).toHaveBeenCalledTimes(2);

        resolveFirst(["topic-a"]);
        await before;
        // the answer of the older request is not kept either
        await listenToIncomingRequests(community);
        expect(ls).toHaveBeenCalledTimes(2);
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
        // challengeExchangePubsubTopic returns `pubsubTopic || signer.address`, so both must be falsy
        // (and ipnsPubsubTopic undefined) for topics.length to be 0.
        const community = {
            address: undefined,
            pubsubTopic: undefined,
            signer: undefined,
            ipnsPubsubTopic: undefined,
            _lastPubsubTopicRoutingProvideAt: undefined,
            _clientsManager: { getDefaultKuboRpcClient }
        } as unknown as LocalCommunity;

        await providePubsubTopicRoutingCidsIfNeeded(community);
        expect(getDefaultKuboRpcClient).not.toHaveBeenCalled();
    });

    // The challenge topic is the only thing settings.disablePubsubChallengeExchange takes off the
    // network (issue #229). The IPNS-over-pubsub topic is a separate derivation and must keep being
    // advertised, otherwise disabling the exchange would quietly degrade record replication too.
    it("provides only the IPNS topic when the challenge exchange is disabled", async () => {
        provideMock.mockClear();
        const community = {
            address: "readonly.bso",
            pubsubTopic: "custom-topic",
            signer: { address: "signer-address" },
            settings: { disablePubsubChallengeExchange: true },
            ipnsPubsubTopic: "ipns-topic",
            _lastPubsubTopicRoutingProvideAt: undefined,
            _clientsManager: { getDefaultKuboRpcClient: () => ({ _client: {} }) }
        } as unknown as LocalCommunity;

        await providePubsubTopicRoutingCidsIfNeeded(community);

        expect(provideMock.mock.calls.map((call) => call[0].pubsubTopic)).to.deep.equal(["ipns-topic"]);
    });

    it("provides both the challenge topic and the IPNS topic when the exchange is enabled", async () => {
        provideMock.mockClear();
        const community = {
            address: "enabled.bso",
            pubsubTopic: "custom-topic",
            signer: { address: "signer-address" },
            settings: {},
            ipnsPubsubTopic: "ipns-topic",
            _lastPubsubTopicRoutingProvideAt: undefined,
            _clientsManager: { getDefaultKuboRpcClient: () => ({ _client: {} }) }
        } as unknown as LocalCommunity;

        await providePubsubTopicRoutingCidsIfNeeded(community);

        expect(provideMock.mock.calls.map((call) => call[0].pubsubTopic)).to.deep.equal(["custom-topic", "ipns-topic"]);
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

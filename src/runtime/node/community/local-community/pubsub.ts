import Logger from "../../../../logger.js";
import { retryKuboBlockPutPinAndProvidePubsubTopic } from "../../../../util.js";
import type { LocalCommunity } from "../local-community.js";
import { challengeExchangePubsubTopic, communityChallengePubsubTopic } from "./comment-updates.js";

export async function listenToIncomingRequests(community: LocalCommunity) {
    const log = Logger("pkc-js:local-community:sync:_listenToIncomingRequests");
    // Make sure community listens to pubsub topic
    // Code below is to handle in case the ipfs node restarted and the subscription got lost or something
    const topic = challengeExchangePubsubTopic(community);
    // Only a community that actually runs the exchange requires a pubsub provider; a node hosting
    // read-only communities alone may have none configured (issue #229), and then there is nothing
    // subscribed to drop either. An enabled community with no provider still throws, as it must.
    const pubsubClient = topic
        ? community._clientsManager.getDefaultKuboPubsubClient()
        : community._clientsManager.getDefaultKuboPubsubClientIfAny();
    if (!pubsubClient) return;
    const subscribedTopics = await pubsubClient._client.pubsub.ls();
    // Whatever we joined last, which is the only way to know a topic is ours: the kubo node is shared
    // with every other community on it, so kubo's subscription list cannot be diffed safely.
    const staleTopic = community._subscribedChallengePubsubTopic;
    const unsubscribeStaleTopicIfNeeded = async (currentTopic: string | undefined) => {
        if (!staleTopic || staleTopic === currentTopic) return;
        if (subscribedTopics.includes(staleTopic))
            await community._clientsManager.pubsubUnsubscribe(staleTopic, community.handleChallengeExchange);
        community._subscribedChallengePubsubTopic = undefined;
        log(`Stopped listening on the previous challenge exchange pubsub topic (${staleTopic})`);
    };

    if (!topic) {
        // settings.disablePubsubChallengeExchange is on (issue #229). This runs on every sync-loop
        // iteration, so toggling the setting on while started drops the subscription without a restart.
        const disabledTopic = communityChallengePubsubTopic(community);
        if (disabledTopic && subscribedTopics.includes(disabledTopic)) {
            await community._clientsManager.pubsubUnsubscribe(disabledTopic, community.handleChallengeExchange);
            if (community._subscribedChallengePubsubTopic === disabledTopic) community._subscribedChallengePubsubTopic = undefined;
            log(`Challenge exchange is disabled, unsubscribed from pubsub topic (${disabledTopic})`);
        }
        await unsubscribeStaleTopicIfNeeded(undefined);
        return;
    }
    // A community can change its pubsubTopic while started. Drop the topic we joined for the previous
    // one, otherwise kubo keeps delivering requests to a handler on a topic we no longer advertise and
    // the subscription leaks for the lifetime of the node.
    await unsubscribeStaleTopicIfNeeded(topic);
    if (!subscribedTopics.includes(topic)) {
        await community._clientsManager.pubsubUnsubscribe(topic, community.handleChallengeExchange); // Make sure it's not hanging
        await community._clientsManager.pubsubSubscribe(topic, community.handleChallengeExchange);
        community._clientsManager.updateKuboRpcPubsubState("waiting-challenge-requests", pubsubClient.url);
        log(`Waiting for publications on pubsub topic (${topic})`);
    }
    community._subscribedChallengePubsubTopic = topic;
}

export async function providePubsubTopicRoutingCidsIfNeeded(community: LocalCommunity, force = false) {
    const log = Logger("pkc-js:local-community:_providePubsubTopicRoutingCidsIfNeeded");
    const reprovideIntervalMs = 1 * 60 * 60 * 1000; // re-provide the pubsub-topic routing CIDs hourly so their HTTP-router records keep fresh addresses
    const now = Date.now();
    if (!force && community._lastPubsubTopicRoutingProvideAt && now - community._lastPubsubTopicRoutingProvideAt < reprovideIntervalMs)
        return;

    // A read-only community has no challenge topic to advertise; the IPNS-over-pubsub record topic is
    // a separate derivation and keeps being provided so replication is unaffected (issue #229).
    const pubsubTopic = challengeExchangePubsubTopic(community);
    const topics = [pubsubTopic, community.ipnsPubsubTopic].filter((topic): topic is string => typeof topic === "string");
    if (topics.length === 0) return;

    community._lastPubsubTopicRoutingProvideAt = now;
    const kuboRpcClient = community._clientsManager.getDefaultKuboRpcClient()._client;
    for (const topic of topics) {
        try {
            await retryKuboBlockPutPinAndProvidePubsubTopic({
                ipfsClient: kuboRpcClient,
                log,
                pubsubTopic: topic
            });
        } catch (error) {
            log.error("Failed to reprovide pubsub topic routing block", { topic, error });
        }
    }
}

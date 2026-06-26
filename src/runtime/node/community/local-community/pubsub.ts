import Logger from "../../../../logger.js";
import { retryKuboBlockPutPinAndProvidePubsubTopic } from "../../../../util.js";
import type { LocalCommunity } from "../local-community.js";
import { pubsubTopicWithfallback } from "./comment-updates.js";

export async function listenToIncomingRequests(community: LocalCommunity) {
    const log = Logger("pkc-js:local-community:sync:_listenToIncomingRequests");
    // Make sure community listens to pubsub topic
    // Code below is to handle in case the ipfs node restarted and the subscription got lost or something
    const pubsubClient = community._clientsManager.getDefaultKuboPubsubClient();
    const subscribedTopics = await pubsubClient._client.pubsub.ls();
    const topic = pubsubTopicWithfallback(community);
    if (!subscribedTopics.includes(topic)) {
        await community._clientsManager.pubsubUnsubscribe(topic, community.handleChallengeExchange); // Make sure it's not hanging
        await community._clientsManager.pubsubSubscribe(topic, community.handleChallengeExchange);
        community._clientsManager.updateKuboRpcPubsubState("waiting-challenge-requests", pubsubClient.url);
        log(`Waiting for publications on pubsub topic (${topic})`);
    }
}

export async function providePubsubTopicRoutingCidsIfNeeded(community: LocalCommunity, force = false) {
    const log = Logger("pkc-js:local-community:_providePubsubTopicRoutingCidsIfNeeded");
    const reprovideIntervalMs = 1 * 60 * 60 * 1000; // re-provide the pubsub-topic routing CIDs hourly so their HTTP-router records keep fresh addresses
    const now = Date.now();
    if (!force && community._lastPubsubTopicRoutingProvideAt && now - community._lastPubsubTopicRoutingProvideAt < reprovideIntervalMs)
        return;

    const pubsubTopic = pubsubTopicWithfallback(community);
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

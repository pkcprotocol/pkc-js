import Logger from "../logger.js";
import pLimit from "p-limit";
import pTimeout from "p-timeout";
import { binaryKeyToPubsubTopic, pubsubTopicToDhtKey, pubsubTopicToDhtKeyCid } from "../util.js";
import { PKCError } from "../pkc-error.js";
import { CID } from "kubo-rpc-client";
const log = Logger("pkc-js:helia:ipns:routing:pubsub-with-fetch");
const LIMIT_PARALLEL_FETCH_IPNS_FROM_PEERS = 3;
const IPNS_FETCH_FROM_PEER_TIMEOUT_MS = 10000;
export class IpnsFetchRouter {
    constructor(helia) {
        this.fetchedIpnsRecordBefore = {}; // key is the "topic", value is true if it was fetched before using libp2p/fetch
        this._helia = helia;
        this._fetchService = helia.libp2p.services.fetch;
    }
    put(routingKey, marshaledRecord, options) {
        throw new Error("Method not implemented.");
    }
    async _fetchFromPeer({ peer, routingKey, topic, options }) {
        const contentCidString = pubsubTopicToDhtKeyCid(topic);
        const record = await pTimeout(this._fetchService.fetch(peer, routingKey), {
            milliseconds: IPNS_FETCH_FROM_PEER_TIMEOUT_MS,
            signal: options?.signal,
            message: new PKCError("ERR_LIBP2P_FETCH_IPNS_FROM_PEER_TIMEDOUT", {
                peerId: peer,
                routingKey,
                topic,
                timeoutMs: IPNS_FETCH_FROM_PEER_TIMEOUT_MS,
                contentCidString,
                options
            })
        });
        if (!record) {
            throw new PKCError("ERR_FETCH_OVER_IPNS_OVER_PUBSUB_RETURNED_UNDEFINED", {
                peerId: peer,
                routingKey,
                topic,
                contentCidString,
                options
            });
        }
        return record;
    }
    async _handleFetchingFromSubscribedPubsubPeers({ routingKey, topic, pubsubSubscribers, options }) {
        const limit = pLimit(LIMIT_PARALLEL_FETCH_IPNS_FROM_PEERS);
        // We already have subscribers, no need to find providers
        log("Using", pubsubSubscribers.length, "existing pubsub subscribers for topic", topic);
        // Create individual abort controllers for each fetch
        const fetchAbortControllers = [];
        const peerIdToError = {};
        const cleanUp = () => {
            fetchAbortControllers.forEach((controller) => controller.abort());
            if (options.abortController)
                options.abortController.abort();
        };
        // Create fetch promises for all subscribers in parallel
        const fetchPromises = pubsubSubscribers.map((peer) => {
            const peerAbortController = new AbortController();
            fetchAbortControllers.push(peerAbortController);
            const combinedSignal = AbortSignal.any([options.signal, peerAbortController.signal]);
            return limit(() => this._fetchFromPeer({
                peer,
                routingKey,
                topic,
                options: { ...options, signal: combinedSignal }
            })).catch((error) => {
                peerIdToError[peer.toString()] = error;
                throw error;
            });
        });
        // Use Promise.allSettled to wait for all promises and find the first successful one
        const results = await Promise.allSettled(fetchPromises);
        // Find the first fulfilled (successful) result
        const successfulResult = results.find((result) => result.status === "fulfilled");
        if (successfulResult) {
            log("Fetched IPNS", options?.ipnsName, "record for topic", topic, "using pubsub subscribers");
            cleanUp();
            this.fetchedIpnsRecordBefore[topic] = true;
            return successfulResult.value;
        }
        else {
            // All promises failed
            cleanUp();
            throw new PKCError("ERR_FETCH_OVER_IPNS_OVER_PUBSUB_FAILED", {
                peerIdToError,
                topic,
                routingKey,
                options,
                fetchingFromGossipsubTopicSubscribers: true
            });
        }
    }
    async _handleFetchingFromProviders({ routingKey, topic, options }) {
        const limit = pLimit(LIMIT_PARALLEL_FETCH_IPNS_FROM_PEERS);
        // No subscribers, need to find providers using content routing and process them as they come
        const pubsubTopicCidString = pubsubTopicToDhtKey(topic);
        const pubsubTopicCid = CID.parse(pubsubTopicToDhtKey(topic));
        const peerIdToError = {};
        const fetchAbortControllers = [];
        const activeFetchPromises = [];
        const findProvidersAbortController = new AbortController();
        const cleanUp = () => {
            findProvidersAbortController.abort();
            fetchAbortControllers.forEach((controller) => controller.abort());
            options.abortController.abort();
        };
        // Helper function to check if any promise has succeeded
        const checkForSuccess = async (promises) => {
            if (promises.length === 0)
                return null;
            const results = await Promise.allSettled(promises);
            const successfulResult = results.find((result) => result.status === "fulfilled");
            return successfulResult ? successfulResult.value : null;
        };
        try {
            // Process providers as they're discovered, but in parallel up to the limit
            for await (const peer of this._helia.libp2p.contentRouting.findProviders(pubsubTopicCid, {
                signal: findProvidersAbortController.signal
            })) {
                const peerAbortController = new AbortController();
                fetchAbortControllers.push(peerAbortController);
                const combinedSignal = AbortSignal.any([options.signal, peerAbortController.signal]);
                const fetchPromise = limit(() => this._fetchFromPeer({
                    peer: peer.id,
                    routingKey,
                    topic,
                    options: { ...options, signal: combinedSignal }
                })).catch((error) => {
                    peerIdToError[peer.id.toString()] = error;
                    throw error;
                });
                activeFetchPromises.push(fetchPromise);
                // Check if any active promises have succeeded
                const result = await checkForSuccess(activeFetchPromises);
                if (result) {
                    cleanUp();
                    log("Fetched IPNS", options?.ipnsName, "record for topic", topic, "using provider discovery");
                    return result;
                }
                // If we have reached the limit, wait for some to complete before adding more
                if (activeFetchPromises.length >= LIMIT_PARALLEL_FETCH_IPNS_FROM_PEERS) {
                    // Remove completed promises
                    const results = await Promise.allSettled(activeFetchPromises);
                    const successfulResult = results.find((result) => result.status === "fulfilled");
                    if (successfulResult) {
                        cleanUp();
                        log("Fetched IPNS", options?.ipnsName, "record for topic", topic, "using provider discovery");
                        return successfulResult.value;
                    }
                }
            }
            // Final check on any remaining promises
            const result = await checkForSuccess(activeFetchPromises);
            if (result) {
                log("Fetched IPNS", options?.ipnsName, "record for topic", topic, "using provider discovery");
                this.fetchedIpnsRecordBefore[topic] = true;
                return result;
            }
            cleanUp();
            // If we get here, all providers have been tried and failed
            throw new PKCError("ERR_FETCH_OVER_IPNS_OVER_PUBSUB_FAILED", {
                peerIdToError,
                fetchingFromProviders: true,
                topic,
                routingKey,
                options
            });
        }
        catch (e) {
            //@ts-expect-error
            e.details = {
                //@ts-expect-error
                ...e.details,
                topic,
                routingKey,
                peerIdToError,
                pubsubTopicCid,
                pubsubTopicCidString,
                options
            };
            throw e;
        }
        finally {
            cleanUp();
        }
    }
    async get(routingKey, options) {
        const topic = binaryKeyToPubsubTopic(routingKey);
        // Check if we should use libp2p/fetch based on cooloff period
        const cooloffKey = `${topic}`;
        const shouldUseFetch = !this.fetchedIpnsRecordBefore[cooloffKey];
        if (!shouldUseFetch) {
            log.trace("Skipping libp2p/fetch for topic", topic, "and IPNS", options?.ipnsName, "since we already fetched it before using libp2p/fetch");
            throw new Error("Already loaded via libp2p/fetch, should await for updates in gossipsub topic");
        }
        // First check if we already have pubsub subscribers
        const pubsubSubscribers = this._helia.libp2p.services.pubsub.getSubscribers(topic);
        const abortController = new AbortController();
        const combinedSignal = options?.signal ? AbortSignal.any([options.signal, abortController.signal]) : abortController.signal;
        try {
            if (pubsubSubscribers.length > 0)
                return await this._handleFetchingFromSubscribedPubsubPeers({
                    routingKey,
                    topic,
                    pubsubSubscribers,
                    options: { ...options, signal: combinedSignal, abortController }
                });
            else
                return await this._handleFetchingFromProviders({
                    routingKey,
                    topic,
                    options: { ...options, signal: combinedSignal, abortController }
                });
        }
        catch (error) {
            //@ts-expect-error
            error.details = { ...error.details, topic, routingKey, options };
            log.trace("Error in get method:", error);
            throw error;
        }
        finally {
            abortController.abort(); // make sure to abort
        }
    }
}
export function createIpnsFetchRouter(helia) {
    return new IpnsFetchRouter(helia);
}
//# sourceMappingURL=ipns-over-pubsub-with-fetch.js.map
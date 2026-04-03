import { GetOptions as ipnsGetOptions, IPNSRouting, PutOptions } from "@helia/ipns/routing";
import Logger from "../logger.js";
import pLimit from "p-limit";
import pTimeout from "p-timeout";

import type { Fetch } from "@libp2p/fetch";
import { peerIdFromString } from "@libp2p/peer-id";
import type { HeliaWithLibp2pPubsub } from "./types.js";
import { binaryKeyToPubsubTopic, pubsubTopicToDhtKey, pubsubTopicToDhtKeyCid } from "../util.js";
import { PlebbitError } from "../plebbit-error.js";
import { CID } from "kubo-rpc-client";

const log = Logger("plebbit-js:helia:ipns:routing:pubsub-with-fetch");

export type PlebbitIpnsGetOptions = ipnsGetOptions & {
    ipnsName: string;
};

const LIMIT_PARALLEL_FETCH_IPNS_FROM_PEERS = 3;
const IPNS_FETCH_FROM_PEER_TIMEOUT_MS = 10000;

// Infer types from the existing usage
type PeerId = ReturnType<typeof peerIdFromString>;

export class IpnsFetchRouter implements IPNSRouting {
    fetchedIpnsRecordBefore: Record<string, boolean> = {}; // key is the "topic", value is true if it was fetched before using libp2p/fetch
    // we only want to use libp2p/fetch if we haven't fetched the record before using libp2p/fetch, subsequent updates should be through gossipsub
    _helia: HeliaWithLibp2pPubsub;
    _fetchService: Fetch;
    constructor(helia: HeliaWithLibp2pPubsub) {
        this._helia = helia;
        this._fetchService = <Fetch>helia.libp2p.services.fetch;
    }
    put(routingKey: Uint8Array, marshaledRecord: Uint8Array, options?: PutOptions): Promise<void> {
        throw new Error("Method not implemented.");
    }

    private async _fetchFromPeer({
        peer,
        routingKey,
        topic,
        options
    }: {
        peer: PeerId;
        routingKey: Uint8Array;
        topic: string;
        options?: PlebbitIpnsGetOptions;
    }): Promise<Uint8Array> {
        const contentCidString = pubsubTopicToDhtKeyCid(topic);

        const record = await pTimeout(this._fetchService.fetch(peer, routingKey), {
            milliseconds: IPNS_FETCH_FROM_PEER_TIMEOUT_MS,
            signal: options?.signal,
            message: new PlebbitError("ERR_LIBP2P_FETCH_IPNS_FROM_PEER_TIMEDOUT", {
                peerId: peer,
                routingKey,
                topic,
                timeoutMs: IPNS_FETCH_FROM_PEER_TIMEOUT_MS,
                contentCidString,
                options
            })
        });

        if (!record) {
            throw new PlebbitError("ERR_FETCH_OVER_IPNS_OVER_PUBSUB_RETURNED_UNDEFINED", {
                peerId: peer,
                routingKey,
                topic,
                contentCidString,
                options
            });
        }
        return record;
    }

    async _handleFetchingFromSubscribedPubsubPeers({
        routingKey,
        topic,
        pubsubSubscribers,
        options
    }: {
        routingKey: Uint8Array;
        topic: string;
        pubsubSubscribers: PeerId[];
        options: PlebbitIpnsGetOptions & { signal: AbortSignal; abortController: AbortController };
    }): Promise<Uint8Array> {
        const limit = pLimit(LIMIT_PARALLEL_FETCH_IPNS_FROM_PEERS);

        // We already have subscribers, no need to find providers
        log("Using", pubsubSubscribers.length, "existing pubsub subscribers for topic", topic);

        // Create individual abort controllers for each fetch
        const fetchAbortControllers: AbortController[] = [];
        const peerIdToError: Record<string, Error> = {};

        const cleanUp = () => {
            fetchAbortControllers.forEach((controller) => controller.abort());
            if (options.abortController) options.abortController.abort();
        };

        // Create fetch promises for all subscribers in parallel
        const fetchPromises = pubsubSubscribers.map((peer) => {
            const peerAbortController = new AbortController();
            fetchAbortControllers.push(peerAbortController);

            const combinedSignal = AbortSignal.any([options.signal, peerAbortController.signal]);

            return limit(() =>
                this._fetchFromPeer({
                    peer,
                    routingKey,
                    topic,
                    options: { ...options, signal: combinedSignal }
                })
            ).catch((error) => {
                peerIdToError[peer.toString()] = error as Error;
                throw error;
            });
        });

        // Use Promise.allSettled to wait for all promises and find the first successful one
        const results = await Promise.allSettled(fetchPromises);

        // Find the first fulfilled (successful) result
        const successfulResult = results.find((result): result is PromiseFulfilledResult<Uint8Array> => result.status === "fulfilled");

        if (successfulResult) {
            log("Fetched IPNS", options?.ipnsName, "record for topic", topic, "using pubsub subscribers");
            cleanUp();
            this.fetchedIpnsRecordBefore[topic] = true;
            return successfulResult.value;
        } else {
            // All promises failed
            cleanUp();
            throw new PlebbitError("ERR_FETCH_OVER_IPNS_OVER_PUBSUB_FAILED", {
                peerIdToError,
                topic,
                routingKey,
                options,
                fetchingFromGossipsubTopicSubscribers: true
            });
        }
    }

    async _handleFetchingFromProviders({
        routingKey,
        topic,
        options
    }: {
        routingKey: Uint8Array;
        topic: string;
        options: PlebbitIpnsGetOptions & { signal: AbortSignal; abortController: AbortController };
    }): Promise<Uint8Array> {
        const limit = pLimit(LIMIT_PARALLEL_FETCH_IPNS_FROM_PEERS);
        // No subscribers, need to find providers using content routing and process them as they come
        const pubsubTopicCidString = pubsubTopicToDhtKey(topic);
        const pubsubTopicCid = CID.parse(pubsubTopicToDhtKey(topic));

        const peerIdToError: Record<string, Error> = {};
        const fetchAbortControllers: AbortController[] = [];
        const activeFetchPromises: Promise<Uint8Array>[] = [];

        const findProvidersAbortController = new AbortController();

        const cleanUp = () => {
            findProvidersAbortController.abort();
            fetchAbortControllers.forEach((controller) => controller.abort());
            options.abortController.abort();
        };

        // Helper function to check if any promise has succeeded
        const checkForSuccess = async (promises: Promise<Uint8Array>[]): Promise<Uint8Array | null> => {
            if (promises.length === 0) return null;

            const results = await Promise.allSettled(promises);
            const successfulResult = results.find((result): result is PromiseFulfilledResult<Uint8Array> => result.status === "fulfilled");

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

                const fetchPromise = limit(() =>
                    this._fetchFromPeer({
                        peer: peer.id,
                        routingKey,
                        topic,
                        options: { ...options, signal: combinedSignal }
                    })
                ).catch((error) => {
                    peerIdToError[peer.id.toString()] = error as Error;
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
                    const successfulResult = results.find(
                        (result): result is PromiseFulfilledResult<Uint8Array> => result.status === "fulfilled"
                    );

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
            throw new PlebbitError("ERR_FETCH_OVER_IPNS_OVER_PUBSUB_FAILED", {
                peerIdToError,
                fetchingFromProviders: true,
                topic,
                routingKey,
                options
            });
        } catch (e) {
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
        } finally {
            cleanUp();
        }
    }

    async get(routingKey: Uint8Array, options: PlebbitIpnsGetOptions): Promise<Uint8Array> {
        const topic = binaryKeyToPubsubTopic(routingKey);

        // Check if we should use libp2p/fetch based on cooloff period
        const cooloffKey = `${topic}`;
        const shouldUseFetch = !this.fetchedIpnsRecordBefore[cooloffKey];

        if (!shouldUseFetch) {
            log.trace(
                "Skipping libp2p/fetch for topic",
                topic,
                "and IPNS",
                options?.ipnsName,
                "since we already fetched it before using libp2p/fetch"
            );
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
        } catch (error) {
            //@ts-expect-error
            error.details = { ...error.details, topic, routingKey, options };
            log.trace("Error in get method:", error);
            throw error;
        } finally {
            abortController.abort(); // make sure to abort
        }
    }
}

export function createIpnsFetchRouter(helia: HeliaWithLibp2pPubsub): IPNSRouting {
    return new IpnsFetchRouter(helia);
}

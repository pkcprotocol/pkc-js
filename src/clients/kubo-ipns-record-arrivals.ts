import Logger from "../logger.js";
import type { KuboRpcClient, PubsubSubscriptionHandler } from "../types.js";
import type { IpnsRecordArrivalListener, IpnsRecordArrivals } from "../helia/types.js";

// Push signal for IPNS names on the kubo-RPC resolver (issue #322), the counterpart of the
// libp2p-js client's localStore.put wrap (issue #308). Kubo's namesys keeps its IPNS-over-pubsub
// records in a store pkc cannot observe, but the records travel over ordinary gossipsub topics
// that the daemon's pubsub RPC can also stream to us: one `pubsub.subscribe` per record topic,
// shared by every community update loop watching that name. Two properties of kubo make the
// arrivals safe to act on with a plain `name.resolve` (which the kubo resolver always issues
// with nocache: true, a local-store read — see resolveIpnsToCidP2P):
//   - the record topic's validator runs before delivery to ANY subscriber, so a message that
//     reaches the RPC stream is a signature-valid, unexpired record (we still parse defensively);
//   - kubo hands the record to its namesys store and to the RPC stream from the same delivery,
//     so a resolve issued from the listener observes it (verified 49/49 against kubo 0.43).
//
// One hazard drives the lifecycle rules the update loop follows (community-client-manager's
// _syncIpnsArrivalSubscriptions): if the RPC subscription joins a record topic BEFORE kubo's
// namesys has joined it, namesys can never join that name on that daemon (go-libp2p-pubsub
// refuses a second Join of an existing topic), and `name.resolve` of the name fails for the
// daemon's lifetime — even after the RPC subscription is cancelled. So a topic here is only ever
// subscribed AFTER a resolve walked its name, and a subscription that dies (daemon restart,
// stream error) is reported dead through isSubscribed rather than silently re-established: the
// loop re-walks the name first and re-arms afterwards.
export function createKuboIpnsRecordArrivals({
    kuboRpcClient,
    kuboRpcClientUrl
}: {
    kuboRpcClient: KuboRpcClient["_client"];
    kuboRpcClientUrl: string;
}): IpnsRecordArrivals & { destroy(): Promise<void> } {
    const log = Logger("pkc-js:kubo-rpc-client:ipns-record-arrivals");
    type TopicState = {
        listeners: Set<IpnsRecordArrivalListener>;
        // The kubo-rpc-client handler bound to this establishment; a fresh function per attempt
        // because the client's subscription tracker keys on (topic, handler).
        handler?: PubsubSubscriptionHandler;
        establishing?: Promise<void>;
        live: boolean;
    };
    const topics = new Map<string, TopicState>();
    // ipns is a lazy chunk (kept off the eager import path); resolved once and cached.
    const ipnsModule = import("ipns");

    const tearDownKuboSubscription = async (pubsubTopic: string, state: TopicState) => {
        const handler = state.handler;
        state.handler = undefined;
        state.live = false;
        state.establishing = undefined;
        if (!handler) return;
        try {
            await kuboRpcClient.pubsub.unsubscribe(pubsubTopic, handler);
        } catch (e) {
            log.trace("Failed to cancel the kubo pubsub subscription of IPNS record topic", pubsubTopic, "on", kuboRpcClientUrl, e);
        }
    };

    const establish = (pubsubTopic: string, state: TopicState): Promise<void> => {
        const handler: PubsubSubscriptionHandler = (message) => {
            if (state.handler !== handler) return; // a stale stream delivering after teardown
            ipnsModule
                .then(({ unmarshalIPNSRecord }) => {
                    const record = unmarshalIPNSRecord(message.data);
                    for (const listener of state.listeners) listener({ pubsubTopic, record });
                })
                .catch((e) => log.trace("Ignoring an unparsable message on IPNS record topic", pubsubTopic, "from", kuboRpcClientUrl, e));
        };
        const onError = (err: Error) => {
            if (state.handler !== handler) return;
            // Do NOT re-subscribe here: the daemon may have restarted, in which case namesys has
            // to join the topic again before we do (see the hazard note above). Mark the topic
            // dead; the update loop notices via isSubscribed, re-walks the name, then re-arms.
            log.trace(
                "kubo pubsub stream of IPNS record topic",
                pubsubTopic,
                "on",
                kuboRpcClientUrl,
                "died, will be re-armed after the next resolve",
                err
            );
            tearDownKuboSubscription(pubsubTopic, state).catch(() => {});
        };
        state.handler = handler;
        state.live = false;
        const establishing = kuboRpcClient.pubsub
            .subscribe(pubsubTopic, handler, { onError })
            .then(() => {
                if (state.handler !== handler) return; // torn down while establishing
                state.live = true;
            })
            .catch((e) => {
                if (state.handler === handler) {
                    state.handler = undefined;
                    state.live = false;
                    state.establishing = undefined;
                }
                throw e;
            });
        state.establishing = establishing;
        return establishing;
    };

    return {
        subscribe: ({ pubsubTopic, listener }) => {
            const state = topics.get(pubsubTopic) ?? { listeners: new Set<IpnsRecordArrivalListener>(), live: false };
            topics.set(pubsubTopic, state);
            state.listeners.add(listener);
            if (state.live) return;
            if (state.establishing) return state.establishing;
            return establish(pubsubTopic, state);
        },
        unsubscribe: ({ pubsubTopic, listener }) => {
            const state = topics.get(pubsubTopic);
            if (!state) return;
            state.listeners.delete(listener);
            if (state.listeners.size > 0) return;
            topics.delete(pubsubTopic);
            tearDownKuboSubscription(pubsubTopic, state).catch(() => {});
        },
        isSubscribed: ({ pubsubTopic }) => topics.get(pubsubTopic)?.live === true,
        destroy: async () => {
            const entries = [...topics.entries()];
            topics.clear();
            await Promise.all(entries.map(([pubsubTopic, state]) => tearDownKuboSubscription(pubsubTopic, state)));
        }
    };
}

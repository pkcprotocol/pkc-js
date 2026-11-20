// A kubo node's pubsub subscription list, shared by everything in this process that asks the same node (issue #576).
//
// `pubsub.ls()` returns the node's whole list, and every started community used to call it at the start of every
// cycle to check on its own topic: N calls per publishInterval, each decoding N topic names. Here overlapping
// callers join one request, and a result is reused for `maxAgeMs`. The list is handed out as a Set, built once per
// request: each caller looks its own topic up in it, and scanning an array of N names from N callers is N² again.
//
// A subscribe or unsubscribe made through this process bumps the client's epoch, which drops the stored list and
// stops anyone from joining a request that started before the change. Without that a community that had just
// subscribed could be told by a stale list that its topic is missing, and would tear its subscription down to
// subscribe again. A list that is stale the other way (kubo lost a subscription on its own, e.g. it restarted) is
// noticed at most `maxAgeMs` late.
//
// Dependency-free on purpose: the client manager, which the browser build includes, imports it.

// How long a read that every community of a node waits on may take. The kubo client's own timeout is an hour, and one
// request that never answers would hold the publish loop of every community that joined it for that long. A read
// each community made for itself held up only that community.
export const SHARED_KUBO_READ_TIMEOUT_MS = 60_000;

type PubsubTopicLister = { pubsub: { ls: (options?: { timeout?: number }) => Promise<string[]> } };

type SharedPubsubTopicList = {
    epoch: number;
    stored?: { epoch: number; topics: ReadonlySet<string>; fetchedAtMs: number };
    inFlight?: { epoch: number; promise: Promise<ReadonlySet<string>> };
};

const sharedListByClient = new WeakMap<object, SharedPubsubTopicList>();

function sharedListOf(client: object): SharedPubsubTopicList {
    let shared = sharedListByClient.get(client);
    if (!shared) {
        shared = { epoch: 0 };
        sharedListByClient.set(client, shared);
    }
    return shared;
}

export async function listSubscribedPubsubTopicsShared({
    client,
    maxAgeMs
}: {
    client: PubsubTopicLister;
    maxAgeMs: number;
}): Promise<ReadonlySet<string>> {
    const shared = sharedListOf(client);
    const stored = shared.stored;
    if (stored && stored.epoch === shared.epoch && Date.now() - stored.fetchedAtMs < maxAgeMs) return stored.topics;
    if (shared.inFlight && shared.inFlight.epoch === shared.epoch) return shared.inFlight.promise;

    const epoch = shared.epoch;
    const promise = client.pubsub
        .ls({ timeout: SHARED_KUBO_READ_TIMEOUT_MS })
        .then((topicList): ReadonlySet<string> => {
            const topics = new Set(topicList);
            // A change that landed while the request was out may or may not be in this answer: hand it to the
            // callers that asked before the change, but do not keep it for the ones that ask after.
            if (shared.epoch === epoch) shared.stored = { epoch, topics, fetchedAtMs: Date.now() };
            return topics;
        })
        .finally(() => {
            if (shared.inFlight?.promise === promise) shared.inFlight = undefined;
        });
    shared.inFlight = { epoch, promise };
    return promise;
}

// Called after every subscribe or unsubscribe this process sends to the client, whether or not it succeeded.
export function invalidateSharedPubsubTopicList(client: object): void {
    const shared = sharedListByClient.get(client);
    if (!shared) return;
    shared.epoch++;
    shared.stored = undefined;
}

import { peerIdFromString } from "@libp2p/peer-id";
import Logger from "../logger.js";
import type { KuboRpcClient } from "../types.js";

// Kubo answers these from memory; the bound is for a daemon that is down or wedged, so a stop() never hangs on it.
const KUBO_NAME_PUBSUB_TIMEOUT_MS = 10_000;

// "12D3Koo…" (base58) and "k51…" (base36) spell the same IPNS name; undefined for anything that is not one.
function ipnsNameToPeerIdString(ipnsName: string): string | undefined {
    try {
        return peerIdFromString(ipnsName.replace(/^\/ipns\//, "")).toString();
    } catch {
        return undefined;
    }
}

// Kubo's IPNS-over-pubsub (namesys) subscribes to a name's record topic whenever the name is published or resolved
// through the node, and keeps that subscription until `name pubsub cancel` or a daemon restart. Without a cancel a
// node stays subscribed to every community it has ever hosted or followed, and peers remember only a bounded number
// of topics per peer (see GOSSIPSUB_MAX_TOPIC_BYTES_PER_PEER), so the leftovers crowd out the topics of the
// communities it still serves (issue #602). A later publish or resolve of the name subscribes again.
//
// Never throws: a subscription left behind is a leak, a community that cannot stop is worse.
//
// unlessKuboHoldsTheKey is for a follower. Kubo cannot say who uses a subscription, but it can say whether it has
// the name's key, which means the community is hosted through this node, possibly by another process. That host
// has to stay subscribed to keep serving its record, so the follower leaves the name alone. When the key lookup
// fails nothing is cancelled.
export async function cancelKuboIpnsPubsubSubscriptions({
    kuboRpcClient,
    ipnsNames,
    unlessKuboHoldsTheKey
}: {
    kuboRpcClient: Pick<KuboRpcClient, "_client" | "url">;
    ipnsNames: (string | undefined)[];
    unlessKuboHoldsTheKey?: boolean;
}): Promise<void> {
    const log = Logger("pkc-js:kubo-ipns-pubsub:cancel");
    let namesToCancel = [...new Set(ipnsNames.map((name) => (name ? ipnsNameToPeerIdString(name) : undefined)))].filter(
        (name): name is string => typeof name === "string"
    );
    if (namesToCancel.length === 0) return;

    if (unlessKuboHoldsTheKey) {
        try {
            const keys = await kuboRpcClient._client.key.list({ signal: AbortSignal.timeout(KUBO_NAME_PUBSUB_TIMEOUT_MS) });
            const namesWithKey = new Set(keys.map((key) => ipnsNameToPeerIdString(key.id)));
            namesToCancel = namesToCancel.filter((name) => !namesWithKey.has(name));
        } catch (e) {
            log.error("Failed to list the keys of kubo", kuboRpcClient.url, "so no IPNS pubsub subscription is cancelled", e);
            return;
        }
    }

    for (const name of namesToCancel)
        try {
            await kuboRpcClient._client.name.pubsub.cancel(name, { signal: AbortSignal.timeout(KUBO_NAME_PUBSUB_TIMEOUT_MS) });
        } catch (e) {
            // Expected on a daemon started without --enable-namesys-pubsub, which has no such subscriptions
            log.trace("Failed to cancel the IPNS pubsub subscription of", name, "on kubo", kuboRpcClient.url, e);
        }
}

import Logger from "../../../../logger.js";
import { flat, isDeepEqual, unique } from "remeda";
import { CID } from "multiformats/cid";
import { normalizeSelfAddrsForProvider } from "../../addresses-rewriter-proxy-server.js";

// How often LocalCommunity polls its own node for browser-dialable address changes.
// Matches the address-rewriter proxy's own 60s refresh so a rotation is noticed within one cycle.
export const ADDRESS_REPROVIDE_POLL_INTERVAL_MS = 60 * 1000;

// Minimal structural view of the kubo rpc client used here. Kept narrow so the core logic can be
// unit-tested with a fake client without dragging in the full kubo-rpc-client surface. The real
// LocalCommunity client is structurally assignable to this.
export type ReprovideKuboRpcClient = {
    id: () => Promise<{ id: { toString: () => string }; addresses: Array<{ toString: () => string }> }>;
    swarm: { addrs: () => Promise<Array<{ id: { toString: () => string }; addrs: Array<{ toString: () => string }> }>> };
    routing: { provide: (cid: CID, options?: { recursive?: boolean }) => AsyncIterable<unknown> };
};

// Minimal structural view of LocalCommunity needed to detect address changes and re-provide. The full
// LocalCommunity satisfies this, and it keeps the function testable in isolation.
export type AddressChangeReprovidable = {
    address: string;
    pubsubTopicRoutingCid?: string;
    ipnsPubsubTopicRoutingCid?: string;
    _lastProvidedBrowserDialableSelfAddrs?: string[];
    _lastAddressReprovideCheckAt?: number;
    _clientsManager: { getDefaultKuboRpcClient: () => { _client: ReprovideKuboRpcClient } };
};

// Transports a browser can actually dial. These are exactly the addresses that rotate/expire frequently
// (WebRTC-direct certhash rotation, AutoTLS WSS) and that kubo prunes from HTTP-router announces, so they
// are the ones whose change must trigger a fresh provide. Plain TCP/QUIC changes are irrelevant to browsers.
export function isBrowserDialableAddr(addr: string): boolean {
    return addr.includes("/webrtc") || addr.includes("/ws");
}

// Fetch the node's current browser-dialable self-addresses, normalized the same way the address-rewriter
// proxy normalizes them before announcing (strip the trailing /p2p/<peerId>, dedupe), then sorted so the
// result can be compared by value across calls.
export async function getBrowserDialableSelfAddrs(client: ReprovideKuboRpcClient): Promise<string[]> {
    const idRes = await client.id();
    const peerId = idRes.id.toString();
    const swarmAddrsRes = await client.swarm.addrs();
    const swarmListeningAddresses = swarmAddrsRes.filter((swarmAddr) => swarmAddr.id.toString() === peerId);

    const normalized = normalizeSelfAddrsForProvider(
        [
            ...idRes.addresses.map((addr) => addr.toString()),
            ...flat(swarmListeningAddresses.map((swarmAddr) => swarmAddr.addrs.map((addr) => addr.toString())))
        ],
        peerId
    );

    return unique(normalized.filter(isBrowserDialableAddr)).sort();
}

// The CIDs a browser needs a fresh provider record for in order to bootstrap a connection to the community:
// the pubsub-topic routing blocks used to find challenge / ipns-over-pubsub peers. These are derived
// deterministically from the (never-changing) topics, so their router records are exactly what goes stale
// when the node's addresses rotate. updateCid is intentionally excluded: it rotates every <=15 min and is
// re-provided with fresh addresses on every publish, so it is already self-healing.
function connectionCriticalCids(community: AddressChangeReprovidable): string[] {
    return unique(
        [community.pubsubTopicRoutingCid, community.ipnsPubsubTopicRoutingCid].filter((cid): cid is string => typeof cid === "string")
    );
}

/**
 * Re-provide the connection-critical CIDs when the node's browser-dialable (WSS/WebRTC) self-addresses
 * have changed since the last provide. This pushes the current addresses to the HTTP routers (via the
 * address-rewriter proxy) so browsers don't get NoValidAddressesError against stale/dead addresses.
 *
 * The first observation only establishes a baseline (start() already force-provides these CIDs with fresh
 * addresses via providePubsubTopicRoutingCidsIfNeeded); subsequent changes trigger a re-provide.
 */
export async function reprovideConnectionCidsIfBrowserAddrsChanged(
    community: AddressChangeReprovidable
): Promise<{ reprovided: boolean; providedCids: string[]; browserAddrs: string[] }> {
    const log = Logger("pkc-js:local-community:_reprovideConnectionCidsIfBrowserAddrsChanged");
    const client = community._clientsManager.getDefaultKuboRpcClient()._client;
    const current = await getBrowserDialableSelfAddrs(client);
    const previous = community._lastProvidedBrowserDialableSelfAddrs;

    if (previous === undefined) {
        // First observation: just establish the baseline; start() already provided these CIDs with fresh addresses.
        community._lastProvidedBrowserDialableSelfAddrs = current;
        return { reprovided: false, providedCids: [], browserAddrs: current };
    }

    if (isDeepEqual(previous, current)) return { reprovided: false, providedCids: [], browserAddrs: current };

    // Record the snapshot before providing so a slow/failing provide doesn't make us re-announce every tick.
    community._lastProvidedBrowserDialableSelfAddrs = current;

    const cidStrings = connectionCriticalCids(community);
    const providedCids: string[] = [];
    for (const cidString of cidStrings) {
        let cid: CID;
        try {
            cid = CID.parse(cidString);
        } catch (e) {
            log.error(`Failed to parse connection-critical CID (${cidString}) for community (${community.address})`, e);
            continue;
        }
        try {
            const provideEvents = client.routing.provide(cid, { recursive: true });
            for await (const event of provideEvents) log.trace(`Provide event for ${cidString}:`, event);
            providedCids.push(cidString);
        } catch (e) {
            log.error(`Failed to re-provide connection-critical CID (${cidString}) for community (${community.address})`, e);
        }
    }

    log(
        `Browser-dialable addresses of community (${community.address}) changed; re-provided ${providedCids.length}/${cidStrings.length} connection-critical CIDs`,
        { browserAddrs: current }
    );

    return { reprovided: providedCids.length > 0, providedCids, browserAddrs: current };
}

/**
 * Publish-loop entry point. The publish loop runs once per sync cycle (and faster during bursts), so this
 * throttles the kubo id()/swarm.addrs() poll to ADDRESS_REPROVIDE_POLL_INTERVAL_MS before delegating to the
 * core change-detection. Lives inside the publish loop so it's torn down together with the loop on stop().
 */
export async function reprovideOnAddressChangeIfDue(community: AddressChangeReprovidable): Promise<void> {
    const now = Date.now();
    if (
        typeof community._lastAddressReprovideCheckAt === "number" &&
        now - community._lastAddressReprovideCheckAt < ADDRESS_REPROVIDE_POLL_INTERVAL_MS
    )
        return;
    community._lastAddressReprovideCheckAt = now;
    await reprovideConnectionCidsIfBrowserAddrsChanged(community);
}

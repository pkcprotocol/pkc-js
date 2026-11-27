import { flat, isDeepEqual, unique } from "remeda";
import type { Logger } from "@pkcprotocol/pkc-logger";
import { CID } from "multiformats/cid";
import { SHARED_KUBO_READ_TIMEOUT_MS } from "../../../../clients/shared-pubsub-topic-list.js";

// How often LocalCommunity polls its own node for browser-dialable address changes. One minute is
// short enough that a rotated WebRTC certhash or a re-issued AutoTLS name is noticed while the old
// provider record is still fresh at the routers.
export const ADDRESS_REPROVIDE_POLL_INTERVAL_MS = 60 * 1000;

// `ipfs id` returns self-addresses with a trailing `/p2p/<peerId>` while `swarm addrs`
// returns the same transports without it, so unioning them yields each address twice plus
// non-standard `/p2p`-suffixed entries. The `/routing/v1` provider schema carries the peer id
// in the separate `ID` field and expects transport-only `Addrs`, so strip the trailing
// `/p2p/<peerId>` and dedupe before comparing or announcing.
export function normalizeSelfAddrsForProvider(addrs: string[], peerId: string): string[] {
    const suffix = `/p2p/${peerId}`;
    return unique(addrs.map((addr) => (addr.endsWith(suffix) ? addr.slice(0, -suffix.length) : addr)));
}

// Minimal structural view of the kubo rpc client used here. Kept narrow so the core logic can be
// unit-tested with a fake client without dragging in the full kubo-rpc-client surface. The real
// LocalCommunity client is structurally assignable to this.
export type ReprovideKuboRpcClient = {
    id: (options?: { timeout?: number }) => Promise<{ id: { toString: () => string }; addresses: Array<{ toString: () => string }> }>;
    swarm: {
        addrs: (options?: {
            timeout?: number;
        }) => Promise<Array<{ id: { toString: () => string }; addrs: Array<{ toString: () => string }> }>>;
    };
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
    _log: Logger;
};

// Transports a browser can actually dial. These are exactly the addresses that rotate/expire frequently
// (WebRTC-direct and WebTransport certhash rotation, AutoTLS WSS), so they are the ones whose change must
// trigger a fresh provide. Plain TCP/QUIC changes are irrelevant to browsers.
export function isBrowserDialableAddr(addr: string): boolean {
    // A browser dials WebTransport only with the server's certhash, so a bare /webtransport addr is undialable
    return addr.includes("/webrtc") || addr.includes("/ws") || (addr.includes("/webtransport") && addr.includes("/certhash/"));
}

// Fetch the node's current browser-dialable self-addresses, normalized the way a provider record carries
// them (strip the trailing /p2p/<peerId>, dedupe), then sorted so the result can be compared by value
// across calls.
export async function getBrowserDialableSelfAddrs(client: ReprovideKuboRpcClient, options?: { timeout?: number }): Promise<string[]> {
    const idRes = await client.id(options);
    const peerId = idRes.id.toString();
    const swarmAddrsRes = await client.swarm.addrs(options);
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

// A node's own addresses are the same for every community on it, and swarm.addrs() lists every peer the node knows,
// so one read serves all of them (issue #576): overlapping callers join one request, and its result is reused for
// `maxAgeMs`. Keyed by the kubo client, which the communities of a PKC share. Every caller is told when the read it
// was handed was made. The requests carry a timeout because all the communities that joined one wait on it together.
type SelfAddrsRead = { addrs: string[]; readAtMs: number };
const sharedSelfAddrsByClient = new WeakMap<object, { inFlight?: Promise<SelfAddrsRead>; stored?: SelfAddrsRead }>();

export async function getBrowserDialableSelfAddrsShared({
    client,
    maxAgeMs
}: {
    client: ReprovideKuboRpcClient;
    maxAgeMs: number;
}): Promise<SelfAddrsRead> {
    let shared = sharedSelfAddrsByClient.get(client);
    if (!shared) {
        shared = {};
        sharedSelfAddrsByClient.set(client, shared);
    }
    const sharedOfClient = shared;
    if (sharedOfClient.stored && Date.now() - sharedOfClient.stored.readAtMs < maxAgeMs) return sharedOfClient.stored;
    if (sharedOfClient.inFlight) return sharedOfClient.inFlight;
    const inFlight = getBrowserDialableSelfAddrs(client, { timeout: SHARED_KUBO_READ_TIMEOUT_MS })
        .then((addrs) => {
            sharedOfClient.stored = { addrs, readAtMs: Date.now() };
            return sharedOfClient.stored;
        })
        .finally(() => {
            if (sharedOfClient.inFlight === inFlight) sharedOfClient.inFlight = undefined;
        });
    sharedOfClient.inFlight = inFlight;
    return inFlight;
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
 * Re-provide the connection-critical CIDs when the node's browser-dialable (WSS/WebRTC/WebTransport) self-addresses
 * have changed since the last provide. This pushes the current addresses to the HTTP routers so browsers
 * don't get NoValidAddressesError against stale/dead addresses.
 *
 * The first observation only establishes a baseline (start() already force-provides these CIDs with fresh
 * addresses via providePubsubTopicRoutingCidsIfNeeded); subsequent changes trigger a re-provide.
 */
export async function reprovideConnectionCidsIfBrowserAddrsChanged(
    community: AddressChangeReprovidable,
    // How old a read of the node's addresses another community made may be. 0 always asks kubo.
    { selfAddrsMaxAgeMs = 0 }: { selfAddrsMaxAgeMs?: number } = {}
): Promise<{ reprovided: boolean; providedCids: string[]; browserAddrs: string[]; browserAddrsReadAtMs: number }> {
    const log = community._log;
    const client = community._clientsManager.getDefaultKuboRpcClient()._client;
    const { addrs: current, readAtMs: browserAddrsReadAtMs } =
        selfAddrsMaxAgeMs > 0
            ? await getBrowserDialableSelfAddrsShared({ client, maxAgeMs: selfAddrsMaxAgeMs })
            : { addrs: await getBrowserDialableSelfAddrs(client), readAtMs: Date.now() };
    const previous = community._lastProvidedBrowserDialableSelfAddrs;

    if (previous === undefined) {
        // First observation: just establish the baseline; start() already provided these CIDs with fresh addresses.
        community._lastProvidedBrowserDialableSelfAddrs = current;
        return { reprovided: false, providedCids: [], browserAddrs: current, browserAddrsReadAtMs };
    }

    if (isDeepEqual(previous, current)) return { reprovided: false, providedCids: [], browserAddrs: current, browserAddrsReadAtMs };

    // Record the snapshot before providing so a slow/failing provide doesn't make us re-announce every tick.
    community._lastProvidedBrowserDialableSelfAddrs = current;

    const cidStrings = connectionCriticalCids(community);
    const providedCids: string[] = [];
    for (const cidString of cidStrings) {
        let cid: CID;
        try {
            cid = CID.parse(cidString);
        } catch (e) {
            log.error(
                `_reprovideConnectionCidsIfBrowserAddrsChanged: Failed to parse connection-critical CID (${cidString}) for community (${community.address})`,
                e
            );
            continue;
        }
        try {
            const provideEvents = client.routing.provide(cid, { recursive: true });
            for await (const event of provideEvents)
                log.trace(`_reprovideConnectionCidsIfBrowserAddrsChanged: Provide event for ${cidString}:`, event);
            providedCids.push(cidString);
        } catch (e) {
            log.error(
                `_reprovideConnectionCidsIfBrowserAddrsChanged: Failed to re-provide connection-critical CID (${cidString}) for community (${community.address})`,
                e
            );
        }
    }

    log(
        `_reprovideConnectionCidsIfBrowserAddrsChanged: Browser-dialable addresses of community (${community.address}) changed; re-provided ${providedCids.length}/${cidStrings.length} connection-critical CIDs`,
        { browserAddrs: current }
    );

    return { reprovided: providedCids.length > 0, providedCids, browserAddrs: current, browserAddrsReadAtMs };
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
    // Communities spread their checks over the poll interval, so a read reused for a quarter of it costs the node
    // about four id() + swarm.addrs() calls per interval however many communities it hosts (issue #576). A rotated
    // address is noticed at most that much later: the next check is due one interval after the read this one was
    // handed, not one interval after now, or a read that was already old would be trusted for a whole interval more.
    const { browserAddrsReadAtMs } = await reprovideConnectionCidsIfBrowserAddrsChanged(community, {
        selfAddrsMaxAgeMs: ADDRESS_REPROVIDE_POLL_INTERVAL_MS / 4
    });
    community._lastAddressReprovideCheckAt = Math.min(now, browserAddrsReadAtMs);
}

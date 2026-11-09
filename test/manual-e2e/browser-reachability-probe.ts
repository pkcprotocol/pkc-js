// Probes whether a community's providers can be reached the way a browser reaches them (issue #475).
//
// A Node.js libp2p client dials TCP and QUIC, which no browser has, so a Node run that loads a community says
// nothing about browsers. This probe takes the June 2026 benchmark approach instead: a libp2p node whose
// connection gater denies every address a browser could not dial, so a dial succeeds only over WebSocket Secure
// with a certificate Node trusts the same way a browser does (`/dns4/<name>/tcp/443/tls/ws` behind AutoTLS or an
// operator domain, `/ip4/<ip>/tcp/443/tls/ws` behind a Let's Encrypt IP certificate).
//
// WebTransport cannot be dialed from Node (no WebTransport API, and pkc-js ships no `@libp2p/webtransport`), so
// for `/webtransport` addresses the probe checks the two things a browser needs before the handshake: the address
// carries certhashes, and the UDP path answers. The UDP check is a QUIC version-negotiation probe: a 1200-byte
// long-header packet with an unsupported version, to which every QUIC server must answer with a Version
// Negotiation packet (RFC 9000 section 6). No TLS, no browser. A reply proves a QUIC listener at that address from
// this network; it does not run the WebTransport handshake or check the certhashes. Silence means the UDP path or
// the node is unavailable from here, and the same endpoint answering from another network tells which. Consumer ISPs that filter IPv4 UDP 4001 are why seeders also
// listen on UDP 443 (see docs/reachability.md, "What a seeder must announce").
//
// Providers are found the way pkc-js finds them: the community's IPNS name becomes its IPNS-over-pubsub topic,
// the topic hashes to the CID that providers announce, and every HTTP router is asked for that CID. Which
// routers listed each provider is reported, since a router keeps an announcement for 24 h and a stale one shows
// up as a provider that no longer answers.
import { createLibp2p, type Libp2p } from "libp2p";
import { libp2pDefaults } from "@helia/libp2p";
import { multiaddr, type Multiaddr } from "@multiformats/multiaddr";
import { peerIdFromString } from "@libp2p/peer-id";
import { identify, type Identify } from "@libp2p/identify";
import type { Ping } from "@libp2p/ping";
import { createSocket } from "node:dgram";
import { lookup } from "node:dns/promises";
import { randomFillSync } from "node:crypto";
import { ipnsNameToIpnsOverPubsubTopic, pubsubTopicToDhtKeyCid } from "../../dist/node/util.js";

export type AddrKind = "wss" | "ws" | "webtransport" | "webrtc-direct" | "relay" | "tcp" | "quic" | "other";

export interface ClassifiedAddr {
    multiaddr: string;
    kind: AddrKind;
    /** ip4 / ip6 literal or the DNS name */
    host?: string;
    hostFamily?: "ip4" | "ip6" | "dns4" | "dns6" | "dns";
    port?: number;
    /** `/certhash` components on the address; kubo announces two (current and next certificate) */
    certhashes: number;
}

export interface WssDialResult {
    multiaddr: string;
    ok: boolean;
    /** time to an open, encrypted libp2p connection */
    connectMs?: number;
    pingMs?: number;
    agentVersion?: string;
    protocols?: number;
    error?: string;
}

export interface UdpProbeResult {
    multiaddr: string;
    host: string;
    resolvedIp?: string;
    port: number;
    /** any datagram came back */
    answered: boolean;
    /** the reply is a QUIC Version Negotiation packet */
    versionNegotiation: boolean;
    ms?: number;
    error?: string;
}

export interface ProviderVerdict {
    /** at least one `/tls/ws` or `/wss` address dialed with full certificate verification: what a pkc-js browser can use today */
    wssDialable: boolean;
    /** at least one webtransport address with certhashes; a certhash-less one is announced but no browser can dial it */
    webtransportAnnounced: boolean;
    /** at least one certhash webtransport address whose UDP endpoint answered the QUIC probe with Version Negotiation; a reply
     * of any other shape is some other UDP service or a middlebox and does not count */
    webtransportUdpAnswers: boolean;
    /** a certhash webtransport address on UDP 443, the port that survives networks filtering UDP 4001 */
    webtransportOnUdp443: boolean;
    hasIpv6: boolean;
    relayOnly: boolean;
    /** wssDialable; pkc-js denies webtransport dials by default (src/helia/dial-transport-filter.ts) */
    browserDialableToday: boolean;
    /** wssDialable or webtransportUdpAnswers: what a browser can use once pkc-js allows webtransport. The UDP probe shows a
     * QUIC listener at the address; it does not run the WebTransport handshake or check the certhashes */
    browserDialableWithWebTransport: boolean;
}

export interface ProviderReport {
    peerId: string;
    /** routers whose provider record listed this peer, or ["given"] for peers passed explicitly */
    listedBy: string[];
    addrs: ClassifiedAddr[];
    wss: WssDialResult[];
    webtransport: UdpProbeResult[];
    verdict: ProviderVerdict;
    /** operator-facing findings, one line each */
    problems: string[];
}

export interface TargetReport {
    /** the IPNS name probed, or "peers" for explicitly given peers */
    target: string;
    providerCid?: string;
    providers: ProviderReport[];
    routerErrors: Record<string, string>;
    providersDialableToday: number;
    providersDialableWithWebTransport: number;
}

export interface ProbeReport {
    at: string;
    routers: string[];
    dialTimeoutMs: number;
    udpTimeoutMs: number;
    targets: TargetReport[];
}

export interface ProbeOptions {
    /** community IPNS names (the community's publicKey, 12D3... or k51...) */
    ipnsNames?: string[];
    /** explicit provider multiaddrs with a /p2p/ component; probed without any router lookup */
    peerMultiaddrs?: string[];
    routers: string[];
    dialTimeoutMs?: number;
    udpTimeoutMs?: number;
    /** called as each provider finishes, for progress output */
    onProvider?: (target: string, provider: ProviderReport) => void;
}

const KNOWN_HOST_COMPONENTS = new Set(["ip4", "ip6", "dns4", "dns6", "dns"]);

export function classifyMultiaddr(ma: Multiaddr): ClassifiedAddr {
    const components = ma.getComponents();
    const names = components.map((c) => c.name);
    const has = (name: string) => names.includes(name);
    let kind: AddrKind = "other";
    if (has("p2p-circuit")) kind = "relay";
    else if (has("wss") || (has("tls") && has("ws"))) kind = "wss";
    else if (has("webtransport")) kind = "webtransport";
    else if (has("webrtc-direct")) kind = "webrtc-direct";
    else if (has("ws")) kind = "ws";
    else if (has("quic-v1") || has("quic")) kind = "quic";
    else if (has("tcp")) kind = "tcp";

    const hostComponent = components.find((c) => KNOWN_HOST_COMPONENTS.has(c.name));
    const portComponent = components.find((c) => c.name === "tcp" || c.name === "udp");
    const hostFamily = hostComponent?.name as ClassifiedAddr["hostFamily"];
    return {
        multiaddr: ma.toString(),
        kind,
        host: hostComponent?.value,
        hostFamily,
        port: portComponent?.value !== undefined ? Number(portComponent.value) : undefined,
        certhashes: names.filter((n) => n === "certhash").length
    };
}

export function peerIdOf(ma: Multiaddr): string | undefined {
    return ma.getComponents().find((c) => c.name === "p2p")?.value;
}

export function isBrowserDialableKind(kind: AddrKind): boolean {
    return kind === "wss" || kind === "webtransport";
}

function describeError(error: unknown): string {
    const parts: string[] = [];
    const seen = new Set<unknown>();
    const walk = (e: unknown, depth: number) => {
        if (e === undefined || e === null || seen.has(e) || depth > 4) return;
        seen.add(e);
        if (e instanceof Error) {
            const code = "code" in e && typeof e.code === "string" ? ` [${e.code}]` : "";
            parts.push(`${e.name}${code}: ${e.message}`);
            if ("errors" in e && Array.isArray(e.errors)) for (const inner of e.errors) walk(inner, depth + 1);
            if ("cause" in e) walk(e.cause, depth + 1);
        } else parts.push(String(e));
    };
    walk(error, 0);
    return parts.join(" <- ");
}

// A 1200-byte QUIC long-header packet carrying a version of the reserved 0x?a?a?a?a form (RFC 8999 section 5.1),
// which no server supports, so a live QUIC endpoint answers with Version Negotiation.
function buildQuicVersionNegotiationTrigger(): Buffer {
    const packet = Buffer.alloc(1200, 0);
    packet[0] = 0xc0; // long header, fixed bit set, Initial-shaped type bits
    packet.writeUInt32BE(0x1a2a3a4a, 1);
    packet[5] = 8; // destination connection id length
    randomFillSync(packet, 6, 8);
    packet[14] = 8; // source connection id length
    randomFillSync(packet, 15, 8);
    randomFillSync(packet, 23, 1200 - 23); // the rest must look like a payload, not zeros, to some servers
    return packet;
}

function isQuicVersionNegotiation(datagram: Buffer): boolean {
    return datagram.length >= 5 && (datagram[0] & 0x80) === 0x80 && datagram.readUInt32BE(1) === 0;
}

export async function probeQuicEndpoint({
    host,
    port,
    family,
    timeoutMs
}: {
    host: string;
    port: number;
    family: 4 | 6;
    timeoutMs: number;
}): Promise<Omit<UdpProbeResult, "multiaddr">> {
    let resolvedIp: string;
    try {
        resolvedIp = (await lookup(host, { family })).address;
    } catch (error) {
        return { host, port, answered: false, versionNegotiation: false, error: `dns: ${describeError(error)}` };
    }
    return new Promise((resolve) => {
        const socket = createSocket(family === 6 ? "udp6" : "udp4");
        const start = Date.now();
        let done = false;
        const finish = (result: Omit<UdpProbeResult, "multiaddr">) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            socket.close();
            resolve(result);
        };
        const timer = setTimeout(() => finish({ host, port, resolvedIp, answered: false, versionNegotiation: false }), timeoutMs);
        socket.once("error", (error) =>
            finish({ host, port, resolvedIp, answered: false, versionNegotiation: false, error: describeError(error) })
        );
        socket.once("message", (datagram) =>
            finish({
                host,
                port,
                resolvedIp,
                answered: true,
                versionNegotiation: isQuicVersionNegotiation(datagram),
                ms: Date.now() - start
            })
        );
        socket.send(buildQuicVersionNegotiationTrigger(), port, resolvedIp, (error) => {
            if (error) finish({ host, port, resolvedIp, answered: false, versionNegotiation: false, error: describeError(error) });
        });
    });
}

type BrowserLikeLibp2p = Libp2p<{ identify: Identify; ping: Ping }>;

// Helia's Node defaults carry TCP, kad-dht, AutoTLS, UPnP and the bootstrap list; none of that belongs in a
// browser-shaped probe (AutoTLS alone would register this throwaway node with libp2p.direct). Keep the transports,
// encrypters and muxers so the handshake matches what pkc-js runs, and let the gater refuse every address that is
// not WebSocket Secure, exactly how a browser is limited.
export async function createWssOnlyLibp2p(): Promise<BrowserLikeLibp2p> {
    const defaults = libp2pDefaults();
    return createLibp2p({
        addresses: { listen: [] },
        transports: defaults.transports,
        connectionEncrypters: defaults.connectionEncrypters,
        streamMuxers: defaults.streamMuxers,
        peerDiscovery: [],
        // @libp2p/ping is not a declared pkc-js dependency, so take helia's ping factory; its parameter type names every
        // default service, which this node does not run, hence the widening cast
        // runOnConnectionOpen off: dialWss runs identify itself and the automatic run would race it for the single
        // outbound /ipfs/id/1.0.0 stream (TooManyOutboundProtocolStreamsError)
        services: {
            identify: identify({ runOnConnectionOpen: false }),
            ping: defaults.services.ping as unknown as (components: unknown) => Ping
        },
        connectionGater: {
            denyDialMultiaddr: (ma: Multiaddr) => classifyMultiaddr(ma).kind !== "wss"
        }
    });
}

export async function dialWss({
    node,
    addr,
    timeoutMs
}: {
    node: BrowserLikeLibp2p;
    addr: Multiaddr;
    timeoutMs: number;
}): Promise<WssDialResult> {
    const start = Date.now();
    const signal = AbortSignal.timeout(timeoutMs);
    try {
        const connection = await node.dial(addr, { signal });
        const connectMs = Date.now() - start;
        const identity = await node.services.identify.identify(connection, { signal });
        const pingMs = await node.services.ping.ping(connection.remotePeer, { signal });
        await node.hangUp(connection.remotePeer);
        return {
            multiaddr: addr.toString(),
            ok: true,
            connectMs,
            pingMs,
            agentVersion: identity.agentVersion,
            protocols: identity.protocols.length
        };
    } catch (error) {
        const peerId = peerIdOf(addr);
        if (peerId) await node.hangUp(peerIdFromString(peerId)).catch((): undefined => undefined);
        return { multiaddr: addr.toString(), ok: false, error: describeError(error) };
    }
}

// Plain HTTP against the delegated routing v1 API (https://specs.ipfs.tech/routing/http-routing-v1/), the same
// endpoint pkc-js queries through @helia/delegated-routing-v1-http-api-client; a direct fetch keeps the probe free of
// libp2p component wiring and shows exactly what each router returned.
interface RoutingV1PeerRecord {
    Schema: "peer";
    ID: string;
    Addrs?: string[];
}

function isRoutingV1PeerRecord(value: unknown): value is RoutingV1PeerRecord {
    if (typeof value !== "object" || value === null) return false;
    const record = value as Record<string, unknown>;
    return (
        record["Schema"] === "peer" && typeof record["ID"] === "string" && (record["Addrs"] === undefined || Array.isArray(record["Addrs"]))
    );
}

export async function fetchProvidersFromRouter({
    router,
    cid,
    timeoutMs
}: {
    router: string;
    cid: string;
    timeoutMs: number;
}): Promise<RoutingV1PeerRecord[]> {
    const url = `${router.replace(/\/$/, "")}/routing/v1/providers/${cid}`;
    const response = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (response.status === 404) return []; // the spec's "no providers" answer
    if (!response.ok) throw new Error(`${url} answered HTTP ${response.status}`);
    const body: unknown = await response.json();
    const providers = typeof body === "object" && body !== null ? (body as Record<string, unknown>)["Providers"] : undefined;
    if (!Array.isArray(providers)) throw new Error(`${url} returned no Providers array`);
    return providers.filter(isRoutingV1PeerRecord);
}

export async function findProvidersViaRouters({
    ipnsName,
    routers,
    timeoutMs
}: {
    ipnsName: string;
    routers: string[];
    timeoutMs: number;
}): Promise<{
    providerCid: string;
    providers: Map<string, { addrs: Set<string>; listedBy: string[] }>;
    routerErrors: Record<string, string>;
}> {
    const providerCid = pubsubTopicToDhtKeyCid(ipnsNameToIpnsOverPubsubTopic(ipnsName)).toString();
    const providers = new Map<string, { addrs: Set<string>; listedBy: string[] }>();
    const routerErrors: Record<string, string> = {};
    await Promise.all(
        routers.map(async (router) => {
            try {
                for (const record of await fetchProvidersFromRouter({ router, cid: providerCid, timeoutMs })) {
                    // one malformed record (bad id, bad address) must not hide the records after it
                    try {
                        // routers write the id as base58 (12D3...) or as a base36 libp2p-key CID (k51...); normalize to one spelling
                        const peerId = peerIdFromString(record.ID).toString();
                        const entry = providers.get(peerId) ?? { addrs: new Set<string>(), listedBy: [] };
                        for (const addr of record.Addrs ?? []) {
                            // and one unparseable address (a protocol newer than our multiaddr, a garbled string) must not drop
                            // the record's good /tls/ws and /webtransport addresses with it
                            try {
                                entry.addrs.add(peerIdOf(multiaddr(addr)) ? addr : `${addr}/p2p/${peerId}`);
                            } catch (error) {
                                routerErrors[`${router} (record ${record.ID} addr ${addr})`] = describeError(error);
                            }
                        }
                        if (!entry.listedBy.includes(router)) entry.listedBy.push(router);
                        providers.set(peerId, entry);
                    } catch (error) {
                        routerErrors[`${router} (record ${record.ID})`] = describeError(error);
                    }
                }
            } catch (error) {
                routerErrors[router] = describeError(error);
            }
        })
    );
    return { providerCid, providers, routerErrors };
}

function judge(
    addrs: ClassifiedAddr[],
    wss: WssDialResult[],
    webtransport: UdpProbeResult[]
): { verdict: ProviderVerdict; problems: string[] } {
    const problems: string[] = [];
    const wtAddrs = addrs.filter((a) => a.kind === "webtransport");
    const wtWithCerthash = wtAddrs.filter((a) => a.certhashes > 0);
    const answeredWt = new Set(webtransport.filter((r) => r.answered && r.versionNegotiation).map((r) => r.multiaddr));
    const verdict: ProviderVerdict = {
        wssDialable: wss.some((r) => r.ok),
        webtransportAnnounced: wtWithCerthash.length > 0,
        webtransportUdpAnswers: wtWithCerthash.some((a) => answeredWt.has(a.multiaddr)),
        webtransportOnUdp443: wtWithCerthash.some((a) => a.port === 443),
        hasIpv6: addrs.some((a) => a.hostFamily === "ip6" || a.hostFamily === "dns6"),
        relayOnly: addrs.length > 0 && addrs.every((a) => a.kind === "relay"),
        browserDialableToday: false,
        browserDialableWithWebTransport: false
    };
    verdict.browserDialableToday = verdict.wssDialable;
    verdict.browserDialableWithWebTransport = verdict.wssDialable || verdict.webtransportUdpAnswers;

    if (addrs.length === 0) problems.push("announces no addresses");
    if (verdict.relayOnly)
        problems.push(
            "announces only /p2p-circuit relay addresses: the node is behind NAT and no browser or libp2p-js client can reach it"
        );
    const wssAddrs = addrs.filter((a) => a.kind === "wss");
    if (wssAddrs.length === 0) problems.push("announces no WebSocket Secure (/tls/ws) address: pkc-js browsers cannot dial it today");
    else if (!verdict.wssDialable) for (const r of wss) problems.push(`WSS dial failed ${r.multiaddr}: ${r.error}`);
    if (wssAddrs.length > 0 && !wssAddrs.some((a) => a.port === 443))
        problems.push("WSS is announced only on a non-443 port; networks that allow outbound 443 only cannot reach it");
    if (addrs.some((a) => a.kind === "ws"))
        problems.push("announces a plain /ws address, which an https page cannot open (mixed content); only /tls/ws counts");
    if (wtAddrs.length === 0) problems.push("announces no WebTransport address");
    else {
        for (const a of wtAddrs)
            if (a.certhashes === 0) problems.push(`WebTransport address without certhash, browsers cannot dial it: ${a.multiaddr}`);
        // a certhash-less 443 address is already reported above; its fix is the certhash config, not another listener
        if (!wtAddrs.some((a) => a.port === 443)) {
            const ports = [...new Set(wtAddrs.map((a) => a.port).filter((p): p is number => p !== undefined))]
                .sort((x, y) => x - y)
                .join(", ");
            problems.push(`WebTransport only on UDP ${ports}, no UDP 443 listener: unreachable from networks that filter UDP ${ports}`);
        }
        for (const r of webtransport) {
            if (!r.answered)
                problems.push(
                    `UDP ${r.port} on ${r.resolvedIp ?? r.host} did not answer the QUIC probe from this network${r.error ? ` (${r.error})` : ""}`
                );
            else if (!r.versionNegotiation)
                problems.push(
                    `UDP ${r.port} on ${r.resolvedIp ?? r.host} answered, but not with QUIC Version Negotiation: something other than a QUIC listener is at that address`
                );
        }
    }
    if (!verdict.hasIpv6) problems.push("no IPv6 address: IPv4-only networks that filter UDP 4001 depend entirely on the 443 listeners");
    return { verdict, problems };
}

async function probeProvider({
    node,
    peerId,
    addrStrings,
    listedBy,
    dialTimeoutMs,
    udpTimeoutMs
}: {
    node: BrowserLikeLibp2p;
    peerId: string;
    addrStrings: Iterable<string>;
    listedBy: string[];
    dialTimeoutMs: number;
    udpTimeoutMs: number;
}): Promise<ProviderReport> {
    const multiaddrs = [...addrStrings].map((s) => multiaddr(s));
    const addrs = multiaddrs.map(classifyMultiaddr);

    const wss: WssDialResult[] = [];
    for (const ma of multiaddrs) {
        if (classifyMultiaddr(ma).kind !== "wss") continue;
        wss.push(await dialWss({ node, addr: ma, timeoutMs: dialTimeoutMs }));
    }

    const webtransport = await Promise.all(
        addrs
            .filter((a) => a.kind === "webtransport" && a.host !== undefined && a.port !== undefined)
            .map(async (a): Promise<UdpProbeResult> => {
                const family = a.hostFamily === "ip6" || a.hostFamily === "dns6" ? 6 : 4;
                const result = await probeQuicEndpoint({ host: a.host!, port: a.port!, family, timeoutMs: udpTimeoutMs });
                return { multiaddr: a.multiaddr, ...result };
            })
    );

    const { verdict, problems } = judge(addrs, wss, webtransport);
    return { peerId, listedBy, addrs, wss, webtransport, verdict, problems };
}

export async function probeBrowserReachability(options: ProbeOptions): Promise<ProbeReport> {
    const dialTimeoutMs = options.dialTimeoutMs ?? 15_000;
    const udpTimeoutMs = options.udpTimeoutMs ?? 3_000;
    const node = await createWssOnlyLibp2p();
    const targets: TargetReport[] = [];
    try {
        if (options.peerMultiaddrs && options.peerMultiaddrs.length > 0) {
            const byPeer = new Map<string, Set<string>>();
            for (const s of options.peerMultiaddrs) {
                const peerId = peerIdOf(multiaddr(s));
                if (!peerId) throw new Error(`peer multiaddr needs a /p2p/<peer id> component: ${s}`);
                const set = byPeer.get(peerId) ?? new Set<string>();
                set.add(s);
                byPeer.set(peerId, set);
            }
            const providers: ProviderReport[] = [];
            for (const [peerId, addrStrings] of byPeer) {
                const report = await probeProvider({ node, peerId, addrStrings, listedBy: ["given"], dialTimeoutMs, udpTimeoutMs });
                providers.push(report);
                options.onProvider?.("peers", report);
            }
            targets.push(summarizeTarget("peers", undefined, providers, {}));
        }
        for (const ipnsName of options.ipnsNames ?? []) {
            const found = await findProvidersViaRouters({ ipnsName, routers: options.routers, timeoutMs: dialTimeoutMs });
            const providers: ProviderReport[] = [];
            for (const [peerId, entry] of found.providers) {
                const report = await probeProvider({
                    node,
                    peerId,
                    addrStrings: entry.addrs,
                    listedBy: entry.listedBy,
                    dialTimeoutMs,
                    udpTimeoutMs
                });
                providers.push(report);
                options.onProvider?.(ipnsName, report);
            }
            targets.push(summarizeTarget(ipnsName, found.providerCid, providers, found.routerErrors));
        }
    } finally {
        await node.stop();
    }
    return { at: new Date().toISOString(), routers: options.routers, dialTimeoutMs, udpTimeoutMs, targets };
}

function summarizeTarget(
    target: string,
    providerCid: string | undefined,
    providers: ProviderReport[],
    routerErrors: Record<string, string>
): TargetReport {
    return {
        target,
        providerCid,
        providers,
        routerErrors,
        providersDialableToday: providers.filter((p) => p.verdict.browserDialableToday).length,
        providersDialableWithWebTransport: providers.filter((p) => p.verdict.browserDialableWithWebTransport).length
    };
}

export function formatProviderReport(provider: ProviderReport): string {
    const lines: string[] = [];
    const v = provider.verdict;
    const flag = (ok: boolean) => (ok ? "yes" : "NO ");
    const source =
        provider.listedBy.length === 1 && provider.listedBy[0] === "given"
            ? "addresses given"
            : `listed by ${provider.listedBy.length} router(s)`;
    lines.push(`${provider.peerId}  ${source}`);
    lines.push(
        `  browser today (WSS): ${flag(v.browserDialableToday)}   with WebTransport: ${flag(v.browserDialableWithWebTransport)}   IPv6: ${flag(v.hasIpv6)}   UDP 443: ${flag(v.webtransportOnUdp443)}`
    );
    for (const r of provider.wss) {
        lines.push(
            r.ok
                ? `  wss ok    ${r.multiaddr}  connect ${r.connectMs} ms, ping ${r.pingMs} ms, ${r.agentVersion ?? "?"}`
                : `  wss FAIL  ${r.multiaddr}  ${r.error}`
        );
    }
    for (const r of provider.webtransport) {
        lines.push(
            r.answered && r.versionNegotiation
                ? `  udp ok    ${r.multiaddr}  version negotiation in ${r.ms} ms`
                : r.answered
                  ? `  udp ODD   ${r.multiaddr}  reply in ${r.ms} ms is not QUIC version negotiation`
                  : `  udp DEAD  ${r.multiaddr}  ${r.error ?? "no reply"}`
        );
    }
    for (const a of provider.addrs)
        if (!isBrowserDialableKind(a.kind)) lines.push(`  ${a.kind.padEnd(9)} ${a.multiaddr}  (not browser-dialable)`);
    for (const p of provider.problems) lines.push(`  ! ${p}`);
    return lines.join("\n");
}

export function formatProbeReport(report: ProbeReport): string {
    const out: string[] = [`Browser reachability probe at ${report.at}`, `routers: ${report.routers.join(", ")}`];
    for (const target of report.targets) {
        out.push("");
        out.push(
            `== ${target.target}${target.providerCid ? ` (provider cid ${target.providerCid})` : ""}: ${target.providers.length} provider(s), ` +
                `${target.providersDialableToday} dialable from pkc-js browsers today, ${target.providersDialableWithWebTransport} with WebTransport`
        );
        for (const [router, error] of Object.entries(target.routerErrors)) out.push(`  router error ${router}: ${error}`);
        for (const provider of target.providers) out.push(formatProviderReport(provider));
    }
    return out.join("\n");
}

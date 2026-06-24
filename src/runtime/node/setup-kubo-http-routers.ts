import { PKC } from "../../pkc/pkc.js";
import retry from "retry";
import Logger from "../../logger.js";
import { PKCError } from "../../pkc-error.js";
import * as remeda from "remeda";

// fetch() resolves even on HTTP 4xx/5xx — it only rejects on a network failure — so a kubo RPC
// error response would otherwise be treated as success and skip our retries. POST to the kubo
// RPC and throw on a non-2xx status (reading the body for kubo's own error message). Each caller
// wraps the throw into its specific PKCError. Shared by every kubo RPC POST in this file.
async function _postToKuboRpc(kuboClient: PKC["clients"]["kuboRpcClients"][string], url: string): Promise<void> {
    const res = await fetch(url, { method: "POST", headers: kuboClient._clientOptions.headers });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw Error(`kubo RPC responded with non-2xx status ${res.status} ${res.statusText}${body ? `: ${body}` : ""}`);
    }
}

function _mergeRouterConfigs(existingConfig: any, newConfig: any) {
    if (!existingConfig?.Routers) return newConfig;

    const existingRoutersByEndpoint = new Map();
    Object.entries(existingConfig.Routers).forEach(([routerName, router]: [string, any]) => {
        if (router.Parameters?.Endpoint) {
            existingRoutersByEndpoint.set(router.Parameters.Endpoint, { routerName, router });
        }
    });

    const mergedRouters = { ...newConfig.Routers };

    Object.entries(newConfig.Routers).forEach(([newRouterName, newRouter]: [string, any]) => {
        if (newRouter.Parameters?.Endpoint) {
            const existing = existingRoutersByEndpoint.get(newRouter.Parameters.Endpoint);
            if (existing) {
                mergedRouters[newRouterName] = {
                    ...existing.router,
                    ...newRouter,
                    Parameters: { ...existing.router.Parameters, ...newRouter.Parameters }
                };
            }
        }
    });

    return {
        ...newConfig,
        Routers: mergedRouters
    };
}

async function _setProvideDhtSweepEnabledOnKuboNode(kuboClient: PKC["clients"]["kuboRpcClients"][string], sweepEnabled: boolean) {
    const log = Logger("pkc-js:pkc:_init:retrySettingHttpRoutersOnIpfsNodes:setProvideDhtSweepEnabledOnIpfsNode");
    const configKey = "Provide.DHT.SweepEnabled";
    const url = `${kuboClient._clientOptions.url}/config?arg=${configKey}&arg=${JSON.stringify(sweepEnabled)}&json=true`;
    try {
        await _postToKuboRpc(kuboClient, url);
    } catch (e) {
        const error = new PKCError("ERR_FAILED_TO_SET_CONFIG_ON_KUBO_NODE", {
            fullUrl: url,
            actualError: e,
            kuboEndpoint: kuboClient._clientOptions.url,
            configKey,
            configValueToBeSet: sweepEnabled
        });
        log.error(e);
        throw error;
    }
    log.trace("Succeeded in setting config key", configKey, "on node", kuboClient._clientOptions.url, "to be", sweepEnabled);
}

async function _setHttpRouterOptionsOnKuboNode(kuboClient: PKC["clients"]["kuboRpcClients"][string], routingValue: any) {
    const log = Logger("pkc-js:pkc:_init:retrySettingHttpRoutersOnIpfsNodes:setHttpRouterOptionsOnIpfsNode");
    const routingKey = "Routing";

    let routingConfigBeforeChanging: typeof routingValue | undefined;
    try {
        routingConfigBeforeChanging = await kuboClient._client.config.get(routingKey);
    } catch (e) {
        const error = new PKCError("ERR_FAILED_TO_GET_CONFIG_ON_KUBO_NODE", {
            actualError: e,
            kuboEndpoint: kuboClient._clientOptions.url,
            configKey: routingKey
        });
        log.error(e);
        throw error;
    }

    const mergedRoutingValue = _mergeRouterConfigs(routingConfigBeforeChanging, routingValue);

    const url = `${kuboClient._clientOptions.url}/config?arg=${routingKey}&arg=${JSON.stringify(mergedRoutingValue)}&json=true`;
    try {
        await _postToKuboRpc(kuboClient, url);
    } catch (e) {
        const error = new PKCError("ERR_FAILED_TO_SET_CONFIG_ON_KUBO_NODE", {
            fullUrl: url,
            actualError: e,
            kuboEndpoint: kuboClient._clientOptions.url,
            configKey: routingKey,
            configValueToBeSet: mergedRoutingValue
        });
        log.error(e);
        throw error;
    }
    log.trace("Succeeded in setting config key", routingKey, "on node", kuboClient._clientOptions.url, "to be", mergedRoutingValue);

    await _setProvideDhtSweepEnabledOnKuboNode(kuboClient, false);

    const endpointsBefore: string[] = Object.values(routingConfigBeforeChanging?.["Routers"] || {}).map(
        //@ts-expect-error
        (router) => router["Parameters"]["Endpoint"]
    );
    //@ts-expect-error
    const endpointsAfter = Object.values(mergedRoutingValue.Routers).map((router) => router["Parameters"]["Endpoint"]);
    if (!remeda.isDeepEqual(endpointsBefore.sort(), endpointsAfter.sort())) {
        log(
            "Config on kubo node has been changed. PKC-js will send shutdown command to node",
            kuboClient._clientOptions.url,
            "Clients of pkc-js should restart ipfs node"
        );
        const shutdownUrl = `${kuboClient._clientOptions.url}/shutdown`;
        try {
            await _postToKuboRpc(kuboClient, shutdownUrl);
        } catch (e) {
            const error = new PKCError("ERR_FAILED_TO_SHUTDOWN_KUBO_NODE", {
                actualError: e,
                kuboEndpoint: kuboClient._clientOptions.url,
                shutdownUrl
            });
            log.error(e);
            throw error;
        }
    }
}

// ============================================================================================
// TODO(kubo#11369): DELETE THIS ENTIRE WORKAROUND once ipfs/kubo#11369 is fixed.
// Everything from here to the end of this file that concerns AppendAnnounce — the IP/host
// helpers (_isPrivateOrLoopbackIpv4/Ipv6, _hasPublicHost), selectBrowserDialableAddrsToAppendAnnounce,
// _setKuboConfigJson, _syncAppendAnnounceOnKuboNode, syncKuboAppendAnnounce — plus the
// browser stub (src/runtime/browser/setup-kubo-http-routers.ts), the scheduler/timer wiring in
// src/pkc/pkc.ts (_appendAnnounceTimer, _runAppendAnnounceSyncAndReschedule, the destroy()
// cleanup), and test/node/kubo-append-announce.unit.test.ts exist ONLY to compensate for that
// kubo bug. When kubo#11369 ships a fix, remove all of it.
// --------------------------------------------------------------------------------------------
// Why it exists: a publicly-reachable kubo node advertises its browser-dialable transports
// (AutoTLS Secure-WebSocket `/tls/ws` and `webrtc-direct/certhash`) in `ipfs id`, but kubo does
// NOT announce those two address types to delegated HTTP routers once AutoNAT v2 has confirmed
// reachability — it only announces tcp/quic-v1/webtransport. Browser libp2p/helia clients
// therefore never learn a dialable address. We force-announce the node's own browser-dialable
// addresses via `Addresses.AppendAnnounce`, which go-libp2p applies AFTER the reachability
// filter, so they survive into provider records.
// ============================================================================================

function _isPrivateOrLoopbackIpv4(ip: string): boolean {
    if (/^(10|127|0)\./.test(ip) || /^169\.254\./.test(ip) || /^192\.168\./.test(ip)) return true;
    const m172 = ip.match(/^172\.(\d{1,3})\./); // 172.16.0.0 - 172.31.255.255
    if (m172 && Number(m172[1]) >= 16 && Number(m172[1]) <= 31) return true;
    const m100 = ip.match(/^100\.(\d{1,3})\./); // 100.64.0.0/10 (CGNAT)
    if (m100 && Number(m100[1]) >= 64 && Number(m100[1]) <= 127) return true;
    return false;
}

function _isPrivateOrLoopbackIpv6(ip: string): boolean {
    const l = ip.toLowerCase();
    return l === "::1" || l === "::" || l.startsWith("fe80") || l.startsWith("fc") || l.startsWith("fd");
}

// Is the address rooted at a public host (public IP, or a DNS name like the AutoTLS
// `*.libp2p.direct` domain)? Private/loopback/link-local/CGNAT addresses are excluded so we
// never force-announce an undialable LAN address.
function _hasPublicHost(addr: string): boolean {
    const parts = addr.split("/"); // ["", "ip4", "1.2.3.4", ...]
    const proto = parts[1];
    const host = parts[2] ?? "";
    if (proto === "ip4") return !_isPrivateOrLoopbackIpv4(host);
    if (proto === "ip6") return !_isPrivateOrLoopbackIpv6(host);
    if (proto === "dns" || proto === "dns4" || proto === "dns6" || proto === "dnsaddr") return true;
    return false;
}

// Pure: from the multiaddrs reported by `ipfs id`, pick the node's own public browser-dialable
// addresses that kubo withholds from provider records — webrtc-direct (with certhash) and the
// AutoTLS Secure-WebSocket (`/tls/ws`, on a `libp2p.direct` domain). `/p2p/...` suffixes are
// stripped (AppendAnnounce entries are addresses; kubo appends the peer id).
export function selectBrowserDialableAddrsToAppendAnnounce(idAddrs: string[]): {
    webrtcDirect: string[];
    wss: string[];
    all: string[];
} {
    const webrtcDirect = new Set<string>();
    const wss = new Set<string>();
    for (const raw of idAddrs) {
        const addr = String(raw).replace(/\/p2p\/[^/]+$/, "");
        if (!_hasPublicHost(addr)) continue;
        if (addr.includes("/webrtc-direct/") && addr.includes("/certhash/")) webrtcDirect.add(addr);
        // Only real browser-dialable Secure-WebSocket forms: the plain `.../tls/ws` and the
        // AutoTLS IP+SNI `.../tls/sni/<*.libp2p.direct>/ws`. Matching any `libp2p.direct` substring
        // would be too broad — a non-`/ws` address on that domain could falsely satisfy `wssPresent`
        // and stop the retry loop before the WSS address actually lands.
        else if (addr.endsWith("/ws") && (addr.includes("/tls/ws") || (addr.includes("/tls/sni/") && addr.includes("libp2p.direct"))))
            wss.add(addr);
    }
    return { webrtcDirect: [...webrtcDirect], wss: [...wss], all: [...webrtcDirect, ...wss] };
}

async function _setKuboConfigJson(kuboClient: PKC["clients"]["kuboRpcClients"][string], configKey: string, value: unknown) {
    const log = Logger("pkc-js:pkc:_init:syncKuboAppendAnnounce:setConfig");
    const url = `${kuboClient._clientOptions.url}/config?arg=${configKey}&arg=${JSON.stringify(value)}&json=true`;
    try {
        await _postToKuboRpc(kuboClient, url);
    } catch (e) {
        const error = new PKCError("ERR_FAILED_TO_SET_CONFIG_ON_KUBO_NODE", {
            fullUrl: url,
            actualError: e,
            kuboEndpoint: kuboClient._clientOptions.url,
            configKey,
            configValueToBeSet: value
        });
        log.error(e);
        throw error;
    }
    log.trace("Set config key", configKey, "on node", kuboClient._clientOptions.url);
}

// Sync one kubo node's AppendAnnounce. Returns whether it changed, whether the AutoTLS WSS is
// now present, and whether AutoTLS is enabled (so the caller can decide when to stop re-checking).
async function _syncAppendAnnounceOnKuboNode(
    pkc: PKC,
    kuboClient: PKC["clients"]["kuboRpcClients"][string]
): Promise<{ changed: boolean; wssPresent: boolean; autoTlsEnabled: boolean }> {
    const log = Logger("pkc-js:pkc:_init:syncKuboAppendAnnounce");

    const idResult = await kuboClient._client.id();
    const idAddrs = (idResult.addresses ?? []).map((a) => String(a));
    const desired = selectBrowserDialableAddrsToAppendAnnounce(idAddrs);

    let autoTlsEnabled = false;
    try {
        // config.get returns the JSON value (a boolean here) typed loosely as string | object
        autoTlsEnabled = String(await kuboClient._client.config.get("AutoTLS.Enabled")) === "true";
    } catch {
        // older kubo / key absent — treat as disabled
    }

    const current = ((await kuboClient._client.config.get("Addresses.AppendAnnounce")) ?? []) as unknown as string[];
    const currentArr = Array.isArray(current) ? current.map((a) => String(a)) : [];
    const currentSet = new Set(currentArr);

    const merged = [...currentArr];
    let changed = false;
    for (const addr of desired.all)
        if (!currentSet.has(addr)) {
            merged.push(addr);
            currentSet.add(addr);
            changed = true;
        }

    // Don't mutate the node (config write + shutdown) if pkc was destroyed while we were reading
    // its `ipfs id` / config above — destroy() must stop the sync from touching kubo any further.
    if (changed && !pkc.destroyed) {
        await _setKuboConfigJson(kuboClient, "Addresses.AppendAnnounce", merged);
        // AppendAnnounce is only read at kubo startup (verified: a running daemon ignores a live
        // config.set until restart). Shut down so the operator's supervisor restarts the node and
        // the addresses go live — same mechanism setupKuboHttpRouters uses for Routing changes.
        log(
            "Added browser-dialable addresses to AppendAnnounce on kubo node",
            kuboClient._clientOptions.url,
            desired.all,
            "- sending shutdown so the node restarts and announces them"
        );
        const shutdownUrl = `${kuboClient._clientOptions.url}/shutdown`;
        try {
            await _postToKuboRpc(kuboClient, shutdownUrl);
        } catch (e) {
            const error = new PKCError("ERR_FAILED_TO_SHUTDOWN_KUBO_NODE", {
                actualError: e,
                kuboEndpoint: kuboClient._clientOptions.url,
                shutdownUrl
            });
            log.error(e);
            throw error;
        }
    }

    const wssPresent = desired.wss.length > 0 && desired.wss.every((a) => currentSet.has(a));
    return { changed, wssPresent, autoTlsEnabled };
}

// Sync AppendAnnounce on every connected kubo node. Returns allDone = true once every node has
// its AutoTLS WSS announced (or has AutoTLS disabled, in which case the one-shot webrtc-direct
// sync is all there is to do) — the caller stops the 10-minute re-check loop when allDone.
export async function syncKuboAppendAnnounce(pkc: PKC): Promise<{ allDone: boolean }> {
    const log = Logger("pkc-js:pkc:_init:syncKuboAppendAnnounce");
    if (pkc.destroyed) return { allDone: true };
    let allDone = true;
    for (const kuboClient of Object.values(pkc.clients.kuboRpcClients)) {
        if (pkc.destroyed) return { allDone: true }; // destroyed mid-sync — stop touching nodes
        try {
            const { wssPresent, autoTlsEnabled } = await _syncAppendAnnounceOnKuboNode(pkc, kuboClient);
            // Keep re-checking while AutoTLS is enabled but its (slow to provision) /tls/ws hasn't
            // landed in AppendAnnounce yet. When AutoTLS is off there is no WSS to wait for.
            if (autoTlsEnabled && !wssPresent) allDone = false;
        } catch (e) {
            log.error("Failed to sync AppendAnnounce on kubo node", kuboClient._clientOptions.url, e);
            allDone = false; // retry on the next tick
        }
    }
    return { allDone };
}

export async function setupKuboHttpRouters(pkc: PKC): Promise<void> {
    if (pkc.destroyed) return;
    if (!Array.isArray(pkc.kuboRpcClientsOptions) || pkc.kuboRpcClientsOptions.length <= 0)
        throw Error("need ipfs http client to be defined");
    if (!Array.isArray(pkc.httpRoutersOptions) || pkc.httpRoutersOptions.length <= 0) throw Error("Need http router options to defined");

    const httpRouterUrls = [...pkc.httpRoutersOptions].sort(); // make sure it's always the same order

    // Set up http routers directly on the kubo nodes
    const kuboClients = pkc.clients.kuboRpcClients;
    const httpRoutersConfig: any = {
        HttpRoutersParallel: { Type: "parallel", Parameters: { Routers: [] } },
        HttpRouterNotSupported: { Type: "http", Parameters: { Endpoint: "http://kubohttprouternotsupported" } }
    };
    for (const [i, httpRouterUrl] of httpRouterUrls.entries()) {
        const RouterName = `HttpRouter${i + 1}`;
        httpRoutersConfig[RouterName] = {
            Type: "http",
            Parameters: {
                Endpoint: httpRouterUrl
            }
        };
        httpRoutersConfig.HttpRoutersParallel.Parameters.Routers[i] = {
            RouterName: RouterName,
            IgnoreErrors: true,
            Timeout: "10s"
        };
    }

    const httpRoutersMethodsConfig = {
        "find-providers": { RouterName: "HttpRoutersParallel" },
        provide: { RouterName: "HttpRoutersParallel" },
        // not supported by pkc trackers
        "find-peers": { RouterName: "HttpRouterNotSupported" },
        "get-ipns": { RouterName: "HttpRouterNotSupported" },
        "put-ipns": { RouterName: "HttpRouterNotSupported" }
    };

    const routingValue = {
        Type: "custom",
        Methods: httpRoutersMethodsConfig,
        Routers: httpRoutersConfig
    };

    const settingOptionRetryOption = retry.operation({ forever: true, factor: 2 });

    const setHttpRouterOnAllNodes = new Promise((resolve) => {
        settingOptionRetryOption.attempt(async (curAttempt) => {
            if (pkc.destroyed) {
                resolve(1);
                return;
            }
            for (const kuboClient of Object.values(kuboClients)) {
                try {
                    await _setHttpRouterOptionsOnKuboNode(kuboClient, routingValue);
                } catch (e) {
                    settingOptionRetryOption.retry(<Error>e);
                    return;
                }
            }
            resolve(1);
        });
    });

    await setHttpRouterOnAllNodes;
    settingOptionRetryOption.stop();
}

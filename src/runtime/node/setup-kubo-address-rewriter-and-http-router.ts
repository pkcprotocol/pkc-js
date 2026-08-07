import { PKC } from "../../pkc/pkc.js";
import retry, { RetryOperation } from "retry";
import { AddressesRewriterProxyServer } from "./addresses-rewriter-proxy-server.js";
import Logger from "../../logger.js";
import { PKCError } from "../../pkc-error.js";
import { isDeepEqual } from "remeda";
import tcpPortUsed from "tcp-port-used";

type KuboRouterEntry = {
    Type: string;
    Parameters: {
        Endpoint?: string;
        Routers?: Array<{ RouterName: string; IgnoreErrors: boolean; Timeout: string }>;
    };
};
type KuboRoutersMap = Record<string, KuboRouterEntry>;
type KuboRoutingConfig = {
    Type?: string;
    Methods?: Record<string, { RouterName: string }>;
    Routers: KuboRoutersMap;
};

function _mergeRouterConfigs(existingConfig: KuboRoutingConfig | undefined, newConfig: KuboRoutingConfig): KuboRoutingConfig {
    if (!existingConfig?.Routers) return newConfig;

    const existingRoutersByEndpoint = new Map<string, { routerName: string; router: KuboRouterEntry }>();
    Object.entries(existingConfig.Routers).forEach(([routerName, router]) => {
        if (router.Parameters?.Endpoint) {
            existingRoutersByEndpoint.set(router.Parameters.Endpoint, { routerName, router });
        }
    });

    const mergedRouters: KuboRoutersMap = { ...newConfig.Routers };

    Object.entries(newConfig.Routers).forEach(([newRouterName, newRouter]) => {
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
        await fetch(url, { method: "POST", headers: kuboClient._clientOptions.headers });
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

async function _setHttpRouterOptionsOnKuboNode(kuboClient: PKC["clients"]["kuboRpcClients"][string], routingValue: KuboRoutingConfig) {
    const log = Logger("pkc-js:pkc:_init:retrySettingHttpRoutersOnIpfsNodes:setHttpRouterOptionsOnIpfsNode");
    const routingKey = "Routing";

    let routingConfigBeforeChanging: KuboRoutingConfig | undefined;
    try {
        routingConfigBeforeChanging = <KuboRoutingConfig>await kuboClient._client.config.get(routingKey);
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
        await fetch(url, { method: "POST", headers: kuboClient._clientOptions.headers });
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

    const endpointsBefore: string[] = Object.values(routingConfigBeforeChanging?.Routers || {})
        .map((router) => router.Parameters?.Endpoint)
        .filter((endpoint): endpoint is string => endpoint !== undefined);
    const endpointsAfter: string[] = Object.values(mergedRoutingValue.Routers)
        .map((router) => router.Parameters?.Endpoint)
        .filter((endpoint): endpoint is string => endpoint !== undefined);
    if (!isDeepEqual(endpointsBefore.sort(), endpointsAfter.sort())) {
        log(
            "Config on kubo node has been changed. PKC-js will send shutdown command to node",
            kuboClient._clientOptions.url,
            "Clients of pkc-js should restart ipfs node"
        );
        const shutdownUrl = `${kuboClient._clientOptions.url}/shutdown`;
        try {
            await fetch(shutdownUrl, { method: "POST", headers: kuboClient._clientOptions.headers });
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

async function _getStartedProxyUrl(pkc: PKC, httpRouterUrl: string) {
    if (pkc.destroyed) return undefined;
    const mappingKeyName = `httprouter_proxy_${httpRouterUrl}`;
    try {
        const urlOfProxyOfHttpRouter = <string | undefined>await pkc._storage.getItem(mappingKeyName);
        if (pkc.destroyed) return undefined;
        if (urlOfProxyOfHttpRouter) {
            const proxyHttpUrl = new URL(urlOfProxyOfHttpRouter);
            if (await tcpPortUsed.check(Number(proxyHttpUrl.port), "127.0.0.1")) return urlOfProxyOfHttpRouter;
            if (pkc.destroyed) return undefined;
            await pkc._storage.removeItem(mappingKeyName);
        }
        return undefined;
    } catch (error) {
        if (pkc.destroyed && error instanceof Error && error.message.includes("database connection is not open")) {
            return undefined;
        }
        throw error;
    }
}

export async function setupKuboAddressesRewriterAndHttpRouters(pkc: PKC): Promise<{ destroy: () => Promise<void> }> {
    if (pkc.destroyed) {
        return {
            destroy: async () => {}
        };
    }
    if (!Array.isArray(pkc.kuboRpcClientsOptions) || pkc.kuboRpcClientsOptions.length <= 0)
        throw Error("need ipfs http client to be defined");
    if (!Array.isArray(pkc.httpRoutersOptions) || pkc.httpRoutersOptions.length <= 0) throw Error("Need http router options to defined");

    const log = Logger("pkc-js:node:setupKuboAddressesRewriterAndHttpRouters");
    // Set up http proxies first to rewrite addresses

    const httpRouterProxyUrls: string[] = [];
    const proxyServers: AddressesRewriterProxyServer[] = [];
    // Port 19575 looks like IPRTR (IPFS ROUTER). The loop below walks upward from here to the first
    // free port, so a busy 19575 is not fatal.
    //
    // PKC_ADDRESSES_REWRITER_START_PORT moves that base. It exists for tests: the port is process-wide
    // and shared by every PKC instance, so two test files that both assume 19575 — one starting a
    // proxy on it, one asserting it is free — collide whenever vitest's --parallel scheduling puts
    // them in flight together. Each file can now claim its own base instead. Left unset in
    // production on purpose: the chosen port is written into Kubo's Routing config, and a changed
    // endpoint set bounces the daemon, so the base has to stay stable across restarts.
    const parsedStartPortOverride = Number(process.env.PKC_ADDRESSES_REWRITER_START_PORT);
    let addressesRewriterStartPort =
        Number.isInteger(parsedStartPortOverride) && parsedStartPortOverride > 0 && parsedStartPortOverride <= 65535
            ? parsedStartPortOverride
            : 19575;
    for (const httpRouter of pkc.httpRoutersOptions) {
        if (pkc.destroyed) break;
        const startedProxyUrl = await _getStartedProxyUrl(pkc, httpRouter);
        if (startedProxyUrl) {
            // Intentionally not tracked in proxyServers: this proxy was started by a previous PKC
            // instance in the same process and persisted via storage. We have no server handle to it
            // and must not destroy() it on teardown, since another instance may still rely on it. It
            // is bounded (one proxy per httpRouter, reusing the same stored URL) and lives until the
            // process exits, so this is reuse by design, not a leak.
            httpRouterProxyUrls.push(startedProxyUrl);
            continue;
        }
        // launch the proxy server

        let port = addressesRewriterStartPort;
        const hostname = "127.0.0.1";
        while (await tcpPortUsed.check(port, hostname))
            // keep increasing port till we find an empty port
            port++;

        const addressesRewriterProxyServer = new AddressesRewriterProxyServer({
            kuboClients: Object.values(pkc.clients.kuboRpcClients).map((kubo) => kubo._client),
            port,
            hostname,
            proxyTargetUrl: httpRouter,
            pkc
        });
        await addressesRewriterProxyServer.listen();
        if (pkc.destroyed) {
            await addressesRewriterProxyServer.destroy();
            break;
        }
        proxyServers.push(addressesRewriterProxyServer);

        // save the proxy urls to use them later

        const httpRouterProxyUrl = `http://${hostname}:${port}`;
        httpRouterProxyUrls.push(httpRouterProxyUrl);
    }
    httpRouterProxyUrls.sort(); // make sure it's always the same order

    // Set up http routers to use proxies
    const kuboClients = pkc.clients.kuboRpcClients;
    const parallelRouters: NonNullable<KuboRouterEntry["Parameters"]["Routers"]> = [];
    const httpRoutersConfig: KuboRoutersMap = {
        HttpRoutersParallel: { Type: "parallel", Parameters: { Routers: parallelRouters } },
        HttpRouterNotSupported: { Type: "http", Parameters: { Endpoint: "http://kubohttprouternotsupported" } }
    };
    for (const [i, httpRouterUrl] of httpRouterProxyUrls.entries()) {
        const RouterName = `HttpRouter${i + 1}`;
        httpRoutersConfig[RouterName] = {
            Type: "http",
            Parameters: {
                Endpoint: httpRouterUrl
            }
        };
        parallelRouters[i] = {
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

    // Cap the backoff: with forever:true and no maxTimeout the exponential delay grows unbounded
    // (hours between attempts after enough failures), which would stall router setup indefinitely.
    const settingOptionRetryOption = retry.operation({ forever: true, factor: 2, maxTimeout: 60 * 1000 });

    const setHttpRouterOnAllNodes = new Promise((resolve) => {
        settingOptionRetryOption.attempt(async (curAttempt) => {
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
    return {
        destroy: async () => {
            for (const proxyServer of proxyServers) {
                await proxyServer.destroy();
            }
        }
    };
}

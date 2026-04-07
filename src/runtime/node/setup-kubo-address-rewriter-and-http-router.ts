import { PKC } from "../../pkc/pkc.js";
import retry, { RetryOperation } from "retry";
import { AddressesRewriterProxyServer } from "./addresses-rewriter-proxy-server.js";
import Logger from "../../logger.js";
import { PKCError } from "../../pkc-error.js";
import * as remeda from "remeda";
import tcpPortUsed from "tcp-port-used";

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
    let addressesRewriterStartPort = 19575; // use port 19575 as first port, looks like IPRTR (IPFS ROUTER)
    for (const httpRouter of pkc.httpRoutersOptions) {
        if (pkc.destroyed) break;
        const startedProxyUrl = await _getStartedProxyUrl(pkc, httpRouter);
        if (startedProxyUrl) {
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
    const httpRoutersConfig: any = {
        HttpRoutersParallel: { Type: "parallel", Parameters: { Routers: [] } },
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

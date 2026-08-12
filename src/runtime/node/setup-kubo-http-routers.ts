import { PKC } from "../../pkc/pkc.js";
import retry from "retry";
import Logger from "../../logger.js";
import { PKCError } from "../../pkc-error.js";
import { isDeepEqual } from "remeda";

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

// Kubo publishes the provider records to these routers itself. It used to drop the browser-dialable
// transports (AutoTLS /tls/ws and webrtc-direct) from anything it PUT to a delegated HTTP router,
// which is why every router URL below used to be a loopback AddressesRewriterProxyServer that
// rewrote `Addrs` on the way through. Kubo 0.43.0 fixed that (ipfs/kubo#11394, closing the
// ipfs/kubo#11369 we filed), so Kubo now points straight at the real routers. Do not reintroduce a
// rewriting proxy: the addrs it could reconstruct (kubo id + swarm addrs) carry no certhash, so a
// rewritten webrtc-direct/webtransport addr is one no browser can dial.
export async function setupKuboHttpRouters(pkc: PKC): Promise<void> {
    if (pkc.destroyed) return;
    if (!Array.isArray(pkc.kuboRpcClientsOptions) || pkc.kuboRpcClientsOptions.length <= 0)
        throw Error("need ipfs http client to be defined");
    if (!Array.isArray(pkc.httpRoutersOptions) || pkc.httpRoutersOptions.length <= 0) throw Error("Need http router options to defined");

    const log = Logger("pkc-js:node:setupKuboHttpRouters");

    const httpRouterUrls = [...pkc.httpRoutersOptions].sort(); // make sure it's always the same order

    const kuboClients = pkc.clients.kuboRpcClients;
    const parallelRouters: NonNullable<KuboRouterEntry["Parameters"]["Routers"]> = [];
    const httpRoutersConfig: KuboRoutersMap = {
        HttpRoutersParallel: { Type: "parallel", Parameters: { Routers: parallelRouters } },
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
        settingOptionRetryOption.attempt(async () => {
            // A destroyed PKC has nothing left to configure, and `forever: true` would otherwise keep
            // retrying against a torn-down instance for the life of the process.
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
    log.trace("Set http router config on all kubo nodes", Object.keys(kuboClients), "to", httpRouterUrls);
}

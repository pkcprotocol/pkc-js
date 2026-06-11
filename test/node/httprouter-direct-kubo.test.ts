// Regression test for kubo#11213 (Routing.Type=custom publishing unresolved/empty/0.0.0.0
// addresses in IPIP-526 provider records), fixed in Kubo >= 0.41. The removed address rewriter
// proxy (#128) existed solely to work around that bug. Complements test/node/httprouter.test.ts:
// here Kubo's Routing config is set DIRECTLY over its RPC API (bypassing pkc's
// _setupHttpRoutersWithKuboNodeInBackground entirely) and the provider records Kubo publishes
// natively to a MockHttpRouter are asserted valid, with Provide.DHT.SweepEnabled both off and on.
import { beforeAll, afterAll, describe } from "vitest";
import PKC from "../../dist/node/index.js";
import { createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../helpers/conditional-tests.js";
import { MockHttpRouter } from "../../dist/node/runtime/node/test/mock-http-router.js";
import type { PKC as PKCType } from "../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";

import tcpPortUsed from "tcp-port-used";

const kuboApiUrl = "http://localhost:15006/api/v0";
const kuboApiPort = 15006;
const legacyRewriterProxyPort = 19575; // first port the removed address rewriter proxy used to listen on

async function getKuboConfig(key: string): Promise<unknown> {
    const res = await fetch(`${kuboApiUrl}/config?arg=${encodeURIComponent(key)}`, { method: "POST" });
    if (!res.ok) throw new Error(`Failed to get kubo config ${key}: ${res.status} ${await res.text()}`);
    const json = (await res.json()) as { Key: string; Value: unknown };
    return json.Value;
}

async function setKuboConfig(key: string, value: unknown): Promise<void> {
    const res = await fetch(
        `${kuboApiUrl}/config?arg=${encodeURIComponent(key)}&arg=${encodeURIComponent(JSON.stringify(value))}&json=true`,
        {
            method: "POST"
        }
    );
    if (!res.ok) throw new Error(`Failed to set kubo config ${key}: ${res.status} ${await res.text()}`);
}

// The test server (test/server/test-server.js) respawns the kubo daemon when it exits, same
// mechanism setupKuboHttpRouters relies on after changing Routing config
async function shutdownKuboAndWaitForRestart(): Promise<void> {
    await fetch(`${kuboApiUrl}/shutdown`, { method: "POST" });
    await tcpPortUsed.waitUntilFree(kuboApiPort, 500, 60000);
    await tcpPortUsed.waitUntilUsed(kuboApiPort, 500, 120000);
    // port being open doesn't mean the RPC API is ready yet, poll /id until it responds
    const deadline = Date.now() + 60000;
    while (true) {
        try {
            const res = await fetch(`${kuboApiUrl}/id`, { method: "POST" });
            if (res.ok) return;
        } catch {
            // daemon not ready yet
        }
        if (Date.now() > deadline) throw new Error("kubo RPC did not come back up after restart");
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}

// Same Routing config shape that setupKuboHttpRouters builds, set manually so pkc's own setup
// stays out of the path entirely
function buildDirectRoutingConfig(httpRouterUrl: string) {
    return {
        Type: "custom",
        Methods: {
            "find-providers": { RouterName: "HttpRoutersParallel" },
            provide: { RouterName: "HttpRoutersParallel" },
            "find-peers": { RouterName: "HttpRouterNotSupported" },
            "get-ipns": { RouterName: "HttpRouterNotSupported" },
            "put-ipns": { RouterName: "HttpRouterNotSupported" }
        },
        Routers: {
            HttpRoutersParallel: {
                Type: "parallel",
                Parameters: { Routers: [{ RouterName: "HttpRouter1", IgnoreErrors: true, Timeout: "10s" }] }
            },
            HttpRouterNotSupported: { Type: "http", Parameters: { Endpoint: "http://kubohttprouternotsupported" } },
            HttpRouter1: { Type: "http", Parameters: { Endpoint: httpRouterUrl } }
        }
    };
}

// Cannot run under RPC: this test reconfigures the Kubo node's Routing config directly over
// its RPC API and restarts the daemon. Under remote-pkc-rpc the RPC server owns the Kubo node and
// applies the http router config itself, so the config changes and daemon restarts cannot be
// driven from the test process.
describeSkipIfRpc(`kubo#11213 regression: Kubo provides valid addresses directly to HTTP router (raw Routing config)`, () => {
    let mockHttpRouter: MockHttpRouter;
    let originalRouting: unknown;
    let originalSweepEnabled: unknown;

    beforeAll(async () => {
        mockHttpRouter = new MockHttpRouter();
        await mockHttpRouter.start();
        originalRouting = await getKuboConfig("Routing");
        try {
            originalSweepEnabled = await getKuboConfig("Provide.DHT.SweepEnabled");
        } catch {
            originalSweepEnabled = undefined;
        }
    });

    afterAll(async () => {
        // restore the kubo node to its pre-experiment config so other test files are unaffected
        await setKuboConfig("Routing", originalRouting);
        if (originalSweepEnabled !== undefined) await setKuboConfig("Provide.DHT.SweepEnabled", originalSweepEnabled);
        await shutdownKuboAndWaitForRestart();
        if (mockHttpRouter) await mockHttpRouter.destroy();
    });

    // run once with the sweep provider disabled (current production config set by
    // setupKuboHttpRouters) and once enabled, in case the kubo#11213 fix behaves differently
    // between the legacy and sweep provide paths
    for (const sweepEnabled of [false, true]) {
        describe(`Provide.DHT.SweepEnabled=${sweepEnabled}`, () => {
            let pkc: PKCType;
            let community: LocalCommunity | undefined;

            beforeAll(async () => {
                mockHttpRouter.clearRequests();
                await setKuboConfig("Routing", buildDirectRoutingConfig(mockHttpRouter.url));
                await setKuboConfig("Provide.DHT.SweepEnabled", sweepEnabled);
                await shutdownKuboAndWaitForRestart();
                // httpRoutersOptions: [] prevents the Zod default production routers AND makes
                // _setupHttpRoutersWithKuboNodeInBackground a no-op, so the Routing config we
                // just set is left untouched
                pkc = await PKC({ kuboRpcClientsOptions: [kuboApiUrl], httpRoutersOptions: [] });
                pkc.on("error", (err) => {
                    console.log("Received an error on PKC instance", err);
                });
            });

            afterAll(async () => {
                try {
                    if (community) await community.delete();
                } catch {}
                try {
                    if (pkc) await pkc.destroy();
                } catch {}
            });

            it(`no legacy address rewriter proxy is running`, async () => {
                expect(await tcpPortUsed.check(legacyRewriterProxyPort)).to.be.false;
            });

            it(`Kubo Routing.Routers points directly at the mock http router (no proxy)`, async () => {
                const routers = (await getKuboConfig("Routing.Routers")) as Record<string, { Parameters: { Endpoint: string } }>;
                expect(routers["HttpRouter1"].Parameters.Endpoint).to.equal(mockHttpRouter.url);
            });

            it(`Kubo publishes provider records with valid addresses directly to the http router`, async () => {
                community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;

                await community.start();
                await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community!.updatedAt === "number" });

                expect(community.updateCid).to.be.a("string");
                expect(community.pubsubTopicRoutingCid).to.be.a("string");
                expect(community.ipnsPubsubTopicRoutingCid).to.be.a("string");
                const provideToTestAgainst = [
                    { label: "community.updateCid", cid: community.updateCid! },
                    { label: "community.pubsubTopicRoutingCid", cid: community.pubsubTopicRoutingCid! },
                    { label: "community.ipnsPubsubTopicRoutingCid", cid: community.ipnsPubsubTopicRoutingCid! }
                ];

                // provides happen in the background during community.start(), poll instead of asserting instantly
                const deadline = Date.now() + 120000;
                while (Date.now() < deadline) {
                    if (provideToTestAgainst.every(({ cid }) => mockHttpRouter.hasProvidersFor(cid))) break;
                    await new Promise((resolve) => setTimeout(resolve, 1000));
                }

                // diagnostics for the report: what Kubo actually sent vs what the rewriter would have injected
                const kuboRpcClient = pkc.clients.kuboRpcClients[kuboApiUrl]._client;
                const kuboId = await kuboRpcClient.id();
                const swarmAddrs = await kuboRpcClient.swarm.addrs();
                console.log("DIAGNOSTIC what the rewriter would have sent (id.Addresses):", JSON.stringify(kuboId.addresses.map(String)));
                console.log(
                    "DIAGNOSTIC swarm.addrs peers:",
                    JSON.stringify(swarmAddrs.map((peer) => ({ id: String(peer.id), addrs: peer.addrs.map(String) })))
                );
                const putRequests = mockHttpRouter.requests.filter(
                    (request) => request.method === "PUT" && request.url.startsWith("/routing/v1/providers")
                );
                console.log(`DIAGNOSTIC mock router received ${putRequests.length} provider PUT request(s):`);
                for (const request of putRequests) console.log("DIAGNOSTIC PUT body:", request.body);

                const providerStatuses = provideToTestAgainst.map(({ cid, label }) => ({
                    label,
                    cid,
                    hasProviders: mockHttpRouter.hasProvidersFor(cid)
                }));
                expect(
                    providerStatuses.every(({ hasProviders }) => hasProviders),
                    providerStatuses
                        .map(({ label, cid, hasProviders }) => `${label} (${cid}): ${hasProviders ? "provided" : "missing"}`)
                        .join(", ")
                ).to.be.true;

                for (const { cid: resourceToProvide } of provideToTestAgainst) {
                    const providersUrl = `${mockHttpRouter.url}/routing/v1/providers/${resourceToProvide}`;
                    const res = await fetch(providersUrl, { method: "GET" });
                    expect(res.status).to.equal(
                        200,
                        "http router " + mockHttpRouter.url + " has responded with wrong status code, did kubo provide correctly?"
                    );
                    const resJson = (await res.json()) as {
                        Providers: Array<{ Schema: string; ID: string; Addrs: string[]; Protocols?: string[] }>;
                    };
                    expect(resJson["Providers"]).to.be.a("array");
                    expect(resJson["Providers"].length).to.be.at.least(1);
                    for (const provider of resJson["Providers"]) {
                        expect(provider.Schema).to.equal("peer");
                        expect(provider.ID).to.be.a("string").and.to.have.length.greaterThan(0);
                        const providerAddrs = provider.Addrs;
                        expect(providerAddrs.length).to.be.at.least(1);
                        for (const providerAddr of providerAddrs) {
                            expect(providerAddr).to.be.a.string;
                            expect(providerAddr).to.not.include("0.0.0.0");
                        }
                        if (provider.Protocols) {
                            expect(provider.Protocols).to.be.an("array");
                        }
                    }
                }

                const hasPutRequest = putRequests.length > 0;
                expect(hasPutRequest).to.be.true;
            });
        });
    }
});

import { beforeAll, afterAll } from "vitest";
import PKC from "../../dist/node/index.js";
import { createSubWithNoChallenge, describeSkipIfRpc, resolveWhenConditionIsTrue } from "../../dist/node/test/test-util.js";
import { MockHttpRouter } from "../../dist/node/runtime/node/test/mock-http-router.js";
import type { PKC as PKCType } from "../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../dist/node/runtime/node/community/local-community.js";

import tcpPortUsed from "tcp-port-used";

describeSkipIfRpc(`Testing HTTP router settings and address rewriter`, async () => {
    const kuboNodeForHttpRouter = "http://localhost:15006/api/v0";
    let mockHttpRouter: MockHttpRouter;
    let httpRouterUrls: string[] = [];

    const startPort = 19575;

    let pkc: PKCType;

    beforeAll(async () => {
        mockHttpRouter = new MockHttpRouter();
        await mockHttpRouter.start();
        httpRouterUrls = [mockHttpRouter.url];
    });

    afterAll(async () => {
        try {
            await pkc.destroy();
        } catch {}
        if (mockHttpRouter) {
            await mockHttpRouter.destroy();
        }
    });

    it(`address rewriter proxy should not be taken before we start pkc`, async () => {
        for (let i = 0; i < httpRouterUrls.length; i++) expect(await tcpPortUsed.check(startPort + i)).to.be.false;
    });

    it(`PKC({kuboRpcClientsOptions, httpRoutersOptions}) will change config of ipfs node`, async () => {
        pkc = await PKC({ kuboRpcClientsOptions: [kuboNodeForHttpRouter], httpRoutersOptions: httpRouterUrls });
        pkc.on("error", (err) => {
            console.log("Received an error on PKC instance", err);
        });
        await new Promise((resolve) => setTimeout(resolve, 5000)); // wait unti pkc is done changing config and restarting
        expect(pkc.httpRoutersOptions).to.deep.equal(httpRouterUrls);
        const kuboRpcClient = pkc.clients.kuboRpcClients[kuboNodeForHttpRouter]._client;
        const configValueType = await kuboRpcClient.config.get("Routing.Type");
        expect(configValueType).to.equal("custom");

        const configValueMethods = (await kuboRpcClient.config.get("Routing.Methods")) as Record<string, object> | undefined;
        expect(configValueMethods?.["find-peers"]).to.be.a("object");

        const configValueRouters = (await kuboRpcClient.config.get("Routing.Routers")) as
            | Record<string, { Parameters: { Endpoint: string } }>
            | undefined;
        expect(configValueRouters?.["HttpRouter1"]).to.be.a("object");
    });

    it(`Should start up address rewriter proxy`, async () => {
        for (let i = 0; i < httpRouterUrls.length; i++) expect(await tcpPortUsed.check(startPort + i)).to.be.true;
    });

    it(`Routing.Routers should be set to proxy`, async () => {
        const kuboRpcClient = pkc.clients.kuboRpcClients[kuboNodeForHttpRouter]._client;
        const configValueRouters = (await kuboRpcClient.config.get("Routing.Routers")) as Record<
            string,
            { Parameters: { Endpoint: string } }
        >;
        for (let i = 0; i < httpRouterUrls.length; i++) {
            const endpoint = configValueRouters[`HttpRouter${i + 1}`].Parameters.Endpoint;
            expect(endpoint).to.equal(`http://127.0.0.1:${startPort + i}`);
        }
    });

    it(`Can create another pkc instance with same configs with no problem`, async () => {
        const anotherInstance = await PKC({
            kuboRpcClientsOptions: [kuboNodeForHttpRouter],
            httpRoutersOptions: httpRouterUrls,
            dataPath: pkc.dataPath
        });
        anotherInstance.on("error", (err) => {
            console.log("Received an error on PKC instance", err);
        });
        const kuboRpcClient = anotherInstance.clients.kuboRpcClients[kuboNodeForHttpRouter]._client;
        const configValueRouters = (await kuboRpcClient.config.get("Routing.Routers")) as Record<
            string,
            { Parameters: { Endpoint: string } }
        >;
        for (let i = 0; i < httpRouterUrls.length; i++) {
            const endpoint = configValueRouters[`HttpRouter${i + 1}`].Parameters.Endpoint;
            expect(endpoint).to.equal(`http://127.0.0.1:${startPort + i}`);
        }

        await anotherInstance.destroy();
    });

    it(`The proxy proxies requests to http router properly`, async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity; // an online community

        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        expect(community.updateCid).to.be.a("string");
        expect(community.pubsubTopicRoutingCid).to.be.a("string");
        expect(community.ipnsPubsubTopicRoutingCid).to.be.a("string");
        const provideToTestAgainst = [
            { label: "community.updateCid", cid: community.updateCid! },
            { label: "community.pubsubTopicRoutingCid", cid: community.pubsubTopicRoutingCid! },
            { label: "community.ipnsPubsubTopicRoutingCid", cid: community.ipnsPubsubTopicRoutingCid! }
        ];

        const providerStatuses = provideToTestAgainst.map(({ cid, label }) => ({
            label,
            cid,
            hasProviders: mockHttpRouter.hasProvidersFor(cid)
        }));
        expect(
            providerStatuses.every(({ hasProviders }) => hasProviders),
            providerStatuses.map(({ label, cid, hasProviders }) => `${label} (${cid}): ${hasProviders ? "provided" : "missing"}`).join(", ")
        ).to.be.true;

        for (const httpRouterUrl of httpRouterUrls) {
            // why does community.ipnsPubsubDhtKey fails here?
            for (const { cid: resourceToProvide } of provideToTestAgainst) {
                const providersUrl = `${httpRouterUrl}/routing/v1/providers/${resourceToProvide}`;
                const res = await fetch(providersUrl, { method: "GET" });
                expect(res.status).to.equal(
                    200,
                    "http router " + httpRouterUrl + " has responded with wrong status code, did it provide correctly?"
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
        }

        const hasPutRequest = mockHttpRouter.requests
            .filter((request) => request.method === "PUT")
            .some((request) => request.url.startsWith("/routing/v1/providers"));
        expect(hasPutRequest).to.be.true;

        await community.delete();
    });

    it(`Calling pkc.destroy() on original pkc instance that started address rewriter proxy frees up the proxy server`, async () => {
        await pkc.destroy();
        for (let i = 0; i < httpRouterUrls.length; i++) expect(await tcpPortUsed.check(startPort + i)).to.be.false;
    });

    it(`Creating a new pkc instance will start a new proxy server after destroying the previous one`, async () => {
        const anotherInstance = await PKC({
            kuboRpcClientsOptions: [kuboNodeForHttpRouter],
            httpRoutersOptions: httpRouterUrls,
            dataPath: pkc.dataPath
        });

        await new Promise((resolve) => setTimeout(resolve, 5000)); // wait unti pkc is done changing config and restarting
        for (let i = 0; i < httpRouterUrls.length; i++) expect(await tcpPortUsed.check(startPort + i)).to.be.true;

        await anotherInstance.destroy();

        for (let i = 0; i < httpRouterUrls.length; i++) expect(await tcpPortUsed.check(startPort + i)).to.be.false;
    });
});

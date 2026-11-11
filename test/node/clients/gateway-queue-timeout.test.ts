import http, { Server } from "http";
import type { AddressInfo } from "net";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mockGatewayPKC } from "../../../dist/node/test/test-util.js";
import { calculateIpfsCidV0 } from "../../../dist/node/util.js";
import Logger from "../../../dist/node/logger.js";

import type { PKC } from "../../../dist/node/pkc/pkc.js";

// Both gateway fetchers run at most 3 gateways at a time and queue the rest. Each gateway's timeout used
// to be armed when it was queued, not when its request started, so when the first 3 gateways hung, every
// queued gateway's timer had already fired by the time a slot freed up: it started with an aborted
// request and failed without ever being asked, however healthy it was.
describe("gateway timeouts start when the gateway's request does, not while it waits in the queue", () => {
    const servers: Server[] = [];
    const requestsPerGateway = [0, 0, 0, 0];
    const gatewayUrls: string[] = [];
    let pkc: PKC;
    const body = JSON.stringify({ hello: "from the fourth gateway" });
    const timeoutMs = 500;

    beforeAll(async () => {
        for (let i = 0; i < 4; i++) {
            const server = http.createServer((_req, res) => {
                requestsPerGateway[i]++;
                if (i < 3) return; // accepts the request and never answers
                res.writeHead(200, { "content-type": "application/json" });
                res.end(body);
            });
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            servers.push(server);
            gatewayUrls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        }
        pkc = await mockGatewayPKC({ pkcOptions: { ipfsGatewayUrls: gatewayUrls } });
    });

    afterAll(async () => {
        await pkc?.destroy();
        for (const server of servers) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("fetchFromMultipleGateways loads from the 4th gateway when the first 3 time out", async () => {
        requestsPerGateway.fill(0);
        const res = await pkc._clientsManager.fetchFromMultipleGateways({
            recordIpfsType: "ipfs",
            root: await calculateIpfsCidV0(body),
            recordPKCType: "generic-ipfs",
            validateGatewayResponseFunc: async () => {},
            log: Logger("pkc-js:test:gateway-queue-timeout"),
            maxFileSizeBytes: 1024,
            timeoutMs
        });
        expect(res.resText).to.equal(body);
        expect(requestsPerGateway).to.deep.equal([1, 1, 1, 1]);
    });

    it("a community's gateway fetch asks the 4th gateway when the first 3 time out", async () => {
        requestsPerGateway.fill(0);
        const community = await pkc.createCommunity({ address: (await pkc.createSigner()).address });
        community._createStopAbortController();
        const originalTimeoutMs = pkc._timeouts["community-ipns"];
        pkc._timeouts["community-ipns"] = timeoutMs;
        try {
            const clientsManager = community._clientsManager as unknown as {
                _fetchCommunityFromGateways: (ipnsName: string) => Promise<unknown>;
            };
            // The 4th gateway's answer is not a community record, so the fetch fails either way. What matters is
            // whether the 4th gateway was asked at all.
            await clientsManager._fetchCommunityFromGateways(community.address).catch((): void => undefined);
        } finally {
            pkc._timeouts["community-ipns"] = originalTimeoutMs;
            community._clearStopAbortController();
        }
        expect(requestsPerGateway.slice(0, 3)).to.deep.equal([1, 1, 1]);
        expect(requestsPerGateway[3], "the 4th gateway was never asked").to.equal(1);
    });
});

// With more than 3 gateways, a community's gateway fetch awaits the gateway score sort before it queues
// anything. A community stopped during that await must not ask any gateway: the fetch rejects with the stop,
// and nothing is left to clean up its queue. With timeouts armed per request, a gateway queued then would
// start a real request with a fresh timeout long after the stop.
describe("a community stopped while its gateway fetch sorts the gateways", () => {
    const servers: Server[] = [];
    const requestsPerGateway = [0, 0, 0, 0, 0];
    let pkc: PKC;
    const timeoutMs = 300;

    beforeAll(async () => {
        const gatewayUrls: string[] = [];
        for (let i = 0; i < 5; i++) {
            const server = http.createServer(() => void requestsPerGateway[i]++); // accepts the request and never answers
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            servers.push(server);
            gatewayUrls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
        }
        pkc = await mockGatewayPKC({ pkcOptions: { ipfsGatewayUrls: gatewayUrls } });
    });

    afterAll(async () => {
        await pkc?.destroy();
        for (const server of servers) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("rejects with the stop and asks no gateway", async () => {
        const community = await pkc.createCommunity({ address: (await pkc.createSigner()).address });
        community._createStopAbortController();
        const stats = pkc._stats;
        const originalSort = stats.sortGatewaysAccordingToScore;
        stats.sortGatewaysAccordingToScore = async (type) => {
            const sorted = await originalSort.call(stats, type);
            community._abortStopOperations("stopped while the gateways were being sorted");
            return sorted;
        };
        const originalTimeoutMs = pkc._timeouts["community-ipns"];
        pkc._timeouts["community-ipns"] = timeoutMs;
        let error: Error | undefined;
        try {
            const clientsManager = community._clientsManager as unknown as {
                _fetchCommunityFromGateways: (ipnsName: string) => Promise<unknown>;
            };
            await clientsManager._fetchCommunityFromGateways(community.address).catch((e: Error): void => void (error = e));
            // Long enough for the first 3 gateways to time out and the 2 queued behind them to start, if anything was queued
            await new Promise((resolve) => setTimeout(resolve, 4 * timeoutMs));
        } finally {
            stats.sortGatewaysAccordingToScore = originalSort;
            pkc._timeouts["community-ipns"] = originalTimeoutMs;
            community._clearStopAbortController();
        }
        expect(error?.name).to.equal("AbortError");
        expect(requestsPerGateway.slice(3), "a gateway queued behind the first 3 started after the stop").to.deep.equal([0, 0]);
        expect(requestsPerGateway, "no gateway is asked after the community stopped").to.deep.equal([0, 0, 0, 0, 0]);
    });
});

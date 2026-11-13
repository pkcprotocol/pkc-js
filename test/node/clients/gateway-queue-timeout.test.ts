import http, { Server } from "http";
import type { AddressInfo } from "net";
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { mockGatewayPKC } from "../../../dist/node/test/test-util.js";
import { calculateIpfsCidV0 } from "../../../dist/node/util.js";
import Logger from "../../../dist/node/logger.js";

import validPageFixture from "../../fixtures/valid_page.json" with { type: "json" };
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

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

// The same through the public API. comment.update() has no deadline of its own, it retries the load until it is
// stopped, so with timeouts armed at enqueue every attempt failed the same way and the comment never loaded,
// although the 4th gateway serves it.
describe("comment.update() with 4 gateways, the first 3 hanging", () => {
    const servers: Server[] = [];
    const requestsPerGateway = [0, 0, 0, 0];
    let pkc: PKC;
    const body = JSON.stringify(validPageFixture.comments[0].comment);

    beforeAll(async () => {
        const gatewayUrls: string[] = [];
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
        pkc._timeouts["comment-ipfs"] = 500;
    });

    afterAll(async () => {
        await pkc?.destroy();
        for (const server of servers) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it("loads the comment from the 4th gateway", async () => {
        const comment = await pkc.createComment({ cid: await calculateIpfsCidV0(body) });
        // The first 3 gateways' timeouts are retriable errors, emitted while the comment keeps trying
        comment.on("error", () => {});
        await comment.update();
        try {
            await vi.waitFor(() => expect(comment.raw.comment, "the comment never loaded its CommentIpfs").to.not.equal(undefined), {
                timeout: 8000
            });
        } finally {
            await comment.stop();
        }
        expect(comment.signature).to.deep.equal(validPageFixture.comments[0].comment.signature);
        expect(requestsPerGateway[3], "the 4th gateway was never asked for the comment").to.be.greaterThan(0);
    });
});

// pkc.getComment's deadline is the comment-ipfs timeout, the same length as each gateway's. A gateway that gets a
// slot at once has its timeout armed when it is queued, before getComment arms its own, so when every gateway hangs,
// getComment rejects with what the gateways did rather than with a bare timeout. Armed a tick later, when the request
// starts, that timeout always lost the race to getComment's.
describe("a gateway that starts at once times out before a caller's deadline of the same length", () => {
    let server: Server;
    let gatewayUrl: string;
    let pkc: PKC;

    beforeAll(async () => {
        server = http.createServer(() => {}); // accepts the request and never answers
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        gatewayUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        pkc = await mockGatewayPKC({ pkcOptions: { ipfsGatewayUrls: [gatewayUrl] } });
    });

    afterAll(async () => {
        await pkc?.destroy();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it("pkc.getComment rejects with the gateways' errors when every gateway hangs", async () => {
        pkc._timeouts["comment-ipfs"] = 200;
        const cid = await calculateIpfsCidV0("a comment no gateway serves");
        const error = await pkc.getComment({ cid }).then(
            (): undefined => undefined,
            (e: PKCError) => e
        );
        expect(error?.code, "getComment timed out before the gateway did").to.equal("ERR_FAILED_TO_FETCH_COMMENT_IPFS_FROM_GATEWAYS");
        expect((error?.details.gatewayToError as Record<string, PKCError>)[gatewayUrl].code).to.equal("ERR_GATEWAY_TIMED_OUT_OR_ABORTED");
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

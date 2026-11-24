import http, { Server } from "http";
import type { AddressInfo } from "net";
import { describe, it, beforeAll, afterAll, afterEach, expect, vi } from "vitest";
import { mockGatewayPKC } from "../../../dist/node/test/test-util.js";
import { calculateIpfsCidV0 } from "../../../dist/node/util.js";
import Logger from "../../../dist/node/logger.js";

import communityRecordFixture from "../../fixtures/signatures/community/valid_community_ipfs_new_format.json" with { type: "json" };
import type { PKC } from "../../../dist/node/pkc/pkc.js";

// Gateways are ordered by their recorded successes and failures, so a recorded failure has to mean the
// gateway was bad. A request that pkc-js aborted itself says nothing about the gateway: another gateway
// answered first, or the community was stopped. Those used to be recorded as failures, so two healthy
// gateways out of every three racing lost score on each fetch. A gateway's own timeout still counts.

type GatewayHandler = (gatewayIndex: number, res: http.ServerResponse, req: http.IncomingMessage) => void;

async function startGateways(count: number, handler: GatewayHandler) {
    const servers: Server[] = [];
    const gatewayUrls: string[] = [];
    for (let i = 0; i < count; i++) {
        const server = http.createServer((req, res) => handler(i, res, req));
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        servers.push(server);
        gatewayUrls.push(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    }
    const close = async () => {
        for (const server of servers) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    };
    return { gatewayUrls, close };
}

const log = Logger("pkc-js:test:gateway-stats-recording");

describe("fetchFromMultipleGateways records a failure only for a gateway that failed", () => {
    const body = JSON.stringify({ hello: "from the gateway that answers" });
    const timeoutMs = 300;
    let cid: string;

    beforeAll(async () => {
        cid = await calculateIpfsCidV0(body);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    const loadOpts = () => ({
        recordIpfsType: "ipfs" as const,
        root: cid,
        recordPKCType: "generic-ipfs" as const,
        validateGatewayResponseFunc: async () => {},
        log,
        maxFileSizeBytes: 1024,
        timeoutMs
    });

    it("records nothing for the gateways that were aborted because another one answered first", async () => {
        // Gateways 0 and 1 never answer, gateway 2 answers, gateway 3 waits in the queue and is never asked
        const gateways = await startGateways(4, (i, res) => {
            if (i !== 2) return;
            res.writeHead(200, { "content-type": "application/json" });
            res.end(body);
        });
        const pkc: PKC = await mockGatewayPKC({ pkcOptions: { ipfsGatewayUrls: gateways.gatewayUrls } });
        try {
            const recordFailure = vi.spyOn(pkc._stats, "recordGatewayFailure");
            const gatewayRequestEnded = vi.spyOn(pkc._clientsManager, "postFetchGatewayFailure");

            const res = await pkc._clientsManager.fetchFromMultipleGateways(loadOpts());
            expect(res.resText).to.equal(body);

            // The two aborted requests end after the fetch has returned. The queued gateway may get its slot
            // just before the queue is cleared, and is then aborted like them
            await vi.waitFor(() =>
                expect(gatewayRequestEnded.mock.calls.map(([gatewayUrl]) => gatewayUrl)).to.include.members(
                    gateways.gatewayUrls.slice(0, 2)
                )
            );
            expect(recordFailure.mock.calls.map(([gatewayUrl]) => gatewayUrl)).to.deep.equal([]);
        } finally {
            await pkc.destroy();
            await gateways.close();
        }
    });

    it("records a failure for every gateway that timed out", async () => {
        const gateways = await startGateways(3, () => {}); // every gateway accepts the request and never answers
        const pkc: PKC = await mockGatewayPKC({ pkcOptions: { ipfsGatewayUrls: gateways.gatewayUrls } });
        try {
            const recordFailure = vi.spyOn(pkc._stats, "recordGatewayFailure");
            await pkc._clientsManager.fetchFromMultipleGateways(loadOpts()).catch((): void => undefined);
            expect(recordFailure.mock.calls.map(([gatewayUrl, type]) => `${gatewayUrl} ${type}`).sort()).to.deep.equal(
                gateways.gatewayUrls.map((gatewayUrl) => `${gatewayUrl} ipfs`).sort()
            );
        } finally {
            await pkc.destroy();
            await gateways.close();
        }
    });
});

describe("a community's gateway fetch records a failure only for a gateway that failed", () => {
    const timeoutMs = 300;

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // By default every gateway accepts the request and never answers
    async function setUp(handler: GatewayHandler = () => {}, communityIpnsTimeoutMs = timeoutMs) {
        const gateways = await startGateways(3, handler);
        const pkc: PKC = await mockGatewayPKC({ pkcOptions: { ipfsGatewayUrls: gateways.gatewayUrls } });
        pkc._timeouts["community-ipns"] = communityIpnsTimeoutMs;
        const community = await pkc.createCommunity({ address: (await pkc.createSigner()).address });
        community._createStopAbortController();
        const clientsManager = community._clientsManager as unknown as {
            _fetchCommunityFromGateways: (ipnsName: string) => Promise<unknown>;
            postFetchGatewayFailure: (gatewayUrl: string) => void;
        };
        const tearDown = async () => {
            community._clearStopAbortController();
            await pkc.destroy();
            await gateways.close();
        };
        return { gateways, pkc, community, clientsManager, tearDown };
    }

    it("records nothing for the gateways that were aborted because the community stopped", async () => {
        const { gateways, pkc, community, clientsManager, tearDown } = await setUp();
        try {
            const recordFailure = vi.spyOn(pkc._stats, "recordGatewayFailure");
            const gatewayRequestEnded = vi.spyOn(clientsManager, "postFetchGatewayFailure");

            const fetching = clientsManager._fetchCommunityFromGateways(community.address).catch((): void => undefined);
            await new Promise((resolve) => setTimeout(resolve, timeoutMs / 3)); // the 3 requests are in flight
            community._abortStopOperations("stopped while the gateways were being asked");
            await fetching;

            await vi.waitFor(() =>
                expect(gatewayRequestEnded.mock.calls.map(([gatewayUrl]) => gatewayUrl).sort()).to.deep.equal(
                    [...gateways.gatewayUrls].sort()
                )
            );
            expect(recordFailure.mock.calls.map(([gatewayUrl]) => gatewayUrl)).to.deep.equal([]);
        } finally {
            await tearDown();
        }
    });

    // A record signed by another key than the one asked for may be a delegated community, so the gateway is
    // asked for the IPNS records of the chain before its answer is accepted. That walk runs after the gateway
    // has answered, and an abort of it surfaces as the fetch's own AbortError, not as a gateway error
    it("records nothing for the gateways that were aborted while their delegated IPNS chain was being walked", async () => {
        let chainRequests = 0;
        const { gateways, pkc, community, clientsManager, tearDown } = await setUp((_i, res, req) => {
            if (req.url?.includes("format=ipns-record")) return void chainRequests++; // never answers
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify(communityRecordFixture)); // signed by a key that is not this community's
        }, 30_000);
        try {
            const recordFailure = vi.spyOn(pkc._stats, "recordGatewayFailure");
            const gatewayRequestEnded = vi.spyOn(clientsManager, "postFetchGatewayFailure");

            const fetching = clientsManager._fetchCommunityFromGateways(community.address).catch((): void => undefined);
            // Only the first gateway to answer walks the chain: the other two served a record already seen
            await vi.waitFor(() => expect(chainRequests, "a gateway is being asked for the chain").to.equal(1));
            community._abortStopOperations("stopped while the chains were being walked");
            await fetching;

            await vi.waitFor(() =>
                expect(gatewayRequestEnded.mock.calls.map(([gatewayUrl]) => gatewayUrl).sort()).to.deep.equal(
                    [...gateways.gatewayUrls].sort()
                )
            );
            expect(recordFailure.mock.calls.map(([gatewayUrl]) => gatewayUrl)).to.deep.equal([]);
        } finally {
            await tearDown();
        }
    });

    it("records a failure for every gateway that timed out", async () => {
        const { gateways, pkc, community, clientsManager, tearDown } = await setUp();
        try {
            const recordFailure = vi.spyOn(pkc._stats, "recordGatewayFailure");
            await clientsManager._fetchCommunityFromGateways(community.address).catch((): void => undefined);
            expect(recordFailure.mock.calls.map(([gatewayUrl, type]) => `${gatewayUrl} ${type}`).sort()).to.deep.equal(
                gateways.gatewayUrls.map((gatewayUrl) => `${gatewayUrl} ipns`).sort()
            );
        } finally {
            await tearDown();
        }
    });
});

// The sort only matters when there are more gateways than the 3 asked at once: the rest are asked only if
// one of those 3 fails. A gateway with a record of failures must be one of the rest.
describe("with 5 gateways, the one with recorded failures is asked last", () => {
    it("asks the 4 gateways without failures before it", async () => {
        const askedOrder: number[] = [];
        const gateways = await startGateways(5, (i) => void askedOrder.push(i)); // never answers
        // The test PKC stubs its storage by default, which leaves every gateway without a record
        const pkc: PKC = await mockGatewayPKC({ pkcOptions: { ipfsGatewayUrls: gateways.gatewayUrls }, stubStorage: false });
        try {
            for (let i = 0; i < 5; i++) await pkc._stats.recordGatewayFailure(gateways.gatewayUrls[0], "ipfs");

            await pkc._clientsManager
                .fetchFromMultipleGateways({
                    recordIpfsType: "ipfs",
                    root: await calculateIpfsCidV0("anything"),
                    recordPKCType: "generic-ipfs",
                    validateGatewayResponseFunc: async () => {},
                    log,
                    maxFileSizeBytes: 1024,
                    timeoutMs: 300
                })
                .catch((): void => undefined);

            expect(askedOrder.slice(0, 3).sort(), "the first 3 asked at once").to.deep.equal([1, 2, 3]);
            expect(askedOrder.slice(3), "the 2 asked once a slot freed up").to.deep.equal([4, 0]);
        } finally {
            await pkc.destroy();
            await gateways.close();
        }
    });
});

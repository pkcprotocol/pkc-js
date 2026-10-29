import http, { Server } from "http";
import type { AddressInfo } from "net";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mockGatewayPKC } from "../../../dist/node/test/test-util.js";
import Logger from "../../../dist/node/logger.js";

import type { PKC } from "../../../dist/node/pkc/pkc.js";

// Both gateway fetchers run at most 3 gateways at a time and queue the rest. Aborting (the caller's signal, or the
// community's stop) clears that queue; the cleared gateways must still settle, otherwise the call never returns
describe("gateway fetches aborted while gateways are queued", () => {
    const servers: Server[] = [];
    let pkc: PKC;

    beforeAll(async () => {
        const gatewayUrls: string[] = [];
        for (let i = 0; i < 5; i++) {
            const server = http.createServer(() => {}); // accepts the request and never answers
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

    const settlesWithin5s = (fetching: Promise<unknown>) =>
        Promise.race([
            fetching.then(
                () => "resolved",
                () => "rejected"
            ),
            new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 5000))
        ]);

    it("fetchFromMultipleGateways rejects with the abort instead of hanging", async () => {
        const abortController = new AbortController();
        const fetching = pkc._clientsManager.fetchFromMultipleGateways({
            recordIpfsType: "ipfs",
            root: "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f",
            recordPKCType: "comment",
            validateGatewayResponseFunc: async () => {},
            log: Logger("pkc-js:test:gateway-queue-abort"),
            maxFileSizeBytes: 1024,
            timeoutMs: 60_000,
            abortSignal: abortController.signal
        });
        setTimeout(() => abortController.abort(), 500);
        const settled = await settlesWithin5s(fetching);
        expect(settled).toBe("rejected");
    });

    it("a community's gateway fetch rejects with the stop instead of hanging", async () => {
        const community = await pkc.createCommunity({ address: (await pkc.createSigner()).address });
        community._createStopAbortController();
        const clientsManager = community._clientsManager as unknown as {
            _fetchCommunityFromGateways: (ipnsName: string) => Promise<unknown>;
        };
        const fetching = clientsManager._fetchCommunityFromGateways(community.address);
        setTimeout(() => community._abortStopOperations("test stop"), 500);
        const settled = await settlesWithin5s(fetching);
        community._clearStopAbortController();
        expect(settled).toBe("rejected");
    });
});

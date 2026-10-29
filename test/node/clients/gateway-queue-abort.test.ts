import http, { Server } from "http";
import type { AddressInfo } from "net";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mockGatewayPKC } from "../../../dist/node/test/test-util.js";
import Logger from "../../../dist/node/logger.js";

import type { PKC } from "../../../dist/node/pkc/pkc.js";

// fetchFromMultipleGateways runs at most 3 gateways at a time and queues the rest. Aborting the caller's signal clears
// that queue; the cleared gateways must still settle, otherwise the call never returns
describe("fetchFromMultipleGateways aborted while gateways are queued", () => {
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

    it("rejects with the abort instead of hanging", async () => {
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
        const settled = await Promise.race([
            fetching.then(
                () => "resolved",
                () => "rejected"
            ),
            new Promise<string>((resolve) => setTimeout(() => resolve("still pending"), 5000))
        ]);
        expect(settled).toBe("rejected");
    });
});

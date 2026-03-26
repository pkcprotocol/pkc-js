import http, { IncomingMessage, ServerResponse, Server } from "http";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { mockGatewayPlebbit, mockPlebbit } from "../../../dist/node/test/test-util.js";
import { signSubplebbit } from "../../../dist/node/signer/signatures.js";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { convertBase58IpnsNameToBase36Cid } from "../../../dist/node/signer/util.js";

import type { Plebbit } from "../../../dist/node/plebbit/plebbit.js";
import type { SignerWithPublicKeyAddress } from "../../../dist/node/signer/index.js";
import type { SubplebbitIpfsType } from "../../../dist/node/subplebbit/types.js";

// Tests for gateway responses with missing or malformed etag headers
// Since etag is now optional, gateways with missing/malformed etag should still succeed
// as long as the body can be fetched and validated
describe("Test gateway response with malformed etag headers", async () => {
    // Mock gateway ports (chosen to avoid conflicts with test-server.js and multiplegateways tests)
    const MALFORMED_ETAG_GATEWAY_PORT = 25020;
    const EMPTY_ETAG_GATEWAY_PORT = 25021;
    const WEAK_MALFORMED_ETAG_GATEWAY_PORT = 25022;
    const VALID_GATEWAY_PORT = 25023;
    const QUOTES_ONLY_ETAG_GATEWAY_PORT = 25024;

    // Gateway URLs
    const malformedEtagGateway = `http://localhost:${MALFORMED_ETAG_GATEWAY_PORT}`;
    const emptyEtagGateway = `http://localhost:${EMPTY_ETAG_GATEWAY_PORT}`;
    const weakMalformedEtagGateway = `http://localhost:${WEAK_MALFORMED_ETAG_GATEWAY_PORT}`;
    const validGateway = `http://localhost:${VALID_GATEWAY_PORT}`;
    const quotesOnlyEtagGateway = `http://localhost:${QUOTES_ONLY_ETAG_GATEWAY_PORT}`;

    let servers: Server[] = [];
    let testSigner: SignerWithPublicKeyAddress;
    let subAddress: string;
    let expectedBase36: string;

    // Create an HTTP server helper
    const createServer = (port: number, handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Server> => {
        return new Promise((resolve, reject) => {
            const server = http.createServer(handler);
            server.on("error", reject);
            server.listen(port, () => {
                servers.push(server);
                resolve(server);
            });
        });
    };

    // Check if request is for our test subplebbit
    const isRequestForTestSub = (req: IncomingMessage): boolean => {
        if (!req.url?.includes("/ipns/")) return false;
        const base36Address = req.url.split("/ipns/")[1]?.split("?")[0];
        if (!base36Address) return false;
        return base36Address === expectedBase36;
    };

    // Generate a fresh subplebbit record
    const generateFreshRecord = (): Omit<SubplebbitIpfsType, "signature"> => {
        const now = Math.round(Date.now() / 1000);
        return {
            challenges: [],
            createdAt: now - 3600, // Created 1 hour ago
            updatedAt: now, // Updated now (fresh)
            encryption: {
                publicKey: testSigner.publicKey,
                type: "ed25519-aes-gcm"
            },
            pubsubTopic: subAddress,
            statsCid: "QmYHzA8euDgUpNy3fh7JRwpPwt6jCgF35YTutYkyGGyr8f", // Dummy CID
            protocolVersion: "1.0.0"
        };
    };

    // Sign a subplebbit record
    const signRecord = async (record: Omit<SubplebbitIpfsType, "signature">): Promise<SubplebbitIpfsType> => {
        const signature = await signSubplebbit({ subplebbit: record, signer: testSigner });
        return { ...record, signature };
    };

    beforeAll(async () => {
        // Create a unique signer for this test to ensure complete isolation
        const plebbit: Plebbit = await mockPlebbit();
        testSigner = await plebbit.createSigner();
        subAddress = testSigner.address;
        expectedBase36 = convertBase58IpnsNameToBase36Cid(subAddress);
        await plebbit.destroy();

        // Gateway with malformed etag (invalid CID string)
        await createServer(MALFORMED_ETAG_GATEWAY_PORT, async (req, res) => {
            res.setHeader("Access-Control-Allow-Origin", "*");
            if (!isRequestForTestSub(req)) {
                res.statusCode = 404;
                res.end("Not found");
                return;
            }
            const freshRecord = await signRecord(generateFreshRecord());
            const freshRecordJson = JSON.stringify(freshRecord);
            // Set a malformed etag that is not a valid CID
            res.setHeader("etag", '"not-a-valid-cid"');
            res.end(freshRecordJson);
        });

        // Gateway with empty etag
        await createServer(EMPTY_ETAG_GATEWAY_PORT, async (req, res) => {
            res.setHeader("Access-Control-Allow-Origin", "*");
            if (!isRequestForTestSub(req)) {
                res.statusCode = 404;
                res.end("Not found");
                return;
            }
            const freshRecord = await signRecord(generateFreshRecord());
            const freshRecordJson = JSON.stringify(freshRecord);
            // Set an empty etag
            res.setHeader("etag", "");
            res.end(freshRecordJson);
        });

        // Gateway with weak etag containing malformed CID
        await createServer(WEAK_MALFORMED_ETAG_GATEWAY_PORT, async (req, res) => {
            res.setHeader("Access-Control-Allow-Origin", "*");
            if (!isRequestForTestSub(req)) {
                res.statusCode = 404;
                res.end("Not found");
                return;
            }
            const freshRecord = await signRecord(generateFreshRecord());
            const freshRecordJson = JSON.stringify(freshRecord);
            // Set a weak etag with invalid CID
            res.setHeader("etag", 'W/"garbage-cid-value"');
            res.end(freshRecordJson);
        });

        // Valid gateway - responds with proper etag
        await createServer(VALID_GATEWAY_PORT, async (req, res) => {
            res.setHeader("Access-Control-Allow-Origin", "*");
            if (!isRequestForTestSub(req)) {
                res.statusCode = 404;
                res.end("Not found");
                return;
            }
            const freshRecord = await signRecord(generateFreshRecord());
            const freshRecordJson = JSON.stringify(freshRecord);
            const freshRecordCid = await calculateIpfsHash(freshRecordJson);
            res.setHeader("etag", `"${freshRecordCid}"`);
            res.end(freshRecordJson);
        });

        // Gateway with etag containing only quotes (empty after stripping)
        await createServer(QUOTES_ONLY_ETAG_GATEWAY_PORT, async (req, res) => {
            res.setHeader("Access-Control-Allow-Origin", "*");
            if (!isRequestForTestSub(req)) {
                res.statusCode = 404;
                res.end("Not found");
                return;
            }
            const freshRecord = await signRecord(generateFreshRecord());
            const freshRecordJson = JSON.stringify(freshRecord);
            // Set etag with only quotes - will be empty after stripping
            res.setHeader("etag", '""');
            res.end(freshRecordJson);
        });
    });

    afterAll(async () => {
        // Close all mock servers
        for (const server of servers) {
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
    });

    it(`Gateway with malformed etag still succeeds by fetching body`, async () => {
        // Since etag is optional, malformed etag just skips the optimization
        const customPlebbit = await mockGatewayPlebbit({ plebbitOptions: { ipfsGatewayUrls: [malformedEtagGateway, validGateway] } });
        try {
            const sub = await customPlebbit.getSubplebbit({ address: subAddress });
            expect(sub.address).to.equal(subAddress);
            expect(sub.updatedAt).to.be.a("number");
            // Verify it's fresh (within the last 10 seconds)
            const now = Math.round(Date.now() / 1000);
            expect(sub.updatedAt).to.be.closeTo(now, 10);
        } finally {
            await customPlebbit.destroy();
        }
    });

    it(`Gateway with weak etag containing malformed CID still succeeds`, async () => {
        // Since etag is optional, malformed CID in etag just skips the optimization
        const customPlebbit = await mockGatewayPlebbit({ plebbitOptions: { ipfsGatewayUrls: [weakMalformedEtagGateway, validGateway] } });
        try {
            const sub = await customPlebbit.getSubplebbit({ address: subAddress });
            expect(sub.address).to.equal(subAddress);
            expect(sub.updatedAt).to.be.a("number");
        } finally {
            await customPlebbit.destroy();
        }
    });

    it(`All gateways with malformed etag headers still succeed by fetching body`, async () => {
        // Since etag is optional, gateways with malformed etag will fetch body and succeed
        const customPlebbit = await mockGatewayPlebbit({
            plebbitOptions: { ipfsGatewayUrls: [malformedEtagGateway, weakMalformedEtagGateway] }
        });
        try {
            const sub = await customPlebbit.getSubplebbit({ address: subAddress });
            expect(sub.address).to.equal(subAddress);
            expect(sub.updatedAt).to.be.a("number");
        } finally {
            await customPlebbit.destroy();
        }
    });

    it(`Gateway with empty etag still succeeds by fetching body`, async () => {
        // Empty etag is treated as missing, but the body is still fetched and validated
        const customPlebbit = await mockGatewayPlebbit({ plebbitOptions: { ipfsGatewayUrls: [emptyEtagGateway, validGateway] } });
        try {
            const sub = await customPlebbit.getSubplebbit({ address: subAddress });
            expect(sub.address).to.equal(subAddress);
            expect(sub.updatedAt).to.be.a("number");
        } finally {
            await customPlebbit.destroy();
        }
    });

    it(`Single gateway with empty etag header still succeeds`, async () => {
        // Even with only one gateway that has empty etag, the body is fetched and validated
        const customPlebbit = await mockGatewayPlebbit({ plebbitOptions: { ipfsGatewayUrls: [emptyEtagGateway] } });
        try {
            const sub = await customPlebbit.getSubplebbit({ address: subAddress });
            expect(sub.address).to.equal(subAddress);
            expect(sub.updatedAt).to.be.a("number");
        } finally {
            await customPlebbit.destroy();
        }
    });

    it(`Gateway with quotes-only etag still succeeds by fetching body`, async () => {
        // etag: "" is treated as malformed, but body is still fetched and validated
        const customPlebbit = await mockGatewayPlebbit({ plebbitOptions: { ipfsGatewayUrls: [quotesOnlyEtagGateway, validGateway] } });
        try {
            const sub = await customPlebbit.getSubplebbit({ address: subAddress });
            expect(sub.address).to.equal(subAddress);
            expect(sub.updatedAt).to.be.a("number");
        } finally {
            await customPlebbit.destroy();
        }
    });
});

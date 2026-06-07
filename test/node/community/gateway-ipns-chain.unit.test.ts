import { afterAll, afterEach, beforeAll, it, expect, vi } from "vitest";
import { mockPKCNoDataPathWithOnlyKuboClient } from "../../../dist/node/test/test-util.js";
import { fetchAndValidateIpnsRecordFromGateway } from "../../../dist/node/util.js";
import { PKCError } from "../../../dist/node/pkc-error.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { generateKeyPair } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { createIPNSRecord, marshalIPNSRecord } from "ipns";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { CommunityClientsManager } from "../../../dist/node/community/community-client-manager.js";

// These exercise the untrusted-gateway IPNS-record validation + chain walk used for delegated IPNS
// loading (docs/protocol/delegated-ipns.md). The error/value branches can't be triggered through a
// real kubo gateway (kubo only serves validly-signed records pointing at valid /ipfs/ or /ipns/
// values), so we mock `fetch` and craft IPNS records directly. It's all client-side and
// config-independent, so testing it once under non-RPC fully covers these branches.
describeSkipIfRpc("Delegated IPNS gateway chain validation branches", () => {
    let pkc: PKC;
    let community: RemoteCommunity;
    let chainResolver: CommunityClientsManager;

    beforeAll(async () => {
        pkc = await mockPKCNoDataPathWithOnlyKuboClient({ pkcOptions: { httpRoutersOptions: [] } });
        // createCommunity (no update) gives us a CommunityClientsManager whose private
        // _resolveIpnsChainViaGateway we drive directly with a stubbed gateway fetch below.
        community = (await pkc.createCommunity({ address: "12D3KooWANwdyPERMQaCgiMnTT1t3Lr4XLFbK1z4ptFVhW2ozg1z" })) as RemoteCommunity;
        chainResolver = community._clientsManager;
    });
    afterAll(async () => {
        if (pkc) await pkc.destroy();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Builds a well-formed, validly-signed IPNS record whose name == the signing key's peer id, so
    // `ipnsValidator` accepts it. `value` is whatever the record points at (an /ipfs/, /ipns/, or
    // deliberately malformed path), letting us reach the chain walker's value branches.
    const makeSignedRecord = async (value: string) => {
        const privateKey = await generateKeyPair("Ed25519");
        const ipnsName = peerIdFromPrivateKey(privateKey).toString();
        const bytes = marshalIPNSRecord(await createIPNSRecord(privateKey, value, 0, 24 * 60 * 60 * 1000));
        return { ipnsName, bytes };
    };

    // A Response-like stub good enough for fetchAndValidateIpnsRecordFromGateway (reads status +
    // arrayBuffer). The ArrayBuffer is copied so `new Uint8Array(buf)` sees exactly the record bytes.
    const okResponse = (bytes: Uint8Array) => ({
        status: 200,
        statusText: "OK",
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
    });

    const expectChainInvalid = (e: unknown, reasonSubstring: string) => {
        const err = e as PKCError;
        expect(err.code).to.equal("ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID");
        expect(String((err.details as { reason?: string })?.reason)).to.include(reasonSubstring);
    };

    // --- fetchAndValidateIpnsRecordFromGateway (gap 2) ---

    it("rejects a non-200 gateway response", async () => {
        vi.spyOn(globalThis, "fetch").mockResolvedValue({ status: 404, statusText: "Not Found" } as Response);
        try {
            await fetchAndValidateIpnsRecordFromGateway("http://localhost:1234", "12D3KooWAnchor");
            expect.fail("should reject a non-200 ipns-record response");
        } catch (e) {
            expectChainInvalid(e, "Gateway did not return the raw IPNS record");
        }
    });

    it("remaps a fetch/network failure to ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID", async () => {
        vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
        try {
            await fetchAndValidateIpnsRecordFromGateway("http://localhost:1234", "12D3KooWAnchor");
            expect.fail("should reject when the gateway fetch fails");
        } catch (e) {
            expectChainInvalid(e, "Failed to fetch the raw IPNS record");
        }
    });

    it("rethrows an abort error unchanged (does NOT remap it to a chain-validation failure)", async () => {
        const abortError = Object.assign(new Error("the operation was aborted"), { name: "AbortError" });
        vi.spyOn(globalThis, "fetch").mockRejectedValue(abortError);
        try {
            await fetchAndValidateIpnsRecordFromGateway("http://localhost:1234", "12D3KooWAnchor");
            expect.fail("should rethrow the abort error");
        } catch (e) {
            // The very same error object is rethrown, NOT wrapped — remapping aborts would break
            // parent-driven abort logic. See util.ts.
            expect(e).to.equal(abortError);
            expect((e as PKCError).code).to.not.equal("ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID");
        }
    });

    it("rejects a record whose signature does not validate against the requested name", async () => {
        // A record validly signed by key A, but fetched under a DIFFERENT name B -> the routing key
        // derived from B does not match the record's signing key, so ipnsValidator rejects it. This
        // is the forged-record case a malicious gateway would attempt.
        const { bytes } = await makeSignedRecord("/ipfs/bafybeigdypsgdcm2ddvyh2y2gnltw3zi5iphzzwdlpie3jfxpmer7frknu");
        const { ipnsName: otherName } = await makeSignedRecord("/ipfs/bafybeigdypsgdcm2ddvyh2y2gnltw3zi5iphzzwdlpie3jfxpmer7frknu");
        vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(bytes) as Response);
        try {
            await fetchAndValidateIpnsRecordFromGateway("http://localhost:1234", otherName);
            expect.fail("should reject a record signed by the wrong key");
        } catch (e) {
            expectChainInvalid(e, "IPNS record signature validation failed");
        }
    });

    it("returns the validated record for a well-formed, correctly-signed record", async () => {
        const value = "/ipfs/bafybeigdypsgdcm2ddvyh2y2gnltw3zi5iphzzwdlpie3jfxpmer7frknu";
        const { ipnsName, bytes } = await makeSignedRecord(value);
        vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(bytes) as Response);
        const record = await fetchAndValidateIpnsRecordFromGateway("http://localhost:1234", ipnsName);
        expect(String(record.value)).to.equal(value);
    });

    // The "Failed to parse the IPNS record" branch (util.ts) is defensively unreachable from this
    // function: ipnsValidator already unmarshals the record to verify its signature, so any bytes
    // that pass validation also unmarshal. Reaching it would require mocking the `ipns` package's
    // internals (validator passes, unmarshal throws), which would defeat the point of testing the
    // real validation path. Left as a documented gap rather than a synthetic mock.
    it.skip("rejects an unparseable record (defensively unreachable: validator unmarshals first)", () => {});

    // --- _resolveIpnsChainViaGateway value branches (gap 4) ---

    const resolveChain = (gatewayUrl: string, anchorName: string) =>
        (
            chainResolver as unknown as {
                _resolveIpnsChainViaGateway: (
                    g: string,
                    n: string,
                    s?: AbortSignal
                ) => Promise<{ ipnsHops: string[]; terminalCidV0: string }>;
            }
        )._resolveIpnsChainViaGateway(gatewayUrl, anchorName);

    it("rejects a chain whose terminal /ipfs/ value is not a valid CID", async () => {
        const { ipnsName, bytes } = await makeSignedRecord("/ipfs/notacid");
        vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(bytes) as Response);
        try {
            await resolveChain("http://localhost:1234", ipnsName);
            expect.fail("should reject a terminal value that is not a valid CID");
        } catch (e) {
            expectChainInvalid(e, "not a valid CID");
        }
    });

    it("rejects a chain record whose value is neither an /ipfs/ nor an /ipns/ path", async () => {
        const { ipnsName, bytes } = await makeSignedRecord("/ipld/foo");
        vi.spyOn(globalThis, "fetch").mockResolvedValue(okResponse(bytes) as Response);
        try {
            await resolveChain("http://localhost:1234", ipnsName);
            expect.fail("should reject an unsupported record value");
        } catch (e) {
            expectChainInvalid(e, "neither an /ipfs/ nor an /ipns/ path");
        }
    });

    // --- non-retriable classification (gap 7) ---

    it("classifies the delegated-IPNS chain errors as non-retriable when loading", () => {
        const nonRetriableCodes: ConstructorParameters<typeof PKCError>[0][] = [
            "ERR_GATEWAY_IPNS_RECORD_CHAIN_INVALID",
            "ERR_IPNS_MAX_HOPS_EXCEEDED",
            "ERR_RESOLVED_IPNS_TO_UNSUPPORTED_VALUE"
        ];
        for (const code of nonRetriableCodes) {
            expect(community._isRetriableErrorWhenLoading(new PKCError(code, {})), code).to.equal(false);
        }
        // control: a transient IPNS resolution failure stays retriable, proving the check is selective.
        expect(community._isRetriableErrorWhenLoading(new PKCError("ERR_FAILED_TO_RESOLVE_IPNS_VIA_IPFS_P2P", {}))).to.equal(true);
    });
});

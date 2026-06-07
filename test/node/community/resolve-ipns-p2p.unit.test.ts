import { afterAll, afterEach, beforeAll, it, expect, vi } from "vitest";
import { mockPKCNoDataPathWithOnlyKuboClient, addStringToIpfs } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { PKCClientsManager } from "../../../dist/node/pkc/pkc-client-manager.js";

type FakeIpfsClient = ReturnType<PKCClientsManager["getIpfsClientWithKuboRpcClientFunctions"]>;

// Drives BaseClientsManager.resolveIpnsToCidP2P with a stubbed single-hop resolver. These error
// branches can't be triggered through real kubo (it only publishes /ipfs/ and /ipns/ values, and a
// 33-hop chain is too slow/flaky for an integration test), so we stub the immediate-hop resolver.
// Skipped under RPC because resolution is client-side and config-independent — the resolveIpnsToCidP2P
// method runs locally here, so testing it once under non-RPC fully covers these branches.
describeSkipIfRpc("resolveIpnsToCidP2P resolution branches", () => {
    let pkc: PKC;

    beforeAll(async () => {
        pkc = await mockPKCNoDataPathWithOnlyKuboClient({ pkcOptions: { httpRoutersOptions: [] } });
    });
    afterAll(async () => {
        if (pkc) await pkc.destroy();
    });
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // Stub the immediate-hop resolver. `all()` (it-all) accepts a plain array, so each call returns
    // the single-hop value(s) the real kubo/helia resolver would yield for `recursive: false`.
    const stubResolver = (resolve: (name: string) => string[]) => {
        const fake = { name: { resolve: (name: string) => resolve(name) } } as unknown as FakeIpfsClient;
        vi.spyOn(pkc._clientsManager, "getIpfsClientWithKuboRpcClientFunctions").mockReturnValue(fake);
    };

    it("throws ERR_RESOLVED_IPNS_TO_UNSUPPORTED_VALUE when a record resolves to a non-ipfs/non-ipns value", async () => {
        stubResolver(() => ["/ipld/foo"]);
        try {
            await pkc._clientsManager.resolveIpnsToCidP2P("12D3KooWAnchor", { timeoutMs: 5000 });
            expect.fail("should have thrown for an unsupported resolved value");
        } catch (e) {
            expect((e as { code?: string }).code).to.equal("ERR_RESOLVED_IPNS_TO_UNSUPPORTED_VALUE");
        }
    });

    it("throws ERR_IPNS_RECURSION_DEPTH_EXCEEDED when the chain never terminates in an /ipfs/ value", async () => {
        // Always resolve to another /ipns/ hop -> the walk loops until it hits the depth cap.
        stubResolver(() => ["/ipns/12D3KooWNext"]);
        try {
            await pkc._clientsManager.resolveIpnsToCidP2P("12D3KooWAnchor", { timeoutMs: 10000 });
            expect.fail("should have thrown for exceeding recursion depth");
        } catch (e) {
            const err = e as { code?: string; details?: { maxDepth?: number } };
            expect(err.code).to.equal("ERR_IPNS_RECURSION_DEPTH_EXCEEDED");
            expect(err.details?.maxDepth).to.equal(32);
        }
    });

    it("walks /ipns/ -> /ipfs/ and returns the cid with ordered ipnsHops", async () => {
        const cid = await addStringToIpfs("hello delegated world");
        let call = 0;
        stubResolver(() => (call++ === 0 ? ["/ipns/12D3KooWMinter"] : [`/ipfs/${cid}`]));

        const result = await pkc._clientsManager.resolveIpnsToCidP2P("12D3KooWAnchor", { timeoutMs: 5000 });
        expect(result.cid).to.equal(cid);
        expect(result.ipnsHops).to.deep.equal(["12D3KooWAnchor", "12D3KooWMinter"]);
    });
});

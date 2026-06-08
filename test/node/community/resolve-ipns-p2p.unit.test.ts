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
            const err = e as { code?: string; details?: { hopRole?: string; hopIndex?: number } };
            expect(err.code).to.equal("ERR_RESOLVED_IPNS_TO_UNSUPPORTED_VALUE");
            // the failing record is the anchor (hop 0), labelled so the error names which hop failed
            expect(err.details?.hopRole).to.equal("anchor");
            expect(err.details?.hopIndex).to.equal(0);
        }
    });

    it("throws ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED when a record resolves to no value", async () => {
        // The resolver yields nothing (empty array) -> the immediate-hop value is undefined.
        stubResolver(() => []);
        try {
            await pkc._clientsManager.resolveIpnsToCidP2P("12D3KooWAnchor", { timeoutMs: 5000 });
            expect.fail("should have thrown for an undefined resolved value");
        } catch (e) {
            const err = e as { code?: string; details?: { hopRole?: string; hopIndex?: number } };
            expect(err.code).to.equal("ERR_RESOLVED_IPNS_P2P_TO_UNDEFINED");
            expect(err.details?.hopRole).to.equal("anchor");
            expect(err.details?.hopIndex).to.equal(0);
        }
    });

    it("throws ERR_IPNS_MAX_HOPS_EXCEEDED when the chain never terminates in an /ipfs/ value", async () => {
        // Always resolve to another /ipns/ hop -> the walk exceeds the single-hop cap.
        stubResolver(() => ["/ipns/12D3KooWNext"]);
        try {
            await pkc._clientsManager.resolveIpnsToCidP2P("12D3KooWAnchor", { timeoutMs: 10000 });
            expect.fail("should have thrown for exceeding the max hops");
        } catch (e) {
            const err = e as { code?: string; details?: { maxHops?: number } };
            expect(err.code).to.equal("ERR_IPNS_MAX_HOPS_EXCEEDED");
            expect(err.details?.maxHops).to.equal(1);
        }
    });

    // For now we follow only a single anchor -> minter delegation hop. A legitimate finite 2-hop
    // chain (anchor -> minter -> terminal -> /ipfs/) must be rejected before reaching the /ipfs/
    // value, proving this is a deliberate hop cap and not merely non-termination detection.
    it("follows only one hop (anchor -> minter) and rejects a finite 2-hop chain", async () => {
        const cid = await addStringToIpfs("two hops is one too many");
        const chain: Record<string, string> = {
            "12D3KooWAnchor": "/ipns/12D3KooWMinter",
            "12D3KooWMinter": "/ipns/12D3KooWTerminal",
            "12D3KooWTerminal": `/ipfs/${cid}`
        };
        stubResolver((name) => [chain[name]]);
        try {
            await pkc._clientsManager.resolveIpnsToCidP2P("12D3KooWAnchor", { timeoutMs: 5000 });
            expect.fail("should reject a delegated chain longer than one hop");
        } catch (e) {
            const err = e as { code?: string; details?: { maxHops?: number; ipnsHops?: string[]; hopRole?: string; hopIndex?: number } };
            expect(err.code).to.equal("ERR_IPNS_MAX_HOPS_EXCEEDED");
            expect(err.details?.maxHops).to.equal(1);
            // the cap trips as soon as the minter record is seen to delegate further, so the
            // terminal's record is never resolved past being recorded as a hop.
            expect(err.details?.ipnsHops).to.deep.equal(["12D3KooWAnchor", "12D3KooWMinter", "12D3KooWTerminal"]);
            // the over-the-cap delegation came from the minter record (hop 1), not the anchor
            expect(err.details?.hopRole).to.equal("minter");
            expect(err.details?.hopIndex).to.equal(1);
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

import { describe, it, expect } from "vitest";
import PKCFactory from "../../../dist/node/index.js";
import { getDefaultDataPath } from "../../../dist/node/runtime/node/util.js";

// Node-only: relies on getDefaultDataPath() from the node runtime, so it must not live under
// test/node-and-browser (importing the node runtime breaks the browser leg of the suite).
describe("mockPKC respects caller-supplied transport options", () => {
    it("PKC({ pkcRpcClientsOptions, dataPath }) retains both options when caller provides both", async () => {
        // Providing both an RPC URL and a dataPath should be permissible — the resulting PKC
        // should connect to the RPC server while keeping dataPath available for any local
        // operations the caller intends. Today PKC's constructor silently drops dataPath when
        // pkcRpcClientsOptions is set (src/pkc/pkc.ts:299-301), so this assertion fails and
        // documents the bug.
        const rpcUrl = "ws://127.0.0.1:39652";
        const dataPath = getDefaultDataPath();
        const pkc = await PKCFactory({ pkcRpcClientsOptions: [rpcUrl], dataPath, httpRoutersOptions: [] });
        pkc.on("error", () => {}); // swallow async RPC errors so they don't fail the test
        try {
            expect(pkc.pkcRpcClientsOptions).to.deep.equal([rpcUrl]);
            expect(pkc.dataPath).to.equal(dataPath);
            expect(Object.keys(pkc.clients.pkcRpcClients)).to.deep.equal([rpcUrl]);
        } finally {
            await pkc.destroy();
        }
    });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Logger, { createLogger } from "@pkcprotocol/pkc-logger";
import { createRequire } from "node:module";
import PKC from "../../../dist/node/index.js";
import { mockRpcServerPKC } from "../../../dist/node/test/test-util.js";
import { createInProcessRpcServer, uniqueTmpDataPath, type PKCWsServerType } from "../../helpers/rpc-server-harness.js";
import { describeIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

// pkc.getLogs({ rpcUrl }) forwards to the server's getLogs method, which serves the server's own buffer (issue #493).
// The server runs in-process so this suite can enable its namespaces; `debug` is CJS, createRequire hands back the
// same cached instance pkc-logger logs through, and disable() returns the previous selection to restore.
interface DebugModule {
    enable: (namespaces: string) => void;
    disable: () => string;
}
const debugModule: DebugModule = createRequire(import.meta.url)("debug");

async function rejectionOf(promise: Promise<unknown>): Promise<PKCError> {
    try {
        await promise;
    } catch (e) {
        return e as PKCError;
    }
    throw Error("expected the promise to reject");
}

// Needs the in-process PKCWsServer, which is backed by a Node-side PKC pointed at the local test Kubo like every other
// in-process RPC suite here, so it runs in the RPC configs only.
describeIfRpc("pkc.getLogs({ rpcUrl }) and the getLogs RPC method (#493)", () => {
    let rpcServer: PKCWsServerType;
    let serverPKC: PKCType;
    let clientPKC: PKCType;
    let rpcUrl: string;
    let previousNamespaces: string;
    const serverRoot = createLogger({ buffer: { maxBytes: 8 * 1024 * 1024 } });

    beforeAll(async () => {
        previousNamespaces = debugModule.disable();
        debugModule.enable("pkc-js*");
        serverPKC = await mockRpcServerPKC({ dataPath: uniqueTmpDataPath("pkc-get-logs-rpc-test"), logger: { instance: serverRoot } });
        ({ rpcServer, rpcUrl } = await createInProcessRpcServer({ serverPKC, authKey: "test-get-logs-rpc" }));
        clientPKC = await PKC({ pkcRpcClientsOptions: [rpcUrl], dataPath: undefined, httpRoutersOptions: [] });
    });

    afterAll(async () => {
        if (clientPKC) await clientPKC.destroy();
        if (rpcServer) await rpcServer.destroy();
        if (serverPKC && !serverPKC.destroyed) await serverPKC.destroy();
        debugModule.enable(previousNamespaces);
    });

    it("pkcOptions.logger.instance is adopted as pkc.logger", () => {
        expect(serverPKC.logger).to.equal(serverRoot);
    });

    it("returns the server's lines of a started community, every one tagged with that publicKey", async () => {
        const community = <RpcLocalCommunity>await clientPKC.createCommunity({});
        await community.start();
        try {
            const publicKey = community.publicKey;
            expect(publicKey).to.be.a("string");

            const remote = await clientPKC.getLogs({ tags: { publicKey }, rpcUrl });
            expect(remote.entries.length).to.be.greaterThan(0);
            for (const entry of remote.entries) {
                expect(entry.tags.publicKey).to.equal(publicKey);
                expect(entry.namespace.startsWith("pkc-js:local-community")).to.equal(true);
            }
            // It is the server's buffer: the same query against the server's root returns the same lines
            const direct = serverRoot.getLogs({ tags: { publicKey } });
            expect(remote.entries.map((entry) => entry.seq)).to.deep.equal(direct.entries.map((entry) => entry.seq));
            // and these lines are not in the client's own buffer, whose community lines come from the RPC mirror
            const local = await clientPKC.getLogs({ tags: { publicKey } });
            expect(local.entries.every((entry) => entry.namespace.startsWith("pkc-js:rpc-local-community"))).to.equal(true);
        } finally {
            await community.stop();
        }
    });

    it("throws ERR_INVALID_LOG_QUERY over RPC for an invalid regex", async () => {
        const error = await rejectionOf(clientPKC.getLogs({ regex: { source: "(" }, rpcUrl }));
        expect(error.code).to.equal("ERR_INVALID_LOG_QUERY");
    });

    it("the server rejects an rpcUrl in its params, so a call is never chained to a third daemon", async () => {
        const error = await rejectionOf(clientPKC._pkcRpcClient!.rpcCall("getLogs", [{ rpcUrl: "ws://127.0.0.1:1/third" }]));
        expect(error.code).to.equal("ERR_INVALID_LOG_QUERY");
    });

    it("throws ERR_PKC_NOT_CONNECTED_TO_RPC for an rpcUrl this instance is not configured with", async () => {
        const error = await rejectionOf(clientPKC.getLogs({ rpcUrl: "ws://127.0.0.1:1/other-daemon" }));
        expect(error.code).to.equal("ERR_PKC_NOT_CONNECTED_TO_RPC");
        expect(error.details.pkcRpcClientsOptions).to.deep.equal([rpcUrl]);
    });

    it("the RPC server keeps its root across setSettings, so the buffer survives the pkc swap", async () => {
        const before = serverRoot.getLogs({ limit: 1 }).entries[0];
        expect(before).to.not.equal(undefined);
        await clientPKC._pkcRpcClient!.rpcCall("setSettings", [
            { pkcOptions: { ...serverPKC.parsedPKCOptions, updateInterval: serverPKC.updateInterval + 1 } }
        ]);
        const swapped = (rpcServer as unknown as { pkc: PKCType }).pkc;
        expect(swapped).to.not.equal(serverPKC);
        expect(swapped.logger).to.equal(serverRoot);
        expect(serverRoot.getLogs({ limit: 1 }).entries[0]).to.deep.equal(before);
        serverPKC = swapped; // afterAll destroys the live one
    });
});

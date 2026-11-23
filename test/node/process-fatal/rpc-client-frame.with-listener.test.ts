// A broken RPC server must not be able to end the client process (finding 1): one non-JSON frame, pkc error listener: with-listener
import { describe, it, expect } from "vitest";
import PKC from "../../../dist/node/index.js";
import { captureProcessFatalErrors, letDetachedWorkSettle } from "../../helpers/process-fatal.js";
import { startFrameSendingServer } from "../../helpers/fake-rpc-server.js";

describe("RPC client survives a non-JSON frame, with-listener", () => {
    it("raises no uncaught exception or unhandled rejection", async () => {
        const server = await startFrameSendingServer("this is not json");
        const capture = captureProcessFatalErrors();
        const pkc = await PKC({ pkcRpcClientsOptions: [server.url], dataPath: undefined, httpRoutersOptions: [] });
        pkc.on("error", () => {});
        await letDetachedWorkSettle(800);
        capture.stop();
        await pkc.destroy();
        await server.close();
        expect(capture.fatals).toEqual([]);
    });
});

// With no error listener, a non-JSON frame from the server still stops the process, by design (README: listen for
// "error"), but through the documented route: a PKCError the client reports, not a raw SyntaxError from JSON.parse.
import { describe, it, expect } from "vitest";
import PKC from "../../../dist/node/index.js";
import { captureProcessFatalErrors, letDetachedWorkSettle } from "../../helpers/process-fatal.js";
import { startFrameSendingServer } from "../../helpers/fake-rpc-server.js";

describe("RPC client survives a non-JSON frame, no-listener", () => {
    it("reports the frame as a client error, not as a raw parse failure", async () => {
        const server = await startFrameSendingServer("this is not json");
        const capture = captureProcessFatalErrors();
        const pkc = await PKC({ pkcRpcClientsOptions: [server.url], dataPath: undefined, httpRoutersOptions: [] });
        
        await letDetachedWorkSettle(800);
        capture.stop();
        await pkc.destroy();
        await server.close();
        expect(capture.fatals.map((f) => f.code)).toContain("ERR_RPC_CLIENT_FAILED_TO_HANDLE_SERVER_MESSAGE");
        expect(capture.fatals.map((f) => f.message)).not.toContain(expect.stringContaining("is not valid JSON"));
    });
});

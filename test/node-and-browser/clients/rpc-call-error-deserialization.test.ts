// A server-side PKCError rejecting a JSON-RPC request/response call must reach the caller as a
// PKCError instance, exactly like subscription "error" notifications do (which already go through
// _deserializeRpcError). Before the fix, the monkey-patched _webSocketClient.call only decorated
// the raw JSON-RPC error object with rpcArgs/rpcServerUrl, so every call-path rejection was a
// plain object and `instanceof PKCError` checks on it always failed.
//
// These tests need a live RPC server, so they only run under the remote-pkc-rpc config
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { describeIfRpc } from "../../helpers/conditional-tests.js";
import { mockRpcRemotePKC } from "../../../dist/node/test/test-util.js";
import { PKCError } from "../../../dist/node/pkc-error.js";
import { messages } from "../../../dist/node/errors.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";

describeIfRpc("rpc call error deserialization", () => {
    let pkc: PKC;
    beforeAll(async () => {
        pkc = await mockRpcRemotePKC();
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    it("a server-side PKCError rejects the call as a PKCError instance with its code, message and details", async () => {
        try {
            // the server rejects this with ERR_INVALID_COMMUNITY_LIST_SCHEMA before touching IPFS
            await pkc._pkcRpcClient!.publishCommunityList({ communityListRawString: JSON.stringify({ not: "a CommunityList" }) });
            expect.fail("should have thrown");
        } catch (e) {
            const err = <PKCError>e;
            expect(err).to.be.instanceOf(PKCError);
            expect(err.code).to.equal("ERR_INVALID_COMMUNITY_LIST_SCHEMA");
            expect(err.message).to.equal(messages.ERR_INVALID_COMMUNITY_LIST_SCHEMA);
            // the local decoration must survive deserialization
            expect((<{ rpcArgs?: unknown }>err.details).rpcArgs).to.be.an("array");
            expect((<{ rpcServerUrl?: unknown }>err.details).rpcServerUrl).to.be.a("string");
        }
    });
});

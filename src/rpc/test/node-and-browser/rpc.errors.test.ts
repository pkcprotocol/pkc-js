import { describe, it, expect } from "vitest";
import PKCRpcClient from "../../../../dist/node/clients/rpc-client/pkc-rpc-client.js";
import { PKCError } from "../../../../dist/node/pkc-error.js";
import { messages } from "../../../../dist/node/errors.js";
import { sanitizeRpcNotificationResult } from "../../../../dist/node/rpc/src/json-rpc-util.js";

type RpcClientWithDeserialize = {
    _deserializeRpcError: (error: unknown) => Error & { code?: string; details?: unknown; metadata?: unknown };
};

describe("RPC error (de)serialization helpers", () => {
    describe("_deserializeRpcError", () => {
        it("returns a populated PKCError when the payload contains a known error code", () => {
            const client = new PKCRpcClient("ws://localhost:0");
            const details = { rpcArgs: ["startCommunity"], newStartedState: "failed" };
            const serializedError = {
                name: "PKCError",
                code: "ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC" as const,
                message: "RPC is down",
                details,
                stack: "stack to remove",
                extra: "metadata"
            };

            const deserialized = (client as unknown as RpcClientWithDeserialize)._deserializeRpcError(serializedError);

            expect(deserialized).to.be.instanceOf(PKCError);
            expect(deserialized.code).to.equal(serializedError.code);
            expect(deserialized.message).to.equal(messages[serializedError.code] as string);
            expect(deserialized.details).to.deep.equal(details);
            expect((deserialized as PKCError & { extra?: string }).extra).to.equal("metadata");
        });

        it("returns a PKCError when the payload is tagged as PKCError but has an unknown code", () => {
            const client = new PKCRpcClient("ws://localhost:0");
            const serializedError = {
                name: "PKCError",
                code: "ERR_SERVER_ONLY_CODE",
                message: "Server introduced a newer error",
                details: { foo: "bar" },
                metadata: { remoteVersion: "2.0.0" }
            };

            const deserialized = (client as unknown as RpcClientWithDeserialize)._deserializeRpcError(serializedError);

            expect(deserialized).to.be.instanceOf(PKCError);
            expect(deserialized.code).to.equal(serializedError.code);
            expect(deserialized.message).to.equal(serializedError.message);
            expect(deserialized.details).to.deep.equal(serializedError.details);
            expect(deserialized.metadata).to.deep.equal(serializedError.metadata);
        });

        it("returns a plain Error when the payload is not tagged as PKCError and has an unknown code", () => {
            const client = new PKCRpcClient("ws://localhost:0");
            const serializedError = {
                name: "Error",
                code: "ERR_UNKNOWN_RPC",
                message: "Unknown RPC error",
                details: { foo: "bar" }
            };

            const deserialized = (client as unknown as RpcClientWithDeserialize)._deserializeRpcError(serializedError);

            expect(deserialized).to.be.instanceOf(Error);
            expect(deserialized).to.not.be.instanceOf(PKCError);
            expect(deserialized.message).to.equal(serializedError.message);
            expect(deserialized.code).to.equal(serializedError.code);
            expect(deserialized.details).to.deep.equal(serializedError.details);
        });

        it("preserves the message of a plain Error after server-side serialization", () => {
            // Plain Error properties are non-enumerable, so JSON.stringify loses them.
            // The server must extract message/name into a plain object before throwing.
            const originalError = new Error("Failed to resolve community address to an IPNS name");
            (originalError as any).details = { ipnsPubsubTopic: undefined };

            // Simulate the server-side serialization (the fix in rpcWebsocketsRegister)
            const errorJson: Record<string, unknown> = {
                message: originalError.message,
                name: originalError.name
            };
            if ("details" in originalError) errorJson.details = (originalError as any).details;
            if ("code" in originalError) errorJson.code = (originalError as any).code;

            const client = new PKCRpcClient("ws://localhost:0");
            const deserialized = (client as unknown as RpcClientWithDeserialize)._deserializeRpcError(errorJson);

            expect(deserialized).to.be.instanceOf(Error);
            expect(deserialized).to.not.be.instanceOf(PKCError);
            expect(deserialized.message).to.equal("Failed to resolve community address to an IPNS name");
            expect(deserialized.details).to.deep.equal({ ipnsPubsubTopic: undefined });
        });

        it("loses the message when a plain Error is JSON.stringified directly (documents the bug)", () => {
            // This test documents WHY the server-side fix is needed:
            // JSON.stringify(new Error("msg")) produces "{}" because message/name are non-enumerable.
            const error = new Error("important message");
            const roundTripped = JSON.parse(JSON.stringify(error));

            // Without the fix, the client would receive this empty object
            expect(roundTripped.message).to.be.undefined;
            expect(roundTripped.name).to.be.undefined;

            const client = new PKCRpcClient("ws://localhost:0");
            const deserialized = (client as unknown as RpcClientWithDeserialize)._deserializeRpcError(roundTripped);

            // The client falls back to the generic message
            expect(deserialized.message).to.equal("RPC server returned an unknown error");
        });

        it("returns a generic Error when payload is malformed", () => {
            const client = new PKCRpcClient("ws://localhost:0");

            const deserialized = (client as unknown as RpcClientWithDeserialize)._deserializeRpcError("not-an-object");

            expect(deserialized).to.be.instanceOf(Error);
            expect(deserialized.message).to.equal("Received malformed RPC error payload");
            expect(deserialized.details).to.deep.equal({ rawError: "not-an-object" });
        });
    });

    describe("circular error serialization", () => {
        it("crashes with circular structure when using plain JSON.stringify (documents the bug)", () => {
            const error = new PKCError("ERR_FAILED_TO_IMPORT_CHALLENGE_FILE_FACTORY", {
                path: "/path/to/nonexistent/challenge.js"
            });
            // Simulate what challenges/index.ts:375 does: error.details.error = error
            error.details.error = error;

            expect(() => JSON.stringify(error)).to.throw("Converting circular structure to JSON");
        });

        it("does not crash when serializing a PKCError with circular details.error using a circular-safe replacer", () => {
            const error = new PKCError("ERR_FAILED_TO_IMPORT_CHALLENGE_FILE_FACTORY", {
                path: "/path/to/nonexistent/challenge.js"
            });
            error.details.error = error; // circular self-reference

            // This is what the fixed rpcWebsocketsRegister should do
            const seen = new WeakSet();
            const errorJson = JSON.parse(
                JSON.stringify(error, (_key, value) => {
                    if (typeof value === "object" && value !== null) {
                        if (seen.has(value)) return undefined;
                        seen.add(value);
                    }
                    return value;
                })
            );

            expect(errorJson.code).to.equal("ERR_FAILED_TO_IMPORT_CHALLENGE_FILE_FACTORY");
            expect(errorJson.details.path).to.equal("/path/to/nonexistent/challenge.js");
            // The circular reference is broken — details.error is serialized but its
            // own details (which would recurse) are stripped by the WeakSet guard
            expect(errorJson.details.error).to.be.an("object");
            expect(errorJson.details.error.code).to.equal("ERR_FAILED_TO_IMPORT_CHALLENGE_FILE_FACTORY");
        });
    });

    describe("sanitizeRpcNotificationResult", () => {
        it("strips stack traces for error notifications without mutating the original payload", () => {
            const errorPayload = {
                name: "PKCError",
                code: "ERR_COMMUNITY_ALREADY_STARTED",
                message: messages.ERR_COMMUNITY_ALREADY_STARTED,
                stack: "top-level stack",
                details: {
                    newStartedState: "failed",
                    error: { stack: "nested stack", reason: "boom" }
                }
            };

            const sanitized = sanitizeRpcNotificationResult("error", errorPayload);

            expect(sanitized).to.not.equal(errorPayload);
            expect(sanitized.stack).to.be.undefined;
            expect(sanitized.details.error.stack).to.be.undefined;
            expect(sanitized.details.error.reason).to.equal("boom");
            expect(sanitized.details.newStartedState).to.equal("failed");
            // original payload remains untouched
            expect(errorPayload.stack).to.equal("top-level stack");
            expect(errorPayload.details.error.stack).to.equal("nested stack");
        });

        it("returns the original payload reference for non-error events", () => {
            const notificationPayload = {
                stack: "keep me",
                details: { error: { stack: "keep me too" } }
            };

            const sanitized = sanitizeRpcNotificationResult("update", notificationPayload);

            expect(sanitized).to.equal(notificationPayload);
            expect(sanitized.stack).to.equal("keep me");
            expect(sanitized.details.error.stack).to.equal("keep me too");
        });
    });
});

import { describe, it } from "vitest";
import PlebbitRpcClient from "../../../../dist/node/clients/rpc-client/plebbit-rpc-client.js";
import { PlebbitError } from "../../../../dist/node/plebbit-error.js";
import { messages } from "../../../../dist/node/errors.js";
import { sanitizeRpcNotificationResult } from "../../../../dist/node/rpc/src/json-rpc-util.js";

type RpcClientWithDeserialize = {
    _deserializeRpcError: (error: unknown) => Error & { code?: string; details?: unknown; metadata?: unknown };
};

describe("RPC error (de)serialization helpers", () => {
    describe("_deserializeRpcError", () => {
        it("returns a populated PlebbitError when the payload contains a known error code", () => {
            const client = new PlebbitRpcClient("ws://localhost:0");
            const details = { rpcArgs: ["startSubplebbit"], newStartedState: "failed" };
            const serializedError = {
                name: "PlebbitError",
                code: "ERR_FAILED_TO_OPEN_CONNECTION_TO_RPC" as const,
                message: "RPC is down",
                details,
                stack: "stack to remove",
                extra: "metadata"
            };

            const deserialized = (client as unknown as RpcClientWithDeserialize)._deserializeRpcError(serializedError);

            expect(deserialized).to.be.instanceOf(PlebbitError);
            expect(deserialized.code).to.equal(serializedError.code);
            expect(deserialized.message).to.equal(messages[serializedError.code] as string);
            expect(deserialized.details).to.deep.equal(details);
            expect((deserialized as PlebbitError & { extra?: string }).extra).to.equal("metadata");
        });

        it("returns a PlebbitError when the payload is tagged as PlebbitError but has an unknown code", () => {
            const client = new PlebbitRpcClient("ws://localhost:0");
            const serializedError = {
                name: "PlebbitError",
                code: "ERR_SERVER_ONLY_CODE",
                message: "Server introduced a newer error",
                details: { foo: "bar" },
                metadata: { remoteVersion: "2.0.0" }
            };

            const deserialized = (client as unknown as RpcClientWithDeserialize)._deserializeRpcError(serializedError);

            expect(deserialized).to.be.instanceOf(PlebbitError);
            expect(deserialized.code).to.equal(serializedError.code);
            expect(deserialized.message).to.equal(serializedError.message);
            expect(deserialized.details).to.deep.equal(serializedError.details);
            expect(deserialized.metadata).to.deep.equal(serializedError.metadata);
        });

        it("returns a plain Error when the payload is not tagged as PlebbitError and has an unknown code", () => {
            const client = new PlebbitRpcClient("ws://localhost:0");
            const serializedError = {
                name: "Error",
                code: "ERR_UNKNOWN_RPC",
                message: "Unknown RPC error",
                details: { foo: "bar" }
            };

            const deserialized = (client as unknown as RpcClientWithDeserialize)._deserializeRpcError(serializedError);

            expect(deserialized).to.be.instanceOf(Error);
            expect(deserialized).to.not.be.instanceOf(PlebbitError);
            expect(deserialized.message).to.equal(serializedError.message);
            expect(deserialized.code).to.equal(serializedError.code);
            expect(deserialized.details).to.deep.equal(serializedError.details);
        });

        it("returns a generic Error when payload is malformed", () => {
            const client = new PlebbitRpcClient("ws://localhost:0");

            const deserialized = (client as unknown as RpcClientWithDeserialize)._deserializeRpcError("not-an-object");

            expect(deserialized).to.be.instanceOf(Error);
            expect(deserialized.message).to.equal("Received malformed RPC error payload");
            expect(deserialized.details).to.deep.equal({ rawError: "not-an-object" });
        });
    });

    describe("sanitizeRpcNotificationResult", () => {
        it("strips stack traces for error notifications without mutating the original payload", () => {
            const errorPayload = {
                name: "PlebbitError",
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

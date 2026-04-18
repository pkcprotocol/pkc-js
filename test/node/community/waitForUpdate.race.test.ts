import { EventEmitter } from "events";
import { describe, it, expect } from "vitest";
import { waitForUpdateInCommunityInstanceWithErrorAndTimeout } from "../../../dist/node/util.js";
import { PKCError } from "../../../dist/node/pkc-error.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

describe("waitForUpdateInCommunityInstanceWithErrorAndTimeout - race condition", () => {
    it("throws promptly when error fires synchronously during community.update()", async () => {
        // Regression test for CI flake: under RPC, emitAllPendingMessages() replays
        // a buffered error event synchronously during community.update(), BEFORE
        // the Promise.race's once("error") listener is set up. Without the fix,
        // the error is captured in updateError but the Promise.race never resolves,
        // causing the function to hang until the full timeout expires.
        const mockCommunity = new EventEmitter() as EventEmitter & Partial<RemoteCommunity>;
        (mockCommunity as any).state = "stopped";
        (mockCommunity as any).raw = { communityIpfs: undefined };
        (mockCommunity as any)._pkc = { _updatingCommunities: {} };
        (mockCommunity as any).publicKey = "12D3KooWTest";
        (mockCommunity as any).address = "12D3KooWTest";
        (mockCommunity as any).update = async () => {
            (mockCommunity as any).state = "updating";
            // Simulate the RPC path: error fires synchronously during update
            // (from emitAllPendingMessages replaying buffered WebSocket events)
            mockCommunity.emit("error", new PKCError("ERR_INVALID_JSON", { test: true }));
        };
        (mockCommunity as any).stop = async () => {
            (mockCommunity as any).state = "stopped";
        };

        // Use a 5s timeout — without the fix this would hang for 5s then throw a timeout error.
        // With the fix it should throw ERR_INVALID_JSON almost immediately.
        const start = Date.now();
        await expect(
            waitForUpdateInCommunityInstanceWithErrorAndTimeout(mockCommunity as unknown as RemoteCommunity, 5000)
        ).rejects.toThrow("The loaded file is not the expected json");
        const elapsed = Date.now() - start;
        // Should resolve in well under 1s, not wait for the 5s timeout
        expect(elapsed).toBeLessThan(1000);
    });

    it("does not throw on retriable errors, waits for update", async () => {
        // When the retry loop emits a retriable error (e.g. transient IPNS timeout),
        // waitForUpdate should NOT throw — it should wait for the retry to succeed.
        const mockCommunity = new EventEmitter() as EventEmitter & Partial<RemoteCommunity>;
        (mockCommunity as any).state = "stopped";
        (mockCommunity as any).raw = { communityIpfs: undefined };
        (mockCommunity as any)._pkc = { _updatingCommunities: {} };
        (mockCommunity as any).publicKey = "12D3KooWTest";
        (mockCommunity as any).address = "12D3KooWTest";
        (mockCommunity as any).update = async () => {
            (mockCommunity as any).state = "updating";
            // Emit a retriable error (like a transient IPNS resolution failure)
            const retriableErr = new PKCError("ERR_FAILED_TO_RESOLVE_IPNS_VIA_IPFS_P2P", {
                retriableError: true
            });
            mockCommunity.emit("error", retriableErr);
            // Shortly after, the retry succeeds and emits update
            setTimeout(() => {
                (mockCommunity as any).raw = { communityIpfs: { updatedAt: 123 } };
                mockCommunity.emit("update", mockCommunity);
            }, 50);
        };
        (mockCommunity as any).stop = async () => {
            (mockCommunity as any).state = "stopped";
        };

        // Should NOT throw — the retriable error is ignored, waits for the update event
        await waitForUpdateInCommunityInstanceWithErrorAndTimeout(mockCommunity as unknown as RemoteCommunity, 5000);
    });

    it("throws last retriable error on timeout when no non-retriable error occurs", async () => {
        // When only retriable errors fire and the timeout expires, the last retriable
        // error should be thrown (not a generic ERR_GET_COMMUNITY_TIMED_OUT) since
        // it's more informative about what actually went wrong.
        const mockCommunity = new EventEmitter() as EventEmitter & Partial<RemoteCommunity>;
        (mockCommunity as any).state = "stopped";
        (mockCommunity as any).raw = { communityIpfs: undefined };
        (mockCommunity as any)._pkc = { _updatingCommunities: {} };
        (mockCommunity as any).publicKey = "12D3KooWTest";
        (mockCommunity as any).address = "12D3KooWTest";
        (mockCommunity as any).update = async () => {
            (mockCommunity as any).state = "updating";
            // Emit retriable errors but never succeed
            const retriableErr = new PKCError("ERR_FAILED_TO_RESOLVE_IPNS_VIA_IPFS_P2P", {
                retriableError: true
            });
            mockCommunity.emit("error", retriableErr);
        };
        (mockCommunity as any).stop = async () => {
            (mockCommunity as any).state = "stopped";
        };

        // Should throw the retriable error (not ERR_GET_COMMUNITY_TIMED_OUT)
        await expect(waitForUpdateInCommunityInstanceWithErrorAndTimeout(mockCommunity as unknown as RemoteCommunity, 200)).rejects.toThrow(
            "Failed to resolve IPNS through IPFS P2P"
        );
    });
});

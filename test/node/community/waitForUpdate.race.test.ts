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
});

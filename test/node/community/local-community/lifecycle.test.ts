// Unit tests for src/runtime/node/community/local-community/lifecycle.ts.
// start / stop / update / delete orchestrate the whole community lifecycle (DB lock,
// IPFS sign+pin, pubsub subscribe, registry tracking, mirroring) and are covered
// in depth by the integration suite under test/node/community/ (create, edit,
// delete, error.start, mirror-client-mismatch, etc.).
// Unit tests here cover just the pieces that don't need a running kubo:
//   - cleanUpMirroredStartedOrUpdatingCommunity early-return when nothing is mirrored
//   - export shape for the orchestrators

import { describe, it, expect } from "vitest";
import {
    cleanUpMirroredStartedOrUpdatingCommunity,
    deleteCommunity,
    initBeforeStarting,
    initMirroringStartedOrUpdatingCommunity,
    publishLoop,
    start,
    stop,
    update,
    updateLoop,
    updateOnce
} from "../../../../dist/node/runtime/node/community/local-community/lifecycle.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";

describe("lifecycle: export shape", () => {
    it("exports all lifecycle helpers", () => {
        expect(typeof cleanUpMirroredStartedOrUpdatingCommunity).to.equal("function");
        expect(typeof deleteCommunity).to.equal("function");
        expect(typeof initBeforeStarting).to.equal("function");
        expect(typeof initMirroringStartedOrUpdatingCommunity).to.equal("function");
        expect(typeof publishLoop).to.equal("function");
        expect(typeof start).to.equal("function");
        expect(typeof stop).to.equal("function");
        expect(typeof update).to.equal("function");
        expect(typeof updateLoop).to.equal("function");
        expect(typeof updateOnce).to.equal("function");
    });
});

describe("lifecycle: cleanUpMirroredStartedOrUpdatingCommunity", () => {
    it("returns immediately when no community is currently being mirrored", async () => {
        const community = {
            _mirroredStartedOrUpdatingCommunity: undefined,
            clients: {}
        } as unknown as LocalCommunity;

        // Should not throw and should leave the field undefined.
        await cleanUpMirroredStartedOrUpdatingCommunity(community);
        expect(community._mirroredStartedOrUpdatingCommunity).to.equal(undefined);
    });
});

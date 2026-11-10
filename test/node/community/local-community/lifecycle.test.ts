// Unit tests for src/runtime/node/community/local-community/lifecycle.ts.
// start / stop / update / delete orchestrate the whole community lifecycle (DB lock,
// IPFS sign+pin, pubsub subscribe, registry tracking, mirroring) and are covered
// in depth by the integration suite under test/node/community/ (create, edit,
// delete, error.start, mirror-client-mismatch, etc.).
// Unit tests here cover just the pieces that don't need a running kubo:
//   - cleanUpMirroredStartedOrUpdatingCommunity early-return when nothing is mirrored
//   - stopAfterLosingStartLock stopping the community whether or not anyone listens for its error
//   - export shape for the orchestrators

import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import {
    cleanUpMirroredStartedOrUpdatingCommunity,
    deleteCommunity,
    initBeforeStarting,
    initMirroringStartedOrUpdatingCommunity,
    publishLoop,
    start,
    stop,
    stopAfterLosingStartLock,
    update,
    updateLoop,
    updateOnce
} from "../../../../dist/node/runtime/node/community/local-community/lifecycle.js";
import { PKCError } from "../../../../dist/node/pkc-error.js";
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

// The lock library calls this from its refresh timer once this process has lost a started community's start lock (another
// process took it over). Two processes must not run one community, so it has to stop whatever happens to the error it
// reports: an owner that listens for "error" neither on the community nor on its PKC makes emit("error") throw.
describe("lifecycle: stopAfterLosingStartLock", () => {
    function createStartedCommunity() {
        const stopMock = vi.fn(async () => {});
        const community = Object.assign(new EventEmitter(), {
            address: "12D3KooWStopAfterLosingStartLock",
            state: "started",
            _stopHasBeenCalled: false,
            stop: stopMock
        }) as unknown as LocalCommunity;
        const error = new PKCError("ERR_COMMUNITY_START_LOCK_COMPROMISED", { communityAddress: community.address });
        return { community, stopMock, error };
    }

    it("stops the community even when nobody listens for its error, and still raises that error", () => {
        const { community, stopMock, error } = createStartedCommunity();

        expect(() => stopAfterLosingStartLock(community, error)).toThrow(error.message);
        expect(stopMock).toHaveBeenCalledTimes(1);
    });

    it("stops the community before its error listeners run", () => {
        const { community, stopMock, error } = createStartedCommunity();
        const stopCallsSeenByListener: number[] = [];
        community.on("error", () => void stopCallsSeenByListener.push(stopMock.mock.calls.length));

        stopAfterLosingStartLock(community, error);

        expect(stopCallsSeenByListener).to.deep.equal([1]);
        expect(stopMock).toHaveBeenCalledTimes(1);
    });

    it("does nothing for a community that is already stopping", () => {
        const { community, stopMock, error } = createStartedCommunity();
        const errorListener = vi.fn();
        community.on("error", errorListener);
        community._stopHasBeenCalled = true;

        stopAfterLosingStartLock(community, error);

        expect(stopMock).not.toHaveBeenCalled();
        expect(errorListener).not.toHaveBeenCalled();
    });
});

// Unit tests for src/runtime/node/community/local-community/lifecycle.ts.
// start / stop / update / delete orchestrate the whole community lifecycle (DB lock,
// IPFS sign+pin, pubsub subscribe, registry tracking, mirroring) and are covered
// in depth by the integration suite under test/node/community/ (create, edit,
// delete, error.start, mirror-client-mismatch, etc.).
// Unit tests here cover just the pieces that don't need a running kubo:
//   - cleanUpMirroredStartedOrUpdatingCommunity early-return when nothing is mirrored
//   - stopAfterLosingStartLock stopping the community whether or not anyone listens for its error
//   - publishLoop and stop skipping every write once the start lock is lost, also when a start() is refused during that stop
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

// Once the start lock is lost, the process that took it may be running the community already. The stop that follows must
// not publish, write the DB or unpin on the way down, or the two processes still write the same community. Here an edit
// is pending, which an ordinary stop publishes before it returns, and a stale cid is queued for unpinning.
describe("lifecycle: stopping a community that lost its start lock", () => {
    function createCommunityThatLostItsStartLock() {
        const address = "12D3KooWStopAfterLosingStartLock";
        const listenToIncomingRequests = vi.fn(async () => {
            throw new Error("a publish cycle ran");
        });
        const pinRm = vi.fn(async () => {});
        const kuboRpcClient = { url: "http://127.0.0.1:15001/api/v0", _client: { pin: { rm: pinRm } } };
        const dbHandler = {
            initDbIfNeeded: vi.fn(async () => {}),
            lockCommunityState: vi.fn(async () => {}),
            unlockCommunityState: vi.fn(async () => {}),
            keyvSet: vi.fn(async () => {}),
            unlockCommunityStart: vi.fn(async () => {}),
            rollbackAllTransactions: vi.fn(async () => {}),
            destoryConnection: vi.fn(),
            queryLatestPostCid: (): { cid: string } | undefined => undefined,
            queryLatestCommentCid: (): { cid: string } | undefined => undefined
        };
        const toJSONInternalBeforeFirstUpdate = vi.fn(() => ({ address }));
        const pubsubUnsubscribe = vi.fn(async () => {});
        const setState = vi.fn();
        const community = Object.assign(new EventEmitter(), {
            address,
            signer: { address },
            state: "started",
            updatedAt: Math.round(Date.now() / 1000),
            _startLockLost: true,
            _stopHasBeenCalled: false,
            _pendingEditProps: [{ editId: "pending-edit" }],
            _cidsToUnPin: new Set(["QmStaleCidQueuedForUnpinning"]),
            _blocksToRm: [],
            _communityUpdateTrigger: false,
            _updateTriggerGeneration: 0,
            _subscribedChallengePubsubTopic: address,
            _inFlightPublicationExchanges: new Map(),
            _pkc: { _startedCommunities: { untrack: vi.fn() } },
            _dbHandler: dbHandler,
            _clientsManager: {
                getDefaultKuboRpcClient: () => kuboRpcClient,
                pubsubUnsubscribe,
                updateKuboRpcState: vi.fn(),
                updateKuboRpcPubsubStateIfProviderExists: vi.fn()
            },
            posts: { _stop: vi.fn() },
            handleChallengeExchange: () => {},
            toJSONInternalBeforeFirstUpdate,
            _listenToIncomingRequests: listenToIncomingRequests,
            _setStartedStateWithEmission: vi.fn(),
            _updateStartedValue: vi.fn(async () => {}),
            _setState: setState
        }) as unknown as LocalCommunity;
        const errorListener = vi.fn();
        community.on("error", errorListener);
        return {
            community,
            listenToIncomingRequests,
            pinRm,
            dbHandler,
            toJSONInternalBeforeFirstUpdate,
            pubsubUnsubscribe,
            setState,
            errorListener
        };
    }

    it("the publish loop runs no further cycle, even with an edit pending", async () => {
        const { community, listenToIncomingRequests, errorListener } = createCommunityThatLostItsStartLock();
        community._stopHasBeenCalled = true;

        await publishLoop(community, 60000);

        expect(listenToIncomingRequests).not.toHaveBeenCalled();
        expect(errorListener).not.toHaveBeenCalled();
    });

    it("stop() tears the community down without writing its internal state, unpinning, or unlocking a lock it lost", async () => {
        const { community, pinRm, dbHandler, toJSONInternalBeforeFirstUpdate, pubsubUnsubscribe, setState } =
            createCommunityThatLostItsStartLock();

        await stop(community);

        expect(toJSONInternalBeforeFirstUpdate).not.toHaveBeenCalled();
        expect(dbHandler.keyvSet).not.toHaveBeenCalled();
        expect(pinRm).not.toHaveBeenCalled();
        expect([...community._cidsToUnPin]).to.deep.equal(["QmStaleCidQueuedForUnpinning"]);
        expect(dbHandler.unlockCommunityStart).not.toHaveBeenCalled();
        // the rest of the teardown still runs
        expect(pubsubUnsubscribe).toHaveBeenCalled();
        expect(dbHandler.destoryConnection).toHaveBeenCalledTimes(1);
        expect(setState).toHaveBeenLastCalledWith("stopped");
    });

    // An owner that restarts a community on its error event calls start() while the stop after a lost lock still runs. That
    // start() is refused (the community is still started), and it must not turn the stop's writes back on on its way out.
    it("a start() refused while that stop runs leaves the stop skipping its writes", async () => {
        const { community, pinRm, dbHandler, toJSONInternalBeforeFirstUpdate, errorListener } = createCommunityThatLostItsStartLock();
        let stopPromise: Promise<void> | undefined;
        let startPromise: Promise<void> | undefined;
        Object.assign(community, {
            started: true,
            stop: vi.fn(() => (stopPromise = stop(community))),
            initDbHandlerIfNeeded: vi.fn(async () => {})
        });
        Object.assign(community._clientsManager, { getDefaultKuboRpcClientOrHelia: () => ({}) });
        errorListener.mockImplementation(() => void (startPromise = start(community)));

        stopAfterLosingStartLock(community, new PKCError("ERR_COMMUNITY_START_LOCK_COMPROMISED", { communityAddress: community.address }));
        await expect(startPromise).rejects.toMatchObject({ code: "ERR_COMMUNITY_ALREADY_STARTED" });
        await stopPromise;

        expect(toJSONInternalBeforeFirstUpdate).not.toHaveBeenCalled();
        expect(dbHandler.keyvSet).not.toHaveBeenCalled();
        expect(pinRm).not.toHaveBeenCalled();
        expect(dbHandler.unlockCommunityStart).not.toHaveBeenCalled();
        expect(community._startLockLost).to.equal(true);
    });
});

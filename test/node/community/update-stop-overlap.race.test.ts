import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { clone } from "remeda";
import signers from "../../fixtures/signers.js";
import communityRecordFixture from "../../fixtures/signatures/community/valid_community_ipfs_new_format.json" with { type: "json" };
import { mockPKCV2 } from "../../../dist/node/test/test-util.js";
import { CommunityClientsManager } from "../../../dist/node/community/community-client-manager.js";
import { listUpdatingCommunities, trackUpdatingCommunity } from "../../../dist/node/pkc/tracked-instance-registry-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { CommunityIpfsType } from "../../../dist/node/community/types.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

// A construction-time warm start sets this when the tracked instance it copied from had migrated to another key. The
// tests set it directly, which is what the warm start leaves behind.
type KeyMigration = { previousPublicKey: string; newPublicKey: string };
const setPendingWarmStartKeyMigration = (community: RemoteCommunity, migration: KeyMigration) => {
    (community as unknown as { _pendingWarmStartKeyMigration?: KeyMigration })._pendingWarmStartKeyMigration = migration;
};

// Records the events a community emits after the first stop() a listener of the test calls
const eventsAfterStop = (community: RemoteCommunity) => {
    const events: string[] = [];
    let stopped = false;
    let stopPromise: Promise<void> | undefined;
    community.on("update", () => stopped && events.push("update"));
    community.on("error", () => stopped && events.push("error"));
    return {
        events,
        stop: () => {
            if (stopped) return;
            stopped = true;
            stopPromise = community.stop();
        },
        stopped: () => stopPromise
    };
};

// RemoteCommunity.update() and stop() overlapping on the same instance. stop() only reports "stopped" once its
// cleanup finishes, and update() awaits pkc.createCommunity() when no updating instance is tracked yet, so either call
// can land while the other is suspended:
// - stop() while update() awaits createCommunity(): update() used to resume and track, mirror and start the shared
//   instance anyway, leaving a "stopped" community attached to a live update loop.
// - update() while an un-awaited stop() is cleaning up: update() saw "updating" and returned, then stop() finished,
//   so the community ended stopped although update() was the last call.
// - update() that rejects before attaching: the state stayed "updating" with nothing running, and every later
//   update() returned early.
// The interleavings are deterministic: each second call is made synchronously while the first is suspended.

// Skipped under RPC because these code paths are client-side only: RpcRemoteCommunity has its own update() and stop()
// and never reaches RemoteCommunity.fetchLatestCommunityOrSubscribeToEvent. The test also reads internal fields
// (_updatingCommunityInstanceWithListeners, pkc._updatingCommunities) that a remote RPC server does not expose.
describeSkipIfRpc("RemoteCommunity update() and stop() overlapping on one instance", () => {
    let pkc: PKC;

    beforeEach(async () => {
        // No-op the fetch so no networking is attempted; these tests only exercise subscribe/stop bookkeeping.
        vi.spyOn(CommunityClientsManager.prototype, "updateOnce").mockImplementation(async () => {});
        pkc = await mockPKCV2({
            stubStorage: true,
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
                noData: true,
                updateInterval: 100,
                kuboRpcClientsOptions: [],
                pubsubKuboRpcClientsOptions: [],
                httpRoutersOptions: []
            }
        });
    });

    afterEach(async () => {
        if (pkc) await pkc.destroy();
        vi.restoreAllMocks();
    });

    it("stop() while update() is creating the shared updating instance leaves nothing tracked or mirrored", async () => {
        const community = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        expect(listUpdatingCommunities(pkc)).toHaveLength(0);

        // No updating instance is tracked yet, so update() suspends on pkc.createCommunity() for the shared one
        const updatePromise = community.update();
        const stopPromise = community.stop();
        await Promise.all([updatePromise, stopPromise]);

        expect(community.state).toBe("stopped");
        expect(community._updatingCommunityInstanceWithListeners).toBeUndefined();
        expect(listUpdatingCommunities(pkc)).toHaveLength(0);

        // The next update() starts a clean run with a single listener on the shared instance
        await community.update();
        expect(community.state).toBe("updating");
        const sharedInstance = community._updatingCommunityInstanceWithListeners!.community;
        expect(sharedInstance._numOfListenersForUpdatingInstance).toBe(1);
        expect(listUpdatingCommunities(pkc)).toEqual([sharedInstance]);

        await community.stop();
        expect(sharedInstance.state).toBe("stopped");
        expect(listUpdatingCommunities(pkc)).toHaveLength(0);
    });

    it("update() called while an un-awaited stop() is still cleaning up restarts the community", async () => {
        const community = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        await community.update();
        const firstSharedInstance = community._updatingCommunityInstanceWithListeners!.community;

        // stop() keeps reporting "updating" until it has stopped the shared instance it was the last listener of
        const stopPromise = community.stop();
        expect(community.state).toBe("updating");
        const updatePromise = community.update();
        await Promise.all([stopPromise, updatePromise]);

        expect(firstSharedInstance.state).toBe("stopped");
        expect(community.state).toBe("updating");
        const mirrored = community._updatingCommunityInstanceWithListeners;
        expect(mirrored).toBeDefined();
        expect(mirrored!.community.state).toBe("updating");
        expect(listUpdatingCommunities(pkc)).toEqual([mirrored!.community]);

        await community.stop();
        expect(listUpdatingCommunities(pkc)).toHaveLength(0);
    });

    it("stop(), update(), stop() in one tick ends stopped: the last call wins", async () => {
        const community = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        await community.update();
        const sharedInstance = community._updatingCommunityInstanceWithListeners!.community;

        await Promise.all([community.stop(), community.update(), community.stop()]);

        expect(community.state).toBe("stopped");
        expect(community._updatingCommunityInstanceWithListeners).toBeUndefined();
        expect(sharedInstance._numOfListenersForUpdatingInstance).toBe(0);
        expect(listUpdatingCommunities(pkc)).toHaveLength(0);
    });

    it("an update() that fails before attaching reports stopped, so the next update() retries", async () => {
        const community = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        const states: string[] = [];
        community.on("statechange", (state) => states.push(state));

        // update() creates the shared updating instance through pkc.createCommunity(); fail that once
        vi.spyOn(pkc, "createCommunity").mockRejectedValueOnce(new Error("failed to create the updating instance"));
        await expect(community.update()).rejects.toThrow("failed to create the updating instance");

        expect(community.state).toBe("stopped");
        expect(states).toEqual(["updating", "stopped"]);

        await community.update();
        expect(community.state).toBe("updating");
        expect(community._updatingCommunityInstanceWithListeners).toBeDefined();
        expect(listUpdatingCommunities(pkc)).toEqual([community._updatingCommunityInstanceWithListeners!.community]);

        await community.stop();
        expect(listUpdatingCommunities(pkc)).toHaveLength(0);
    });

    // update() runs its listeners synchronously: statechange "updating", then the deferred key-migration announcement
    // (update, error), then the events the attach forwards from the updating instance, the attach-time announcement and
    // the replay. A listener that calls stop() from one of them ends the run, and the run must not attach, mirror or emit
    // anything after that.

    it("stop() from a statechange listener while update() attaches to an already tracked instance ends stopped", async () => {
        const a = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        await a.update();
        const sharedInstance = a._updatingCommunityInstanceWithListeners!.community;
        expect(sharedInstance._numOfListenersForUpdatingInstance).toBe(1);

        const b = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        const afterStop = eventsAfterStop(b);
        b.on("statechange", (state) => state === "updating" && afterStop.stop());

        await b.update();
        await afterStop.stopped();

        expect(b.state).toBe("stopped");
        expect(b._updatingCommunityInstanceWithListeners).toBeUndefined();
        expect(sharedInstance._numOfListenersForUpdatingInstance).toBe(1);
        expect(listUpdatingCommunities(pkc)).toEqual([sharedInstance]);
        expect(afterStop.events).toEqual([]);

        await a.stop();
        expect(listUpdatingCommunities(pkc)).toHaveLength(0);
    });

    it("stop() from an error listener during the deferred key-migration announcement ends stopped", async () => {
        const a = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        await a.update();
        const sharedInstance = a._updatingCommunityInstanceWithListeners!.community;

        const b = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        setPendingWarmStartKeyMigration(b, { previousPublicKey: signers[1].address, newPublicKey: sharedInstance.publicKey! });
        const afterStop = eventsAfterStop(b);
        const errors: string[] = [];
        b.on("error", (error) => {
            errors.push((error as PKCError).code);
            afterStop.stop();
        });

        await b.update();
        await afterStop.stopped();

        expect(errors).toEqual(["ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY"]);
        expect(b.state).toBe("stopped");
        expect(b._updatingCommunityInstanceWithListeners).toBeUndefined();
        expect(sharedInstance._numOfListenersForUpdatingInstance).toBe(1);
        expect(listUpdatingCommunities(pkc)).toEqual([sharedInstance]);
        expect(afterStop.events).toEqual([]);

        await a.stop();
        expect(listUpdatingCommunities(pkc)).toHaveLength(0);
    });

    it("stop() from a statechange listener while update() creates the shared updating instance ends stopped", async () => {
        const community = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        const afterStop = eventsAfterStop(community);
        community.on("statechange", (state) => state === "updating" && afterStop.stop());

        await community.update();
        await afterStop.stopped();

        expect(community.state).toBe("stopped");
        expect(community._updatingCommunityInstanceWithListeners).toBeUndefined();
        expect(listUpdatingCommunities(pkc)).toHaveLength(0);
        expect(afterStop.events).toEqual([]);
    });

    it("stop() from an error listener during the attach-time key-migration announcement skips the record replay", async () => {
        // b is created first so its construction-time warm start finds nothing to copy
        const b = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;

        // The tracked instance has migrated to another key and holds a record that b would replay after attaching
        const sharedInstance = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        trackUpdatingCommunity(pkc, sharedInstance);
        sharedInstance.publicKey = signers[1].address;
        sharedInstance.raw.communityIpfs = clone(communityRecordFixture) as CommunityIpfsType;

        const afterStop = eventsAfterStop(b);
        const errors: string[] = [];
        b.on("error", (error) => {
            errors.push((error as PKCError).code);
            afterStop.stop();
        });

        await b.update();
        await afterStop.stopped();

        expect(errors).toEqual(["ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY"]);
        expect(afterStop.events).toEqual([]);
        expect(b.state).toBe("stopped");
        expect(b._updatingCommunityInstanceWithListeners).toBeUndefined();
        // b was the shared instance's only listener, so its stop() stopped and untracked it
        expect(sharedInstance._numOfListenersForUpdatingInstance).toBe(0);
        expect(sharedInstance.state).toBe("stopped");
        expect(listUpdatingCommunities(pkc)).toHaveLength(0);
    });

    it("stop() from an updatingstatechange listener during the attach skips the record replay", async () => {
        // b is created first so its construction-time warm start finds nothing to copy
        const b = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;

        // A tracked, stopped instance with b's key that holds a record b would replay after attaching. Attaching starts
        // its update loop, and the first iteration reports "fetching-ipns" synchronously, which the mirror forwards to b.
        const sharedInstance = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        trackUpdatingCommunity(pkc, sharedInstance);
        sharedInstance.raw.communityIpfs = clone(communityRecordFixture) as CommunityIpfsType;
        expect(sharedInstance.publicKey).toBe(b.publicKey);
        vi.spyOn(CommunityClientsManager.prototype, "updateOnce").mockImplementation(async function (this: CommunityClientsManager) {
            (this as unknown as { _community: RemoteCommunity })._community._setUpdatingStateWithEventEmissionIfNewState("fetching-ipns");
        });

        const afterStop = eventsAfterStop(b);
        const updatingStates: string[] = [];
        b.on("updatingstatechange", (updatingState) => {
            updatingStates.push(updatingState);
            afterStop.stop();
        });

        await b.update();
        await afterStop.stopped();

        expect(updatingStates[0]).toBe("fetching-ipns");
        expect(afterStop.events).toEqual([]);
        expect(b.state).toBe("stopped");
        expect(b._updatingCommunityInstanceWithListeners).toBeUndefined();
        // b was the shared instance's only listener, so its stop() stopped and untracked it
        expect(sharedInstance._numOfListenersForUpdatingInstance).toBe(0);
        expect(sharedInstance.state).toBe("stopped");
        expect(listUpdatingCommunities(pkc)).toHaveLength(0);
    });

    it("a stop() from a statechange listener keeps a pending key-migration announcement for the next update()", async () => {
        const a = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        await a.update();
        const sharedInstance = a._updatingCommunityInstanceWithListeners!.community;

        const b = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        setPendingWarmStartKeyMigration(b, { previousPublicKey: signers[1].address, newPublicKey: sharedInstance.publicKey! });
        const errors: string[] = [];
        b.on("error", (error) => errors.push((error as PKCError).code));
        const afterStop = eventsAfterStop(b);
        const stopOnFirstUpdating = (state: string) => {
            if (state !== "updating") return;
            b.removeListener("statechange", stopOnFirstUpdating);
            afterStop.stop();
        };
        b.on("statechange", stopOnFirstUpdating);

        await b.update();
        await afterStop.stopped();

        expect(b.state).toBe("stopped");
        expect(afterStop.events).toEqual([]);
        expect(errors).toEqual([]);

        // The next run announces the migration the stopped one did not
        await b.update();
        expect(errors).toEqual(["ERR_COMMUNITY_NAME_RESOLVES_TO_DIFFERENT_PUBLIC_KEY"]);
        expect(b._updatingCommunityInstanceWithListeners!.community).toBe(sharedInstance);

        await b.stop();
        await a.stop();
        expect(listUpdatingCommunities(pkc)).toHaveLength(0);
    });
});

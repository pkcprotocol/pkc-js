import { afterEach, expect, it, vi } from "vitest";
import signers from "../../fixtures/signers.js";
import { mockPKCV2 } from "../../../dist/node/test/test-util.js";
import { CommunityClientsManager } from "../../../dist/node/community/community-client-manager.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

// Reproduction for the check-then-attach race in RemoteCommunity.fetchLatestCommunityOrSubscribeToEvent
// (reported in review on PR #289).
//
// The method verifies the tracked updating instance is still in pkc._updatingCommunities, then awaits
// _initCommunityInstanceWithListeners() before attaching listeners. That await yields one microtask
// even though the helper contains no asynchronous work. A concurrent stop() of another mirror runs
// synchronously from its call site all the way through untrackUpdatingCommunity() (the first await on
// that path is the tracked instance's own stop(), which comes AFTER the untrack). So the untrack can
// land exactly in the gap between the membership check and the listener attach: the second mirror then
// attaches to an untracked, dying instance and is silently torn down by its statechange->stopped
// cascade, without ever throwing or emitting an error.
//
// The interleaving below is deterministic, not timing-based:
//   1. b.update() runs synchronously up to the await after the membership check, then suspends.
//   2. a.stop() runs synchronously through the untrack of the shared updating instance.
//   3. Microtasks drain: b resumes and attaches its listeners to the now-untracked instance.

// Skipped under RPC because the raced code path is client-side only: RpcRemoteCommunity has its own
// subscription flow and never calls RemoteCommunity.fetchLatestCommunityOrSubscribeToEvent. The test
// also drives internal fields (_updatingCommunityInstanceWithListeners, pkc._updatingCommunities)
// that a remote RPC server does not expose.
describeSkipIfRpc("concurrent mirror stop() during update() listener attach (PR #289 review)", () => {
    let pkc: PKC;
    afterEach(async () => {
        if (pkc) await pkc.destroy();
        vi.restoreAllMocks();
    });

    it("stopping one mirror while another mirror's update() is attaching does not orphan the second mirror", async () => {
        // No-op the fetch so no networking is attempted; this test only exercises subscribe/stop bookkeeping.
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

        const a = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;
        await a.update();
        const trackedInstance = a._updatingCommunityInstanceWithListeners!.community;
        expect(pkc._updatingCommunities.has(trackedInstance)).toBe(true);

        const b = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;

        // Deliberately not awaited in sequence: the two synchronous prefixes interleave as described above.
        const bUpdate = b.update();
        const aStop = a.stop();
        await Promise.all([bUpdate, aStop]);

        expect(a.state).toBe("stopped");

        // Give the buggy statechange->stopped cascade time to land on b (it needs a few event-loop turns).
        await new Promise((resolve) => setTimeout(resolve, 500));

        // Invariant: stopping mirror A must not tear down mirror B. B's update() resolved without
        // throwing, so B must still be updating and subscribed to a tracked updating instance.
        expect(b.state).toBe("updating");
        const mirroredByB = b._updatingCommunityInstanceWithListeners;
        expect(mirroredByB).toBeDefined();
        expect(pkc._updatingCommunities.has(mirroredByB!.community)).toBe(true);

        await b.stop();
    });
});

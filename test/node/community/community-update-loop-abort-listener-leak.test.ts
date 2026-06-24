import { getEventListeners } from "events";
import { afterEach, expect, it } from "vitest";
import signers from "../../fixtures/signers.js";
import { mockPKCV2 } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";

// Reproduction for https://github.com/pkcprotocol/pkc-js/issues/145
//
// The remote-community update loop sleeps between iterations with:
//   stopSignal.addEventListener("abort", () => { clearTimeout(timer); resolve() }, { once: true })
// `{ once: true }` only detaches the listener when abort FIRES. The normal outcome
// of the sleep is the timer firing (the interval elapses), so the listener is never
// removed and one leaks onto the long-lived community stop signal per iteration
// (~1/sec). This is the same class as issue #144.
//
// We drive startUpdatingLoop() directly with a no-op updateOnce so the loop spins
// fast through the inter-iteration sleep, then assert the abort-listener count on
// the stop signal does not grow with the number of iterations.

// Custom resolvers/loops aren't controllable under a remote PKC RPC server.
describeSkipIfRpc("issue #145: RemoteCommunity update loop leaks an abort listener per iteration", () => {
    let pkc: PKC;
    afterEach(async () => {
        if (pkc) await pkc.destroy();
    });

    it("does not accumulate `abort` listeners on the stop signal across update iterations", async () => {
        pkc = await mockPKCV2({
            stubStorage: true,
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
                noData: true,
                // No kubo/helia clients → startUpdatingLoop uses pkc.updateInterval (not the hardcoded 1000ms),
                // so we can make the loop spin quickly.
                updateInterval: 25,
                kuboRpcClientsOptions: [],
                pubsubKuboRpcClientsOptions: [],
                httpRoutersOptions: []
            }
        });

        const community = (await pkc.createCommunity({ address: signers[0].address })) as RemoteCommunity;

        // Replace the (networked) update with a no-op so each iteration is just the inter-iteration sleep.
        let iterations = 0;
        community._clientsManager.updateOnce = async () => {
            iterations++;
        };

        community._setState("updating");
        const loopPromise = community._clientsManager.startUpdatingLoop();

        const TARGET_ITERATIONS = 12;
        const deadline = Date.now() + 10_000;
        while (iterations < TARGET_ITERATIONS && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));

        const stopSignal = community._getStopAbortSignal();
        const leakedAbortListeners = stopSignal ? getEventListeners(stopSignal, "abort").length : 0;

        // Stop the loop before asserting so a failure doesn't leave it spinning.
        community._setState("stopped");
        community._abortStopOperations("test finished");
        await loopPromise;

        expect(iterations).to.be.greaterThanOrEqual(TARGET_ITERATIONS);
        // With the bug this grows ~1 per iteration (>= ~11). After the fix at most one
        // listener is attached at any instant (the in-flight sleep), independent of iteration count.
        expect(leakedAbortListeners).to.be.lessThanOrEqual(2);
    });
});

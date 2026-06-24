import { getEventListeners } from "events";
import { expect, it } from "vitest";
import { updateLoop } from "../../../dist/node/runtime/node/community/local-community/lifecycle.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// Reproduction for https://github.com/pkcprotocol/pkc-js/issues/146
//
// The LocalCommunity update loop (lifecycle.ts `updateLoop`) sleeps between
// iterations with:
//   community._updateLoopAbortController.signal.addEventListener("abort", () => {...}, { once: true })
// `{ once: true }` only detaches the listener when abort FIRES. The normal
// outcome of the sleep is the timer elapsing, so the listener is never removed
// and one leaks onto the long-lived update-loop signal per iteration. Same leak
// class as issues #144 and #145.
//
// `updateLoop` is a module-level function that calls the module-level
// `updateOnce(community)` by closure, so we drive it directly with a minimal
// community driver. `updateOnce` throws immediately on this stub (no
// initDbHandlerIfNeeded) and the loop's try/catch swallows it, so the loop
// spins fast straight through the inter-iteration sleep. We then assert the
// abort-listener count on the update-loop signal does not grow with iterations.

it("issue #146: LocalCommunity update loop does not accumulate `abort` listeners per iteration", async () => {
    const updateLoopAbortController = new AbortController();
    let iterations = 0;

    // updateLoop + the inter-iteration sleep only touch these members. The
    // updateInterval getter doubles as a per-iteration counter (it is read once
    // per sleep, and updateOnce throws before reaching any _pkc access).
    const community = {
        state: "updating" as string,
        _stopHasBeenCalled: false,
        _updateLoopAbortController: updateLoopAbortController,
        _pkc: {
            get updateInterval() {
                iterations++;
                return 20;
            }
        },
        emit: () => true
    };

    const loopPromise = updateLoop(community as unknown as LocalCommunity);

    const TARGET_ITERATIONS = 12;
    const deadline = Date.now() + 10_000;
    while (iterations < TARGET_ITERATIONS && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));

    const leakedAbortListeners = getEventListeners(updateLoopAbortController.signal, "abort").length;

    // Stop the loop before asserting so a failure doesn't leave it spinning.
    community.state = "stopped";
    community._stopHasBeenCalled = true;
    updateLoopAbortController.abort();
    await loopPromise;

    expect(iterations).to.be.greaterThanOrEqual(TARGET_ITERATIONS);
    // With the bug this grows ~1 per iteration. After the fix at most one listener
    // is attached at any instant (the in-flight sleep), independent of iteration count.
    expect(leakedAbortListeners).to.be.lessThanOrEqual(2);
});

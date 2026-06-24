import { getEventListeners } from "events";
import { expect, it, vi } from "vitest";
import { mockPKCV2 } from "../../../dist/node/test/test-util.js";

// Reproduction for https://github.com/pkcprotocol/pkc-js/issues/147
//
// Comment._scheduleParallelCommunityConnect schedules a 5s timer and registers
//   stopSignal.addEventListener("abort", () => clearTimeout(timer), { once: true })
// to cancel that timer if the comment is stopped early. `{ once: true }` only
// detaches the listener when abort FIRES. In the common case the 5s timer fires
// normally, the callback runs, and the listener is never removed — so it leaks
// on the long-lived comment stop signal, one per call. Same class as #144.
//
// The method is private and only touches a handful of `this` members, so we
// pull it off a real Comment instance (importing the Comment class directly
// trips a module-init cycle) and drive it with a minimal stub plus fake timers
// (no 5s wait, no network). raw.comment is truthy so the timer callback
// short-circuits before any getCommunity call.

type SchedulerThis = {
    communityName?: string;
    communityPublicKey?: string;
    cid?: string;
    raw: { comment?: unknown };
    _pkc: { destroyed: boolean; getCommunity: () => Promise<unknown> };
    _getStopAbortSignal: () => AbortSignal | undefined;
    _isStopAbortRequested: () => boolean;
};

it("issue #147: _scheduleParallelCommunityConnect does not leak an abort listener per call", async () => {
    const pkc = await mockPKCV2({
        stubStorage: true,
        remotePKC: true,
        mockResolve: false,
        pkcOptions: { noData: true, kuboRpcClientsOptions: [], pubsubKuboRpcClientsOptions: [], httpRoutersOptions: [] }
    });
    const realComment = await pkc.createComment({ cid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG" });
    const scheduleParallelCommunityConnect = (
        realComment as unknown as { _scheduleParallelCommunityConnect: (this: SchedulerThis, log: unknown) => void }
    )._scheduleParallelCommunityConnect;
    await pkc.destroy();

    vi.useFakeTimers();
    try {
        const stopController = new AbortController();
        // Never invoked (raw.comment short-circuits the callback), but shaped like a Logger.
        const log = Object.assign(() => {}, { error: () => {}, trace: () => {} });
        const comment: SchedulerThis = {
            communityName: "leaky.bso",
            cid: "QmTestCidForParallelConnectLeak",
            raw: { comment: { ok: true } }, // truthy → timer callback returns before any getCommunity
            _pkc: { destroyed: false, getCommunity: async () => undefined },
            _getStopAbortSignal: () => stopController.signal,
            _isStopAbortRequested: () => stopController.signal.aborted
        };

        const CALLS = 5;
        for (let i = 0; i < CALLS; i++) scheduleParallelCommunityConnect.call(comment, log);

        // While the 5s timers are pending, one listener per call is attached (true for buggy and fixed code).
        expect(getEventListeners(stopController.signal, "abort").length).to.equal(CALLS);

        // Fire all the parallel-connect timers. The fix detaches each listener when its timer fires;
        // the bug leaves them attached on the long-lived stop signal forever.
        await vi.advanceTimersByTimeAsync(5_000);

        const remaining = getEventListeners(stopController.signal, "abort").length;
        expect(remaining).to.be.lessThanOrEqual(1);
    } finally {
        vi.useRealTimers();
    }
});

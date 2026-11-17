import { getEventListeners } from "events";
import { expect, it } from "vitest";
import { mockPKCNoDataPathWithOnlyKuboClient } from "../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../helpers/conditional-tests.js";

// Abort-listener leak guard for the community connect a comment load runs next to its CID fetch.
//
// History: issue #147. The connect used to wait 5s behind a timer and registered
//   stopSignal.addEventListener("abort", () => clearTimeout(timer), { once: true })
// which only detached when abort FIRED, so every call left one listener on the long-lived comment
// stop signal. Since issue #562 there is no timer: Comment._startParallelCommunityConnect calls
// pkc.getCommunity at once and hands it the stop signal. The same class of leak is still possible
// one level down (pkc.getCommunity listening on a signal that outlives the call), so this drives the
// real method against a community nobody publishes and checks the signal afterwards.

// The connect is not started under a PKC RPC client (the server runs it), so there is nothing to
// measure on the client side.
itSkipIfRpc(
    "issue #147/#562: the parallel community connect leaves no abort listener on a long-lived signal",
    async () => {
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
        pkc._timeouts["community-ipns"] = 1_500;
        try {
            const unpublishedCommunityKey = (await pkc.createSigner()).address;
            const comment = await pkc.createComment({
                cid: "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG",
                communityPublicKey: unpublishedCommunityKey
            });
            const longLivedController = new AbortController();

            const CALLS = 3;
            const outcomes: (Error | undefined)[] = [];
            // One at a time: a second call made while the first community load is still updating is
            // skipped by design, and this test wants every call to run a full community load.
            for (let i = 0; i < CALLS; i++)
                outcomes.push(await comment._startParallelCommunityConnect({ abortSignal: longLivedController.signal }));

            for (const outcome of outcomes)
                expect(outcome, "each community load should have run and failed (nobody publishes this community)").to.be.instanceOf(Error);
            expect(longLivedController.signal.aborted).to.be.false;
            expect(getEventListeners(longLivedController.signal, "abort").length).to.equal(0);
        } finally {
            await pkc.destroy();
        }
    },
    60_000
);

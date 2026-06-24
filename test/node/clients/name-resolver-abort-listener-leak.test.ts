import { getEventListeners } from "events";
import { afterEach, expect, it } from "vitest";
import { v4 as uuidv4 } from "uuid";
import signers from "../../fixtures/signers.js";
import { createMockNameResolver, mockPKCV2 } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";

// Reproduction for https://github.com/pkcprotocol/pkc-js/issues/144
//
// `_resolveViaNameResolvers` races the resolver against the abort signal by
// attaching an `abort` listener with `{ once: true }`. `{ once: true }` only
// detaches the listener when the abort event *fires*. In the common case the
// resolver wins the race and `abort` never fires, so the listener stays bound
// to the (long-lived) abort signal forever — one leak per successful
// resolution. Over a remote-community update loop these pile up into the tens
// of thousands and pin a CPU core (O(n^2) EventTarget churn), wedging the
// daemon.
//
// We drive the exact same code path the update loop uses
// (resolveCommunityNameIfNeeded on a single long-lived signal) and assert the
// number of `abort` listeners on that signal does not grow with the number of
// resolutions.

// Custom resolvers + the local cache aren't controllable under a remote PKC RPC
// server, so this assertion is only meaningful in-process.
describeSkipIfRpc("issue #144: _resolveViaNameResolvers leaks an abort listener per resolution", () => {
    let pkc: PKC;
    afterEach(async () => {
        if (pkc) await pkc.destroy();
    });

    it("does not accumulate `abort` listeners on the long-lived stop signal", async () => {
        // Resolver always succeeds → the resolve promise wins the race, abort never fires.
        const resolver = createMockNameResolver({
            key: `leak-resolver-${uuidv4()}`,
            provider: "mock://leak",
            records: { "leaky.bso": signers[3].address }
        });

        pkc = await mockPKCV2({
            stubStorage: true,
            remotePKC: true,
            mockResolve: false,
            pkcOptions: {
                // noData → LRU storage falls back to in-memory SQLite
                noData: true,
                nameResolvers: [resolver]
            }
        });

        // A single long-lived signal, mirroring community._getStopAbortSignal().
        const stopController = new AbortController();
        const stopSignal = stopController.signal;

        const RESOLUTIONS = 50;
        for (let i = 0; i < RESOLUTIONS; i++) {
            // cache: { maxAge: 0 } bypasses the persistent cache so every call reaches
            // the resolver + the abort-race block (same as a cache miss in the loop).
            const resolved = await pkc._clientsManager.resolveCommunityNameIfNeeded({
                communityName: "leaky.bso",
                abortSignal: stopSignal,
                cache: { maxAge: 0 }
            });
            expect(resolved).to.equal(signers[3].address);
        }

        const leakedAbortListeners = getEventListeners(stopSignal, "abort").length;

        // With the bug present this equals RESOLUTIONS (~50). After the fix it
        // should stay at ~0 regardless of how many resolutions ran.
        expect(leakedAbortListeners).to.be.lessThanOrEqual(2);

        stopController.abort();
    });
});

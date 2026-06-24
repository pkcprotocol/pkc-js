import { getEventListeners } from "events";
import { describe, expect, it, vi } from "vitest";
import { isAbortError, raceAgainstAbort, sleepUntilTimeoutOrAbort } from "../../../dist/node/util.js";

// Unit tests for the shared abort helpers extracted from the issue #144-#147 fixes
// (follow-up to https://github.com/pkcprotocol/pkc-js/pull/149). The four call-site
// regression tests cover each usage; these pin the helper contract directly, including
// the reject-on-abort and no-signal paths the call-site tests don't isolate.
//
// The core invariant for both helpers: the abort listener is detached on EVERY outcome
// (timer elapsed / promise settled / aborted), so repeated calls on a long-lived signal
// never accumulate listeners.

describe("sleepUntilTimeoutOrAbort", () => {
    it("resolves after the timeout and leaves no abort listener", async () => {
        vi.useFakeTimers();
        try {
            const controller = new AbortController();
            const sleep = sleepUntilTimeoutOrAbort(1000, controller.signal);
            expect(getEventListeners(controller.signal, "abort").length).to.equal(1);
            await vi.advanceTimersByTimeAsync(1000);
            await sleep;
            expect(getEventListeners(controller.signal, "abort").length).to.equal(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("resolves early (does not reject) when the signal aborts, and detaches the listener", async () => {
        const controller = new AbortController();
        const sleep = sleepUntilTimeoutOrAbort(60_000, controller.signal);
        expect(getEventListeners(controller.signal, "abort").length).to.equal(1);
        controller.abort();
        await sleep; // resolves, never rejects
        expect(getEventListeners(controller.signal, "abort").length).to.equal(0);
    });

    it("resolves immediately when the signal is already aborted and never attaches a listener", async () => {
        const controller = new AbortController();
        controller.abort();
        await sleepUntilTimeoutOrAbort(60_000, controller.signal);
        expect(getEventListeners(controller.signal, "abort").length).to.equal(0);
    });

    it("does not accumulate listeners across many concurrent sleeps on one long-lived signal", async () => {
        vi.useFakeTimers();
        try {
            const controller = new AbortController();
            const N = 50;
            const sleeps = Array.from({ length: N }, () => sleepUntilTimeoutOrAbort(1000, controller.signal));
            expect(getEventListeners(controller.signal, "abort").length).to.equal(N);
            await vi.advanceTimersByTimeAsync(1000);
            await Promise.all(sleeps);
            expect(getEventListeners(controller.signal, "abort").length).to.equal(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("resolves after the timeout when no signal is given", async () => {
        vi.useFakeTimers();
        try {
            let resolved = false;
            const sleep = sleepUntilTimeoutOrAbort(1000).then(() => (resolved = true));
            await vi.advanceTimersByTimeAsync(1000);
            await sleep;
            expect(resolved).to.equal(true);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("raceAgainstAbort", () => {
    it("returns the promise's value when it wins, and detaches the listener", async () => {
        const controller = new AbortController();
        const result = await raceAgainstAbort(Promise.resolve("ok"), controller.signal);
        expect(result).to.equal("ok");
        expect(getEventListeners(controller.signal, "abort").length).to.equal(0);
    });

    it("rejects with an AbortError when the signal wins, and detaches the listener", async () => {
        const controller = new AbortController();
        const never = new Promise<string>(() => {}); // never settles on its own
        const raced = raceAgainstAbort(never, controller.signal);
        expect(getEventListeners(controller.signal, "abort").length).to.equal(1);
        controller.abort();
        let err: unknown;
        try {
            await raced;
        } catch (e) {
            err = e;
        }
        expect(isAbortError(err)).to.equal(true);
        expect(getEventListeners(controller.signal, "abort").length).to.equal(0);
    });

    it("rejects immediately when the signal is already aborted", async () => {
        const controller = new AbortController();
        controller.abort();
        let err: unknown;
        try {
            await raceAgainstAbort(new Promise<string>(() => {}), controller.signal);
        } catch (e) {
            err = e;
        }
        expect(isAbortError(err)).to.equal(true);
        expect(getEventListeners(controller.signal, "abort").length).to.equal(0);
    });

    it("does not accumulate listeners across many resolutions on one long-lived signal", async () => {
        const controller = new AbortController();
        for (let i = 0; i < 50; i++) expect(await raceAgainstAbort(Promise.resolve(i), controller.signal)).to.equal(i);
        expect(getEventListeners(controller.signal, "abort").length).to.equal(0);
    });

    it("passes the promise through unchanged when no signal is given", async () => {
        expect(await raceAgainstAbort(Promise.resolve(42))).to.equal(42);
    });
});

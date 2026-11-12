// linkAbortSignals() (#502) replaces AbortSignal.any() wherever a source lives as long as the pkc or a
// comment's update loop: on Node 20/22 every AbortSignal.any() call over such a source retains memory
// until the source aborts. The replacement must behave like AbortSignal.any() while linked, and leave
// nothing on the long-lived source once disposed, or it trades #502 for the #144 abort-listener leak.
import { describe, it, expect } from "vitest";
import { getEventListeners } from "node:events";
import { linkAbortSignals } from "../../../dist/node/util.js";

describe("linkAbortSignals", () => {
    it("aborts with the reason of whichever source aborts first", () => {
        const longLived = new AbortController();
        const perOperation = new AbortController();
        const { signal } = linkAbortSignals([longLived.signal, perOperation.signal]);
        perOperation.abort("operation cancelled");
        expect({ aborted: signal?.aborted, reason: signal?.reason }).toEqual({ aborted: true, reason: "operation cancelled" });
    });

    it("is aborted immediately when a source already is", () => {
        const aborted = new AbortController();
        aborted.abort("already");
        const { signal } = linkAbortSignals([new AbortController().signal, aborted.signal]);
        expect({ aborted: signal?.aborted, reason: signal?.reason }).toEqual({ aborted: true, reason: "already" });
    });

    it("returns the only source as is, and undefined for none", () => {
        const only = new AbortController().signal;
        expect(linkAbortSignals([undefined, only]).signal).toBe(only);
        expect(linkAbortSignals([undefined]).signal).toBeUndefined();
    });

    it("leaves no listener on a long-lived source after 1000 disposed links", () => {
        const longLived = new AbortController();
        for (let i = 0; i < 1000; i++) linkAbortSignals([longLived.signal, new AbortController().signal]).dispose();
        expect(getEventListeners(longLived.signal, "abort")).toHaveLength(0);
    });

    it("detaches from every source once one of them aborts", () => {
        const longLived = new AbortController();
        const perOperation = new AbortController();
        linkAbortSignals([longLived.signal, perOperation.signal]);
        perOperation.abort();
        expect(getEventListeners(longLived.signal, "abort")).toHaveLength(0);
    });
});

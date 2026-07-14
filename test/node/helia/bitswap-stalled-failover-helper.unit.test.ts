import { describe, expect, it } from "vitest";
import { CID } from "multiformats/cid";
import * as rawCodec from "multiformats/codecs/raw";
import { sha256 } from "multiformats/hashes/sha2";
import { fetchBlockWithStalledSessionFailover } from "../../../dist/node/helia/util.js";
import Logger from "../../../dist/node/logger.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { FetchBlockFn } from "../../../dist/node/helia/util.js";

// Unit coverage for fetchBlockWithStalledSessionFailover (issue #218), the race between a bitswap
// session's block get and a delayed non-session broadcast want. The cat()-level behavior is covered
// in bitswap-stalled-session-failover.test.ts; these tests pin the helper's exact semantics with
// fake block sources: who may win, when the fallback may start, which errors surface, and that the
// losing source is always aborted rather than leaked.
//
// Pure in-process helper with fake block sources, config-independent, so it runs once under non-RPC.
describeSkipIfRpc("fetchBlockWithStalledSessionFailover (issue #218)", () => {
    // Small stall window so the whole file runs fast; every duration below is defined relative to
    // it so CI timer jitter cannot reorder the intended sequence of events.
    const STALL_MS = 300;

    const log = Logger("pkc-js-test:helia:stalled-failover");

    let testCid: CID;
    const getTestCid = async (): Promise<CID> => {
        testCid ??= CID.createV1(rawCodec.code, await sha256.digest(new TextEncoder().encode("stalled-failover-helper-test")));
        return testCid;
    };

    const abortReasonAsError = (signal: AbortSignal): Error =>
        signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "aborted"));

    // Observability shared by all fake sources: every get records the signal it was called with
    // (so tests can assert the loser was aborted) and how many times it was invoked.
    type SourceProbe = { signals: AbortSignal[]; calls: number };
    const newProbe = (): SourceProbe => ({ signals: [], calls: 0 });

    const abortableDelay = (ms: number, signal: AbortSignal | undefined): Promise<void> =>
        new Promise<void>((resolve, reject) => {
            if (signal?.aborted) {
                reject(abortReasonAsError(signal));
                return;
            }
            const onAbort = () => {
                clearTimeout(timer);
                reject(abortReasonAsError(signal!));
            };
            const timer = setTimeout(() => {
                signal?.removeEventListener("abort", onAbort);
                resolve();
            }, ms);
            signal?.addEventListener("abort", onAbort, { once: true });
        });

    // A source that yields the given chunks after delayMs (rejecting on abort while waiting).
    const sourceYieldingAfter = (probe: SourceProbe, delayMs: number, chunks: Uint8Array[]): FetchBlockFn =>
        async function* (_cid, options) {
            probe.calls++;
            if (options?.signal) probe.signals.push(options.signal);
            await abortableDelay(delayMs, options?.signal);
            yield* chunks;
        };

    // A source that never delivers: it only ends when its signal aborts — the deterministic
    // stand-in for a want pending on a slow sole-HAVE peer.
    const sourceNeverDelivering = (probe: SourceProbe): FetchBlockFn =>
        async function* (_cid, options) {
            probe.calls++;
            if (options?.signal) probe.signals.push(options.signal);
            await new Promise<never>((_resolve, reject) => {
                const signal = options?.signal;
                if (signal == null) return;
                if (signal.aborted) {
                    reject(abortReasonAsError(signal));
                    return;
                }
                signal.addEventListener("abort", () => reject(abortReasonAsError(signal)), { once: true });
            });
            yield new Uint8Array(0); // unreachable, satisfies the generator's type
        };

    // A source that fails after delayMs with the given error.
    const sourceFailingAfter = (probe: SourceProbe, delayMs: number, error: Error): FetchBlockFn =>
        async function* (_cid, options) {
            probe.calls++;
            if (options?.signal) probe.signals.push(options.signal);
            await abortableDelay(delayMs, options?.signal);
            throw error;
        };

    const runHelper = async (args: {
        sessionGet: FetchBlockFn;
        fallbackGet: FetchBlockFn;
        signal?: AbortSignal;
    }): Promise<{ fetched: Buffer; elapsedMs: number }> => {
        const startedAt = Date.now();
        const chunks: Uint8Array[] = [];
        for await (const chunk of fetchBlockWithStalledSessionFailover({
            cid: await getTestCid(),
            sessionGet: args.sessionGet,
            fallbackGet: args.fallbackGet,
            stallTimeoutMs: STALL_MS,
            options: args.signal ? { signal: args.signal } : undefined,
            log
        })) {
            chunks.push(chunk);
        }
        return { fetched: Buffer.concat(chunks), elapsedMs: Date.now() - startedAt };
    };

    const sessionChunks = [new TextEncoder().encode("session-part-1"), new TextEncoder().encode("session-part-2")];
    const sessionBytes = Buffer.concat(sessionChunks);
    const fallbackChunks = [new TextEncoder().encode("fallback-block")];
    const fallbackBytes = Buffer.concat(fallbackChunks);

    it("returns the session's chunks (in order) and never starts the fallback when the session delivers before the stall window", async () => {
        const sessionProbe = newProbe();
        const fallbackProbe = newProbe();
        const { fetched, elapsedMs } = await runHelper({
            sessionGet: sourceYieldingAfter(sessionProbe, 20, sessionChunks),
            fallbackGet: sourceYieldingAfter(fallbackProbe, 0, fallbackChunks)
        });
        expect(fetched.equals(sessionBytes)).to.equal(true);
        expect(elapsedMs).to.be.lessThan(STALL_MS);
        expect(fallbackProbe.calls).to.equal(0);
    });

    it("fails over to the fallback after the stall window and aborts the stalled session get", async () => {
        const sessionProbe = newProbe();
        const fallbackProbe = newProbe();
        const { fetched, elapsedMs } = await runHelper({
            sessionGet: sourceNeverDelivering(sessionProbe),
            fallbackGet: sourceYieldingAfter(fallbackProbe, 0, fallbackChunks)
        });
        expect(fetched.equals(fallbackBytes)).to.equal(true);
        // The fallback must not have started before the stall window elapsed.
        expect(elapsedMs).to.be.at.least(STALL_MS);
        expect(fallbackProbe.calls).to.equal(1);
        // The losing session get was aborted, not left pending on the slow peer.
        expect(sessionProbe.signals[0]?.aborted).to.equal(true);
    });

    it("lets a late session win over a slower fallback and aborts the losing fallback", async () => {
        const sessionProbe = newProbe();
        const fallbackProbe = newProbe();
        const { fetched } = await runHelper({
            // Session delivers after the stall window (2x) but before the fallback would (4x).
            sessionGet: sourceYieldingAfter(sessionProbe, STALL_MS * 2, sessionChunks),
            fallbackGet: sourceYieldingAfter(fallbackProbe, STALL_MS * 4, fallbackChunks)
        });
        expect(fetched.equals(sessionBytes)).to.equal(true);
        expect(fallbackProbe.calls).to.equal(1);
        expect(fallbackProbe.signals[0]?.aborted).to.equal(true);
    });

    it("surfaces a pre-stall session error immediately without starting the fallback", async () => {
        const sessionProbe = newProbe();
        const fallbackProbe = newProbe();
        const sessionError = new Error("InsufficientProvidersError stand-in");
        const startedAt = Date.now();
        await expect(
            runHelper({
                sessionGet: sourceFailingAfter(sessionProbe, 20, sessionError),
                fallbackGet: sourceYieldingAfter(fallbackProbe, 0, fallbackChunks)
            })
        ).rejects.toThrow(sessionError.message);
        // Failed fast (cat()'s retry loop depends on this), and no broadcast want was fired.
        expect(Date.now() - startedAt).to.be.lessThan(STALL_MS);
        expect(fallbackProbe.calls).to.equal(0);
    });

    it("surfaces a post-stall session error and aborts the in-flight fallback", async () => {
        const sessionProbe = newProbe();
        const fallbackProbe = newProbe();
        const sessionError = new Error("session failed after the fallback started");
        await expect(
            runHelper({
                sessionGet: sourceFailingAfter(sessionProbe, STALL_MS * 2, sessionError),
                fallbackGet: sourceYieldingAfter(fallbackProbe, STALL_MS * 4, fallbackChunks)
            })
        ).rejects.toThrow(sessionError.message);
        expect(fallbackProbe.calls).to.equal(1);
        expect(fallbackProbe.signals[0]?.aborted).to.equal(true);
    });

    it("tolerates a fallback error and still returns the session's block", async () => {
        const sessionProbe = newProbe();
        const fallbackProbe = newProbe();
        const { fetched } = await runHelper({
            sessionGet: sourceYieldingAfter(sessionProbe, STALL_MS * 3, sessionChunks),
            fallbackGet: sourceFailingAfter(fallbackProbe, 20, new Error("no providers for broadcast want"))
        });
        expect(fetched.equals(sessionBytes)).to.equal(true);
        expect(fallbackProbe.calls).to.equal(1);
    });

    it("propagates the caller's abort reason and aborts both pending sources", async () => {
        const sessionProbe = newProbe();
        const fallbackProbe = newProbe();
        const abortController = new AbortController();
        const abortReason = new Error("caller gave up (stand-in for cat() timeout)");
        setTimeout(() => abortController.abort(abortReason), STALL_MS * 2);
        await expect(
            runHelper({
                sessionGet: sourceNeverDelivering(sessionProbe),
                fallbackGet: sourceNeverDelivering(fallbackProbe),
                signal: abortController.signal
            })
        ).rejects.toThrow(abortReason.message);
        expect(sessionProbe.signals[0]?.aborted).to.equal(true);
        expect(fallbackProbe.signals[0]?.aborted).to.equal(true);
    });

    it("throws immediately on an already-aborted caller signal without invoking either source", async () => {
        const sessionProbe = newProbe();
        const fallbackProbe = newProbe();
        const abortController = new AbortController();
        abortController.abort(new Error("aborted before the fetch started"));
        await expect(
            runHelper({
                sessionGet: sourceNeverDelivering(sessionProbe),
                fallbackGet: sourceNeverDelivering(fallbackProbe),
                signal: abortController.signal
            })
        ).rejects.toThrow("aborted before the fetch started");
        expect(sessionProbe.calls).to.equal(0);
        expect(fallbackProbe.calls).to.equal(0);
    });
});

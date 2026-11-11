import { describe, expect, it, vi } from "vitest";
import { InflightFetchManager } from "../../../dist/node/util/inflight-fetch-manager.js";
import { createAbortError, isAbortError } from "../../../dist/node/util.js";

// InflightFetchManager hands every caller of the same key the promise of whoever fetched it first. That
// first caller's fetcher runs under its own stop signal (a Comment's or a community's), so its stop()
// rejects the shared promise with an AbortError. The callers that only joined it did not cancel
// anything: they must get their own fetch instead of the owner's cancellation, unless the pkc is being
// destroyed.

// A fetcher that never answers on its own and rejects with an AbortError when its signal fires, the
// way the CommentIpfs and community fetchers do on stop()
const fetcherCancelledBy = (signal: AbortSignal) => () =>
    new Promise<string>((_, reject) =>
        signal.addEventListener("abort", () => reject(createAbortError("owner was stopped")), { once: true })
    );

const settled = <T>(promise: Promise<T>): Promise<{ value?: T; error?: Error }> =>
    promise.then(
        (value) => ({ value }),
        (error: Error) => ({ error })
    );

describe("InflightFetchManager", () => {
    it("a joiner fetches on its own when the owner's fetch is cancelled by the owner's stop", async () => {
        const manager = new InflightFetchManager();
        const ownerStop = new AbortController();
        const joinerFetcher = vi.fn(async () => "fetched by the joiner");

        const owner = settled(manager.withResource("comment-ipfs", "QmCid", fetcherCancelledBy(ownerStop.signal), ownerStop.signal));
        const joiner = settled(manager.withResource("comment-ipfs", "QmCid", joinerFetcher));
        expect(joinerFetcher).not.toHaveBeenCalled(); // it joined the owner's fetch

        ownerStop.abort();

        const ownerResult = await owner;
        expect(isAbortError(ownerResult.error), "the owner still sees its own cancellation").to.equal(true);
        const joinerResult = await joiner;
        expect(joinerResult.error, "the joiner got the owner's cancellation").to.equal(undefined);
        expect(joinerResult.value).to.equal("fetched by the joiner");
        expect(joinerFetcher).toHaveBeenCalledTimes(1);
    });

    it("a joiner that was stopped too gets the cancellation without fetching again", async () => {
        const manager = new InflightFetchManager();
        const ownerStop = new AbortController();
        const joinerStop = new AbortController();
        const joinerFetcher = vi.fn(async () => "fetched by the joiner");

        const owner = settled(manager.withResource("comment-ipfs", "QmCid", fetcherCancelledBy(ownerStop.signal), ownerStop.signal));
        const joiner = settled(manager.withResource("comment-ipfs", "QmCid", joinerFetcher, joinerStop.signal));

        joinerStop.abort();
        ownerStop.abort();

        await owner;
        const joinerResult = await joiner;
        expect(isAbortError(joinerResult.error)).to.equal(true);
        expect(joinerFetcher).not.toHaveBeenCalled();
    });

    it("a joiner does not fetch again once the pkc is destroyed", async () => {
        // pkc.destroy() stops every instance that owns a fetch, so its cancellations are no reason to fetch again
        let destroyed = false;
        const manager = new InflightFetchManager({ isDestroyed: () => destroyed });
        const ownerStop = new AbortController();
        const joinerStop = new AbortController();
        const joinerFetcher = vi.fn(async () => "fetched by the joiner");

        const owner = settled(manager.withResource("comment-ipfs", "QmCid", fetcherCancelledBy(ownerStop.signal), ownerStop.signal));
        const joiner = settled(manager.withResource("comment-ipfs", "QmCid", joinerFetcher, joinerStop.signal));

        destroyed = true;
        ownerStop.abort();

        await owner;
        const joinerResult = await joiner;
        expect(isAbortError(joinerResult.error)).to.equal(true);
        expect(joinerFetcher).not.toHaveBeenCalled();
    });

    it("joiners share a failure that is not a cancellation, without fetching again", async () => {
        const manager = new InflightFetchManager();
        let rejectOwner: (error: Error) => void = () => {};
        const ownerFetcher = () => new Promise<string>((_, reject) => (rejectOwner = reject));
        const joinerFetcher = vi.fn(async () => "fetched by the joiner");

        const owner = settled(manager.withResource("comment-ipfs", "QmCid", ownerFetcher));
        const joiner = settled(manager.withResource("comment-ipfs", "QmCid", joinerFetcher));
        await new Promise((resolve) => setTimeout(resolve, 0));
        rejectOwner(new Error("gateway answered with an invalid record"));

        expect((await owner).error?.message).to.equal("gateway answered with an invalid record");
        expect((await joiner).error?.message).to.equal("gateway answered with an invalid record");
        expect(joinerFetcher).not.toHaveBeenCalled();
    });
});

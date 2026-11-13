import { describe, it, expect, vi, afterEach } from "vitest";
import { mockPKCNoDataPathWithOnlyKuboClient, publishStaticCommunityWithPostInPages } from "../../../../../dist/node/test/test-util.js";
import { CommentClientsManager } from "../../../../../dist/node/publications/comment/comment-client-manager.js";
import { PKCError } from "../../../../../dist/node/pkc-error.js";
import type { CommunityIpfsType } from "../../../../../dist/node/community/types.js";

// The post counterpart of issue #515: a post whose CommentUpdate is only under the community's postUpdates, on a static
// community (published exactly once). The fetch of the post's update file is failed once with the error a fetch timeout
// raises. No new record ever arrives, so only a retry of the post's own can fetch the file again.
// A timeout is the failure that ends the lookup: a connection failure is already retried in place, three times.

interface FetchCidP2PHolder {
    _fetchCidP2P(path: string, opts: unknown): Promise<string>;
}

interface PostLookupHolder {
    useCommunityPostUpdatesToFetchCommentUpdateForPost(record: CommunityIpfsType): Promise<"fetch-failed" | undefined>;
}

const waitForPostUpdateMs = 30_000;
// Longer than the first two backoff delays (1s, then 2s), so a retry that should not happen would be seen
const noRetryWindowMs = 3500;

describe("a post fetching its CommentUpdate from postUpdates after one fetch fails", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    // The control: with no failure the post gets its CommentUpdate from postUpdates, so the red case below is the missing retry
    it("receives its CommentUpdate from postUpdates when no fetch fails", async () => {
        const fixture = await publishStaticCommunityWithPostInPages({ withPostOnlyInPostUpdates: true });
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
        try {
            const post = await pkc.createComment({ cid: fixture.commentCid });
            post.on("error", () => {});
            await post.update();
            await vi.waitFor(() => expect(post.updatedAt).to.be.a("number"), { timeout: waitForPostUpdateMs, interval: 100 });
            await post.stop();
        } finally {
            await pkc.destroy();
            await fixture.ipnsObj.pkc.destroy();
        }
    });

    it("still receives its CommentUpdate when the fetch of its update file times out once", async () => {
        const fixture = await publishStaticCommunityWithPostInPages({ withPostOnlyInPostUpdates: true });
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
        try {
            const updatePath = `${fixture.postUpdatesFolderCid}/${fixture.commentCid}/update`;
            const prototype = CommentClientsManager.prototype as unknown as FetchCidP2PHolder;
            const originalFetchCidP2P = prototype._fetchCidP2P;
            const calls = { failed: 0, total: 0 };
            vi.spyOn(prototype, "_fetchCidP2P").mockImplementation(async function (this: FetchCidP2PHolder, path: string, opts: unknown) {
                if (path === updatePath) {
                    calls.total++;
                    if (calls.failed === 0) {
                        calls.failed++;
                        throw new PKCError("ERR_FETCH_CID_P2P_TIMEOUT", { cid: path, simulated: true });
                    }
                }
                return originalFetchCidP2P.call(this, path, opts);
            });

            const post = await pkc.createComment({ cid: fixture.commentCid });
            const errors: Error[] = [];
            post.on("error", (error) => errors.push(error as Error));
            await post.update();

            await vi.waitFor(() => expect(calls.failed, "the update file fetch was never attempted").to.equal(1), {
                timeout: waitForPostUpdateMs,
                interval: 50
            });
            await vi.waitFor(
                () =>
                    expect(
                        post.updatedAt,
                        `the post never got its CommentUpdate after the failed fetch (state ${post.updatingState}, ` +
                            `${calls.total} fetches of the update file, errors: ${errors.map((e) => (e as PKCError).code).join(", ")})`
                    ).to.be.a("number"),
                { timeout: waitForPostUpdateMs, interval: 100 }
            );
            expect(calls.total, "the update file is fetched once more, by the retry").to.equal(2);
            expect(errors).to.have.length(1);
            expect((errors[0] as PKCError).code).to.equal("ERR_FAILED_TO_FETCH_COMMENT_UPDATE_FROM_ALL_POST_UPDATES_RANGES");
            await post.stop();
        } finally {
            await pkc.destroy();
            await fixture.ipnsObj.pkc.destroy();
        }
    });

    // A file that never arrives (the fetch fails every time, as it also does for a post whose file is not under
    // postUpdates at all) is retried for as long as the post is updating, with a delay that doubles
    it("keeps retrying with a delay that doubles for as long as the post is updating", async () => {
        const fixture = await publishStaticCommunityWithPostInPages({ withPostOnlyInPostUpdates: true });
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
        try {
            const updatePath = `${fixture.postUpdatesFolderCid}/${fixture.commentCid}/update`;
            const prototype = CommentClientsManager.prototype as unknown as FetchCidP2PHolder;
            const originalFetchCidP2P = prototype._fetchCidP2P;
            const fetchedAt: number[] = [];
            vi.spyOn(prototype, "_fetchCidP2P").mockImplementation(async function (this: FetchCidP2PHolder, path: string, opts: unknown) {
                if (path !== updatePath) return originalFetchCidP2P.call(this, path, opts);
                fetchedAt.push(Date.now());
                throw new PKCError("ERR_FETCH_CID_P2P_TIMEOUT", { cid: path, simulated: true });
            });

            const post = await pkc.createComment({ cid: fixture.commentCid });
            const errors: { code: string; updatingState: string }[] = [];
            post.on("error", (error) => errors.push({ code: (error as PKCError).code, updatingState: post.updatingState }));
            await post.update();
            await vi.waitFor(() => expect(fetchedAt).to.have.length(4), { timeout: waitForPostUpdateMs, interval: 50 });

            expect(post.state).to.equal("updating");
            expect(errors.slice(0, 3)).to.deep.equal(
                new Array(3).fill({
                    code: "ERR_FAILED_TO_FETCH_COMMENT_UPDATE_FROM_ALL_POST_UPDATES_RANGES",
                    updatingState: "waiting-retry"
                })
            );
            const gaps = fetchedAt.slice(1).map((time, i) => time - fetchedAt[i]);
            // Timers never fire early, and the lookup itself adds a little on top of each delay
            expect(gaps[0], `gaps: ${gaps.join(", ")}`).to.be.within(990, 1900);
            expect(gaps[1], `gaps: ${gaps.join(", ")}`).to.be.within(1990, 3900);
            expect(gaps[2], `gaps: ${gaps.join(", ")}`).to.be.within(3990, 7900);
            await post.stop();
        } finally {
            await pkc.destroy();
            await fixture.ipnsObj.pkc.destroy();
        }
    });

    it("stops retrying once the post is stopped", async () => {
        const fixture = await publishStaticCommunityWithPostInPages({ withPostOnlyInPostUpdates: true });
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
        try {
            const updatePath = `${fixture.postUpdatesFolderCid}/${fixture.commentCid}/update`;
            const prototype = CommentClientsManager.prototype as unknown as FetchCidP2PHolder;
            const originalFetchCidP2P = prototype._fetchCidP2P;
            let fetches = 0;
            vi.spyOn(prototype, "_fetchCidP2P").mockImplementation(async function (this: FetchCidP2PHolder, path: string, opts: unknown) {
                if (path !== updatePath) return originalFetchCidP2P.call(this, path, opts);
                fetches++;
                throw new PKCError("ERR_FETCH_CID_P2P_TIMEOUT", { cid: path, simulated: true });
            });

            const post = await pkc.createComment({ cid: fixture.commentCid });
            const errors: Error[] = [];
            post.on("error", (error) => errors.push(error as Error));
            await post.update();
            await vi.waitFor(() => expect(errors).to.have.length(1), { timeout: waitForPostUpdateMs, interval: 50 });

            await post.stop();
            const fetchesAtStop = fetches;
            await new Promise((resolve) => setTimeout(resolve, noRetryWindowMs));
            expect(fetches, "a stopped post fetched its update file again").to.equal(fetchesAtStop);
        } finally {
            await pkc.destroy();
            await fixture.ipnsObj.pkc.destroy();
        }
    });

    // The record is valid and simply has nothing to look in, so nothing failed to load: the post waits for the next
    // record without reporting an error, and there is nothing to retry against the same record.
    it("waits without an error when the community record has no postUpdates", async () => {
        const fixture = await publishStaticCommunityWithPostInPages({ withPostOnlyInPostUpdates: true });
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient();
        try {
            const prototype = CommentClientsManager.prototype as unknown as PostLookupHolder;
            const originalLookup = prototype.useCommunityPostUpdatesToFetchCommentUpdateForPost;
            let lookups = 0;
            vi.spyOn(prototype, "useCommunityPostUpdatesToFetchCommentUpdateForPost").mockImplementation(function (
                this: PostLookupHolder,
                record: CommunityIpfsType
            ) {
                lookups++;
                const recordWithoutPostUpdates = { ...record };
                delete recordWithoutPostUpdates.postUpdates;
                return originalLookup.call(this, recordWithoutPostUpdates);
            });

            const post = await pkc.createComment({ cid: fixture.commentCid });
            const errors: Error[] = [];
            post.on("error", (error) => errors.push(error as Error));
            const states: string[] = [];
            post.on("updatingstatechange", (state) => states.push(state));
            await post.update();
            await vi.waitFor(() => expect(lookups).to.equal(1), { timeout: waitForPostUpdateMs, interval: 50 });

            await new Promise((resolve) => setTimeout(resolve, noRetryWindowMs));
            expect(lookups, "the same record has no postUpdates however often it is read").to.equal(1);
            expect(errors, "nothing failed to load, so there is no error to report").to.deep.equal([]);
            expect(states, `states: ${states.join(", ")}`).to.include("waiting-retry");
            expect(states).to.not.include("failed");
            expect(post.updatedAt).to.be.undefined;
            await post.stop();
        } finally {
            await pkc.destroy();
            await fixture.ipnsObj.pkc.destroy();
        }
    });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { mockPKCNoDataPathWithOnlyKuboClient, mockGatewayPKC } from "../../../../../dist/node/test/test-util.js";
import validCommentFixture from "../../../../fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json" with { type: "json" };

import type { CommunityIpfsType } from "../../../../../dist/node/community/types.js";
import type { CommentIpfsType } from "../../../../../dist/node/publications/comment/types.js";

// Issue #312: when a newer community record arrives, handleUpdateEventFromCommunity aborts the previous invocation's
// signal so a superseded postUpdates lookup "bails early, so we don't keep retrying a stale postUpdate path". The lookup
// walks the record's time buckets in turn; a superseded one must not go on to the next bucket of its old record.
// The network is stubbed: the first bucket's fetch hangs until aborted, every later fetch fails at once.

const POST_CID = "QmPkc51WASdWFdLE1juN5AyBXPfys8NiX6EPYP54MMnuGj";
const FOLDER_A = "QmWydYYUKpCGS8y2HJxFrwFaF5ArKR7fyKMLrCm7eTSS94";
const FOLDER_B = "QmQ1QuFXJSu3YzZXY61zD9z3yoiZojo7HMKheKAfJPD1Zq";

type FetchOpts = { abortSignal?: AbortSignal };
interface CommentClientsManagerInternals {
    _resetFreshHandlerAbortController(): void;
    useCommunityPostUpdatesToFetchCommentUpdateForPost(record: CommunityIpfsType): Promise<void>;
    _fetchCidP2P(path: string, opts: FetchOpts): Promise<string>;
    fetchFromMultipleGateways(opts: unknown): Promise<unknown>;
    _resolveIpfsPathToCid(opts: unknown): Promise<string | undefined>;
}

describe("a superseded postUpdates lookup (#312)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("stops at the bucket it was fetching instead of moving on to the next bucket of its old record", async () => {
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient({});
        try {
            const comment = await pkc.createComment({ cid: POST_CID });
            comment._initIpfsProps(validCommentFixture as unknown as CommentIpfsType);
            comment.on("error", () => {}); // the lookup reports its failure as an error event
            expect(comment.postCid, "precondition: a post").to.equal(POST_CID);

            const manager = comment._clientsManager as unknown as CommentClientsManagerInternals;
            const requestedPaths: string[] = [];
            vi.spyOn(manager, "_resolveIpfsPathToCid").mockResolvedValue(undefined);
            vi.spyOn(manager, "_fetchCidP2P").mockImplementation((path: string, opts: FetchOpts) => {
                requestedPaths.push(path);
                if (requestedPaths.length > 1) return Promise.reject(Object.assign(new Error("No link found"), { code: "ERR_NOT_FOUND" }));
                return new Promise((_, reject) =>
                    opts.abortSignal?.addEventListener("abort", () => reject(opts.abortSignal!.reason), { once: true })
                );
            });

            // Both buckets cover the fixture's timestamp, smallest first
            const record = { postUpdates: { "100000000": FOLDER_A, "200000000": FOLDER_B } } as unknown as CommunityIpfsType;
            manager._resetFreshHandlerAbortController(); // what handleUpdateEventFromCommunity does for each record
            const lookup = manager.useCommunityPostUpdatesToFetchCommentUpdateForPost(record);
            await vi.waitFor(() => expect(requestedPaths).to.have.length(1));

            manager._resetFreshHandlerAbortController(); // a newer record arrives and supersedes the lookup
            await lookup;

            expect(requestedPaths, "the superseded lookup must not fetch its old record's next bucket").to.deep.equal([
                `${FOLDER_A}/${POST_CID}/update`
            ]);
        } finally {
            await pkc.destroy();
        }
    });
    // The lookup first resolves the post's file to a cid, to skip a file it already judged. A newer record can abort it
    // during that resolve, which gives up without throwing; the superseded lookup must then stop before it announces a
    // fetch, or the post is left at fetching-update-ipfs with nothing in flight until the next record.
    for (const transport of ["kubo", "gateway"] as const) {
        it(`does not announce a fetch when it is superseded while resolving the post's file cid (${transport})`, async () => {
            const pkc = transport === "kubo" ? await mockPKCNoDataPathWithOnlyKuboClient({}) : await mockGatewayPKC({});
            try {
                const comment = await pkc.createComment({ cid: POST_CID });
                comment._initIpfsProps(validCommentFixture as unknown as CommentIpfsType);
                comment.on("error", () => {});
                const updatingStates: string[] = [];
                comment.on("updatingstatechange", (state: string) => updatingStates.push(state));

                const manager = comment._clientsManager as unknown as CommentClientsManagerInternals;
                let resolveStarted = false;
                vi.spyOn(manager, "_resolveIpfsPathToCid").mockImplementation((opts: unknown) => {
                    resolveStarted = true;
                    const { abortSignal } = opts as FetchOpts;
                    return new Promise((resolve) => abortSignal?.addEventListener("abort", () => resolve(undefined), { once: true }));
                });
                const fetchSpy =
                    transport === "kubo"
                        ? vi.spyOn(manager, "_fetchCidP2P").mockRejectedValue(new Error("must not fetch"))
                        : vi.spyOn(manager, "fetchFromMultipleGateways").mockRejectedValue(new Error("must not fetch"));

                const record = { postUpdates: { "100000000": FOLDER_A } } as unknown as CommunityIpfsType;
                manager._resetFreshHandlerAbortController();
                const lookup = manager.useCommunityPostUpdatesToFetchCommentUpdateForPost(record);
                await vi.waitFor(() => expect(resolveStarted).to.equal(true));

                manager._resetFreshHandlerAbortController(); // a newer record arrives and supersedes the lookup
                await lookup;

                expect(fetchSpy, "the superseded lookup must not fetch").not.toHaveBeenCalled();
                expect(updatingStates, "the superseded lookup must not announce a fetch").to.not.include("fetching-update-ipfs");
            } finally {
                await pkc.destroy();
            }
        });
    }
});

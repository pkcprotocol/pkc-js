import { describe, it, expect, vi, afterEach } from "vitest";
import { mockPKCNoDataPathWithOnlyKuboClient } from "../../../../../dist/node/test/test-util.js";
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
});

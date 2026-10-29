import { describe, it, expect, vi, afterEach } from "vitest";
import { mockPKCNoDataPathWithOnlyKuboClient } from "../../../../../dist/node/test/test-util.js";
import validCommentFixture from "../../../../fixtures/signatures/comment/commentUpdate/valid_comment_ipfs.json" with { type: "json" };

import type { CommunityIpfsType } from "../../../../../dist/node/community/types.js";
import type { CommentIpfsType } from "../../../../../dist/node/publications/comment/types.js";

// Issue #312: before fetching a post's file from a changed bucket folder, the lookup resolves it to a cid to skip a file
// it already judged. That resolve walks the same folder blocks the fetch would. When they are unreachable it times out,
// and fetching from the same folder would only wait out a second full timeout, so the lookup must move on to the next
// bucket after one. The kubo client is stubbed: its resolve times out the way kubo-rpc-client does.

const POST_CID = "QmPkc51WASdWFdLE1juN5AyBXPfys8NiX6EPYP54MMnuGj";
const FOLDER_A = "QmWydYYUKpCGS8y2HJxFrwFaF5ArKR7fyKMLrCm7eTSS94";
const FOLDER_B = "QmQ1QuFXJSu3YzZXY61zD9z3yoiZojo7HMKheKAfJPD1Zq";

interface CommentClientsManagerInternals {
    _resetFreshHandlerAbortController(): void;
    useCommunityPostUpdatesToFetchCommentUpdateForPost(record: CommunityIpfsType): Promise<void>;
    _fetchCidP2P(path: string, opts: unknown): Promise<string>;
    getIpfsClientWithKuboRpcClientFunctions(): unknown;
}

describe("a postUpdates lookup whose file cid resolve times out (#312)", () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it("moves on to the next bucket instead of fetching from the folder it could not walk", async () => {
        const pkc = await mockPKCNoDataPathWithOnlyKuboClient({});
        try {
            const comment = await pkc.createComment({ cid: POST_CID });
            comment._initIpfsProps(validCommentFixture as unknown as CommentIpfsType);
            comment.on("error", () => {}); // the lookup reports its failure as an error event

            const manager = comment._clientsManager as unknown as CommentClientsManagerInternals;
            const resolvedPaths: string[] = [];
            const realIpfsClient = manager.getIpfsClientWithKuboRpcClientFunctions() as object;
            vi.spyOn(manager, "getIpfsClientWithKuboRpcClientFunctions").mockReturnValue({
                ...realIpfsClient,
                resolve: async (path: string) => {
                    resolvedPaths.push(path);
                    throw Object.assign(new Error("Request timed out"), { name: "TimeoutError" });
                }
            });
            const fetchSpy = vi.spyOn(manager, "_fetchCidP2P").mockRejectedValue(new Error("must not fetch"));

            // Both buckets cover the fixture's timestamp, smallest first
            const record = { postUpdates: { "100000000": FOLDER_A, "200000000": FOLDER_B } } as unknown as CommunityIpfsType;
            manager._resetFreshHandlerAbortController();
            await manager.useCommunityPostUpdatesToFetchCommentUpdateForPost(record);

            expect(resolvedPaths, "each bucket is tried once").to.deep.equal([
                `/ipfs/${FOLDER_A}/${POST_CID}/update`,
                `/ipfs/${FOLDER_B}/${POST_CID}/update`
            ]);
            expect(fetchSpy, "a folder the resolve timed out on is not fetched from").not.toHaveBeenCalled();
        } finally {
            await pkc.destroy();
        }
    });
});

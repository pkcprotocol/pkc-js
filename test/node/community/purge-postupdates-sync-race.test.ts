import { mockPKC, publishRandomPost, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { timestamp } from "../../../dist/node/util.js";
import { itSkipIfRpc } from "../../helpers/conditional-tests.js";
import { describe, beforeAll, afterAll, expect } from "vitest";
import {
    calculateNewCommentUpdate,
    syncPostUpdatesWithIpfs
} from "../../../dist/node/runtime/node/community/local-community/comment-updates.js";
import {
    addAllCidsUnderPurgedCommentToBeRemoved,
    rmUnneededMfsPaths
} from "../../../dist/node/runtime/node/community/local-community/cleanup.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// Reproduces the TOCTOU race between comment purge (storeCommentModeration) and the postUpdates
// MFS sync (syncPostUpdatesWithIpfs). A sync cycle can capture a post's CommentUpdate while the
// post is still live, then a concurrent purge deletes the post from the DB and removes its
// postUpdates MFS entry — and finally the in-flight sync writes the stale captured update back to
// MFS, resurrecting the purged post permanently (it is gone from the DB, so nothing cleans it up).
// See pkc-js issue #142.
describe("Purge vs postUpdates sync race", () => {
    let pkc: PKCType;

    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    const mfsPathExists = async (community: LocalCommunity, path: string): Promise<boolean> => {
        const kuboClient = community._clientsManager.getDefaultKuboRpcClient()._client;
        try {
            await kuboClient.files.stat(path);
            return true;
        } catch (e) {
            expect((e as Error).message).to.equal("file does not exist");
            return false;
        }
    };

    // RPC skipped: the test reaches into LocalCommunity internals (_dbHandler, _clientsManager) and
    // calls the low-level postUpdates sync/purge helpers directly. These only exist on the Node
    // LocalCommunity, not on the RPC community wrapper.
    itSkipIfRpc("an in-flight postUpdates sync that captured a post before it was purged must not resurrect it in MFS", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });

        const post = await publishRandomPost({ communityAddress: community.address, pkc });
        const postCid = post.cid;
        expect(postCid).to.be.a("string");

        // Wait until the community's sync loop has written the post's CommentUpdate to the
        // postUpdates MFS tree (mirrors the production state at purge time).
        let mfsPath: string | undefined;
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => {
                const bucket = community.postUpdates && Object.keys(community.postUpdates)[0];
                if (!bucket) return false;
                const candidate = `/${community.address}/postUpdates/${bucket}/${postCid}/update`;
                const exists = await mfsPathExists(community, candidate);
                if (exists) mfsPath = candidate;
                return exists;
            }
        });
        expect(mfsPath).to.be.a("string");

        // 1. Simulate a sync cycle that captured the post's CommentUpdate while it was still live
        //    (updateCommentsThatNeedToBeUpdated → calculateNewCommentUpdate).
        const commentRow = community._dbHandler.queryComment(postCid!);
        expect(commentRow, "post should still be in the DB before purge").to.exist;
        const capturedRow = await calculateNewCommentUpdate(community, commentRow!, timestamp());
        expect(capturedRow.localMfsPath, "captured row should target the post's postUpdates MFS path").to.equal(mfsPath);

        // 2. A purge moderation arrives and runs to completion (what storeCommentModeration does
        //    on commentModeration.purged=true): delete the post from the DB, queue its MFS path,
        //    and remove it from the postUpdates MFS tree.
        const purgedRows = community._dbHandler.purgeComment(postCid!);
        for (const purgedRow of purgedRows) await addAllCidsUnderPurgedCommentToBeRemoved(community, purgedRow);
        await rmUnneededMfsPaths(community);

        // The purge must have removed the post's postUpdates MFS entry.
        expect(await mfsPathExists(community, mfsPath!), "purge should have removed the postUpdates MFS entry").to.equal(false);

        // 3. The in-flight sync from step 1 now finishes and writes the captured (pre-purge) row.
        await syncPostUpdatesWithIpfs(community, [capturedRow]);

        // 4. The purged post must NOT be resurrected in the postUpdates MFS tree.
        expect(
            await mfsPathExists(community, mfsPath!),
            `purged post ${postCid} was resurrected in postUpdates MFS at ${mfsPath}`
        ).to.equal(false);

        await community.delete();
    });
});

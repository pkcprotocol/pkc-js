import { mockPKC, publishRandomPost, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { timestamp } from "../../../dist/node/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { beforeAll, afterAll, afterEach, it, expect, vi } from "vitest";
import {
    calculateNewCommentUpdate,
    syncPostUpdatesWithIpfs
} from "../../../dist/node/runtime/node/community/local-community/comment-updates.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

// Issue #590: a loading.update CI run timed out in every config. The fixture community's bucket swap was
// reported as done by Kubo and the bucket was then gone from MFS (the ipfs/kubo#11494 family), so
// writePostUpdatesToBucket threw ERR_POST_UPDATES_BUCKET_SWAP_WAS_LOST. Its guard ("a bucket that existed and
// is gone must not be answered by building one that holds these posts only") lives inside one call. The next
// cycle is a new call that sees no bucket and builds one from the posts of that cycle alone, and the posts
// that were already marked as published are never written again: clients got `No link "<post cid>" found
// under <bucket cid>` until the test timed out.
//
// RPC skipped: the test calls the low-level postUpdates sync on a LocalCommunity and reaches into its kubo
// client, neither of which exists on the RPC community wrapper.
describeSkipIfRpc("postUpdates bucket that vanishes from MFS after a swap that Kubo reported as done", () => {
    let pkc: PKCType;
    let community: LocalCommunity;
    let postA: Comment;
    let postB: Comment;
    let bucketPath: string;

    const kubo = () => community._clientsManager.getDefaultKuboRpcClient()._client;
    const existsInMfs = async (path: string): Promise<boolean> => {
        try {
            await kubo().files.stat(path);
            return true;
        } catch (e) {
            // Kubo prefixes the MFS path on some platforms (Windows CI: "<path>: file does not exist")
            expect((e as Error).message).to.match(/file does not exist$/);
            return false;
        }
    };
    const updateFileOf = (post: Comment) => `${bucketPath}/${post.cid}/update`;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        postA = await publishRandomPost({ communityAddress: community.address, pkc });
        postB = await publishRandomPost({ communityAddress: community.address, pkc });
        // The community's own cycle has written both posts' first CommentUpdate into the bucket
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => {
                const bucket = community.postUpdates && Object.keys(community.postUpdates)[0];
                if (!bucket) return false;
                bucketPath = `/${community.address}/postUpdates/${bucket}`;
                return (await existsInMfs(updateFileOf(postA))) && (await existsInMfs(updateFileOf(postB)));
            }
        });
    }, 120_000);

    afterEach(() => {
        vi.restoreAllMocks();
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("keeps the CommentUpdate of every post that was in the bucket, once the next cycle has written the bucket again", async () => {
        // The next generation of post A's CommentUpdate, as a cycle would calculate it
        await new Promise((resolve) => setTimeout(resolve, 1100)); // updatedAt is in seconds
        const row = await calculateNewCommentUpdate({
            community,
            comment: community._dbHandler.queryComment(postA.cid!)!,
            batchStartTimestamp: timestamp()
        });

        // The swap is reported as done and the bucket, with the rebuilt copy next to it, is gone from MFS
        const originalMv = kubo().files.mv.bind(kubo().files);
        vi.spyOn(kubo().files, "mv").mockImplementation(async (...args: Parameters<typeof originalMv>) => {
            await originalMv(...args);
            if (args[1] !== bucketPath) return;
            await kubo().files.rm(bucketPath, { recursive: true });
            if (await existsInMfs(String(args[0]))) await kubo().files.rm(String(args[0]), { recursive: true });
        });
        const error = await syncPostUpdatesWithIpfs(community, [row]).then(
            (): undefined => undefined,
            (e: PKCError) => e
        );
        expect(error?.code).to.equal("ERR_POST_UPDATES_BUCKET_SWAP_WAS_LOST");
        vi.restoreAllMocks(); // Kubo behaves again, as it did a second later in the CI run

        // The next cycle: a new post makes the community write its bucket
        const postC = await publishRandomPost({ communityAddress: community.address, pkc });
        await vi.waitFor(async () => expect(await existsInMfs(updateFileOf(postC)), "the new post's CommentUpdate").to.be.true, {
            timeout: 30_000,
            interval: 250
        });

        // Posts A and B were written before the loss, and clients read them through the bucket
        for (const [name, post] of [
            ["A", postA],
            ["B", postB]
        ] as const)
            await vi.waitFor(
                async () =>
                    expect(
                        await existsInMfs(updateFileOf(post)),
                        `post ${name}'s CommentUpdate is missing from the bucket the next cycle wrote`
                    ).to.be.true,
                { timeout: 30_000, interval: 250 }
            );
    }, 120_000);
});

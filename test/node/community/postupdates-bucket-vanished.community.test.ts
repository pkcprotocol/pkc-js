import { mockPKC, publishRandomPost, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { timestamp } from "../../../dist/node/util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { beforeAll, afterAll, afterEach, it, expect, vi } from "vitest";
import {
    calculateNewCommentUpdate,
    syncPostUpdatesWithIpfs,
    writePostUpdatesToMfs
} from "../../../dist/node/runtime/node/community/local-community/comment-updates.js";
import {
    addAllCidsUnderPurgedCommentToBeRemoved,
    rmUnneededMfsPaths
} from "../../../dist/node/runtime/node/community/local-community/cleanup.js";
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

    it("notices a vanished bucket when the community record is built, with no new post to write into it", async () => {
        await vi.waitFor(async () => expect(await existsInMfs(updateFileOf(postA))).to.be.true, { timeout: 30_000, interval: 250 });
        const bucket = bucketPath.split("/").pop()!;
        expect(community.postUpdates?.[bucket], "the last record lists the bucket").to.be.a("string");

        await kubo().files.rm(bucketPath, { recursive: true });
        expect(await existsInMfs(bucketPath)).to.be.false;

        // Nothing is published: an edit makes the community build a record, which stats the bucket
        const updatedAtBefore = community.updatedAt!;
        await community.edit({ description: `a record after the bucket vanished ${Date.now()}` });
        await vi.waitFor(() => expect(community.updatedAt).to.be.greaterThan(updatedAtBefore), { timeout: 30_000, interval: 250 });

        for (const [name, post] of [
            ["A", postA],
            ["B", postB]
        ] as const)
            await vi.waitFor(
                async () => expect(await existsInMfs(updateFileOf(post)), `post ${name}'s CommentUpdate was not written again`).to.be.true,
                { timeout: 30_000, interval: 250 }
            );
    }, 120_000);

    it("fails the cycle when the bucket vanishes between two slices of it, so the first slice is not acknowledged", async () => {
        await vi.waitFor(async () => expect(await existsInMfs(updateFileOf(postA))).to.be.true, { timeout: 30_000, interval: 250 });
        await new Promise((resolve) => setTimeout(resolve, 1100)); // updatedAt is in seconds
        const rowOf = (post: Comment) =>
            calculateNewCommentUpdate({
                community,
                comment: community._dbHandler.queryComment(post.cid!)!,
                batchStartTimestamp: timestamp()
            });
        const rowA = await rowOf(postA);
        const rowB = await rowOf(postB);

        // A cycle writes its posts slice by slice and acknowledges them all at its end: slice 1 is in the bucket
        // when the bucket vanishes, and slice 2 would build a bucket that holds its own posts only
        await writePostUpdatesToMfs(community, [rowA]);
        await kubo().files.rm(bucketPath, { recursive: true });
        const error = await writePostUpdatesToMfs(community, [rowB]).then(
            (): undefined => undefined,
            (e: PKCError) => e
        );
        expect(error?.code, "slice 2 was written into a bucket that no longer holds slice 1").to.equal(
            "ERR_POST_UPDATES_BUCKET_SWAP_WAS_LOST"
        );

        // Nothing was acknowledged, so the next cycle writes all of it
        await community.edit({ description: `a record after the lost slice ${Date.now()}` });
        for (const [name, post] of [
            ["A", postA],
            ["B", postB]
        ] as const)
            await vi.waitFor(
                async () => expect(await existsInMfs(updateFileOf(post)), `post ${name}'s CommentUpdate was not written again`).to.be.true,
                { timeout: 30_000, interval: 250 }
            );
    }, 120_000);

    it("notices a bucket that is still there and has lost the entries of some posts", async () => {
        await vi.waitFor(
            async () => {
                expect(await existsInMfs(updateFileOf(postA))).to.be.true;
                expect(await existsInMfs(updateFileOf(postB))).to.be.true;
            },
            { timeout: 30_000, interval: 250 }
        );
        // The last record lists the bucket
        await vi.waitFor(() => expect(community.postUpdates?.[bucketPath.split("/").pop()!]).to.be.a("string"), {
            timeout: 30_000,
            interval: 250
        });

        // Somebody else drops post A's entry: the bucket is there, with another cid, and without A
        await kubo().files.rm(`${bucketPath}/${postA.cid}`, { recursive: true });
        expect(await existsInMfs(updateFileOf(postB))).to.be.true;

        const updatedAtBefore = community.updatedAt!;
        await community.edit({ description: `a record after a post was lost ${Date.now()}` });
        await vi.waitFor(() => expect(community.updatedAt).to.be.greaterThan(updatedAtBefore), { timeout: 30_000, interval: 250 });
        await vi.waitFor(
            async () => expect(await existsInMfs(updateFileOf(postA)), "post A's CommentUpdate was not written again").to.be.true,
            {
                timeout: 30_000,
                interval: 250
            }
        );
        expect(await existsInMfs(updateFileOf(postB))).to.be.true;
    }, 120_000);
});

// The other side of the repair: a bucket whose only post was purged is not a loss. The purge deletes the post
// from the DB before it removes the MFS path, so there is nothing to rewrite, and no swap of the bucket may
// follow (Kubo leaves the emptied directory in place, so the bucket is not even absent).
//
// RPC skipped: the test calls the low-level purge cleanup on a LocalCommunity and reaches into its kubo client,
// neither of which exists on the RPC community wrapper.
describeSkipIfRpc("postUpdates bucket whose only post was purged", () => {
    let pkc: PKCType;
    let community: LocalCommunity;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    }, 120_000);

    afterEach(() => {
        vi.restoreAllMocks();
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("is not written again after the purge and the records that follow it", async () => {
        const post = await publishRandomPost({ communityAddress: community.address, pkc });
        const bucket = await vi.waitFor(
            async () => {
                const key = community.postUpdates && Object.keys(community.postUpdates)[0];
                expect(key, "the record lists the bucket").to.be.a("string");
                return key!;
            },
            { timeout: 30_000, interval: 250 }
        );
        const bucketPath = `/${community.address}/postUpdates/${bucket}`;
        const kubo = community._clientsManager.getDefaultKuboRpcClient()._client;
        const mvSpy = vi.spyOn(kubo.files, "mv");

        // What storeCommentModeration does for a purge: the DB row first, then the MFS paths
        for (const purgedRow of community._dbHandler.purgeComment(post.cid!))
            await addAllCidsUnderPurgedCommentToBeRemoved(community, purgedRow);
        await rmUnneededMfsPaths(community);

        // Records are built after the purge (an edit forces one) and more cycles run
        const updatedAtBefore = community.updatedAt!;
        await community.edit({ description: "a record after the purge" });
        await vi.waitFor(() => expect(community.updatedAt).to.be.greaterThan(updatedAtBefore), { timeout: 30_000, interval: 250 });
        await new Promise((resolve) => setTimeout(resolve, 3_000));

        expect(
            mvSpy.mock.calls.filter((args) => args[1] === bucketPath),
            "the bucket was swapped after its only post was purged"
        ).to.have.lengthOf(0);
        const postEntryStillInMfs = await kubo.files.stat(`${bucketPath}/${post.cid}/update`).then(
            () => true,
            () => false
        );
        expect(postEntryStillInMfs, "the purged post was written again").to.be.false;
    }, 120_000);
});

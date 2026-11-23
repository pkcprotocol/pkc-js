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

    const rowOf = (post: Comment) =>
        calculateNewCommentUpdate({ community, comment: community._dbHandler.queryComment(post.cid!)!, batchStartTimestamp: timestamp() });
    const waitForBothPostsInTheBucket = async () => {
        await vi.waitFor(
            async () => {
                expect(await existsInMfs(updateFileOf(postA))).to.be.true;
                expect(await existsInMfs(updateFileOf(postB))).to.be.true;
                expect(community._postUpdatesBucketCids.has(Number(bucketPath.split("/").pop())), "a bucket this process wrote").to.be.true;
            },
            { timeout: 30_000, interval: 250 }
        );
    };

    it("does not patch a bucket that lost the entry of a post into a baseline that hides the loss", async () => {
        await waitForBothPostsInTheBucket();
        await new Promise((resolve) => setTimeout(resolve, 1100)); // updatedAt is in seconds
        const rowB = await rowOf(postB);

        // Somebody else drops post A's entry. The cycle then writes another post into the same bucket, as it does
        // for the active bucket every time, and the patched bucket must not become what the bucket should be
        await kubo().files.rm(`${bucketPath}/${postA.cid}`, { recursive: true });
        const error = await writePostUpdatesToMfs(community, [rowB]).then(
            (): undefined => undefined,
            (e: PKCError) => e
        );
        expect(error?.code, "the bucket that had lost post A was patched as if it were whole").to.equal(
            "ERR_POST_UPDATES_BUCKET_SWAP_WAS_LOST"
        );

        await community.edit({ description: `a record after a patched partial loss ${Date.now()}` });
        await vi.waitFor(
            async () => expect(await existsInMfs(updateFileOf(postA)), "post A's CommentUpdate was not written again").to.be.true,
            {
                timeout: 30_000,
                interval: 250
            }
        );
    }, 120_000);

    it("fails the cycle when a removal in the vanished bucket comes between two slices of it", async () => {
        await waitForBothPostsInTheBucket();
        await new Promise((resolve) => setTimeout(resolve, 1100)); // updatedAt is in seconds
        const rowA = await rowOf(postA);
        const rowB = await rowOf(postB);

        await writePostUpdatesToMfs(community, [rowA]); // slice 1
        await kubo().files.rm(bucketPath, { recursive: true });
        // Slice 2 removes a path inside the bucket first (a purge, or a post that moved to a wider bucket)
        community._mfsPathsToRemove.add(`${bucketPath}/${"Qm" + "a".repeat(44)}`);
        const error = await writePostUpdatesToMfs(community, [rowB]).then(
            (): undefined => undefined,
            (e: PKCError) => e
        );
        expect(error?.code, "slice 2 built the bucket from its own posts").to.equal("ERR_POST_UPDATES_BUCKET_SWAP_WAS_LOST");

        await community.edit({ description: `a record after a removal between slices ${Date.now()}` });
        for (const post of [postA, postB])
            await vi.waitFor(
                async () => expect(await existsInMfs(updateFileOf(post)), "a CommentUpdate was not written again").to.be.true,
                {
                    timeout: 30_000,
                    interval: 250
                }
            );
    }, 120_000);

    it("still audits a bucket that lost a post when the first audit could not list it", async () => {
        await waitForBothPostsInTheBucket();
        await new Promise((resolve) => setTimeout(resolve, 1100)); // updatedAt is in seconds
        const rowB = await rowOf(postB);

        await kubo().files.rm(`${bucketPath}/${postA.cid}`, { recursive: true });
        vi.spyOn(kubo().files, "ls").mockImplementationOnce(() => {
            throw Error("the listing timed out");
        });
        await expect(writePostUpdatesToMfs(community, [rowB])).rejects.toThrow("the listing timed out");
        vi.restoreAllMocks();

        // The loss was not forgotten: the next write does not patch the bucket as if it were whole
        const error = await writePostUpdatesToMfs(community, [rowB]).then(
            (): undefined => undefined,
            (e: PKCError) => e
        );
        expect(error?.code, "the bucket that had lost post A was patched after its audit failed").to.equal(
            "ERR_POST_UPDATES_BUCKET_SWAP_WAS_LOST"
        );
        await community.edit({ description: `a record after a failed audit ${Date.now()}` });
        await vi.waitFor(
            async () => expect(await existsInMfs(updateFileOf(postA)), "post A's CommentUpdate was not written again").to.be.true,
            {
                timeout: 30_000,
                interval: 250
            }
        );
    }, 120_000);

    it("does not take a swap of its own that finished in the next cycle for a lost bucket", async () => {
        await waitForBothPostsInTheBucket();
        await new Promise((resolve) => setTimeout(resolve, 1100)); // updatedAt is in seconds
        const rowB = await rowOf(postB);

        // The mv fails after the cp and the rm: the daemon holds the rebuilt bucket in `.next` only
        const originalMv = kubo().files.mv.bind(kubo().files);
        vi.spyOn(kubo().files, "mv").mockImplementationOnce(async (...args: Parameters<typeof originalMv>) => {
            if (args[1] !== bucketPath) return originalMv(...args);
            throw Error("the mv timed out");
        });
        await expect(writePostUpdatesToMfs(community, [rowB])).rejects.toThrow("the mv timed out");
        vi.restoreAllMocks();

        // The next cycle finishes that swap, and the bucket it finds is the one this process built
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await writePostUpdatesToMfs(community, [await rowOf(postB)]);
        expect(await existsInMfs(updateFileOf(postB))).to.be.true;
        expect(await existsInMfs(updateFileOf(postA))).to.be.true;
    }, 120_000);

    it("does not fail the next write when a purge's rm timed out after the daemon applied it", async () => {
        await waitForBothPostsInTheBucket();
        const purged = await publishRandomPost({ communityAddress: community.address, pkc });
        await vi.waitFor(async () => expect(await existsInMfs(updateFileOf(purged))).to.be.true, { timeout: 30_000, interval: 250 });
        await new Promise((resolve) => setTimeout(resolve, 3_000)); // the cycle that wrote it is done
        await waitForBothPostsInTheBucket();

        // storeCommentModeration's purge: the DB row first, then the MFS path. The daemon applies the rm and the
        // client reports a timeout, so nothing is remembered and the path stays queued
        const originalRm = kubo().files.rm.bind(kubo().files);
        vi.spyOn(kubo().files, "rm").mockImplementationOnce(async (...args: Parameters<typeof originalRm>) => {
            await originalRm(...args);
            throw Error("the rm timed out");
        });
        for (const purgedRow of community._dbHandler.purgeComment(purged.cid!))
            await addAllCidsUnderPurgedCommentToBeRemoved(community, purgedRow);
        await expect(rmUnneededMfsPaths(community, { numOfRetries: 0 })).rejects.toThrow("the rm timed out");
        vi.restoreAllMocks();
        expect(await existsInMfs(updateFileOf(purged)), "the daemon applied the rm").to.be.false;

        // The next cycle writes post B again: nothing was lost, the bucket only holds what this process removed from it
        const errors: PKCError[] = [];
        const onError = (error: Error) => errors.push(error as PKCError);
        community.on("error", onError);
        try {
            community._dbHandler.forceUpdateOnAllCommentsWithCid([postB.cid!]);
            await new Promise((resolve) => setTimeout(resolve, 5_000));
        } finally {
            community.off("error", onError);
        }
        expect(
            errors.map((error) => error.code ?? error.message),
            "a cycle failed over a bucket that only lost what a purge removed"
        ).to.deep.equal([]);
        expect(await existsInMfs(updateFileOf(postA))).to.be.true;
        expect(await existsInMfs(updateFileOf(postB))).to.be.true;
    }, 120_000);

    it("does not keep explaining a changed bucket by a removal that was confirmed since", async () => {
        await waitForBothPostsInTheBucket();
        const bucket = Number(bucketPath.split("/").pop());
        community._postUpdatesBucketsWithUnconfirmedRemovals.add(bucket);

        // A retry of the removal succeeds against the bucket this process left
        community._mfsPathsToRemove.add(`${bucketPath}/${"Qm" + "b".repeat(44)}`);
        await rmUnneededMfsPaths(community);

        expect(community._postUpdatesBucketsWithUnconfirmedRemovals.has(bucket), "a confirmed removal still explains the bucket").to.be
            .false;
    }, 120_000);

    it("audits a bucket that MFS holds instead of the one swapped in, before patching it again", async () => {
        await waitForBothPostsInTheBucket();
        await new Promise((resolve) => setTimeout(resolve, 1100)); // updatedAt is in seconds
        const rowB = await rowOf(postB);

        // The swap is reported as done and MFS holds a third bucket, one without post A
        const originalMv = kubo().files.mv.bind(kubo().files);
        vi.spyOn(kubo().files, "mv").mockImplementationOnce(async (...args: Parameters<typeof originalMv>) => {
            await originalMv(...args);
            if (args[1] === bucketPath) await kubo().files.rm(`${bucketPath}/${postA.cid}`, { recursive: true });
        });
        const error = await writePostUpdatesToMfs(community, [rowB]).then(
            (): undefined => undefined,
            (e: PKCError) => e
        );
        vi.restoreAllMocks();
        expect(error?.code, "the bucket without post A was patched and taken for the bucket to expect").to.equal(
            "ERR_POST_UPDATES_BUCKET_SWAP_WAS_LOST"
        );

        await community.edit({ description: `a record after a third bucket ${Date.now()}` });
        await vi.waitFor(
            async () => expect(await existsInMfs(updateFileOf(postA)), "post A's CommentUpdate was not written again").to.be.true,
            {
                timeout: 30_000,
                interval: 250
            }
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

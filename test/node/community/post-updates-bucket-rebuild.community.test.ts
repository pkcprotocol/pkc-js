import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
    mockPKC,
    createSubWithNoChallenge,
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { SignerWithPublicKeyAddress } from "../../../dist/node/signer/index.js";
import type { CommentUpdateType } from "../../../dist/node/publications/comment/types.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// A slice with enough posts for one postUpdates bucket rebuilds the bucket in node and swaps it into MFS
// instead of writing its files one by one (issue #471). The threshold is lowered to one post here so every
// cycle takes that path on a small board; the published record must still point at a bucket that holds
// every post's current CommentUpdate, a swap an earlier process left half done must be finished or
// discarded, and a purge landing mid-rebuild must not be undone by the swap (issue #304).
//
// Skipped under RPC: the test instruments LocalCommunity internals (the rebuild threshold, the
// community's kubo files API and its MFS tree), which is impossible when the community lives in a
// separate RPC server process.
describeSkipIfRpc("postUpdates bucket rebuilt in node (issue #471)", () => {
    let pkc: PKC;
    let community: LocalCommunity;
    let moderatorSigner: SignerWithPublicKeyAddress;
    let restoreCp: (() => void) | undefined;
    const posts: Comment[] = [];
    let threePostBucketCid: string;

    const kubo = () => community._clientsManager.getDefaultKuboRpcClient()._client;
    const bucketPath = () => {
        const buckets = Object.keys(community.postUpdates ?? {});
        expect(buckets, "a small board has exactly one postUpdates bucket").to.have.lengthOf(1);
        return `/${community.address}/postUpdates/${buckets[0]}`;
    };
    const recordBucketCid = () => Object.values(community.postUpdates ?? {})[0];
    const mfsPathExists = async (path: string) => {
        try {
            await kubo().files.stat(path);
            return true;
        } catch (e) {
            expect((e as Error).message).to.include("file does not exist");
            return false;
        }
    };
    const listBucket = async (bucketCid: string): Promise<string[]> => {
        const names: string[] = [];
        for await (const entry of kubo().ls(bucketCid)) names.push(entry.name);
        return names.sort();
    };
    const readUpdate = async (bucketCid: string, postCid: string): Promise<CommentUpdateType> => {
        const chunks: Uint8Array[] = [];
        for await (const chunk of kubo().cat(`/ipfs/${bucketCid}/${postCid}/update`)) chunks.push(chunk);
        return JSON.parse(Buffer.concat(chunks).toString()) as CommentUpdateType;
    };
    // The record published after the cycle that wrote these posts points at a bucket listing all of them
    const waitForRecordBucketListing = async (postCids: string[]) => {
        const expected = [...postCids].sort();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => {
                const bucketCid = recordBucketCid();
                if (!bucketCid) return false;
                const listed = await listBucket(bucketCid);
                return expected.every((cid) => listed.includes(cid));
            }
        });
    };
    const publishPosts = async (count: number) => {
        const published = await Promise.all(
            Array.from({ length: count }, () => publishRandomPost({ communityAddress: community.address, pkc }))
        );
        for (const post of published) if (!post.cid) throw Error("Published post has no cid");
        posts.push(...published);
        return published;
    };
    const postCids = () => posts.map((post) => post.cid!);

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        community._postUpdatesNodeBuiltBucketMinPosts = 1; // every slice with a post rebuilds its bucket
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        moderatorSigner = await pkc.createSigner();
        await community.edit({ roles: { [moderatorSigner.address]: { role: "moderator" } } });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.roles?.[moderatorSigner.address]?.role === "moderator"
        });
    }, 120_000);

    afterAll(async () => {
        restoreCp?.();
        await community.delete();
        await pkc.destroy();
    });

    it("publishes a record whose bucket holds every post's CommentUpdate, with nothing left beside it", async () => {
        await publishPosts(3);
        await waitForRecordBucketListing(postCids());
        threePostBucketCid = recordBucketCid()!;
        expect(await listBucket(threePostBucketCid)).to.deep.equal([...postCids()].sort());
        for (const post of posts) {
            const update = await readUpdate(threePostBucketCid, post.cid!);
            expect(update.cid).to.equal(post.cid);
            expect(update.updatedAt).to.be.a("number");
            expect(update.signature.signature).to.be.a("string");
        }
        // The swap left neither its staging directory nor the pin that protected the import
        expect(await mfsPathExists(`${bucketPath()}.next`)).to.be.false;
        await expect(
            (async () => {
                for await (const pin of kubo().pin.ls({ paths: [threePostBucketCid] })) void pin;
            })()
        ).rejects.toThrow("not pinned");
    }, 120_000);

    it("keeps the other posts' files when a later slice rebuilds the bucket", async () => {
        const firstUpdate = await readUpdate(recordBucketCid()!, posts[0].cid!);
        await publishPosts(2);
        await waitForRecordBucketListing(postCids());
        const bucketCid = recordBucketCid()!;
        expect(bucketCid).to.not.equal(threePostBucketCid);
        expect(await listBucket(bucketCid)).to.deep.equal([...postCids()].sort());
        // A kept post's file is linked as it was: same bytes, not rewritten
        expect(await readUpdate(bucketCid, posts[0].cid!)).to.deep.equal(firstUpdate);
    }, 120_000);

    it("finishes a swap an earlier process left between taking the live bucket down and moving the new one in", async () => {
        const live = await kubo().files.stat(bucketPath());
        await kubo().files.cp(`/ipfs/${live.cid.toString()}`, `${bucketPath()}.next`, { flush: true });
        await kubo().files.rm(bucketPath(), { recursive: true });
        expect(await mfsPathExists(bucketPath())).to.be.false;

        await publishPosts(1);
        await waitForRecordBucketListing(postCids());
        expect(await listBucket(recordBucketCid()!), "the staged bucket was moved in and the new post written into it").to.deep.equal(
            [...postCids()].sort()
        );
        expect(await mfsPathExists(`${bucketPath()}.next`)).to.be.false;
    }, 120_000);

    it("discards a stale staged bucket left beside the live one", async () => {
        await kubo().files.cp(`/ipfs/${threePostBucketCid}`, `${bucketPath()}.next`, { flush: true });

        await publishPosts(1);
        await waitForRecordBucketListing(postCids());
        expect(await listBucket(recordBucketCid()!)).to.deep.equal([...postCids()].sort());
        expect(await mfsPathExists(`${bucketPath()}.next`)).to.be.false;
    }, 120_000);

    it("removes a kept post that was purged while the bucket was being rebuilt (issue #304)", async () => {
        const purgedPost = posts[0];
        const purgedEntryPath = `${bucketPath()}/${purgedPost.cid}`;
        const kuboFilesApi = kubo().files;
        const originalCp = kuboFilesApi.cp.bind(kuboFilesApi);
        restoreCp = () => {
            kuboFilesApi.cp = originalCp;
        };

        // The rebuild has listed the live bucket (the purged post among its kept entries) and is about to
        // swap the new one in. The purge runs to completion meanwhile: DB delete, then its own MFS cleanup
        // of the live bucket, which the swap is about to replace.
        const purgeWhileCpIsHeld = async () => {
            const purgeMod = await pkc.createCommentModeration({
                communityAddress: community.address,
                commentCid: purgedPost.cid!,
                commentModeration: { reason: "Purge mid-rebuild (issue #304)", purged: true },
                signer: moderatorSigner
            });
            await publishWithExpectedResult({ publication: purgeMod, expectedChallengeSuccess: true });
            const deadline = Date.now() + 60_000;
            while (community._dbHandler.commentExistsInDb(purgedPost.cid!)) {
                if (Date.now() > deadline) throw Error("Timed out waiting for the purge to delete the post from the DB");
                await sleep(100);
            }
            while (await mfsPathExists(`${purgedEntryPath}/update`)) {
                if (Date.now() > deadline) throw Error("Timed out waiting for the purge to remove the post's MFS entry");
                await sleep(100);
            }
        };

        let raceExercised = false;
        let purgeDuringHeldCp: Promise<void> | undefined;
        const interceptedCp = async (...args: Parameters<typeof originalCp>): Promise<void> => {
            const destination = args[1];
            if (!raceExercised && typeof destination === "string" && destination === `${bucketPath()}.next`) {
                raceExercised = true;
                purgeDuringHeldCp = purgeWhileCpIsHeld();
                await purgeDuringHeldCp;
            }
            return originalCp(...args);
        };
        kuboFilesApi.cp = interceptedCp as typeof kuboFilesApi.cp;

        // Make the next cycle rebuild the bucket for another post, with the purged one among the kept entries
        community._dbHandler.forceUpdateOnAllCommentsWithCid([posts[1].cid!]);
        const raceDeadline = Date.now() + 60_000;
        while (!raceExercised) {
            if (Date.now() > raceDeadline) throw Error("Timed out waiting for the sync loop to rebuild the bucket");
            await sleep(100);
        }
        await purgeDuringHeldCp;
        restoreCp();
        restoreCp = undefined;

        // The swap has put the purged post's entry back. The cycle's post-write re-check must take it out again.
        const cleanupDeadline = Date.now() + 45_000;
        while (await mfsPathExists(purgedEntryPath)) {
            if (Date.now() > cleanupDeadline)
                expect.fail(
                    `MFS path ${purgedEntryPath} still exists 45s after a purge landed mid-rebuild - the swap resurrected it for good`
                );
            await sleep(1000);
        }
        // The record that cycle publishes points at the cleaned bucket; the previous record may still be current here
        posts.shift();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => {
                const bucketCid = recordBucketCid();
                return typeof bucketCid === "string" && !(await listBucket(bucketCid)).includes(purgedPost.cid!);
            }
        });
        expect(await listBucket(recordBucketCid()!)).to.deep.equal([...postCids()].sort());
    }, 180_000);
});

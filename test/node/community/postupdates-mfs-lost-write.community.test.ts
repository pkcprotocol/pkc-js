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

// Issues #551 and #456: Kubo loses an MFS write that is still open when a directory above the file is
// flushed (ipfs/kubo#11494, tracked in #556). Directory.Flush() in boxo empties the directory's cache of
// open children, so the write's file descriptor is left pointing at an inode nothing references any more.
// `files rm` of a top-level entry (deleting any other community on the daemon) and every `files mv`/`cp`
// with flush flush the MFS root. files.write and the files.flush after it both succeeded, and the
// postUpdates folder kept the post's previous CommentUpdate: clients then loaded an update one generation
// behind the community's DB, with no later cycle to correct it.
//
// Post updates no longer go through files.write at all: the post's bucket is built in node and swapped in
// with cp, rm and mv, which hold nothing open, and the bucket MFS ends up with is checked against the cid
// that was swapped in.
//
// RPC skipped: the tests call the low-level postUpdates sync on a LocalCommunity and reach into its kubo
// client, neither of which exists on the RPC community wrapper.
describeSkipIfRpc("postUpdates sync vs MFS changes that Kubo reports as done and does not hold", () => {
    let pkc: PKCType;
    let community: LocalCommunity;
    let post: Comment;
    let bucketPath: string;
    let mfsPath: string;

    const kubo = () => community._clientsManager.getDefaultKuboRpcClient()._client;
    const readMfsFile = async (path: string): Promise<string | undefined> => {
        const chunks: Uint8Array[] = [];
        try {
            for await (const chunk of kubo().files.read(path)) chunks.push(chunk);
        } catch (e) {
            expect((e as Error).message).to.equal("file does not exist");
            return undefined;
        }
        return Buffer.concat(chunks).toString();
    };
    const updatedAtInMfs = async () => (JSON.parse((await readMfsFile(mfsPath))!) as { updatedAt: number }).updatedAt;
    // The next generation of the post's CommentUpdate, as a cycle would calculate it
    const calculateNextUpdateOfPost = async () => {
        const updatedAtBefore = await updatedAtInMfs();
        // A CommentUpdate's updatedAt is in seconds, and the next one has to be newer
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const row = await calculateNewCommentUpdate({
            community,
            comment: community._dbHandler.queryComment(post.cid!)!,
            batchStartTimestamp: timestamp()
        });
        expect(row.localMfsPath).to.equal(mfsPath);
        expect(row.newCommentUpdate.updatedAt).to.be.greaterThan(updatedAtBefore);
        return row;
    };
    // Puts the bucket back to what it was, the way a swap that MFS dropped would leave it
    const undoSwapsOfBucket = async ({ times }: { times: number }) => {
        const before = await kubo().files.stat(bucketPath);
        const originalMv = kubo().files.mv.bind(kubo().files);
        let undone = 0;
        return vi.spyOn(kubo().files, "mv").mockImplementation(async (...args: Parameters<typeof originalMv>) => {
            if (args[1] !== bucketPath || undone >= times) return originalMv(...args);
            undone++;
            await originalMv(...args);
            await kubo().files.rm(bucketPath, { recursive: true });
            await kubo().files.cp(`/ipfs/${before.cid.toString()}`, bucketPath, { flush: true });
        });
    };

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        // Two posts, so the bucket is there for the rm of a swap even when the other post's file is being written
        await publishRandomPost({ communityAddress: community.address, pkc });
        post = await publishRandomPost({ communityAddress: community.address, pkc });
        // The community's own cycle has written the post's first CommentUpdate
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => {
                const bucket = community.postUpdates && Object.keys(community.postUpdates)[0];
                if (!bucket) return false;
                const candidate = `/${community.address}/postUpdates/${bucket}/${post.cid}/update`;
                if ((await readMfsFile(candidate)) === undefined) return false;
                bucketPath = `/${community.address}/postUpdates/${bucket}`;
                mfsPath = candidate;
                return true;
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

    it("writes a post's CommentUpdate without files.write, while the MFS root is being flushed over and over", async () => {
        const row = await calculateNextUpdateOfPost();
        const writeSpy = vi.spyOn(kubo().files, "write");

        // Flushes the MFS root the way deleting another community does, for as long as the sync runs
        let syncing = true;
        let rootFlushes = 0;
        const flushRootRepeatedly = (async () => {
            while (syncing) {
                const otherTopLevelDirectory = `/lost-write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
                await kubo().files.mkdir(otherTopLevelDirectory, { parents: true });
                await kubo().files.rm(otherTopLevelDirectory, { recursive: true });
                rootFlushes++;
            }
        })();
        try {
            await syncPostUpdatesWithIpfs(community, [row]);
        } finally {
            syncing = false;
            await flushRootRepeatedly;
        }

        expect(rootFlushes, "the MFS root should have been flushed while the sync ran").to.be.greaterThan(0);
        expect(writeSpy, "a post CommentUpdate must not be written through an MFS file descriptor").not.toHaveBeenCalled();
        expect(await updatedAtInMfs()).to.equal(row.newCommentUpdate.updatedAt);
    });

    it("swaps the bucket in again when MFS does not hold the bucket the daemon reported as swapped in", async () => {
        const row = await calculateNextUpdateOfPost();
        const mvSpy = await undoSwapsOfBucket({ times: 1 });

        await syncPostUpdatesWithIpfs(community, [row]);

        expect(
            await updatedAtInMfs(),
            "the postUpdates folder still holds the post's previous CommentUpdate after a sync that reported success"
        ).to.equal(row.newCommentUpdate.updatedAt);
        const swapsOfBucket = mvSpy.mock.calls.filter((args) => args[1] === bucketPath);
        expect(swapsOfBucket, "one swap that was undone and one that held").to.have.lengthOf(2);
    });

    it("fails the sync, instead of marking the post as published, when MFS never holds the swapped bucket", async () => {
        const row = await calculateNextUpdateOfPost();
        const updatedAtBefore = await updatedAtInMfs();
        const mvSpy = await undoSwapsOfBucket({ times: Infinity });
        const markAsPublishedSpy = vi.spyOn(community._dbHandler, "markCommentsAsPublishedToPostUpdates");

        const error = await syncPostUpdatesWithIpfs(community, [row]).then(
            (): undefined => undefined,
            (e: PKCError) => e
        );

        expect(error?.code).to.equal("ERR_POST_UPDATES_BUCKET_SWAP_WAS_LOST");
        expect(error?.details.bucketPath).to.equal(bucketPath);
        expect(mvSpy.mock.calls.filter((args) => args[1] === bucketPath)).to.have.lengthOf(4);
        expect(markAsPublishedSpy).not.toHaveBeenCalled();
        expect(await updatedAtInMfs()).to.equal(updatedAtBefore);
    });
});

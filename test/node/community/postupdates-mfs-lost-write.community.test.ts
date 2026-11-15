import { mockPKC, publishRandomPost, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { timestamp } from "../../../dist/node/util.js";
import { itSkipIfRpc } from "../../helpers/conditional-tests.js";
import { describe, beforeAll, afterAll, expect, vi } from "vitest";
import {
    calculateNewCommentUpdate,
    syncPostUpdatesWithIpfs
} from "../../../dist/node/runtime/node/community/local-community/comment-updates.js";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";

// Issues #551 and #456: Kubo loses an MFS write that is still open when a directory above the file is
// flushed. Directory.Flush() in boxo empties the directory's cache of open children, so the write's file
// descriptor is left pointing at an inode nothing references any more, and with flush=false the close
// never tells the parent. `files rm` of a top-level entry (deleting any other community on the daemon)
// and every `files mv`/`cp` with flush flush the MFS root. files.write and the files.flush after it both
// succeed, and the postUpdates folder keeps the post's previous CommentUpdate: clients then load an
// update that is one generation behind the community's DB, with no later cycle to correct it.
describe("postUpdates sync vs a Kubo MFS write lost to a concurrent flush", () => {
    let pkc: PKCType;

    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    // RPC skipped: the test calls the low-level postUpdates sync on a LocalCommunity and reaches into its
    // kubo client, neither of which exists on the RPC community wrapper.
    itSkipIfRpc("a post's CommentUpdate whose MFS write was lost is written again before the sync returns", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        const post = await publishRandomPost({ communityAddress: community.address, pkc });
        const kuboClient = community._clientsManager.getDefaultKuboRpcClient()._client;
        const readMfsFile = async (path: string): Promise<string | undefined> => {
            const chunks: Uint8Array[] = [];
            try {
                for await (const chunk of kuboClient.files.read(path)) chunks.push(chunk);
            } catch (e) {
                expect((e as Error).message).to.equal("file does not exist");
                return undefined;
            }
            return Buffer.concat(chunks).toString();
        };

        // The community's own cycle has written the post's first CommentUpdate
        let mfsPath: string | undefined;
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => {
                const bucket = community.postUpdates && Object.keys(community.postUpdates)[0];
                if (!bucket) return false;
                const candidate = `/${community.address}/postUpdates/${bucket}/${post.cid}/update`;
                if ((await readMfsFile(candidate)) === undefined) return false;
                mfsPath = candidate;
                return true;
            }
        });
        const updatedAtInMfsBefore = JSON.parse((await readMfsFile(mfsPath!))!).updatedAt as number;

        // The next generation of the post's CommentUpdate, as a cycle would calculate it
        const row = await calculateNewCommentUpdate({
            community,
            comment: community._dbHandler.queryComment(post.cid!)!,
            batchStartTimestamp: timestamp()
        });
        expect(row.localMfsPath).to.equal(mfsPath);
        expect(row.newCommentUpdate.updatedAt).to.be.greaterThan(updatedAtInMfsBefore);

        // Hold the cycle's write of that file open in the daemon, and meanwhile flush the MFS root the way
        // deleting another community does. Only the first write is held: a write the sync repeats goes through.
        const otherTopLevelDirectory = `/lost-write-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        await kuboClient.files.mkdir(otherTopLevelDirectory, { parents: true });
        const originalWrite = kuboClient.files.write.bind(kuboClient.files);
        const writeSpy = vi.spyOn(kuboClient.files, "write").mockImplementationOnce(async (path, content, options) => {
            expect(path).to.equal(mfsPath);
            let rootFlushed: Promise<void> | undefined;
            const heldOpenBody = async function* () {
                yield typeof content === "string" ? new TextEncoder().encode(content) : (content as Uint8Array);
                // Give the daemon time to open the file descriptor before the root is flushed. If it has
                // not, nothing is lost and the test passes without exercising the bug: it cannot fail falsely.
                await new Promise((resolve) => setTimeout(resolve, 500));
                rootFlushed = kuboClient.files.rm(otherTopLevelDirectory, { recursive: true });
                await rootFlushed;
            };
            await originalWrite(path, heldOpenBody(), options);
            expect(rootFlushed, "the MFS root should have been flushed while the write was open").to.not.be.undefined;
        });

        try {
            await syncPostUpdatesWithIpfs(community, [row]);
        } finally {
            writeSpy.mockRestore();
            await kuboClient.files.rm(otherTopLevelDirectory, { recursive: true }).catch((): undefined => undefined);
        }

        const updateInMfs = JSON.parse((await readMfsFile(mfsPath!))!) as { updatedAt: number };
        expect(
            updateInMfs.updatedAt,
            "the postUpdates folder still holds the post's previous CommentUpdate after a sync that reported success"
        ).to.equal(row.newCommentUpdate.updatedAt);

        await community.delete();
    });
});

import {
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    createSubWithNoChallenge,
    mockPKC
} from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { SignerWithPublicKeyAddress } from "../../../../dist/node/signer/index.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Deterministic repro of issue #304: a purge that lands between syncPostUpdatesWithIpfs's
// commentExistsInDb filter and its MFS writes gets resurrected. The purge's own MFS cleanup has
// already run by the time the held write goes through, and the comment is gone from the DB, so on
// buggy code nothing ever removes the resurrected postUpdates entry again.
//
// Skipped under RPC: the test instruments LocalCommunity internals (wraps the community's kubo
// files.write and reads _dbHandler/_mfsPathsToRemove), which is impossible when the community
// lives in a separate RPC server process.
describeSkipIfRpc("Purge landing during postUpdates MFS writes (issue #304)", () => {
    let pkc: PKC;
    let community: LocalCommunity;
    let moderatorSigner: SignerWithPublicKeyAddress;
    let post: Comment;
    let postMfsPath: string;
    let restoreWrite: (() => void) | undefined;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });

        moderatorSigner = await pkc.createSigner();
        await community.edit({ roles: { [moderatorSigner.address]: { role: "moderator" } } });
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.roles?.[moderatorSigner.address]?.role === "moderator"
        });

        post = await publishRandomPost({ communityAddress: community.address, pkc });
        if (!post.cid) throw Error("Published post has no cid");

        // Wait until the post's CommentUpdate has landed in the community's postUpdates MFS directory
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.postUpdates === "object" && Object.keys(community.postUpdates).length > 0
        });
        const postUpdatesBuckets = Object.keys(community.postUpdates!);
        expect(postUpdatesBuckets.length).to.equal(1);
        postMfsPath = `/${community.address}/postUpdates/${postUpdatesBuckets[0]}/${post.cid}/update`;

        const kuboFilesApi = community._clientsManager.getDefaultKuboRpcClient()._client.files;
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => {
                try {
                    await kuboFilesApi.stat(postMfsPath);
                    return true;
                } catch {
                    return false;
                }
            }
        });
    });

    afterAll(async () => {
        restoreWrite?.();
        await community.delete();
        await pkc.destroy();
    });

    it(`Purged post's postUpdates MFS entry is removed even when the purge lands mid-write`, async () => {
        const kuboRpcClient = community._clientsManager.getDefaultKuboRpcClient()._client;
        const kuboFilesApi = kuboRpcClient.files;
        const originalWrite = kuboFilesApi.write.bind(kuboFilesApi);
        restoreWrite = () => {
            kuboFilesApi.write = originalWrite;
        };

        const purgeWhileWriteIsHeld = async () => {
            const purgeMod = await pkc.createCommentModeration({
                communityAddress: community.address,
                commentCid: post.cid,
                commentModeration: { reason: "Purge mid-sync (issue #304)", purged: true },
                signer: moderatorSigner
            });
            await publishWithExpectedResult({ publication: purgeMod, expectedChallengeSuccess: true });

            // The purge must have finished both its DB delete and its MFS cleanup before the held
            // write is released, otherwise the interleaving under test is not reproduced
            const deadline = Date.now() + 60_000;
            while (community._dbHandler.commentExistsInDb(post.cid!)) {
                if (Date.now() > deadline) throw Error("Timed out waiting for the purge to delete the post from the DB");
                await sleep(100);
            }
            while (true) {
                try {
                    await kuboFilesApi.stat(postMfsPath);
                } catch (e) {
                    expect((e as Error).message).to.equal("file does not exist");
                    break; // the purge's rmUnneededMfsPaths removed the entry
                }
                if (Date.now() > deadline) throw Error("Timed out waiting for the purge to remove the post's MFS entry");
                await sleep(100);
            }
        };

        let raceExercised = false;
        let purgeDuringHeldWrite: Promise<void> | undefined;
        const interceptedWrite = async (...args: Parameters<typeof originalWrite>): Promise<void> => {
            const path = args[0];
            if (!raceExercised && typeof path === "string" && path === postMfsPath) {
                raceExercised = true;
                purgeDuringHeldWrite = purgeWhileWriteIsHeld();
                await purgeDuringHeldWrite;
            }
            return originalWrite(...args);
        };
        kuboFilesApi.write = interceptedWrite as typeof kuboFilesApi.write;

        // Make the next sync cycle rewrite the post's CommentUpdate so the interceptor gets to hold
        // that exact write while the purge runs to completion
        community._dbHandler.forceUpdateOnAllCommentsWithCid([post.cid!]);

        const raceDeadline = Date.now() + 60_000;
        while (!raceExercised) {
            if (Date.now() > raceDeadline) throw Error("Timed out waiting for the sync loop to write the post's CommentUpdate");
            await sleep(100);
        }
        await purgeDuringHeldWrite;
        restoreWrite();
        restoreWrite = undefined;

        // The held write has now resurrected the purged post's update file. Fixed code detects the
        // mid-write purge in the same sync cycle and removes the entry; buggy code leaves it forever
        const cleanupDeadline = Date.now() + 45_000;
        while (true) {
            try {
                await kuboFilesApi.stat(postMfsPath);
            } catch (e) {
                expect((e as Error).message).to.equal("file does not exist");
                return; // entry removed, race closed
            }
            if (Date.now() > cleanupDeadline)
                expect.fail(
                    `MFS path ${postMfsPath} still exists 45s after a purge landed mid-write - resurrected entry was never cleaned up`
                );
            await sleep(1000);
        }
    });
});

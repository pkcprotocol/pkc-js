import {
    publishRandomPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    createSubWithNoChallenge,
    mockPKC
} from "../../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { it, beforeAll, afterAll, expect } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { SignerWithPublicKeyAddress } from "../../../../dist/node/signer/index.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Deterministic repro of issue #336: a purge that lands while a publish cycle is in flight (after
// the cycle's name.publish, before it reassigns community.updateCid) reads a STALE
// community.updateCid in storeCommentModeration, so the cid it queues for the purge flush is the
// already-superseded record, not the just-published record that still embeds the purged comment.
// That record's cid only enters _cidsToUnPin at the tail of the NEXT cycle, after that cycle's
// unpinStaleCids already consumed the pending-purge flag, so on buggy code it sits pinned under
// the 30-minute unpin grace of issue #305 with nothing left to flush it: the purged content stays
// pinned on the community's kubo node. This is the exact interleaving behind the purged.test.ts
// CI failures on run 33748582879.
//
// Skipped under RPC: the test wraps the community-side kubo name.publish and reads
// LocalCommunity internals (_dbHandler, _clientsManager), which is impossible when the community
// lives in a separate RPC server process.
describeSkipIfRpc("Purge flush unpins the pre-purge community update cid (issue #336)", () => {
    let pkc: PKC;
    let community: LocalCommunity;
    let moderatorSigner: SignerWithPublicKeyAddress;
    let post: Comment;
    let restorePublish: (() => void) | undefined;

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

        // Wait until the live community record embeds the post, so every record published from
        // here until the purge deletes it references the soon-to-be-purged comment
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => community.lastPostCid === post.cid
        });
    });

    afterAll(async () => {
        restorePublish?.();
        await community.delete();
        await pkc.destroy();
    });

    it("A record published moments before the purge is unpinned by the purge flush", async () => {
        const kuboClient = community._clientsManager.getDefaultKuboRpcClient()._client;
        const isPinned = async (cid: string): Promise<boolean> => {
            for await (const pin of kuboClient.pin.ls()) if (pin.cid.toString() === cid) return true;
            return false;
        };

        const purgeWhilePublishCycleIsInFlight = async () => {
            const purgeMod = await pkc.createCommentModeration({
                communityAddress: community.address,
                commentCid: post.cid,
                commentModeration: { reason: "Purge landing mid-publish-cycle (issue #336)", purged: true },
                signer: moderatorSigner
            });
            await publishWithExpectedResult({ publication: purgeMod, expectedChallengeSuccess: true });

            // The purge must have run its storeCommentModeration (DB delete + unpin queueing,
            // which reads the stale community.updateCid) before the held cycle proceeds to its
            // unpinStaleCids, otherwise the interleaving under test is not reproduced
            const deadline = Date.now() + 60_000;
            while (community._dbHandler.commentExistsInDb(post.cid!)) {
                if (Date.now() > deadline) throw Error("Timed out waiting for the purge to delete the post from the DB");
                await sleep(100);
            }
        };

        const namesysApi = kuboClient.name;
        const originalPublish = namesysApi.publish.bind(namesysApi);
        restorePublish = () => {
            namesysApi.publish = originalPublish;
        };

        let raceExercised = false;
        let recordCidLiveDuringPurge: string | undefined;
        let purgeDuringHeldCycle: Promise<void> | undefined;
        const interceptedPublish = async (...args: Parameters<typeof originalPublish>): ReturnType<typeof originalPublish> => {
            const res = await originalPublish(...args);
            if (!raceExercised) {
                raceExercised = true;
                // The record just published under args[0] was generated while the post was still
                // in the DB, so it embeds the comment about to be purged. Hold the cycle here
                // (before its unpinStaleCids and its community.updateCid reassignment) until the
                // purge has fully landed, mirroring the CI interleaving.
                recordCidLiveDuringPurge = String(args[0]).replace("/ipfs/", "");
                purgeDuringHeldCycle = purgeWhilePublishCycleIsInFlight();
                await purgeDuringHeldCycle;
            }
            return res;
        };
        namesysApi.publish = interceptedPublish as typeof namesysApi.publish;

        // Make the next sync cycle regenerate the post's CommentUpdate and publish a new record
        // embedding the post, so the interceptor gets to hold that exact cycle while the purge
        // runs to completion
        community._dbHandler.forceUpdateOnAllCommentsWithCid([post.cid!]);

        const raceDeadline = Date.now() + 60_000;
        while (!raceExercised) {
            if (Date.now() > raceDeadline) throw Error("Timed out waiting for the sync loop to publish a record with the post");
            await sleep(100);
        }
        await purgeDuringHeldCycle;
        restorePublish();
        restorePublish = undefined;
        if (!recordCidLiveDuringPurge) throw Error("Interceptor did not capture the published record cid");

        expect(
            await isPinned(recordCidLiveDuringPurge),
            "the record published right before the purge should be pinned while it is the live record"
        ).to.be.true;

        // Wait for the record published during the purge to be superseded by a post-purge record:
        // its superseding cycle is the last one that can flush it
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () =>
                typeof community.updateCid === "string" &&
                community.updateCid !== recordCidLiveDuringPurge &&
                !community._dbHandler.commentExistsInDb(post.cid!)
        });

        // Fixed code queues the superseded record before the flush and keeps the purge flush
        // armed across the cycle the purge landed in, so the record is unpinned within a cycle
        // or two; the bounded retry only absorbs kubo latency. On buggy code the record enters
        // the queue after the flush already consumed the pending-purge flag and sits under the
        // 30-minute unpin grace, and nothing else flushes it in this test
        const unpinDeadline = Date.now() + 30_000;
        while (await isPinned(recordCidLiveDuringPurge)) {
            if (Date.now() > unpinDeadline)
                expect.fail(
                    `community update cid ${recordCidLiveDuringPurge} embedding the purged comment is still pinned 30s after being superseded post-purge - the purge flush missed it and the unpin grace period is holding the purged content pinned`
                );
            await sleep(500);
        }
    });
});

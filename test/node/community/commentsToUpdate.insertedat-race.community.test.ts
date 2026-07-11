import { mockPKC, createSubWithNoChallenge, publishRandomPost } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { beforeAll, afterAll, it, expect, vi } from "vitest";
import { timestamp } from "../../../dist/node/util.js";
import {
    storeVote,
    storeComment,
    storeCommentEdit,
    storeCommentModeration
} from "../../../dist/node/runtime/node/community/local-community/publication-store.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";

// Regression tests for issue #209: queryCommentsToBeUpdated() flags a comment when a publication
// row is at least as new as the stored CommentUpdate row (pub.insertedAt >= cu.insertedAt, both
// second-granularity). calculateNewCommentUpdate() reads the aggregates, then does async page
// generation + signing, and used to stamp the CommentUpdate row's insertedAt at row-build time.
// A publication inserted after the aggregate read but before the stamp is not part of the
// calculated update, and when the stamp lands in a later second the publication compares as
// "older" forever: the comment is never re-flagged and the publication stays invisible to the
// update pipeline until unrelated DB churn re-flags the comment (observed in CI with a mod ban).
//
// Each test drives that exact interleaving deterministically: a trigger vote flags the post, and
// once the sync loop is calculating the post's update (aggregates already read, page generation
// running), the racing publication is inserted and the calculation is held until the clock enters
// the next second, so the CommentUpdate row's insertedAt lands strictly after the racing row's.
//
// Uses LocalCommunity internals (_dbHandler, _pageGenerator) which live server-side under RPC and
// are unreachable from the client, so this cannot run under RPC.
describeSkipIfRpc(
    "queryCommentsToBeUpdated does not miss publications inserted during a concurrent CommentUpdate calculation (issue #209)",
    () => {
        let pkc: PKC;
        let community: LocalCommunity;

        // Not used by the store* functions, they only need it for their signature
        const dummyChallengeRequestId = new Uint8Array(32);

        beforeAll(async () => {
            pkc = await mockPKC();
            community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
            await community.start();
            await pollUntil(() => typeof community.updatedAt === "number", 60000, "community never published its first record");
        });

        afterAll(async () => {
            await community.delete();
            await pkc.destroy();
        });

        async function pollUntil(condition: () => boolean, timeoutMs: number, failureMessage: string): Promise<void> {
            const start = Date.now();
            while (!condition()) {
                if (Date.now() - start >= timeoutMs) throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${failureMessage}`);
                await new Promise((resolve) => setTimeout(resolve, 100));
            }
        }

        async function publishPostAndWaitForSteadyState(): Promise<Comment & { cid: string }> {
            const post = await publishRandomPost({ communityAddress: community.address, pkc });
            expect(post.cid).to.be.a("string");
            // Steady state = the post's CommentUpdate row exists and nothing is flagged for update
            // (queryCommentsToBeUpdated includes rows not yet published to MFS, so an empty result
            // also means the previous cycle fully completed).
            await pollUntil(
                () =>
                    community._dbHandler.queryStoredCommentUpdate({ cid: post.cid! }) !== undefined &&
                    community._dbHandler.queryCommentsToBeUpdated().length === 0,
                60000,
                `post ${post.cid} never reached a steady-state CommentUpdate`
            );
            return post as Comment & { cid: string };
        }

        // Reproduce the race: flag `post` with a trigger vote, and when the sync loop is mid-calculation
        // for it (aggregates already read), insert the racing publication and hold the calculation until
        // the next second so the CommentUpdate row's insertedAt stamps strictly after the racing row's.
        async function insertPublicationDuringCommentUpdateCalculation(
            post: Comment & { cid: string },
            insertRacingPublication: () => Promise<void>
        ): Promise<void> {
            const pageGenerator = community._pageGenerator;
            const originalGeneratePostPages = pageGenerator.generatePostPages.bind(pageGenerator);
            let racePromise: Promise<void> | undefined;

            const spy = vi
                .spyOn(pageGenerator, "generatePostPages")
                .mockImplementation(async (...args: Parameters<typeof originalGeneratePostPages>) => {
                    // generatePostPages runs after queryCalculatedCommentUpdate read the aggregates and
                    // before the row's insertedAt is stamped — exactly the window the bug needs.
                    if (args[0].cid === post.cid && racePromise === undefined) {
                        racePromise = (async () => {
                            await insertRacingPublication();
                            const secondOfInsertion = timestamp();
                            // Hold the calculation until the clock enters the next second, so the
                            // CommentUpdate row's insertedAt > racing row's insertedAt.
                            while (timestamp() <= secondOfInsertion) await new Promise((resolve) => setTimeout(resolve, 50));
                        })();
                        await racePromise;
                    }
                    return originalGeneratePostPages(...args);
                });

            try {
                // Flag the post so the next sync cycle recalculates its CommentUpdate. Stored through
                // the same code path the challenge flow uses.
                const triggerVote = await pkc.createVote({
                    commentCid: post.cid,
                    communityAddress: community.address,
                    vote: 1,
                    signer: await pkc.createSigner()
                });
                expect(triggerVote.raw.pubsubMessageToPublish).to.exist;
                await storeVote(community, triggerVote.raw.pubsubMessageToPublish!, dummyChallengeRequestId);

                await pollUntil(() => racePromise !== undefined, 30000, "the sync loop never started recalculating the post");
                await racePromise;
            } finally {
                spy.mockRestore();
            }
        }

        it("a CommentModeration inserted during the calculation is reflected in a subsequent CommentUpdate", async () => {
            const post = await publishPostAndWaitForSteadyState();

            const moderation = await pkc.createCommentModeration({
                commentCid: post.cid,
                communityAddress: community.address,
                commentModeration: { pinned: true },
                signer: await pkc.createSigner()
            });
            expect(moderation.raw.pubsubMessageToPublish).to.exist;

            await insertPublicationDuringCommentUpdateCalculation(post, async () => {
                await storeCommentModeration(community, moderation.raw.pubsubMessageToPublish!, dummyChallengeRequestId);
            });

            await pollUntil(
                () => Boolean(community._dbHandler.queryStoredCommentUpdate({ cid: post.cid })?.pinned),
                20000,
                `CommentUpdate of ${post.cid} never picked up the CommentModeration (pinned=true) inserted during the calculation`
            );
        }, 120000);

        it("a Vote inserted during the calculation is reflected in a subsequent CommentUpdate", async () => {
            const post = await publishPostAndWaitForSteadyState();

            const racingVote = await pkc.createVote({
                commentCid: post.cid,
                communityAddress: community.address,
                vote: 1,
                signer: await pkc.createSigner()
            });
            expect(racingVote.raw.pubsubMessageToPublish).to.exist;

            await insertPublicationDuringCommentUpdateCalculation(post, async () => {
                await storeVote(community, racingVote.raw.pubsubMessageToPublish!, dummyChallengeRequestId);
            });

            // Trigger vote (+1) and racing vote (+1)
            await pollUntil(
                () => community._dbHandler.queryStoredCommentUpdate({ cid: post.cid })?.upvoteCount === 2,
                20000,
                `CommentUpdate of ${post.cid} never picked up the Vote inserted during the calculation (upvoteCount stuck below 2)`
            );
        }, 120000);

        it("a CommentEdit inserted during the calculation is reflected in a subsequent CommentUpdate", async () => {
            const post = await publishPostAndWaitForSteadyState();

            const editedContent = `edited content ${Date.now()}`;
            const edit = await pkc.createCommentEdit({
                commentCid: post.cid,
                communityAddress: community.address,
                content: editedContent,
                signer: post.signer // author edit
            });
            expect(edit.raw.pubsubMessageToPublish).to.exist;

            await insertPublicationDuringCommentUpdateCalculation(post, async () => {
                await storeCommentEdit(community, edit.raw.pubsubMessageToPublish!, dummyChallengeRequestId);
            });

            await pollUntil(
                () => community._dbHandler.queryStoredCommentUpdate({ cid: post.cid })?.edit?.content === editedContent,
                20000,
                `CommentUpdate of ${post.cid} never picked up the CommentEdit inserted during the calculation`
            );
        }, 120000);

        // A reply inserted during the parent's calculation cannot wedge like the other three: the reply
        // has no comment_updates row yet, so the next cycle flags it unconditionally and parent_chain
        // pulls the parent in with it. This test locks that self-healing behavior for the child-comment
        // clause of queryCommentsToBeUpdated.
        it("a reply inserted during the parent post's calculation is reflected in a subsequent CommentUpdate of the parent", async () => {
            const post = await publishPostAndWaitForSteadyState();

            const reply = await pkc.createComment({
                parentCid: post.cid,
                postCid: post.cid,
                communityAddress: community.address,
                content: `racing reply ${Date.now()}`,
                signer: await pkc.createSigner()
            });
            expect(reply.raw.pubsubMessageToPublish).to.exist;

            await insertPublicationDuringCommentUpdateCalculation(post, async () => {
                await storeComment(community, { commentPubsub: reply.raw.pubsubMessageToPublish! });
            });

            await pollUntil(
                () => community._dbHandler.queryStoredCommentUpdate({ cid: post.cid })?.replyCount === 1,
                20000,
                `CommentUpdate of ${post.cid} never picked up the reply inserted during the calculation (replyCount stuck at 0)`
            );
        }, 120000);
    }
);

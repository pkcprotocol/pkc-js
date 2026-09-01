import signers from "../../../../fixtures/signers.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
    getAvailablePKCConfigsToTestAgainst,
    publishRandomPost,
    publishRandomReply,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue
} from "../../../../../dist/node/test/test-util.js";

import type { PKC as PKCType } from "../../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../../dist/node/publications/comment/comment.js";
import type { RemoteCommunity } from "../../../../../dist/node/community/remote-community.js";
import type { CommentIpfsWithCidDefined } from "../../../../../dist/node/publications/comment/types.js";

// Repro suite for issue #312: comments carry no polling timer (handleUpdateEventFromCommunity
// runs once per community update event), but what each invocation does for a post whose
// CommentUpdate did NOT change is almost entirely wasted:
// 1. a post found in the community's preloaded pages with an unchanged updatedAt still falls
//    into useCommunityPostUpdatesToFetchCommentUpdateForPost (the pages hit only short-circuits
//    when the pages copy is strictly newer), and
// 2. the postUpdates folder-cid dedupe (didLastPostUpdateRangeHaveSameFolderCid) only engages
//    when _commentUpdateIpfsPath was set by a previous postUpdates fetch (never set by a
//    pages-served post) and its granularity is the whole timestamp bucket, so any unrelated
//    activity in the bucket re-triggers a walk for every updating post in it.
// Net effect, measured in test/benchmarks/comment-update-fetch-bench.test.ts: one full
// <folderCid>/<postCid>/update network walk plus signature verification per community update per
// idle post, 100% discarded, and a fetching-update-ipfs -> waiting-retry updatingstatechange
// cycle per walk.
//
// The waste pin below is marked it.fails: it asserts the DESIRED behavior (no per-post
// postUpdates walk and no state churn when the post's CommentUpdate did not change), which the
// current code fails, so the suite stays green in CI while the bug exists. The moment the #312
// fix lands, the inverted test starts failing and the .fails flag must be removed, turning it
// into the fix's regression pin. The delivery test is a plain green pin guarding that fix
// against over-deduping.
//
// remote-libp2pjs only: the waste exists on the kubo path too (same shared code in
// comment-client-manager), but the network-fetch oracle instruments the libp2p-js client's cat.
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-libp2pjs"] }).map((config) => {
    describe(`comment updates are change-driven, not per-community-update refetches (issue #312) - ${config.name}`, () => {
        let pkc: PKCType;
        let publisherPkc: Awaited<ReturnType<typeof mockPKCNoDataPathWithOnlyKuboClient>>;
        const commentsToStop: Comment[] = [];
        const communitiesToStop: RemoteCommunity[] = [];

        beforeAll(async () => {
            // Production updateInterval so community updates arrive via gossip push (issue #308)
            // rather than the test default's 500ms safety-net polling.
            pkc = await config.pkcInstancePromise({ pkcOptions: { updateInterval: 60_000 } });
            // Publishing runs on a separate kubo-backed pkc so the measuring client's cat()
            // counts are not polluted by the publishing flow's own fetches.
            publisherPkc = await mockPKCNoDataPathWithOnlyKuboClient({});
        }, 120_000);
        afterAll(async () => {
            for (const comment of commentsToStop.splice(0)) {
                try {
                    await comment.stop();
                } catch {
                    // already stopped
                }
            }
            for (const community of communitiesToStop.splice(0)) {
                try {
                    await community.stop();
                } catch {
                    // already stopped
                }
            }
            await publisherPkc.destroy();
            await pkc.destroy();
        }, 300_000);

        const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
        // NOT signers[0]: this suite drives the live community with filler posts, and several
        // concurrently-running suites (post.updatingstate and friends) assert EXACT tail slices
        // of updating states for posts on the signers[0] community; a filler-triggered update
        // cycle landing between their post's succeeded and stopped shifts that tail and flakes
        // them (observed on the browser CI legs). signers[7] runs the same no-challenge
        // community with far fewer concurrent users.
        const communityAddress = signers[7].address;

        // Publish a post, set it updating on the measuring pkc, and wait for its first update.
        // Also returns an updating community mirror on the same pkc (it attaches to the same
        // tracked updating instance the comment uses internally) to count community updates.
        const startIdlePostAndCommunityMirror = async () => {
            const publishedPost = await publishRandomPost({ communityAddress, pkc: publisherPkc });
            const community = (await pkc.createCommunity({ address: communityAddress })) as RemoteCommunity;
            communitiesToStop.push(community);
            await community.update();
            const comment = await pkc.createComment({ cid: publishedPost.cid! });
            commentsToStop.push(comment);
            await comment.update();
            // Wait for the first CommentUpdate (not just the CommentIpfs load), so the
            // measurement window starts from a fully-settled idle post.
            await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => typeof comment.updatedAt === "number" });
            return { publishedPost, comment, community };
        };

        it.fails(
            "a community update that does not change a post's CommentUpdate costs no postUpdates walk and no state churn (issue #312)",
            async () => {
                const { publishedPost, comment, community } = await startIdlePostAndCommunityMirror();
                await sleep(2000); // let the first update cycle's tail settle

                // Oracle: every P2P file fetch goes through the client functions' cat; a
                // per-post postUpdates walk is a cat of <folderCid>/<postCid>/update, so any
                // path containing this post's cid is a walk for it. A future shared
                // folder-listing fetch (the #312 proposal) does not match, on purpose.
                const libp2pJsClient = pkc.clients.libp2pJsClients[Object.keys(pkc.clients.libp2pJsClients)[0]];
                const clientFunctions = libp2pJsClient.heliaWithKuboRpcClientFunctions;
                const catPaths: string[] = [];
                const originalCat = clientFunctions.cat.bind(clientFunctions);
                clientFunctions.cat = ((...args: Parameters<typeof originalCat>) => {
                    catPaths.push(String(args[0]));
                    return originalCat(...args);
                }) as typeof clientFunctions.cat;

                let communityUpdates = 0;
                const onCommunityUpdate = () => communityUpdates++;
                community.on("update", onCommunityUpdate);
                const recordedCommentStates: string[] = [];
                const onCommentStateChange = (newState: Comment["updatingState"]) => recordedCommentStates.push(newState);
                comment.on("updatingstatechange", onCommentStateChange);

                try {
                    // Drive community updates with activity UNRELATED to the post: filler posts
                    // change the record (and the post's timestamp bucket) but never its
                    // CommentUpdate. Wait for two community updates to land.
                    const deadline = Date.now() + 120_000;
                    while (communityUpdates < 2 && Date.now() < deadline) {
                        await publishRandomPost({ communityAddress, pkc: publisherPkc });
                        const target = Math.min(communityUpdates + 1, 2);
                        while (communityUpdates < target && Date.now() < deadline) await sleep(500);
                    }
                    expect(communityUpdates, "the filler posts must produce community updates").to.be.greaterThanOrEqual(2);
                    await sleep(3000); // give the per-update comment handlers time to finish their walks

                    const postUpdatesWalksForThisPost = catPaths.filter((path) => path.includes(publishedPost.cid!));
                    expect(
                        postUpdatesWalksForThisPost.length,
                        `community updates that did not change the post's CommentUpdate must not trigger network walks of its postUpdates path; saw ${postUpdatesWalksForThisPost.length} walks over ${communityUpdates} updates`
                    ).to.equal(0);
                    expect(
                        recordedCommentStates.length,
                        `an idle post must not churn updatingstatechange on unrelated community updates; saw [${recordedCommentStates.join(", ")}]`
                    ).to.be.at.most(2);
                } finally {
                    clientFunctions.cat = originalCat;
                    community.removeListener("update", onCommunityUpdate);
                    comment.removeListener("updatingstatechange", onCommentStateChange);
                }
            },
            300_000
        );

        // Green today and must stay green after the #312 fix: deduping unchanged CommentUpdates
        // must never swallow a real change.
        it("a reply published to the post still bumps its CommentUpdate", async () => {
            const { publishedPost, comment } = await startIdlePostAndCommunityMirror();
            const replyCountBefore = comment.replyCount ?? 0;
            await publishRandomReply({ parentComment: publishedPost as unknown as CommentIpfsWithCidDefined, pkc: publisherPkc });
            await resolveWhenConditionIsTrue({
                toUpdate: comment,
                predicate: async () => (comment.replyCount ?? 0) > replyCountBefore
            });
            expect(comment.replyCount ?? 0, "the reply must reach the post's CommentUpdate").to.be.greaterThan(replyCountBefore);
        }, 300_000);
    });
});

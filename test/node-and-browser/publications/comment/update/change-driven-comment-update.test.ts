import signers from "../../../../fixtures/signers.js";
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import {
    getAvailablePKCConfigsToTestAgainst,
    publishRandomPost,
    publishRandomReply,
    mockPKCNoDataPathWithOnlyKuboClient,
    resolveWhenConditionIsTrue
} from "../../../../../dist/node/test/test-util.js";
import { BaseClientsManager } from "../../../../../dist/node/clients/base-client-manager.js";
import { CommentClientsManager } from "../../../../../dist/node/publications/comment/comment-client-manager.js";

import type { PKC as PKCType } from "../../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../../dist/node/publications/comment/comment.js";
import type { RemoteCommunity } from "../../../../../dist/node/community/remote-community.js";
import type { CommentIpfsWithCidDefined } from "../../../../../dist/node/publications/comment/types.js";

// Issue #312: a post's CommentUpdate lives at <bucketFolderCid>/<postCid>/update, where postUpdates holds one folder
// per post-age bucket. Any activity in a bucket changes its folder cid, and every updating post in that bucket used
// to refetch and re-verify its own update on each community update, then discard it as not newer (measured: one walk
// per community update per idle post, 100% discarded, plus a fetching-update-ipfs -> waiting-retry state cycle).
//
// A post's own entry, <bucketFolderCid>/<postCid>, has a cid that changes only when that post's update does. So a
// community update whose bucket changed for someone else's activity must cost an idle post no fetch of its update
// file and no updating state churn, and a real change to the post must still arrive.
//
// A record's preloaded pages and its postUpdates come from the same publish cycle, so a post whose page copy is the
// CommentUpdate it holds has nothing to fetch either: no warm-up is allowed before measuring.
//
// Each case runs twice: as is (a fresh post sits in the community's preloaded pages) and with the pages lookup
// disabled, which forces every update through postUpdates, the path a post outside the preloaded page takes. There a
// gateway client is the exception: only kubo and libp2p-js can tell the post's entry cid in a way checked against the
// signed folder, so a gateway client skips an unchanged path only and refetches from a changed bucket.
//
// The fetch oracle spies on the two shared fetch entry points every client manager inherits: _fetchCidP2P (kubo and
// libp2p-js) and fetchFromMultipleGateways (gateways). Under the PKC RPC client the comment is updated by the RPC
// server's process, so only the updating states it forwards can be observed there.
getAvailablePKCConfigsToTestAgainst({
    includeOnlyTheseTests: ["remote-libp2pjs", "remote-kubo-rpc", "remote-ipfs-gateway", "remote-pkc-rpc"]
}).map((config) => {
    describe(`comment updates are change-driven, not per-community-update refetches (issue #312) - ${config.name}`, () => {
        let pkc: PKCType;
        let publisherPkc: Awaited<ReturnType<typeof mockPKCNoDataPathWithOnlyKuboClient>>;
        const commentsToStop: Comment[] = [];
        const communitiesToStop: RemoteCommunity[] = [];
        const isRpc = config.testConfigCode === "remote-pkc-rpc";
        const isGateway = config.testConfigCode === "remote-ipfs-gateway";

        beforeAll(async () => {
            // Production updateInterval so community updates arrive the way they do in production (gossip push on
            // libp2p-js, issue #308) rather than the test default's fast safety-net polling.
            pkc = await config.pkcInstancePromise({ pkcOptions: { updateInterval: 60_000 } });
            // Publishing runs on a separate kubo-backed pkc so the measuring client's fetch counts are not polluted
            // by the publishing flow's own fetches.
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

        // Every fetch of this post's CommentUpdate file, from any client manager in this process
        const spyOnPostUpdateFileFetches = (postCid: string) => {
            const fetchedPaths: string[] = [];
            const isPostUpdateFile = (path: string) => path.includes(`/${postCid}/update`);
            const originalFetchCidP2P = BaseClientsManager.prototype._fetchCidP2P;
            const originalFetchFromMultipleGateways = BaseClientsManager.prototype.fetchFromMultipleGateways;
            const p2pSpy = vi.spyOn(BaseClientsManager.prototype, "_fetchCidP2P").mockImplementation(function (
                this: BaseClientsManager,
                ...args: Parameters<BaseClientsManager["_fetchCidP2P"]>
            ) {
                if (isPostUpdateFile(String(args[0]))) fetchedPaths.push(String(args[0]));
                return originalFetchCidP2P.apply(this, args);
            });
            const gatewaySpy = vi.spyOn(BaseClientsManager.prototype, "fetchFromMultipleGateways").mockImplementation(function (
                this: BaseClientsManager,
                ...args: Parameters<BaseClientsManager["fetchFromMultipleGateways"]>
            ) {
                const path = `${args[0].root}/${args[0].path ?? ""}`;
                if (isPostUpdateFile(path)) fetchedPaths.push(path);
                return originalFetchFromMultipleGateways.apply(this, args);
            });
            return {
                fetchedPaths,
                restore: () => {
                    p2pSpy.mockRestore();
                    gatewaySpy.mockRestore();
                }
            };
        };

        // Forces every CommentUpdate through postUpdates, as for a post outside the community's preloaded page: neither
        // the pages lookup nor the record's own pages may vouch for the post's file
        const disablePagesLookup = () => {
            const lookupSpy = vi
                .spyOn(CommentClientsManager.prototype, "_findCommentInPagesOfUpdatingCommentsOrCommunity")
                .mockReturnValue(undefined);
            const recordPagesSpy = vi
                .spyOn(
                    CommentClientsManager.prototype as unknown as { _markRecordPostUpdateJudgedIfItsPagesHoldTheHeldUpdate: () => boolean },
                    "_markRecordPostUpdateJudgedIfItsPagesHoldTheHeldUpdate"
                )
                .mockReturnValue(false);
            return {
                mockRestore: () => {
                    lookupSpy.mockRestore();
                    recordPagesSpy.mockRestore();
                }
            };
        };

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

        // Drive community updates with activity UNRELATED to the post: filler posts land in the post's own age
        // bucket, so they change that bucket's folder cid but never the post's CommentUpdate.
        const driveUnrelatedCommunityUpdates = async (community: RemoteCommunity, count: number) => {
            let communityUpdates = 0;
            const onCommunityUpdate = () => communityUpdates++;
            community.on("update", onCommunityUpdate);
            try {
                const deadline = Date.now() + 180_000;
                while (communityUpdates < count && Date.now() < deadline) {
                    await publishRandomPost({ communityAddress, pkc: publisherPkc });
                    const target = Math.min(communityUpdates + 1, count);
                    while (communityUpdates < target && Date.now() < deadline) await sleep(500);
                }
                // A loud precondition: without community updates the assertions below would pass vacuously
                expect(communityUpdates, "the filler posts must produce community updates").to.be.greaterThanOrEqual(count);
                await sleep(3000); // give the per-update comment handlers time to finish
            } finally {
                community.removeListener("update", onCommunityUpdate);
            }
        };

        for (const viaPages of [true, false]) {
            const variant = viaPages ? "post in preloaded pages" : "post read through postUpdates only";
            // Under RPC the comment lives in the server's process, out of reach of a client-side spy
            const itUnlessRpcWithoutPages = !viaPages && isRpc ? it.skip : it;

            itUnlessRpcWithoutPages(
                `an idle post costs no fetch and no updating state when unrelated activity changes its postUpdates bucket (${variant})`,
                async () => {
                    const pagesSpy = viaPages ? undefined : disablePagesLookup();
                    try {
                        const { publishedPost, comment, community } = await startIdlePostAndCommunityMirror();
                        await sleep(2000); // let the first update cycle's tail settle

                        const fetches = spyOnPostUpdateFileFetches(publishedPost.cid!);
                        const updatingStates: string[] = [];
                        const onUpdatingState = (state: string) => updatingStates.push(state);
                        comment.on("updatingstatechange", onUpdatingState);
                        try {
                            await driveUnrelatedCommunityUpdates(community, 2);
                        } finally {
                            fetches.restore();
                            comment.removeListener("updatingstatechange", onUpdatingState);
                        }

                        if (!viaPages && isGateway) {
                            // A gateway's answer is not checked against the folder, so it is never trusted to say that a
                            // changed bucket left the post's file unchanged: the post fetches and verifies it again
                            expect(fetches.fetchedPaths, "a gateway client must refetch from a changed bucket").to.not.be.empty;
                        } else {
                            if (!isRpc)
                                expect(fetches.fetchedPaths, "an unchanged CommentUpdate must not be fetched again").to.deep.equal([]);
                            expect(updatingStates, "an unchanged CommentUpdate must not cycle the updating state").to.not.include(
                                "fetching-update-ipfs"
                            );
                        }
                    } finally {
                        pagesSpy?.mockRestore();
                    }
                },
                400_000
            );

            itUnlessRpcWithoutPages(
                `a reply published to the post still bumps its CommentUpdate (${variant})`,
                async () => {
                    const pagesSpy = viaPages ? undefined : disablePagesLookup();
                    try {
                        const { publishedPost, comment } = await startIdlePostAndCommunityMirror();
                        const replyCountBefore = comment.replyCount ?? 0;
                        await publishRandomReply({
                            parentComment: publishedPost as unknown as CommentIpfsWithCidDefined,
                            pkc: publisherPkc
                        });
                        await resolveWhenConditionIsTrue({
                            toUpdate: comment,
                            predicate: async () => (comment.replyCount ?? 0) > replyCountBefore
                        });
                        expect(comment.replyCount ?? 0, "the reply must reach the post's CommentUpdate").to.be.greaterThan(
                            replyCountBefore
                        );
                    } finally {
                        pagesSpy?.mockRestore();
                    }
                },
                300_000
            );
        }
    });
});

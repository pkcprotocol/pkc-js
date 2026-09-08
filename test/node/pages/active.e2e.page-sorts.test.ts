import { describe, it, beforeAll, afterAll, expect } from "vitest";
import {
    createSubWithNoChallenge,
    forceLocalSubPagesToAlwaysGenerateMultipleChunks,
    getAvailablePKCConfigsToTestAgainst,
    loadAllPagesBySortName,
    mockPKC,
    publishRandomPost,
    publishRandomReply,
    resolveWhenConditionIsTrue,
    waitTillPostInCommunityPages
} from "../../../dist/node/test/test-util.js";
import { pageSorts as builtInPageSorts } from "../../../dist/node/index.js";
import { timestamp } from "../../../dist/node/util.js";
import { DEFAULT_RESERVED_OPTIONS } from "../../../dist/node/pages/page-sort-options.js";
import activeNoBumpKeywordPageSort from "../../fixtures/page-sorts/active-no-bump-keyword.js";
import { resortPageLikeAUi, walkRepliesOfPage } from "../../node-and-browser/pages/page-sorts-client-test-util.js";

import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentWithinRepliesPostsPageJson } from "../../../dist/node/publications/comment/types.js";
import type { PageSortFileFactoryInput } from "../../../dist/node/community/types.js";

const remoteConfigs = getAvailablePKCConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true });

const bumpTimeOf = (post: CommentWithinRepliesPostsPageJson) => Math.max(post.timestamp, post.lastReplyTimestamp ?? 0);
const cidsOf = (posts: CommentWithinRepliesPostsPageJson[]) => posts.map((post) => post.cid);

async function loadActivePosts(community: RemoteCommunity | LocalCommunity): Promise<CommentWithinRepliesPostsPageJson[]> {
    return (await loadAllPagesBySortName("active", community.posts)) as CommentWithinRepliesPostsPageJson[];
}

// The built-in `active` end to end (issue #73): a reply to an older post moves it ahead of a newer post in the
// community's `active` pages, across every chunk, and a client holding those pages reproduces the order from the
// CommentUpdate alone (`lastReplyTimestamp`), by applying the built-in's `score` itself (pkc-js exports no sorter;
// resortPageLikeAUi is the doc's worked example). The second test is the client-installed-package case: a UI applies
// its own reply-dependent sort to a board that never configured it, by walking each thread's flat reply pages into
// `replies`.
describe("built-in active sort end to end", () => {
    let publisherPKC: PKC;
    let publisherCommunity: LocalCommunity;
    let older: Comment;
    let newer: Comment;
    let bump: Comment;
    let cleanupChunking: (() => void) | undefined;

    beforeAll(async () => {
        // The publisher is always an in-process LocalCommunity, whatever the RPC flag says: forcing a post's reply
        // pages into pageCids needs its page generator. The remote configs below still include the RPC client.
        publisherPKC = await mockPKC({
            kuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
            pubsubKuboRpcClientsOptions: ["http://localhost:15001/api/v0"],
            pkcRpcClientsOptions: undefined,
            httpRoutersOptions: []
        });
        publisherCommunity = (await createSubWithNoChallenge({}, publisherPKC)) as LocalCommunity;
        await publisherCommunity.start();
        await resolveWhenConditionIsTrue({
            toUpdate: publisherCommunity,
            predicate: async () => typeof publisherCommunity.updatedAt === "number"
        });

        const now = timestamp();
        older = await publishRandomPost({
            communityAddress: publisherCommunity.address,
            pkc: publisherPKC,
            postProps: { timestamp: now - 100 }
        });
        newer = await publishRandomPost({
            communityAddress: publisherCommunity.address,
            pkc: publisherPKC,
            postProps: { timestamp: now - 50 }
        });
        await waitTillPostInCommunityPages(newer as never, publisherPKC);

        // Overflow the record so every post sort lands in pageCids, and the older post's reply sorts too (its newFlat chain
        // is what the client walk prefers)
        await forceLocalSubPagesToAlwaysGenerateMultipleChunks({ community: publisherCommunity, forcedPreloadedPageSizeBytes: 1 });
        ({ cleanup: cleanupChunking } = await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
            community: publisherCommunity,
            parentComment: older,
            forcedPreloadedPageSizeBytes: 1
        }));

        bump = await publishRandomReply({
            parentComment: older as never,
            pkc: publisherPKC,
            commentProps: { content: "bumps the older post", timestamp: timestamp() }
        });
        await resolveWhenConditionIsTrue({
            toUpdate: publisherCommunity,
            predicate: async () => {
                if (!publisherCommunity.posts.pageCids.active) return false;
                const posts = await loadActivePosts(publisherCommunity);
                // lastReplyTimestamp has second resolution and the filler reply can share the bump's second, so the
                // count decides whether the bump reply itself reached the post (issue #351 made the cycle fast enough
                // to publish the filler's update first)
                const olderInPage = posts.find((post) => post.cid === older.cid);
                return olderInPage?.lastReplyTimestamp === bump.timestamp && (olderInPage?.replyCount ?? 0) >= 2;
            }
        });
    });

    afterAll(async () => {
        cleanupChunking?.();
        await publisherCommunity.delete();
        await publisherPKC.destroy();
    });

    remoteConfigs.forEach((config) => {
        describe(`loaded with pkc config ${config.name}`, () => {
            let remotePKC: PKC;
            let remoteCommunity: RemoteCommunity;
            let activePosts: CommentWithinRepliesPostsPageJson[];

            beforeAll(async () => {
                remotePKC = await config.pkcInstancePromise({
                    pkcOptions: { pageSorts: { activeNoBumpKeyword: activeNoBumpKeywordPageSort as PageSortFileFactoryInput } }
                });
                remoteCommunity = (await remotePKC.createCommunity({ address: publisherCommunity.address })) as RemoteCommunity;
                await remoteCommunity.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: remoteCommunity,
                    predicate: async () => {
                        if (!remoteCommunity.posts.pageCids.active) return false;
                        const posts = await loadActivePosts(remoteCommunity);
                        const olderInPage = posts.find((post) => post.cid === older.cid);
                        return olderInPage?.lastReplyTimestamp === bump.timestamp && (olderInPage?.replyCount ?? 0) >= 2;
                    }
                });
                activePosts = await loadActivePosts(remoteCommunity);
            });

            afterAll(async () => {
                await remoteCommunity.stop();
                await remotePKC.destroy();
            });

            it("the bumped older post precedes the newer post across the active pages, which are non-increasing in bump time", () => {
                expect(Object.keys(remoteCommunity.posts.pageCids).length, "every post sort is in pageCids").to.be.greaterThan(1);
                const olderIndex = activePosts.findIndex((post) => post.cid === older.cid);
                const newerIndex = activePosts.findIndex((post) => post.cid === newer.cid);
                expect(olderIndex).to.be.greaterThanOrEqual(0);
                expect(newerIndex).to.be.greaterThanOrEqual(0);
                expect(olderIndex, "the reply bumped the older post ahead of the newer one").to.be.lessThan(newerIndex);
                for (let i = 0; i + 1 < activePosts.length; i++)
                    expect(bumpTimeOf(activePosts[i]), `active order broken between index ${i} and ${i + 1}`).to.be.greaterThanOrEqual(
                        bumpTimeOf(activePosts[i + 1])
                    );
            });

            it("a client reproduces the community's active order with the built-in from PKC.pageSorts and the scope's default options", () => {
                // An unconfigured community publishes no pageSorts: its keys are the built-ins with the scope's reserved defaults
                expect(remoteCommunity.pageSorts).to.be.undefined;
                const resorted = resortPageLikeAUi({
                    comments: [...activePosts].reverse(),
                    factory: builtInPageSorts.active,
                    pageSortSettings: { name: "active", options: DEFAULT_RESERVED_OPTIONS.posts },
                    baseTimestamp: timestamp()
                });
                // Ties (same bump second) keep the community's order, which the reversed input does not preserve, so compare by bump time
                expect(resorted.map(bumpTimeOf)).to.deep.equal(activePosts.map(bumpTimeOf));
                expect(cidsOf(resorted).slice(0, 1)).to.deep.equal(cidsOf(activePosts).slice(0, 1));
            });

            it("a UI applies its own reply-dependent package to a board that never configured it, by walking the flat reply pages", async () => {
                const replies = await walkRepliesOfPage({ comments: activePosts, pkc: remotePKC });
                // The bump reply plus the filler reply the forced chunking published; both under the older post
                expect(replies.map((entry) => entry.comment.content)).to.include("bumps the older post");
                expect(replies.map((entry) => entry.comment.postCid)).to.deep.equal(replies.map(() => older.cid));
                expect(older.replies, "the older post's reply sorts were forced into pageCids").to.exist;
                const olderInPage = activePosts.find((post) => post.cid === older.cid)!;
                expect(olderInPage.replies?.pageCids.newFlat, "the walk took the flat chain").to.be.a("string");

                const byPackage = resortPageLikeAUi({
                    comments: [...activePosts].reverse(),
                    factory: activeNoBumpKeywordPageSort as PageSortFileFactoryInput,
                    pageSortSettings: {
                        name: "activeNoBumpKeyword",
                        options: { ...DEFAULT_RESERVED_OPTIONS.posts, noBumpKeywords: "sage" }
                    },
                    baseTimestamp: timestamp(),
                    replies
                });
                // No reply carries the keyword, so the package agrees with the built-in
                expect(byPackage.map(bumpTimeOf)).to.deep.equal(activePosts.map(bumpTimeOf));
            });
        });
    });
});

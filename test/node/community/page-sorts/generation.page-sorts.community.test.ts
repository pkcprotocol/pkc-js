import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { it, expect } from "vitest";
import { updateCommentsThatNeedToBeUpdated } from "../../../../dist/node/runtime/node/community/local-community/comment-updates.js";
import { timestamp } from "../../../../dist/node/util.js";
import {
    createCommunityWithDefaultDb,
    getPageGenerator,
    regenerateAllCommentUpdates,
    seedComments,
    sortedKeys,
    NO_BUMP_KEYWORD_SORT_PATH,
    THROWING_SORT_PATH,
    type CommunityContext,
    type TreeNode
} from "./page-sorts-test-util.js";

import type { CommunitySettings } from "../../../../dist/node/community/types.js";
import type { PageIpfs } from "../../../../dist/node/pages/types.js";

const DEFAULT_POST_SORTS = ["active", "hot", "new", "topAll", "topDay", "topHour", "topMonth", "topWeek", "topYear"];
const DEFAULT_POST_REPLY_SORTS = ["best", "new", "newFlat", "old", "oldFlat"];

// Big enough that a preloaded first chunk holds a handful of comments, small enough that a dozen 300-byte
// comments overflow it, so generation takes the multi-chunk path (pageCids for the other sorts).
const SMALL_PRELOAD_BUDGET = 8 * 1024;
const LARGE_PRELOAD_BUDGET = 1024 * 1024;

const manyPosts = (count: number, contentBytes = 300): TreeNode[] =>
    Array.from({ length: count }, (_, i) => ({ label: `post-${i}`, contentBytes }));

const postWithManyReplies = (replyCount: number, contentBytes = 300): TreeNode => ({
    label: "post",
    children: Array.from({ length: replyCount }, (_, i) => ({
        label: `reply-${i}`,
        contentBytes,
        children: i === 0 ? [{ label: "reply-0-child", contentBytes }] : undefined
    }))
});

// Edits on a community that is not started close its DB connection; reopen it so the tests can keep seeding.
async function editPages(context: CommunityContext, pages: NonNullable<CommunitySettings["pages"]>): Promise<void> {
    await context.community.edit({ settings: { ...context.community.settings, pages } });
    await context.community._dbHandler.initDbIfNeeded();
}

function commentCidsOfPage(page: PageIpfs | undefined): string[] {
    return (page?.comments ?? []).map((entry) => entry.commentUpdate.cid);
}

// These tests drive the page generator and the DB directly, which only exists on a LocalCommunity in this process.
describeSkipIfRpc.concurrent("settings.pages: page generation", () => {
    it("unset settings.pages generates all nine post sorts with hot preloaded and all five reply sorts with best preloaded", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            const { cidOf } = await seedComments(context.community, [postWithManyReplies(14), ...manyPosts(14)]);
            await updateCommentsThatNeedToBeUpdated(context.community);
            const generator = getPageGenerator(context.community);

            const posts = await generator.generateCommunityPosts({ preloadedPageSizeBytes: SMALL_PRELOAD_BUDGET });
            expect(posts).to.exist;
            if (!posts || "singlePreloadedPage" in posts) throw new Error("expected the multi-chunk path for posts");
            expect(sortedKeys(posts.pages)).to.deep.equal(["hot"]);
            expect(sortedKeys(posts.pageCids)).to.deep.equal(DEFAULT_POST_SORTS.filter((s) => s !== "hot"));
            expect(posts.pages.hot.nextCid).to.be.a("string");

            const post = context.community._dbHandler.queryComment(cidOf("post"))!;
            const postReplies = await generator.generatePostPages(post, SMALL_PRELOAD_BUDGET);
            if (!postReplies || "singlePreloadedPage" in postReplies) throw new Error("expected the multi-chunk path for post replies");
            expect(sortedKeys(postReplies.pages)).to.deep.equal(["best"]);
            expect(sortedKeys(postReplies.pageCids)).to.deep.equal(DEFAULT_POST_REPLY_SORTS.filter((s) => s !== "best"));

            // A reply's own replies never get the flat sorts, same as today
            const reply = context.community._dbHandler.queryComment(cidOf("reply-0"))!;
            const replyReplies = await generator.generateReplyPages(reply, LARGE_PRELOAD_BUDGET);
            if (!replyReplies || !("singlePreloadedPage" in replyReplies))
                throw new Error("expected a single preloaded page for reply replies");
            expect(sortedKeys(replyReplies.singlePreloadedPage)).to.deep.equal(["best"]);
        } finally {
            await context.cleanup();
        }
    });

    it("a 5chan-shaped config generates exactly one post sort and one reply sort", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, {
                posts: [{ path: NO_BUMP_KEYWORD_SORT_PATH, options: { noBumpKeywords: "sage" }, preloaded: true }],
                replies: [{ name: "old", preloaded: true }]
            });
            const { cidOf } = await seedComments(context.community, [postWithManyReplies(14), ...manyPosts(14)]);
            await updateCommentsThatNeedToBeUpdated(context.community);
            const generator = getPageGenerator(context.community);

            // Everything fits: the single-chunk shortcut still applies and nothing else is generated
            const smallBoard = await generator.generateCommunityPosts({ preloadedPageSizeBytes: LARGE_PRELOAD_BUDGET });
            if (!smallBoard || !("singlePreloadedPage" in smallBoard)) throw new Error("expected the single preloaded page shortcut");
            expect(sortedKeys(smallBoard.singlePreloadedPage)).to.deep.equal(["active"]);

            // Overflowing the preload budget still generates only the configured sort
            const posts = await generator.generateCommunityPosts({ preloadedPageSizeBytes: SMALL_PRELOAD_BUDGET });
            if (!posts || "singlePreloadedPage" in posts) throw new Error("expected the multi-chunk path for posts");
            expect(sortedKeys(posts.pages)).to.deep.equal(["active"]);
            expect(sortedKeys(posts.pageCids)).to.deep.equal([]);
            expect(sortedKeys(posts.allPageCids)).to.deep.equal(["active"]);

            const post = context.community._dbHandler.queryComment(cidOf("post"))!;
            const postReplies = await generator.generatePostPages(post, SMALL_PRELOAD_BUDGET);
            if (!postReplies || "singlePreloadedPage" in postReplies) throw new Error("expected the multi-chunk path for post replies");
            expect(sortedKeys(postReplies.pages)).to.deep.equal(["old"]);
            expect(sortedKeys(postReplies.pageCids)).to.deep.equal([]);

            const reply = context.community._dbHandler.queryComment(cidOf("reply-0"))!;
            const replyReplies = await generator.generateReplyPages(reply, LARGE_PRELOAD_BUDGET);
            if (!replyReplies || !("singlePreloadedPage" in replyReplies))
                throw new Error("expected a single preloaded page for reply replies");
            expect(sortedKeys(replyReplies.singlePreloadedPage)).to.deep.equal(["old"]);
        } finally {
            await context.cleanup();
        }
    });

    it("keyword no-bump: a reply carrying the keyword does not bump, one without does, and a prose mention does not trigger", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, {
                posts: [{ path: NO_BUMP_KEYWORD_SORT_PATH, options: { noBumpKeywords: "sage,nobump" }, preloaded: true }]
            });
            const base = timestamp() - 10_000;
            const { cidOf } = await seedComments(context.community, [
                { label: "saged", timestamp: base + 100, children: [{ label: "sage-reply", content: "sage", timestamp: base + 900 }] },
                {
                    label: "prose",
                    timestamp: base + 200,
                    children: [{ label: "prose-reply", content: "sage is overused", timestamp: base + 800 }]
                },
                { label: "bumped", timestamp: base + 300, children: [{ label: "bump-reply", content: "hello", timestamp: base + 700 }] },
                { label: "quiet", timestamp: base + 400 },
                {
                    label: "saged-then-bumped",
                    timestamp: base + 50,
                    children: [
                        {
                            label: "nobump-reply",
                            content: "first line\nnobump",
                            timestamp: base + 600,
                            children: [{ label: "grandchild", content: "still bumps", timestamp: base + 1000 }]
                        }
                    ]
                }
            ]);
            await updateCommentsThatNeedToBeUpdated(context.community);

            const posts = await getPageGenerator(context.community).generateCommunityPosts({
                preloadedPageSizeBytes: LARGE_PRELOAD_BUDGET
            });
            if (!posts || !("singlePreloadedPage" in posts)) throw new Error("expected the single preloaded page shortcut");
            // Scores: saged-then-bumped 1000 (grandchild of a no-bump reply bumps), prose 800, bumped 700, quiet 400, saged 100
            expect(commentCidsOfPage(posts.singlePreloadedPage.active)).to.deep.equal(
                ["saged-then-bumped", "prose", "bumped", "quiet", "saged"].map(cidOf)
            );

            // The built-in active, on the same data, is bumped by the keyword replies
            await editPages(context, { posts: [{ name: "active", preloaded: true }] });
            const builtIn = await getPageGenerator(context.community).generateCommunityPosts({
                preloadedPageSizeBytes: LARGE_PRELOAD_BUDGET
            });
            if (!builtIn || !("singlePreloadedPage" in builtIn)) throw new Error("expected the single preloaded page shortcut");
            expect(commentCidsOfPage(builtIn.singlePreloadedPage.active)).to.deep.equal(
                ["saged-then-bumped", "saged", "prose", "bumped", "quiet"].map(cidOf)
            );
        } finally {
            await context.cleanup();
        }
    });

    it("no entry preloaded ships pages {} with every configured sort in pageCids, even when everything would fit", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, { posts: [{ name: "new" }, { name: "hot" }], replies: [{ name: "old" }] });
            const { cidOf } = await seedComments(context.community, [postWithManyReplies(3), ...manyPosts(3)]);
            await updateCommentsThatNeedToBeUpdated(context.community);
            const generator = getPageGenerator(context.community);

            const posts = await generator.generateCommunityPosts({ preloadedPageSizeBytes: LARGE_PRELOAD_BUDGET });
            if (!posts || "singlePreloadedPage" in posts) throw new Error("expected pageCids-only generation");
            expect(posts.pages).to.deep.equal({});
            expect(sortedKeys(posts.pageCids)).to.deep.equal(["hot", "new"]);

            const post = context.community._dbHandler.queryComment(cidOf("post"))!;
            const postReplies = await generator.generatePostPages(post, LARGE_PRELOAD_BUDGET);
            if (!postReplies || "singlePreloadedPage" in postReplies) throw new Error("expected pageCids-only generation");
            expect(postReplies.pages).to.deep.equal({});
            expect(sortedKeys(postReplies.pageCids)).to.deep.equal(["old"]);
        } finally {
            await context.cleanup();
        }
    });

    it("multiple preloaded sorts share one budget; a sort whose first chunk does not fit drops to pageCids while the others still embed", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, {
                posts: [
                    { name: "new", preloaded: true },
                    { name: "old", preloaded: true }
                ]
            });
            const base = timestamp() - 10_000;
            // The newest post is far larger than half the budget, so `new` (newest first) cannot embed its first
            // chunk while `old` (oldest first) fills its half of the budget with the small ones.
            await seedComments(context.community, [
                ...Array.from({ length: 12 }, (_, i) => ({ label: `small-${i}`, contentBytes: 300, timestamp: base + i })),
                { label: "huge-newest", contentBytes: 6 * 1024, timestamp: base + 100 }
            ]);
            await updateCommentsThatNeedToBeUpdated(context.community);
            const generator = getPageGenerator(context.community);

            const posts = await generator.generateCommunityPosts({ preloadedPageSizeBytes: SMALL_PRELOAD_BUDGET });
            if (!posts || "singlePreloadedPage" in posts) throw new Error("expected the multi-chunk path for posts");
            expect(sortedKeys(posts.pages)).to.deep.equal(["old"]);
            expect(sortedKeys(posts.pageCids)).to.deep.equal(["new"]);
            // The budget is shared: old's embedded chunk stays within half of it
            expect(Buffer.byteLength(JSON.stringify(posts.pages.old))).to.be.at.most(SMALL_PRELOAD_BUDGET / 2);
        } finally {
            await context.cleanup();
        }
    });

    it("when no preloaded sort fits its share of the budget the record ships pages {} with every sort in pageCids", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, {
                posts: [
                    { name: "new", preloaded: true },
                    { name: "old", preloaded: true }
                ]
            });
            const base = timestamp() - 10_000;
            await seedComments(context.community, [
                { label: "huge-oldest", contentBytes: 6 * 1024, timestamp: base },
                ...Array.from({ length: 6 }, (_, i) => ({ label: `small-${i}`, contentBytes: 300, timestamp: base + 1 + i })),
                { label: "huge-newest", contentBytes: 6 * 1024, timestamp: base + 100 }
            ]);
            await updateCommentsThatNeedToBeUpdated(context.community);

            const posts = await getPageGenerator(context.community).generateCommunityPosts({
                preloadedPageSizeBytes: SMALL_PRELOAD_BUDGET
            });
            if (!posts || "singlePreloadedPage" in posts) throw new Error("expected the multi-chunk path for posts");
            expect(posts.pages).to.deep.equal({});
            expect(sortedKeys(posts.pageCids)).to.deep.equal(["new", "old"]);
        } finally {
            await context.cleanup();
        }
    });

    it("pages keys follow the configured order so the first preloaded entry is the client default", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, {
                posts: [
                    { name: "old", preloaded: true },
                    { name: "new", preloaded: true },
                    { name: "hot", preloaded: true }
                ]
            });
            await seedComments(context.community, manyPosts(4));
            await updateCommentsThatNeedToBeUpdated(context.community);

            const posts = await getPageGenerator(context.community).generateCommunityPosts({
                preloadedPageSizeBytes: LARGE_PRELOAD_BUDGET
            });
            if (!posts || !("singlePreloadedPage" in posts)) throw new Error("expected the single preloaded page shortcut");
            expect(Object.keys(posts.singlePreloadedPage)).to.deep.equal(["old", "new", "hot"]);
        } finally {
            await context.cleanup();
        }
    });

    it("maxAge on a non-top sort drops unpinned comments older than the window", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, { posts: [{ name: "new", options: { maxAge: "1h" }, preloaded: true }] });
            const now = timestamp();
            const { cidOf } = await seedComments(context.community, [
                { label: "stale", timestamp: now - 7200 },
                { label: "fresh", timestamp: now - 60 }
            ]);
            await updateCommentsThatNeedToBeUpdated(context.community);

            const posts = await getPageGenerator(context.community).generateCommunityPosts({
                preloadedPageSizeBytes: LARGE_PRELOAD_BUDGET
            });
            if (!posts || !("singlePreloadedPage" in posts)) throw new Error("expected the single preloaded page shortcut");
            expect(commentCidsOfPage(posts.singlePreloadedPage.new)).to.deep.equal([cidOf("fresh")]);
        } finally {
            await context.cleanup();
        }
    });

    it("pinnedFirst true keeps a pinned comment first and inside a maxAge window; false subjects it to the filter and normal ordering", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            const now = timestamp();
            const { cidOf } = await seedComments(context.community, [
                { label: "pinned-stale", timestamp: now - 7200 },
                { label: "fresh-a", timestamp: now - 120 },
                { label: "fresh-b", timestamp: now - 60 }
            ]);
            await updateCommentsThatNeedToBeUpdated(context.community);
            context.community._dbHandler["_db"].prepare(`UPDATE commentUpdates SET pinned = 1 WHERE cid = ?`).run(cidOf("pinned-stale"));

            await editPages(context, { posts: [{ name: "new", options: { maxAge: "1h" }, preloaded: true }] });
            const pinnedFirst = await getPageGenerator(context.community).generateCommunityPosts({
                preloadedPageSizeBytes: LARGE_PRELOAD_BUDGET
            });
            if (!pinnedFirst || !("singlePreloadedPage" in pinnedFirst)) throw new Error("expected the single preloaded page shortcut");
            expect(commentCidsOfPage(pinnedFirst.singlePreloadedPage.new)).to.deep.equal(["pinned-stale", "fresh-b", "fresh-a"].map(cidOf));

            await editPages(context, { posts: [{ name: "new", options: { maxAge: "1h", pinnedFirst: "false" }, preloaded: true }] });
            const notPinnedFirst = await getPageGenerator(context.community).generateCommunityPosts({
                preloadedPageSizeBytes: LARGE_PRELOAD_BUDGET
            });
            if (!notPinnedFirst || !("singlePreloadedPage" in notPinnedFirst))
                throw new Error("expected the single preloaded page shortcut");
            expect(commentCidsOfPage(notPinnedFirst.singlePreloadedPage.new)).to.deep.equal(["fresh-b", "fresh-a"].map(cidOf));

            // Without a window, pinnedFirst false just means normal ordering
            await editPages(context, { posts: [{ name: "new", options: { pinnedFirst: "false" }, preloaded: true }] });
            const plainOrder = await getPageGenerator(context.community).generateCommunityPosts({
                preloadedPageSizeBytes: LARGE_PRELOAD_BUDGET
            });
            if (!plainOrder || !("singlePreloadedPage" in plainOrder)) throw new Error("expected the single preloaded page shortcut");
            expect(commentCidsOfPage(plainOrder.singlePreloadedPage.new)).to.deep.equal(["fresh-b", "fresh-a", "pinned-stale"].map(cidOf));
        } finally {
            await context.cleanup();
        }
    });

    it("a flat reply sort is generated for a post's replies and ignored for a depth-1 comment's replies", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, { replies: [{ name: "old", preloaded: true }, { name: "newFlat" }] });
            const { cidOf } = await seedComments(context.community, [postWithManyReplies(14)]);
            await updateCommentsThatNeedToBeUpdated(context.community);
            const generator = getPageGenerator(context.community);

            // A budget the preloaded sort overflows, so the non-preloaded flat sort is materialised (the single-chunk
            // shortcut would otherwise skip it, by design)
            const post = context.community._dbHandler.queryComment(cidOf("post"))!;
            const postReplies = await generator.generatePostPages(post, SMALL_PRELOAD_BUDGET / 2);
            if (!postReplies || "singlePreloadedPage" in postReplies) throw new Error("expected pageCids for the flat sort");
            expect(sortedKeys(postReplies.pages)).to.deep.equal(["old"]);
            expect(sortedKeys(postReplies.pageCids)).to.deep.equal(["newFlat"]);

            const reply = context.community._dbHandler.queryComment(cidOf("reply-0"))!;
            const replyReplies = await generator.generateReplyPages(reply, LARGE_PRELOAD_BUDGET);
            if (!replyReplies || !("singlePreloadedPage" in replyReplies))
                throw new Error("expected only the preloaded sort for reply replies");
            expect(sortedKeys(replyReplies.singlePreloadedPage)).to.deep.equal(["old"]);
        } finally {
            await context.cleanup();
        }
    });

    it("a sort whose file throws is skipped and the rest publish; a throwing preloaded sort drops from pages while its siblings remain", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, {
                posts: [{ path: THROWING_SORT_PATH, preloaded: true }, { name: "new", preloaded: true }, { name: "old" }]
            });
            await seedComments(context.community, manyPosts(14));
            await updateCommentsThatNeedToBeUpdated(context.community);

            const posts = await getPageGenerator(context.community).generateCommunityPosts({
                preloadedPageSizeBytes: SMALL_PRELOAD_BUDGET
            });
            if (!posts || "singlePreloadedPage" in posts) throw new Error("expected the multi-chunk path");
            expect(sortedKeys(posts.pages)).to.deep.equal(["new"]);
            expect(sortedKeys(posts.pageCids)).to.deep.equal(["old"]);
            expect(sortedKeys(posts.failedSorts)).to.deep.equal(["throwing"]);
            expect(posts.failedSorts.throwing.code).to.equal("ERR_PAGE_SORT_FAILED_TO_GENERATE");
            expect((posts.failedSorts.throwing.details.error as Error).message).to.include("scoreAll failed on purpose");
        } finally {
            await context.cleanup();
        }
    });

    it("nested reply trees are reconstructed from the DB for a non-best preloaded reply sort, and a child's newer update re-flags its parent", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, { replies: [{ name: "old", preloaded: true }] });
            const { cidOf } = await seedComments(context.community, [
                { label: "post", children: [{ label: "r1", children: [{ label: "r1a" }, { label: "r1b" }] }, { label: "r2" }] }
            ]);
            await regenerateAllCommentUpdates(context.community);
            expect(context.community._dbHandler.queryCommentsToBeUpdated()).to.deep.equal([]);

            const tree = context.community._dbHandler.queryPageCommentsWithResolvedReplies({
                parentCid: cidOf("post"),
                excludeCommentsWithDifferentCommunityAddress: true,
                excludeDeletedComments: false,
                excludeRemovedComments: false,
                excludeCommentWithApprovedFalse: false,
                excludeCommentPendingApproval: true,
                preloadedPage: "old",
                baseTimestamp: timestamp()
            });
            const r1 = tree.find((entry) => entry.commentUpdate.cid === cidOf("r1"));
            expect(r1, "r1 should be a direct child of the post").to.exist;
            expect(sortedKeys(r1!.commentUpdate.replies?.pages)).to.deep.equal(["old"]);
            expect(commentCidsOfPage(r1!.commentUpdate.replies?.pages.old)).to.deep.equal([cidOf("r1a"), cidOf("r1b")]);

            // stale_replies must follow whatever sort is preloaded, not a hardcoded `best`
            context.community._dbHandler["_db"]
                .prepare(`UPDATE commentUpdates SET updatedAt = (SELECT updatedAt FROM commentUpdates WHERE cid = ?) + 5 WHERE cid = ?`)
                .run(cidOf("r1"), cidOf("r1a"));
            const flagged = context.community._dbHandler.queryCommentsToBeUpdated().map((row) => row.cid);
            expect(flagged).to.include(cidOf("r1"));
        } finally {
            await context.cleanup();
        }
    });
});

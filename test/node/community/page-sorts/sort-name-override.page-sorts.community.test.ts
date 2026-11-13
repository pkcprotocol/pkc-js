import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { it, expect, beforeAll, afterAll } from "vitest";
import {
    mockPKC,
    mockPKCNoDataPathWithOnlyKuboClient,
    createSubWithNoChallenge,
    generateMockPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { PKCError } from "../../../../dist/node/pkc-error.js";
import {
    computePageSortsFingerprint,
    lookupPageSortFactories,
    pkcJsPageSorts,
    resolvePageSortsAndCollectFailures
} from "../../../../dist/node/runtime/node/community/page-sorts/index.js";
import { syncPageSortsWithRegistry } from "../../../../dist/node/runtime/node/community/local-community/registry-sync.js";
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
    SORT_NAME_ECHO_SORT_PATH,
    type CommunityContext,
    type TreeNode
} from "./page-sorts-test-util.js";

import { resortPageLikeAUi } from "../../../node-and-browser/pages/page-sorts-client-test-util.js";

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RemoteCommunity } from "../../../../dist/node/community/remote-community.js";
import type { CommunitySettings, PageSortFileFactoryInput } from "../../../../dist/node/community/types.js";
import type { PageIpfs } from "../../../../dist/node/pages/types.js";

// Issue #483: a settings.pages entry may carry its own `sortName`, which replaces the file's `sortName` as the wire
// key (posts.pages / posts.pageCids / community.pageSorts, and the same under replies). That lets one file be listed
// more than once under a scope, e.g. two windowed `top` sorts, and makes the key the community owner's decision
// instead of the package's.

type PagesSettings = NonNullable<CommunitySettings["pages"]>;

const TOP_LEVEL_CODES = new Set(["ERR_COMMUNITY_EDIT_OPTIONS_SCHEMA", "ERR_FAILED_TO_IMPORT_PAGE_SORT_FILE_FACTORY"]);

type Failure = { scope: string; pageSortIndex: number; pageSortName: string; error: PKCError };

async function editAndCatch(community: LocalCommunity, pages: PagesSettings): Promise<PKCError> {
    let caught: unknown;
    try {
        await community.edit({ settings: { ...community.settings, pages } });
    } catch (e) {
        caught = e;
    }
    expect(caught, `expected edit with ${JSON.stringify(pages)} to throw`).to.be.instanceOf(PKCError);
    return caught as PKCError;
}

async function expectEditToFail(community: LocalCommunity, pages: PagesSettings, code: string): Promise<PKCError> {
    const error = await editAndCatch(community, pages);
    if (TOP_LEVEL_CODES.has(code)) {
        expect(error.code).to.equal(code);
        return error;
    }
    expect(error.code).to.equal("ERR_PAGE_SORT_SETTINGS_VALIDATION_FAILED_FOR_PAGE_SORTS");
    const failures = error.details.failures as Failure[];
    const failure = failures.find((f) => f.error.code === code);
    expect(failure, `expected a failure with code ${code}, got ${failures.map((f) => f.error.code).join(", ")}`).to.exist;
    return failure!.error;
}

// The resolved wire keys of a settings.pages value, per scope, in list order
async function resolvedKeys(pages: PagesSettings, pkc: PKCType): Promise<{ posts: string[]; replies: string[] }> {
    const { resolved, failures } = await resolvePageSortsAndCollectFailures({ pagesSettings: pages, pkc });
    expect(failures.map((failure) => failure.error.code)).to.deep.equal([]);
    return { posts: resolved.posts.map((sort) => sort.sortName), replies: resolved.replies.map((sort) => sort.sortName) };
}

// A package registered through the `pageSorts` PKC option, the way an installed npm package is
const REGISTERED_PACKAGE_NAME = "@pkc-test/newest-page-sort";
const registeredNewest: PageSortFileFactoryInput = (() => ({
    sortName: "packageNewest",
    description: "Newest first, from a registered package",
    score: ({ comment }: { comment: { timestamp: number } }) => comment.timestamp
})) as unknown as PageSortFileFactoryInput;

// The edit path that validates settings.pages only runs on a LocalCommunity in this process (not over RPC); the RPC
// round trip of the override is covered in test/node/pkc/pkc-settings-page-sorts-rpc.test.ts.
describeSkipIfRpc.concurrent("settings.pages[].sortName: validation (issue #483)", () => {
    let pkc: PKCType;
    beforeAll(async () => {
        pkc = await mockPKC({ pageSorts: { [REGISTERED_PACKAGE_NAME]: registeredNewest } });
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    it("an override on a built-in, on a registered package and on a path file is stored verbatim and becomes the key, under both scopes", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        const pages: PagesSettings = {
            posts: [
                { name: "hot", sortName: "frontPage", preloaded: true },
                { name: REGISTERED_PACKAGE_NAME, sortName: "latest" },
                { path: SORT_NAME_ECHO_SORT_PATH, sortName: "mirror" }
            ],
            replies: [
                { name: "old", sortName: "chronological", preloaded: true },
                { name: REGISTERED_PACKAGE_NAME, sortName: "latestReplies" },
                { path: SORT_NAME_ECHO_SORT_PATH, sortName: "mirrorReplies" }
            ]
        };
        await community.edit({ settings: { ...community.settings, pages } });
        expect(community.settings?.pages).to.deep.equal(pages);
        expect(await resolvedKeys(pages, pkc)).to.deep.equal({
            posts: ["frontPage", "latest", "mirror"],
            replies: ["chronological", "latestReplies", "mirrorReplies"]
        });
    });

    it("an entry without sortName keeps the file's sortName, next to entries that override", async () => {
        const pages: PagesSettings = {
            posts: [
                { name: "hot" },
                { name: REGISTERED_PACKAGE_NAME },
                { path: SORT_NAME_ECHO_SORT_PATH },
                { name: "new", sortName: "latest" }
            ]
        };
        expect((await resolvedKeys(pages, pkc)).posts).to.deep.equal(["hot", "packageNewest", "echo", "latest"]);
    });

    it("two windowed top entries are accepted once each has its own key, with a plain top next to them", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        const pages: PagesSettings = {
            posts: [
                { name: "top", sortName: "topFortnight", options: { maxAge: "2w" }, preloaded: true },
                { name: "top", sortName: "topYearly", options: { maxAge: "1y" } },
                { name: "top" }
            ]
        };
        await community.edit({ settings: { ...community.settings, pages } });
        expect(community.settings?.pages).to.deep.equal(pages);
        expect((await resolvedKeys(pages, pkc)).posts).to.deep.equal(["topFortnight", "topYearly", "top"]);
    });

    it("two windowed top entries without an override are still rejected", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        const error = await expectEditToFail(
            community,
            {
                posts: [
                    { name: "top", options: { maxAge: "2w" } },
                    { name: "top", options: { maxAge: "1y" } }
                ]
            },
            "ERR_PAGE_SORT_DUPLICATE_SORT_NAME"
        );
        expect(error.details).to.include({ sortName: "top", scope: "posts", pageSortIndex: 1, pageSortName: "top" });
        expect(community.settings?.pages).to.be.undefined;
    });

    it("an override equal to another entry's file sortName is a duplicate, whichever comes first", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        const overrideSecond = await expectEditToFail(
            community,
            { posts: [{ name: "hot" }, { name: REGISTERED_PACKAGE_NAME, sortName: "hot" }] },
            "ERR_PAGE_SORT_DUPLICATE_SORT_NAME"
        );
        // the later entry is the one rejected, and details carry the resolved key, not the file's own sortName
        expect(overrideSecond.details).to.include({
            sortName: "hot",
            scope: "posts",
            pageSortIndex: 1,
            pageSortName: REGISTERED_PACKAGE_NAME
        });

        const overrideFirst = await expectEditToFail(
            community,
            { posts: [{ name: REGISTERED_PACKAGE_NAME, sortName: "hot" }, { name: "hot" }] },
            "ERR_PAGE_SORT_DUPLICATE_SORT_NAME"
        );
        expect(overrideFirst.details).to.include({ sortName: "hot", scope: "posts", pageSortIndex: 1, pageSortName: "hot" });
        expect(community.settings?.pages).to.be.undefined;
    });

    it("two overrides with the same value are a duplicate, on any mix of built-in, package and path entries", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        const error = await editAndCatch(community, {
            replies: [
                { name: "new", sortName: "feed" },
                { name: REGISTERED_PACKAGE_NAME, sortName: "feed" },
                { name: "old" },
                { path: SORT_NAME_ECHO_SORT_PATH, sortName: "feed" }
            ]
        });
        expect(error.code).to.equal("ERR_PAGE_SORT_SETTINGS_VALIDATION_FAILED_FOR_PAGE_SORTS");
        const failures = error.details.failures as Failure[];
        expect(failures.map((f) => [f.scope, f.pageSortIndex, f.error.code, f.error.details.sortName])).to.deep.equal([
            ["replies", 1, "ERR_PAGE_SORT_DUPLICATE_SORT_NAME", "feed"],
            ["replies", 3, "ERR_PAGE_SORT_DUPLICATE_SORT_NAME", "feed"]
        ]);
    });

    it("an override frees the file's own sortName for another entry", async () => {
        // both files declare sortName "active"; the built-in moves to "bump" so the path file can keep "active"
        const pages: PagesSettings = {
            posts: [
                { name: "active", sortName: "bump" },
                { path: NO_BUMP_KEYWORD_SORT_PATH, options: { noBumpKeywords: "sage" } }
            ]
        };
        const community = (await pkc.createCommunity()) as LocalCommunity;
        await community.edit({ settings: { ...community.settings, pages } });
        expect((await resolvedKeys(pages, pkc)).posts).to.deep.equal(["bump", "active"]);
    });

    it("the same key under posts and under replies is not a duplicate", async () => {
        const pages: PagesSettings = {
            posts: [{ name: "new", sortName: "feed", preloaded: true }],
            replies: [{ name: "old", sortName: "feed", preloaded: true }]
        };
        const community = (await pkc.createCommunity()) as LocalCommunity;
        await community.edit({ settings: { ...community.settings, pages } });
        expect(await resolvedKeys(pages, pkc)).to.deep.equal({ posts: ["feed"], replies: ["feed"] });
    });

    it("an override equal to the file's own sortName is accepted and stored as written", async () => {
        const pages: PagesSettings = {
            posts: [{ name: "hot", sortName: "hot", preloaded: true }],
            replies: [{ name: "best", sortName: "best" }]
        };
        const community = (await pkc.createCommunity()) as LocalCommunity;
        await community.edit({ settings: { ...community.settings, pages } });
        expect(community.settings?.pages).to.deep.equal(pages);
        expect(await resolvedKeys(pages, pkc)).to.deep.equal({ posts: ["hot"], replies: ["best"] });
    });

    it("one file listed twice with identical options under two keys is accepted", async () => {
        const pages: PagesSettings = { posts: [{ name: "hot" }, { name: "hot", sortName: "hotAgain" }] };
        const community = (await pkc.createCommunity()) as LocalCommunity;
        await community.edit({ settings: { ...community.settings, pages } });
        expect((await resolvedKeys(pages, pkc)).posts).to.deep.equal(["hot", "hotAgain"]);
    });

    // toString and the rest are keys every plain object inherits: a client's per-sort maps would find the inherited
    // function instead of an empty slot (review of PR #538)
    it("rejects __proto__, constructor, prototype and the other keys an object inherits as an override, on every entry kind", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        for (const reserved of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"])
            for (const entry of [{ name: "hot" }, { name: REGISTERED_PACKAGE_NAME }, { path: SORT_NAME_ECHO_SORT_PATH }]) {
                await expectEditToFail(community, { posts: [{ ...entry, sortName: reserved }] }, "ERR_COMMUNITY_EDIT_OPTIONS_SCHEMA");
                await expectEditToFail(community, { replies: [{ ...entry, sortName: reserved }] }, "ERR_COMMUNITY_EDIT_OPTIONS_SCHEMA");
            }
        expect(community.settings?.pages).to.be.undefined;
    });

    it("rejects an empty or non-string override", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        await expectEditToFail(community, { posts: [{ name: "hot", sortName: "" }] }, "ERR_COMMUNITY_EDIT_OPTIONS_SCHEMA");
        for (const notAString of [5, true, null, ["hot"], { key: "hot" }])
            await expectEditToFail(
                community,
                { posts: [{ name: "hot", sortName: notAString }] } as unknown as PagesSettings,
                "ERR_COMMUNITY_EDIT_OPTIONS_SCHEMA"
            );
        expect(community.settings?.pages).to.be.undefined;
    });

    // The override follows the same rule as a file's sortName: any non-empty string that is safe as an object key. No
    // character set or length limit is imposed on either (decided on issue #483).
    it("accepts any other non-empty string, the same freedom a file's sortName has", async () => {
        const pages: PagesSettings = {
            posts: [
                { name: "hot", sortName: "top 2 weeks" },
                { name: "new", sortName: "custom-newest" },
                { name: "old", sortName: "älteste/первые" },
                { name: "top", sortName: "tostring" },
                { name: "active", sortName: "x".repeat(300) }
            ]
        };
        const community = (await pkc.createCommunity()) as LocalCommunity;
        await community.edit({ settings: { ...community.settings, pages } });
        expect(community.settings?.pages).to.deep.equal(pages);
        expect((await resolvedKeys(pages, pkc)).posts).to.deep.equal(pages.posts!.map((entry) => entry.sortName));
    });

    it("createCommunity accepts overrides and rejects a duplicate between an override and a file sortName", async () => {
        const pages: PagesSettings = {
            posts: [
                { name: "top", sortName: "topFortnight", options: { maxAge: "2w" }, preloaded: true },
                { name: "top", sortName: "topYearly", options: { maxAge: "1y" } }
            ]
        };
        const community = (await pkc.createCommunity({ settings: { pages } })) as LocalCommunity;
        expect(community.settings?.pages).to.deep.equal(pages);

        let caught: unknown;
        try {
            await pkc.createCommunity({
                settings: { pages: { replies: [{ name: "best" }, { name: "new" }, { name: "old", sortName: "best" }] } }
            });
        } catch (e) {
            caught = e;
        }
        expect(caught).to.be.instanceOf(PKCError);
        const error = caught as PKCError;
        expect(error.code).to.equal("ERR_PAGE_SORT_SETTINGS_VALIDATION_FAILED_FOR_PAGE_SORTS");
        const failures = error.details.failures as Failure[];
        expect(failures.map((f) => [f.scope, f.pageSortIndex, f.pageSortName, f.error.code, f.error.details.sortName])).to.deep.equal([
            ["replies", 2, "old", "ERR_PAGE_SORT_DUPLICATE_SORT_NAME", "best"]
        ]);
    });

    it("every other validation still applies to an overriding entry, and its error details carry the override as sortName", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        const scopeMismatch = await expectEditToFail(
            community,
            { posts: [{ name: "newFlat", sortName: "flatFeed" }] },
            "ERR_PAGE_SORT_SCOPE_MISMATCH"
        );
        expect(scopeMismatch.details).to.include({ sortName: "flatFeed", pageSortName: "newFlat", scope: "posts", pageSortIndex: 0 });

        const undeclaredOption = await expectEditToFail(
            community,
            { posts: [{ name: "new", sortName: "latest", options: { noBumpKeywords: "sage" } }] },
            "ERR_PAGE_SORT_OPTION_NOT_DECLARED_IN_OPTION_INPUTS"
        );
        expect(undeclaredOption.details).to.include({ sortName: "latest", pageSortName: "new" });

        const badReservedOption = await expectEditToFail(
            community,
            { replies: [{ name: "old", sortName: "chronological", options: { maxAge: "fortnight" } }] },
            "ERR_PAGE_SORT_INVALID_RESERVED_OPTION"
        );
        expect(badReservedOption.details).to.include({ sortName: "chronological", pageSortName: "old", scope: "replies" });

        const privateNotSet = await expectEditToFail(
            community,
            { posts: [{ path: NO_BUMP_KEYWORD_SORT_PATH, sortName: "bump", privateOptions: ["noBumpKeywords"] }] },
            "ERR_PAGE_SORT_PRIVATE_OPTION_NOT_SET"
        );
        expect(privateNotSet.details).to.include({ sortName: "bump" });
    });

    it("the sort file's factory and validatePageSortSettings receive the entry's sortName", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        const pages: PagesSettings = {
            posts: [{ path: SORT_NAME_ECHO_SORT_PATH, sortName: "mirror", options: { expectedSortName: "mirror" } }]
        };
        await community.edit({ settings: { ...community.settings, pages } });
        const { resolved } = await resolvePageSortsAndCollectFailures({ pagesSettings: pages, pkc });
        expect(resolved.posts[0].sortName).to.equal("mirror");
        expect(resolved.posts[0].file.sortName, "the file itself is untouched").to.equal("echo");
        expect(resolved.posts[0].file.description).to.equal("factory saw sortName mirror");
        expect(resolved.posts[0].settings).to.deep.equal(pages.posts![0]);

        // the file's validation sees the override too: it rejects an entry whose sortName is not the expected one
        const mismatch = await expectEditToFail(
            community,
            { posts: [{ path: SORT_NAME_ECHO_SORT_PATH, sortName: "mirror", options: { expectedSortName: "somethingElse" } }] },
            "ERR_PAGE_SORT_SETTINGS_VALIDATION_FAILED"
        );
        expect(mismatch.details.validationError).to.include("saw sortName mirror, expected somethingElse");
        expect(mismatch.details).to.include({ sortName: "mirror" });

        // without an override the file sees no sortName on the entry and its own sortName is the key
        const plain = await resolvePageSortsAndCollectFailures({ pagesSettings: { posts: [{ path: SORT_NAME_ECHO_SORT_PATH }] }, pkc });
        expect(plain.resolved.posts[0].sortName).to.equal("echo");
        expect(plain.resolved.posts[0].file.description).to.equal("factory saw sortName undefined");
    });

    it("the override changes nothing else about the resolved sort: flat, preloaded, scope and merged options come from the file and the entry", async () => {
        const { resolved, failures } = await resolvePageSortsAndCollectFailures({
            pagesSettings: {
                posts: [{ name: "topWeek", sortName: "thisWeek", preloaded: true }],
                replies: [{ name: "newFlat", sortName: "flatLatest", options: { pinnedFirst: "false" } }]
            },
            pkc
        });
        expect(failures).to.deep.equal([]);
        expect(resolved.posts[0]).to.include({ sortName: "thisWeek", scope: "posts", preloaded: true, flat: false });
        expect(resolved.posts[0].options.maxAge, "topWeek's defaultOptions still apply").to.equal("1w");
        expect(resolved.replies[0]).to.include({ sortName: "flatLatest", scope: "replies", preloaded: false, flat: true });
        expect(resolved.replies[0].options.pinnedFirst).to.equal("false");
    });
});

// These tests read queryCommentsToBeUpdated, seed rows straight into the community DB and call the page generator,
// which only exist on a LocalCommunity in this process; an RPC client never sees the DB.
describeSkipIfRpc.concurrent("settings.pages[].sortName: regeneration and fingerprint (issue #483)", () => {
    it("an edit that only adds, changes or removes a sortName flags every comment for regeneration; resubmitting it does not", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            const editPagesTo = async (pages: PagesSettings) => {
                await context.community.edit({ settings: { ...context.community.settings, pages } });
                await context.community._dbHandler.initDbIfNeeded();
            };
            await editPagesTo({ replies: [{ name: "old", preloaded: true }] });
            const { rows } = await seedComments(context.community, [
                { label: "post-a", children: [{ label: "reply-a" }] },
                { label: "post-b", children: [{ label: "reply-b", children: [{ label: "reply-b-child" }] }] }
            ]);
            const everyCid = rows.map((row) => row.cid!).sort();
            await regenerateAllCommentUpdates(context.community);
            expect(context.community._dbHandler.queryCommentsToBeUpdated()).to.deep.equal([]);

            const steps: PagesSettings[] = [
                { replies: [{ name: "old", sortName: "chronological", preloaded: true }] }, // added
                { replies: [{ name: "old", sortName: "oldestFirst", preloaded: true }] }, // changed
                { replies: [{ name: "old", preloaded: true }] } // removed
            ];
            for (const pages of steps) {
                await editPagesTo(pages);
                const flagged = context.community._dbHandler.queryCommentsToBeUpdated().map((row) => row.cid);
                expect(flagged.sort(), JSON.stringify(pages)).to.deep.equal(everyCid);
                await regenerateAllCommentUpdates(context.community);
                expect(context.community._dbHandler.queryCommentsToBeUpdated()).to.deep.equal([]);

                await editPagesTo(pages); // identical config: not a change
                expect(context.community._dbHandler.queryCommentsToBeUpdated(), JSON.stringify(pages)).to.deep.equal([]);
            }
        } finally {
            await context.cleanup();
        }
    });

    it("the persisted page-sorts fingerprint changes when only a sortName changes, and is stable otherwise", async () => {
        const pkc = await mockPKC();
        try {
            const fingerprintOf = async (pagesSettings: PagesSettings) => {
                const factories = lookupPageSortFactories({ pagesSettings, pkc });
                const { resolved } = await resolvePageSortsAndCollectFailures({ pagesSettings, pkc });
                return computePageSortsFingerprint({ pagesSettings, resolved, factories });
            };
            const plain = await fingerprintOf({ posts: [{ name: "top", options: { maxAge: "2w" } }] });
            const overridden = await fingerprintOf({ posts: [{ name: "top", sortName: "topFortnight", options: { maxAge: "2w" } }] });
            const renamed = await fingerprintOf({ posts: [{ name: "top", sortName: "top2w", options: { maxAge: "2w" } }] });
            expect(new Set([plain, overridden, renamed]).size).to.equal(3);
            expect(await fingerprintOf({ posts: [{ name: "top", sortName: "topFortnight", options: { maxAge: "2w" } }] })).to.equal(
                overridden
            );
        } finally {
            await pkc.destroy();
        }
    });

    // The start path (and a registry reload) reports an invalid entry as an `error` event and keeps the valid ones.
    // Edits reject a duplicate up front, so the way one reaches a running community is a package whose new version
    // declares a sortName that an existing override already took.
    it("on the start path a duplicate against an override is one error event, and only the later entry is skipped", async () => {
        const SWAPPED_NAME = "swappedPageSort";
        const makeSwapped = (sortName: string): PageSortFileFactoryInput =>
            (() => ({
                sortName,
                description: `declares ${sortName}`,
                score: ({ comment }: { comment: { timestamp: number } }) => comment.timestamp
            })) as unknown as PageSortFileFactoryInput;
        const context = await createCommunityWithDefaultDb({ pageSorts: { [SWAPPED_NAME]: makeSwapped("swapped") } });
        try {
            const registry = context.pkc.settings.pageSorts!;
            await context.community.edit({
                settings: {
                    ...context.community.settings,
                    pages: { posts: [{ name: "new", sortName: "feed", preloaded: true }, { name: SWAPPED_NAME }, { name: "old" }] }
                }
            });
            await context.community._dbHandler.initDbIfNeeded();
            await syncPageSortsWithRegistry(context.community); // baseline
            expect(context.community._pageSorts!.posts.map((sort) => sort.sortName)).to.deep.equal(["feed", "swapped", "old"]);

            const errors: PKCError[] = [];
            context.community.on("error", (error) => errors.push(error as PKCError));
            registry[SWAPPED_NAME] = makeSwapped("feed"); // the package's new version collides with the override
            await syncPageSortsWithRegistry(context.community);

            expect(errors.map((error) => error.code)).to.deep.equal(["ERR_PAGE_SORT_DUPLICATE_SORT_NAME"]);
            expect(errors[0].details).to.include({ sortName: "feed", scope: "posts", pageSortIndex: 1, pageSortName: SWAPPED_NAME });
            expect(context.community._pageSorts!.posts.map((sort) => sort.sortName)).to.deep.equal(["feed", "old"]);
            expect(context.community.pageSorts?.posts?.feed?.name, "the override keeps its key and its own file").to.equal("new");
            expect(sortedKeys(context.community.pageSorts?.posts)).to.deep.equal(["feed", "old"]);
        } finally {
            await context.cleanup();
        }
    });
});

const SMALL_PRELOAD_BUDGET = 8 * 1024;
const LARGE_PRELOAD_BUDGET = 1024 * 1024;

const manyPosts = (count: number, contentBytes = 300): TreeNode[] =>
    Array.from({ length: count }, (_, i) => ({ label: `post-${i}`, contentBytes }));

const postWithManyReplies = (replyCount: number, contentBytes = 300): TreeNode => ({
    label: "post",
    children: Array.from({ length: replyCount }, (_, i) => ({
        label: `reply-${i}`,
        contentBytes,
        children: [{ label: `reply-${i}-child`, contentBytes }]
    }))
});

// Edits on a community that is not started close its DB connection; reopen it so the tests can keep seeding.
async function editPages(context: CommunityContext, pages: PagesSettings): Promise<void> {
    await context.community.edit({ settings: { ...context.community.settings, pages } });
    await context.community._dbHandler.initDbIfNeeded();
}

function commentCidsOfPage(page: PageIpfs | undefined): string[] {
    return (page?.comments ?? []).map((entry) => entry.commentUpdate.cid);
}

// These tests drive the page generator and the DB directly, which only exists on a LocalCommunity in this process.
describeSkipIfRpc.concurrent("settings.pages[].sortName: page generation (issue #483)", () => {
    it("two windowed top entries generate their own pages under their own keys", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, {
                posts: [
                    { name: "top", sortName: "topAllTime", preloaded: true },
                    { name: "top", sortName: "topWeekly", options: { maxAge: "1w" }, preloaded: true },
                    { name: "top", sortName: "topDaily", options: { maxAge: "1d" }, preloaded: true }
                ]
            });
            const now = timestamp();
            const { cidOf } = await seedComments(context.community, [
                { label: "month-old", timestamp: now - 30 * 24 * 3600 },
                { label: "three-days-old", timestamp: now - 3 * 24 * 3600 },
                { label: "fresh", timestamp: now - 60 }
            ]);
            await updateCommentsThatNeedToBeUpdated(context.community);

            const posts = await getPageGenerator(context.community).generateCommunityPosts({
                preloadedPageSizeBytes: LARGE_PRELOAD_BUDGET
            });
            if (!posts) throw new Error("expected posts to be generated");
            // the unwindowed first entry holds the whole board, so every preloaded sort is embedded in one chunk
            if (!("singlePreloadedPage" in posts)) throw new Error("expected the single preloaded page shortcut");
            const pages = posts.singlePreloadedPage;
            expect(Object.keys(pages)).to.deep.equal(["topAllTime", "topWeekly", "topDaily"]);
            expect(pages).to.not.have.property("top");
            expect(commentCidsOfPage(pages.topAllTime).sort()).to.deep.equal(["month-old", "three-days-old", "fresh"].map(cidOf).sort());
            expect(commentCidsOfPage(pages.topWeekly).sort()).to.deep.equal(["three-days-old", "fresh"].map(cidOf).sort());
            expect(commentCidsOfPage(pages.topDaily)).to.deep.equal([cidOf("fresh")]);
        } finally {
            await context.cleanup();
        }
    });

    it("one file listed twice with different options produces two different pages, and its own sortName is not a key", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, {
                posts: [
                    { path: SORT_NAME_ECHO_SORT_PATH, sortName: "newestFirst", options: { order: "new" }, preloaded: true },
                    { path: SORT_NAME_ECHO_SORT_PATH, sortName: "oldestFirst", options: { order: "old" }, preloaded: true }
                ]
            });
            const now = timestamp();
            const { cidOf } = await seedComments(context.community, [
                { label: "first", timestamp: now - 300 },
                { label: "second", timestamp: now - 200 },
                { label: "third", timestamp: now - 100 }
            ]);
            await updateCommentsThatNeedToBeUpdated(context.community);

            const posts = await getPageGenerator(context.community).generateCommunityPosts({
                preloadedPageSizeBytes: LARGE_PRELOAD_BUDGET
            });
            if (!posts || !("singlePreloadedPage" in posts)) throw new Error("expected the single preloaded page shortcut");
            expect(Object.keys(posts.singlePreloadedPage)).to.deep.equal(["newestFirst", "oldestFirst"]);
            expect(commentCidsOfPage(posts.singlePreloadedPage.newestFirst)).to.deep.equal(["third", "second", "first"].map(cidOf));
            expect(commentCidsOfPage(posts.singlePreloadedPage.oldestFirst)).to.deep.equal(["first", "second", "third"].map(cidOf));
            expect(posts.singlePreloadedPage).to.not.have.property("echo");
        } finally {
            await context.cleanup();
        }
    });

    it("a preloaded override lands in pages and a non-preloaded one in pageCids, next to an entry without an override", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, {
                posts: [{ name: "new", sortName: "latest", preloaded: true }, { name: "old", sortName: "earliest" }, { name: "hot" }]
            });
            await seedComments(context.community, manyPosts(14));
            await updateCommentsThatNeedToBeUpdated(context.community);

            const posts = await getPageGenerator(context.community).generateCommunityPosts({
                preloadedPageSizeBytes: SMALL_PRELOAD_BUDGET
            });
            if (!posts || "singlePreloadedPage" in posts) throw new Error("expected the multi-chunk path");
            expect(sortedKeys(posts.pages)).to.deep.equal(["latest"]);
            expect(sortedKeys(posts.pageCids)).to.deep.equal(["earliest", "hot"]);
            expect(sortedKeys(posts.allPageCids)).to.deep.equal(["earliest", "hot", "latest"]);
            expect(posts.pages.latest.nextCid).to.be.a("string");
            for (const fileSortName of ["new", "old"]) {
                expect(posts.pages).to.not.have.property(fileSortName);
                expect(posts.pageCids).to.not.have.property(fileSortName);
                expect(posts.allPageCids).to.not.have.property(fileSortName);
            }
        } finally {
            await context.cleanup();
        }
    });

    it("pages keys follow the configured order with overrides, so the first preloaded entry is still the client default", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, {
                posts: [
                    { name: "old", sortName: "zLast", preloaded: true },
                    { name: "new", sortName: "aFirst", preloaded: true },
                    { name: "hot", preloaded: true }
                ]
            });
            await seedComments(context.community, manyPosts(4));
            await updateCommentsThatNeedToBeUpdated(context.community);

            const posts = await getPageGenerator(context.community).generateCommunityPosts({
                preloadedPageSizeBytes: LARGE_PRELOAD_BUDGET
            });
            if (!posts || !("singlePreloadedPage" in posts)) throw new Error("expected the single preloaded page shortcut");
            expect(Object.keys(posts.singlePreloadedPage)).to.deep.equal(["zLast", "aFirst", "hot"]);
        } finally {
            await context.cleanup();
        }
    });

    it("reply sorts: a nested override and a flat override are generated for a post, and the flat one is skipped for a depth-1 comment", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, {
                replies: [
                    { name: "old", sortName: "chronological", preloaded: true },
                    { name: "newFlat", sortName: "flatLatest" }
                ]
            });
            const { cidOf } = await seedComments(context.community, [postWithManyReplies(14)]);
            await updateCommentsThatNeedToBeUpdated(context.community);
            const generator = getPageGenerator(context.community);

            const post = context.community._dbHandler.queryComment(cidOf("post"))!;
            const postReplies = await generator.generatePostPages(post, SMALL_PRELOAD_BUDGET / 2);
            if (!postReplies || "singlePreloadedPage" in postReplies) throw new Error("expected pageCids for the flat sort");
            expect(sortedKeys(postReplies.pages)).to.deep.equal(["chronological"]);
            expect(sortedKeys(postReplies.pageCids)).to.deep.equal(["flatLatest"]);

            const reply = context.community._dbHandler.queryComment(cidOf("reply-0"))!;
            const replyReplies = await generator.generateReplyPages(reply, LARGE_PRELOAD_BUDGET);
            if (!replyReplies || !("singlePreloadedPage" in replyReplies))
                throw new Error("expected only the preloaded sort for reply replies");
            expect(sortedKeys(replyReplies.singlePreloadedPage)).to.deep.equal(["chronological"]);
        } finally {
            await context.cleanup();
        }
    });

    it("stored CommentUpdates and the nested reply trees rebuilt from the DB are keyed by the override", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, { replies: [{ name: "old", sortName: "chronological", preloaded: true }] });
            const { cidOf } = await seedComments(context.community, [
                { label: "post", children: [{ label: "r1", children: [{ label: "r1a" }, { label: "r1b" }] }, { label: "r2" }] }
            ]);
            await regenerateAllCommentUpdates(context.community);
            expect(context.community._dbHandler.queryCommentsToBeUpdated()).to.deep.equal([]);

            // the stored form of a CommentUpdate's replies is keyed by sort name directly
            const storedPost = context.community._dbHandler.queryStoredCommentUpdate({ cid: cidOf("post") });
            expect(sortedKeys(storedPost?.replies)).to.deep.equal(["chronological"]);

            const tree = context.community._dbHandler.queryPageCommentsWithResolvedReplies({
                parentCid: cidOf("post"),
                excludeDeletedComments: false,
                excludeRemovedComments: false,
                excludeCommentWithApprovedFalse: false,
                excludeCommentPendingApproval: true,
                preloadedPage: "chronological",
                baseTimestamp: timestamp()
            });
            const r1 = tree.find((entry) => entry.commentUpdate.cid === cidOf("r1"));
            expect(r1, "r1 should be a direct child of the post").to.exist;
            expect(sortedKeys(r1!.commentUpdate.replies?.pages)).to.deep.equal(["chronological"]);
            expect(commentCidsOfPage(r1!.commentUpdate.replies?.pages.chronological)).to.deep.equal([cidOf("r1a"), cidOf("r1b")]);

            // a child's newer update still re-flags its parent when the preloaded key is an override
            context.community._dbHandler["_db"]
                .prepare(`UPDATE commentUpdates SET updatedAt = (SELECT updatedAt FROM commentUpdates WHERE cid = ?) + 5 WHERE cid = ?`)
                .run(cidOf("r1"), cidOf("r1a"));
            expect(context.community._dbHandler.queryCommentsToBeUpdated().map((row) => row.cid)).to.include(cidOf("r1"));
        } finally {
            await context.cleanup();
        }
    });

    it("renaming a key regenerates under the new key and the old key is gone, for posts and for stored reply pages", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            const pagesWithKeys = (postKey: string, replyKey: string): PagesSettings => ({
                posts: [{ name: "new", sortName: postKey, preloaded: true }],
                replies: [{ name: "old", sortName: replyKey, preloaded: true }]
            });
            await editPages(context, pagesWithKeys("latest", "chronological"));
            const { cidOf } = await seedComments(context.community, [{ label: "post", children: [{ label: "r1" }, { label: "r2" }] }]);
            await regenerateAllCommentUpdates(context.community);
            const generator = getPageGenerator(context.community);

            const before = await generator.generateCommunityPosts({ preloadedPageSizeBytes: LARGE_PRELOAD_BUDGET });
            if (!before || !("singlePreloadedPage" in before)) throw new Error("expected the single preloaded page shortcut");
            expect(sortedKeys(before.singlePreloadedPage)).to.deep.equal(["latest"]);
            expect(sortedKeys(context.community._dbHandler.queryStoredCommentUpdate({ cid: cidOf("post") })?.replies)).to.deep.equal([
                "chronological"
            ]);

            await editPages(context, pagesWithKeys("fresh", "oldestFirst"));
            await regenerateAllCommentUpdates(context.community);

            const after = await generator.generateCommunityPosts({ preloadedPageSizeBytes: LARGE_PRELOAD_BUDGET });
            if (!after || !("singlePreloadedPage" in after)) throw new Error("expected the single preloaded page shortcut");
            expect(sortedKeys(after.singlePreloadedPage)).to.deep.equal(["fresh"]);
            const storedReplies = context.community._dbHandler.queryStoredCommentUpdate({ cid: cidOf("post") })?.replies;
            expect(sortedKeys(storedReplies)).to.deep.equal(["oldestFirst"]);
            expect(storedReplies?.oldestFirst?.commentCids).to.deep.equal([cidOf("r1"), cidOf("r2")]);
            // the nested post entry inside the posts page carries the renamed reply key too
            const postEntry = after.singlePreloadedPage.fresh.comments[0];
            expect(sortedKeys(postEntry.commentUpdate.replies?.pages)).to.deep.equal(["oldestFirst"]);
        } finally {
            await context.cleanup();
        }
    });

    // docs/protocol/page-sorts.md, "Re-sorting a page locally": on a configured community the key is a label and the
    // package is community.pageSorts[scope][key].name. Here the key `hot` is the built-in `old`.
    it("a client re-sorts an overridden key with the package community.pageSorts names, not the built-in the key looks like", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, { posts: [{ name: "old", sortName: "hot", preloaded: true }] });
            const now = timestamp();
            const { cidOf } = await seedComments(context.community, [
                { label: "first", timestamp: now - 3000 },
                { label: "second", timestamp: now - 2000 },
                { label: "third", timestamp: now - 1000 }
            ]);
            await updateCommentsThatNeedToBeUpdated(context.community);
            const posts = await getPageGenerator(context.community).generateCommunityPosts({
                preloadedPageSizeBytes: LARGE_PRELOAD_BUDGET
            });
            if (!posts || !("singlePreloadedPage" in posts)) throw new Error("expected the single preloaded page shortcut");
            const oldestFirst = ["first", "second", "third"].map(cidOf);
            expect(commentCidsOfPage(posts.singlePreloadedPage.hot)).to.deep.equal(oldestFirst);

            const published = context.community.pageSorts?.posts?.hot;
            expect(published?.name).to.equal("old");
            const shuffled = [...posts.singlePreloadedPage.hot.comments].reverse();
            const resortWith = (packageName: string) =>
                resortPageLikeAUi({
                    comments: shuffled,
                    factory: pkcJsPageSorts[packageName],
                    pageSortSettings: { name: packageName, options: published?.publicOptions },
                    baseTimestamp: now
                }).map((entry) => entry.commentUpdate.cid);
            expect(resortWith(published!.name!)).to.deep.equal(oldestFirst);
            // resolving the package from the key instead would silently apply the wrong scorer
            expect(resortWith("hot")).to.not.deep.equal(oldestFirst);
        } finally {
            await context.cleanup();
        }
    });

    it("a sort whose file throws is reported under its override, and the other sorts still publish", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, {
                posts: [
                    { path: THROWING_SORT_PATH, sortName: "broken", preloaded: true },
                    { name: "new", sortName: "latest", preloaded: true },
                    { name: "old" }
                ]
            });
            await seedComments(context.community, manyPosts(14));
            await updateCommentsThatNeedToBeUpdated(context.community);

            const posts = await getPageGenerator(context.community).generateCommunityPosts({
                preloadedPageSizeBytes: SMALL_PRELOAD_BUDGET
            });
            if (!posts || "singlePreloadedPage" in posts) throw new Error("expected the multi-chunk path");
            expect(sortedKeys(posts.pages)).to.deep.equal(["latest"]);
            expect(sortedKeys(posts.pageCids)).to.deep.equal(["old"]);
            expect(sortedKeys(posts.failedSorts)).to.deep.equal(["broken"]);
            expect(posts.failedSorts.broken.code).to.equal("ERR_PAGE_SORT_FAILED_TO_GENERATE");
            expect(posts.failedSorts.broken.details).to.include({ sortName: "broken", scope: "posts" });
        } finally {
            await context.cleanup();
        }
    });

    it("when every sort throws, the aggregated error lists the failed sorts by their override", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await editPages(context, {
                posts: [
                    { path: THROWING_SORT_PATH, sortName: "brokenA", preloaded: true },
                    { path: THROWING_SORT_PATH, sortName: "brokenB" }
                ]
            });
            await seedComments(context.community, manyPosts(3));
            await updateCommentsThatNeedToBeUpdated(context.community);

            let caught: unknown;
            try {
                await getPageGenerator(context.community).generateCommunityPosts({ preloadedPageSizeBytes: LARGE_PRELOAD_BUDGET });
            } catch (e) {
                caught = e;
            }
            expect((caught as PKCError)?.code).to.equal("ERR_ALL_PAGE_SORTS_FAILED_TO_GENERATE");
            const failedSorts = (caught as PKCError).details.failedSorts as Record<string, PKCError>;
            expect(sortedKeys(failedSorts)).to.deep.equal(["brokenA", "brokenB"]);
        } finally {
            await context.cleanup();
        }
    });
});

// Starts a community and loads it from a second PKC to check what is actually published. It loads sorts by `path`,
// which an RPC server cannot resolve on the client's filesystem, and reads the owner instance's private state.
describeSkipIfRpc.concurrent("settings.pages[].sortName: published record (issue #483)", () => {
    let pkc: PKCType;
    let remotePKC: PKCType;
    beforeAll(async () => {
        pkc = await mockPKC({ pageSorts: { [REGISTERED_PACKAGE_NAME]: registeredNewest } });
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
    });
    afterAll(async () => {
        await pkc.destroy();
        await remotePKC.destroy();
    });

    const loadRemote = async (community: LocalCommunity, predicate: (remote: RemoteCommunity) => boolean): Promise<RemoteCommunity> => {
        const remote = (await remotePKC.createCommunity({ address: community.address })) as RemoteCommunity;
        await remote.update();
        await resolveWhenConditionIsTrue({ toUpdate: remote, predicate: async () => predicate(remote) });
        return remote;
    };

    it("community.pageSorts is keyed by the override while name, description and publicOptions still describe the file", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        await community.edit({
            settings: {
                ...community.settings,
                pages: {
                    posts: [
                        { name: "top", sortName: "topFortnight", options: { maxAge: "2w" }, preloaded: true },
                        { name: "top", sortName: "topYearly", options: { maxAge: "1y" } },
                        { name: REGISTERED_PACKAGE_NAME, sortName: "latest" },
                        // a path entry taking a built-in's key: nothing in the record may say it is the built-in
                        { path: SORT_NAME_ECHO_SORT_PATH, sortName: "hot" }
                    ],
                    replies: [
                        { name: "old", sortName: "chronological", preloaded: true },
                        { name: "newFlat", sortName: "flatLatest" }
                    ]
                }
            }
        });
        await community.start();
        try {
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            const remoteCommunity = await loadRemote(community, (remote) => remote.updatedAt === community.updatedAt);
            const postDefaults = {
                pinnedFirst: "true",
                excludeRemovedComments: "true",
                excludeDeletedComments: "true",
                excludeCommentPendingApproval: "true",
                excludeCommentWithApprovedFalse: "true"
            };
            const replyDefaults = {
                pinnedFirst: "true",
                excludeRemovedComments: "false",
                excludeDeletedComments: "false",
                excludeCommentPendingApproval: "true",
                excludeCommentWithApprovedFalse: "false"
            };
            const topDescription = pkcJsPageSorts.top({ pageSortSettings: { name: "top" } }).description;
            const newFlatDescription = pkcJsPageSorts.newFlat({ pageSortSettings: { name: "newFlat" } }).description;
            for (const _community of [community, remoteCommunity]) {
                expect(_community.pageSorts).to.deep.equal({
                    posts: {
                        topFortnight: { name: "top", description: topDescription, publicOptions: { ...postDefaults, maxAge: "2w" } },
                        topYearly: { name: "top", description: topDescription, publicOptions: { ...postDefaults, maxAge: "1y" } },
                        latest: {
                            name: REGISTERED_PACKAGE_NAME,
                            description: "Newest first, from a registered package",
                            publicOptions: postDefaults
                        },
                        hot: { description: "factory saw sortName hot", publicOptions: postDefaults }
                    },
                    replies: {
                        chronological: { name: "old", description: "Oldest first", publicOptions: replyDefaults },
                        flatLatest: { name: "newFlat", description: newFlatDescription, publicOptions: replyDefaults }
                    }
                });
                // nothing about the files' own sortNames is published
                for (const published of Object.values(_community.pageSorts?.posts ?? {}))
                    expect(published).to.not.have.property("sortName");
                expect(JSON.stringify(_community.pageSorts)).to.not.include("echo");
                expect(_community.pageSorts?.posts).to.not.have.property("top");
            }
            expect(remoteCommunity.raw.communityIpfs?.pageSorts).to.deep.equal(community.pageSorts);
            await remoteCommunity.stop();
        } finally {
            await community.stop();
        }
    });

    it("a remote client finds the override keys in pages and pageCids, gets client state for them and loads their pages", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.edit({
            settings: {
                ...community.settings,
                // no entry preloaded: every sort is published through pageCids
                pages: {
                    posts: [
                        { name: "new", sortName: "latest" },
                        { name: "top", sortName: "topFortnight", options: { maxAge: "2w" } }
                    ]
                }
            }
        });
        await community.start();
        try {
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            const post = await generateMockPost({ communityAddress: community.address, pkc });
            await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => typeof community.posts.pageCids?.topFortnight === "string"
            });
            expect(sortedKeys(community.posts.pageCids)).to.deep.equal(["latest", "topFortnight"]);
            expect(sortedKeys(community.posts.pages)).to.deep.equal([]);

            const remoteCommunity = await loadRemote(community, (remote) => typeof remote.posts.pageCids?.topFortnight === "string");
            expect(sortedKeys(remoteCommunity.posts.pageCids)).to.deep.equal(["latest", "topFortnight"]);
            expect(remoteCommunity.posts.pageCids).to.not.have.property("new");
            expect(remoteCommunity.posts.pageCids).to.not.have.property("top");

            // client state is keyed by sort name, then by client URL; the built-in names are pre-seeded next to the
            // keys found in pageCids
            const kuboClients = remoteCommunity.posts.clients.kuboRpcClients as unknown as Record<
                string,
                Record<string, { state: string }>
            >;
            expect(Object.keys(kuboClients)).to.include.members(["latest", "topFortnight"]);
            for (const key of ["latest", "topFortnight"]) expect(Object.keys(kuboClients[key]).length, key).to.be.greaterThan(0);

            for (const key of ["latest", "topFortnight"]) {
                const page = await remoteCommunity.posts.getPage({ cid: remoteCommunity.posts.pageCids[key] });
                expect(
                    page.comments.map((comment) => comment.cid),
                    key
                ).to.deep.equal([post.cid]);
            }
            await remoteCommunity.stop();
        } finally {
            await community.stop();
        }
    });

    it("a preloaded override is the embedded default sort of the published record", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.edit({
            settings: { ...community.settings, pages: { posts: [{ name: "new", sortName: "latest", preloaded: true }, { name: "hot" }] } }
        });
        await community.start();
        try {
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            const post = await generateMockPost({ communityAddress: community.address, pkc });
            await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
            const remoteCommunity = await loadRemote(community, (remote) => remote.posts.pages?.latest?.comments?.[0]?.cid === post.cid);
            expect(Object.keys(remoteCommunity.posts.pages)).to.deep.equal(["latest"]);
            expect(Object.keys(remoteCommunity.raw.communityIpfs!.posts!.pages)).to.deep.equal(["latest"]);
            expect(remoteCommunity.pageSorts?.posts?.latest?.name).to.equal("new");
            await remoteCommunity.stop();
        } finally {
            await community.stop();
        }
    });
});

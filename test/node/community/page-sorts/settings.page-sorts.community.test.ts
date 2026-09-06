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
import { DbHandler } from "../../../../dist/node/runtime/node/community/db-handler.js";
import { timestamp } from "../../../../dist/node/util.js";
import {
    createCommunityWithDefaultDb,
    regenerateAllCommentUpdates,
    seedComments,
    NO_BUMP_KEYWORD_SORT_PATH,
    THROWING_SORT_PATH
} from "./page-sorts-test-util.js";

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RemoteCommunity } from "../../../../dist/node/community/remote-community.js";
import type { CommunitySettings } from "../../../../dist/node/community/types.js";

type PagesSettings = NonNullable<CommunitySettings["pages"]>;

// Invalid entries are rejected the way challenges are: loading failures (a bad name or path) and schema errors
// propagate as their own code, everything found by validating the loaded file is aggregated under
// ERR_PAGE_SORT_SETTINGS_VALIDATION_FAILED_FOR_PAGE_SORTS with one failure per entry.
const TOP_LEVEL_CODES = new Set(["ERR_COMMUNITY_EDIT_OPTIONS_SCHEMA", "ERR_FAILED_TO_IMPORT_PAGE_SORT_FILE_FACTORY"]);

async function expectEditToFail(community: LocalCommunity, pages: PagesSettings, code: string): Promise<PKCError> {
    let caught: unknown;
    try {
        await community.edit({ settings: { ...community.settings, pages } });
    } catch (e) {
        caught = e;
    }
    expect(caught, `expected edit with ${JSON.stringify(pages)} to throw ${code}`).to.be.instanceOf(PKCError);
    const error = caught as PKCError;
    if (TOP_LEVEL_CODES.has(code)) {
        expect(error.code).to.equal(code);
        return error;
    }
    expect(error.code).to.equal("ERR_PAGE_SORT_SETTINGS_VALIDATION_FAILED_FOR_PAGE_SORTS");
    const failures = error.details.failures as { error: PKCError }[];
    const failure = failures.find((f) => f.error.code === code);
    expect(failure, `expected a failure with code ${code}, got ${failures.map((f) => f.error.code).join(", ")}`).to.exist;
    return failure!.error;
}

// settings.pages is validated by the LocalCommunity edit path, which only runs in this process (not over RPC).
describeSkipIfRpc.concurrent("settings.pages: validation", () => {
    let pkc: PKCType;
    beforeAll(async () => {
        pkc = await mockPKC();
    });
    afterAll(async () => {
        await pkc.destroy();
    });

    it("accepts empty posts and replies lists and stores the settings verbatim", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        const pages: PagesSettings = { posts: [], replies: [] };
        await community.edit({ settings: { ...community.settings, pages } });
        expect(community.settings?.pages).to.deep.equal(pages);
    });

    it("rejects an entry with neither name nor path", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        await expectEditToFail(community, { posts: [{ options: { maxAge: "1d" } }] }, "ERR_COMMUNITY_EDIT_OPTIONS_SCHEMA");
    });

    it("rejects an unregistered name", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        await expectEditToFail(community, { posts: [{ name: "does-not-exist" }] }, "ERR_FAILED_TO_IMPORT_PAGE_SORT_FILE_FACTORY");
    });

    it("rejects two entries resolving to the same sortName", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        const error = await expectEditToFail(
            community,
            { posts: [{ name: "active" }, { path: NO_BUMP_KEYWORD_SORT_PATH, options: { noBumpKeywords: "sage" } }] },
            "ERR_PAGE_SORT_DUPLICATE_SORT_NAME"
        );
        expect(error.details).to.include({ sortName: "active" });
    });

    it("rejects a reply-scoped sort under posts and a post-scoped sort under replies", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        await expectEditToFail(community, { posts: [{ name: "newFlat" }] }, "ERR_PAGE_SORT_SCOPE_MISMATCH");
        await expectEditToFail(community, { replies: [{ name: "active" }] }, "ERR_PAGE_SORT_SCOPE_MISMATCH");
    });

    it("rejects an option the sort file does not declare, but accepts the reserved options on every sort", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        await expectEditToFail(
            community,
            { posts: [{ name: "new", options: { noBumpKeywords: "sage" } }] },
            "ERR_PAGE_SORT_OPTION_NOT_DECLARED_IN_OPTION_INPUTS"
        );
        const pages: PagesSettings = {
            posts: [{ name: "new", options: { maxAge: "2w", pinnedFirst: "false", excludeRemovedComments: "false" } }]
        };
        await community.edit({ settings: { ...community.settings, pages } });
        expect(community.settings?.pages).to.deep.equal(pages);
    });

    it("rejects a malformed maxAge and a non-boolean pinnedFirst", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        await expectEditToFail(
            community,
            { posts: [{ name: "new", options: { maxAge: "fortnight" } }] },
            "ERR_PAGE_SORT_INVALID_RESERVED_OPTION"
        );
        await expectEditToFail(
            community,
            { posts: [{ name: "new", options: { pinnedFirst: "yes" } }] },
            "ERR_PAGE_SORT_INVALID_RESERVED_OPTION"
        );
    });

    it("rejects a privateOptions entry that is not a set option", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        await expectEditToFail(community, { posts: [{ name: "new", privateOptions: ["maxAge"] }] }, "ERR_PAGE_SORT_PRIVATE_OPTION_NOT_SET");
    });

    it("accepts every built-in under its scope, including controversial", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        const pages: PagesSettings = {
            posts: [
                { name: "hot", preloaded: true },
                { name: "new" },
                { name: "active" },
                { name: "controversial" },
                { name: "topHour" },
                { name: "topDay" },
                { name: "topWeek" },
                { name: "topMonth" },
                { name: "topYear" },
                { name: "topAll" },
                { name: "old" },
                { name: "best" }
            ],
            replies: [
                { name: "best", preloaded: true },
                { name: "new" },
                { name: "old" },
                { name: "newFlat" },
                { name: "oldFlat" },
                { name: "controversial" }
            ]
        };
        await community.edit({ settings: { ...community.settings, pages } });
        expect(community.settings?.pages).to.deep.equal(pages);
    });
});

describeSkipIfRpc.concurrent("settings.pages: regeneration triggers", () => {
    it("any settings.pages edit flags every comment for CommentUpdate regeneration; an unrelated settings edit does not", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            const { rows } = await seedComments(context.community, [
                { label: "post-a", children: [{ label: "reply-a" }] },
                { label: "post-b", children: [{ label: "reply-b", children: [{ label: "reply-b-child" }] }] }
            ]);
            await regenerateAllCommentUpdates(context.community);
            expect(context.community._dbHandler.queryCommentsToBeUpdated()).to.deep.equal([]);

            await context.community.edit({ settings: { ...context.community.settings, fetchThumbnailUrls: true } });
            await context.community._dbHandler.initDbIfNeeded();
            expect(context.community._dbHandler.queryCommentsToBeUpdated()).to.deep.equal([]);

            await context.community.edit({
                settings: { ...context.community.settings, pages: { replies: [{ name: "old", preloaded: true }] } }
            });
            await context.community._dbHandler.initDbIfNeeded();
            const flagged = context.community._dbHandler.queryCommentsToBeUpdated().map((row) => row.cid);
            expect(flagged.sort()).to.deep.equal(rows.map((row) => row.cid!).sort());

            // Regeneration clears the flags again
            await regenerateAllCommentUpdates(context.community);
            expect(context.community._dbHandler.queryCommentsToBeUpdated()).to.deep.equal([]);

            // Re-submitting the identical pages config is not a change
            await context.community.edit({
                settings: { ...context.community.settings, pages: { replies: [{ name: "old", preloaded: true }] } }
            });
            await context.community._dbHandler.initDbIfNeeded();
            expect(context.community._dbHandler.queryCommentsToBeUpdated()).to.deep.equal([]);
        } finally {
            await context.cleanup();
        }
    });

    it("a windowed reply sort re-flags a parent only when a non-pinned reply crosses the window boundary", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            const WINDOW_SECONDS = 4;
            await context.community.edit({
                settings: {
                    ...context.community.settings,
                    pages: { replies: [{ name: "new", options: { maxAge: `${WINDOW_SECONDS}s` }, preloaded: true }] }
                }
            });
            await context.community._dbHandler.initDbIfNeeded();
            const now = timestamp();
            const { cidOf } = await seedComments(context.community, [
                { label: "crossing", children: [{ label: "crossing-reply", timestamp: now - 1 }] },
                { label: "already-out", children: [{ label: "old-reply", timestamp: now - 100 }] },
                { label: "pinned", children: [{ label: "pinned-reply", timestamp: now - 1 }] },
                { label: "no-replies" }
            ]);
            await regenerateAllCommentUpdates(context.community);
            context.community._dbHandler["_db"].prepare(`UPDATE commentUpdates SET pinned = 1 WHERE cid = ?`).run(cidOf("pinned-reply"));
            expect(context.community._dbHandler.queryCommentsToBeUpdated()).to.deep.equal([]);

            await new Promise((resolve) => setTimeout(resolve, (WINDOW_SECONDS + 1) * 1000));

            const flagged = context.community._dbHandler.queryCommentsToBeUpdated().map((row) => row.cid);
            expect(flagged).to.deep.equal([cidOf("crossing")]);

            // Regenerating drops the aged-out reply from the page and clears the flag; nothing else crosses later
            await regenerateAllCommentUpdates(context.community);
            const crossingUpdate = context.community._dbHandler.queryStoredCommentUpdate({ cid: cidOf("crossing") });
            expect(crossingUpdate?.replies).to.be.undefined;
            expect(context.community._dbHandler.queryCommentsToBeUpdated()).to.deep.equal([]);
        } finally {
            await context.cleanup();
        }
    });
});

describeSkipIfRpc.concurrent("settings.pages: the db facade", () => {
    it("rejects a write statement on a file-backed community and still serves reads", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            const db = context.community._dbHandler.createPageSortDb();
            expect(db.prepare("SELECT COUNT(*) AS n FROM comments").get()).to.deep.equal({ n: 0 });
            expect(() => db.prepare("DELETE FROM comments")).to.throw();
            expect(() => db.prepare("INSERT INTO keyv (key, value) VALUES ('x', 'y')")).to.throw();
            expect(db.exclusionClauses({ excludeRemovedComments: "true" }, { comment: "c", update: "cu" }).sql).to.include("cu.removed");
        } finally {
            await context.cleanup();
        }
    });

    it("rejects a write statement on a noData (in-memory) community through the shared handle", async () => {
        // pkc.createCommunity refuses to create a local community without a dataPath, so an in-memory community DB only
        // exists when a DbHandler is built by hand (the migration tests do the same); the facade must still work there.
        const fakeCommunity = { address: "in-memory-page-sorts", _pkc: { noData: true } } as unknown as LocalCommunity;
        const dbHandler = new DbHandler(fakeCommunity);
        await dbHandler.initDbIfNeeded({ filename: ":memory:", fileMustExist: false });
        try {
            await dbHandler.createOrMigrateTablesIfNeeded();
            const db = dbHandler.createPageSortDb();
            expect(db.prepare("SELECT COUNT(*) AS n FROM comments").get()).to.deep.equal({ n: 0 });
            expect(() => db.prepare("DELETE FROM comments")).to.throw();
        } finally {
            dbHandler.destoryConnection();
        }
    });
});

describeSkipIfRpc.concurrent("settings.pages: published record", () => {
    let pkc: PKCType;
    let remotePKC: PKCType;
    beforeAll(async () => {
        pkc = await mockPKC();
        remotePKC = await mockPKCNoDataPathWithOnlyKuboClient();
    });
    afterAll(async () => {
        await pkc.destroy();
        await remotePKC.destroy();
    });

    it("publishes community.pageSorts with every option public by default and privateOptions withheld", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        await community.edit({
            settings: {
                ...community.settings,
                pages: {
                    posts: [
                        {
                            path: NO_BUMP_KEYWORD_SORT_PATH,
                            options: { noBumpKeywords: "sage", maxAge: "1w" },
                            privateOptions: ["maxAge"],
                            preloaded: true
                        }
                    ],
                    replies: [
                        { name: "old", preloaded: true },
                        { name: "new", options: { pinnedFirst: "false" } }
                    ]
                }
            }
        });
        await community.start();
        try {
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            const remoteCommunity = (await remotePKC.getCommunity({ address: community.address })) as RemoteCommunity;
            expect(remoteCommunity.updatedAt).to.equal(community.updatedAt);
            for (const _community of [community, remoteCommunity]) {
                expect(_community.pageSorts).to.deep.equal({
                    posts: {
                        active: {
                            description: "Bump order where replies whose content is one of the configured keywords do not bump the thread",
                            publicOptions: { noBumpKeywords: "sage" }
                        }
                    },
                    replies: {
                        old: { name: "old", description: "Oldest first" },
                        new: { name: "new", description: "Newest first", publicOptions: { pinnedFirst: "false" } }
                    }
                });
            }
            expect(remoteCommunity.raw.communityIpfs?.pageSorts).to.deep.equal(community.pageSorts);
        } finally {
            await community.stop();
        }
    });

    it("an unset settings.pages publishes no pageSorts field", async () => {
        const community = (await pkc.createCommunity()) as LocalCommunity;
        await community.start();
        try {
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            expect(community.pageSorts).to.be.undefined;
            expect(community.raw.communityIpfs?.pageSorts).to.be.undefined;
        } finally {
            await community.stop();
        }
    });

    it("a configured sort that stops producing emits on the community's error event on every cycle that generates pages", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.edit({
            settings: {
                ...community.settings,
                pages: {
                    posts: [
                        { path: THROWING_SORT_PATH, preloaded: true },
                        { name: "new", preloaded: true }
                    ]
                }
            }
        });
        const errors: PKCError[] = [];
        community.on("error", (error) => {
            if ((error as PKCError).code === "ERR_PAGE_SORT_FAILED_TO_GENERATE") errors.push(error as PKCError);
        });
        await community.start();
        try {
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            expect(errors).to.deep.equal([]); // nothing to sort yet

            const post1 = await generateMockPost({ communityAddress: community.address, pkc });
            await publishWithExpectedResult({ publication: post1, expectedChallengeSuccess: true });
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => errors.length >= 1 });
            expect(errors[0].details).to.include({ sortName: "throwing", scope: "posts" });
            expect(community.posts?.pages).to.have.property("new");
            expect(community.posts?.pages).to.not.have.property("throwing");

            const post2 = await generateMockPost({ communityAddress: community.address, pkc });
            await publishWithExpectedResult({ publication: post2, expectedChallengeSuccess: true });
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => errors.length >= 2 });
        } finally {
            await community.stop();
        }
    });
});

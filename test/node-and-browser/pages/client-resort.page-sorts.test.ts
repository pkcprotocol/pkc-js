import { beforeAll, afterAll, describe, it, expect } from "vitest";
import signers from "../../fixtures/signers.js";
import activeNoBumpKeywordPageSort from "../../fixtures/page-sorts/active-no-bump-keyword.js";
import keywordFilterPageSort from "../../fixtures/page-sorts/keyword-filter.js";
import { resortPageLikeAUi, walkRepliesOfPage } from "./page-sorts-client-test-util.js";
import {
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue,
    PAGE_SORTS_TEST_COMMUNITY
} from "../../../dist/node/test/test-util.js";
import { pageSorts as builtInPageSorts } from "../../../dist/node/index.js";
import { timestamp } from "../../../dist/node/util.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { PageTypeJson } from "../../../dist/node/pages/types.js";
import type { PageSortFileFactory, PageSortFileFactoryInput } from "../../../dist/node/community/types.js";

const communityAddress = signers[12].address; // subForPageSorts on the test server

const titlesOf = (comments: PageTypeJson["comments"]) => comments.map((comment) => comment.title);
const shuffled = <T>(items: T[]): T[] => [...items].reverse();

// A client can reproduce a community's page order, or apply any other sort it has, from the embedded page alone:
// the community publishes every option each sort runs with (community.pageSorts[sortName].publicOptions) and the
// package's per-comment `score` needs no database. pkc-js exports no sorter: the UI installs the package the
// community names (community.pageSorts[sortName].name) and applies its `score` itself, which resortPageLikeAUi is
// the doc's worked example of (issue #73).
getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`client-side re-sorting with a page-sort package - ${config.name}`, () => {
        let pkc: PKCType;
        let community: RemoteCommunity;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise({
                pkcOptions: {
                    pageSorts: { [PAGE_SORTS_TEST_COMMUNITY.registryName]: activeNoBumpKeywordPageSort as PageSortFileFactoryInput }
                }
            });
            community = (await pkc.createCommunity({ address: communityAddress })) as RemoteCommunity;
            await community.update();
            await resolveWhenConditionIsTrue({
                toUpdate: community,
                predicate: async () => Boolean(community.posts.pages[PAGE_SORTS_TEST_COMMUNITY.sortName]) && Boolean(community.pageSorts)
            });
        });
        afterAll(async () => {
            await community.stop();
            await pkc.destroy();
        });

        it("community.pageSorts names the package and publishes the full option set the sort ran with", () => {
            const published = community.pageSorts?.posts?.[PAGE_SORTS_TEST_COMMUNITY.sortName];
            expect(published?.name).to.equal(PAGE_SORTS_TEST_COMMUNITY.registryName);
            expect(published?.publicOptions).to.deep.equal({
                noBumpKeywords: PAGE_SORTS_TEST_COMMUNITY.noBumpKeyword,
                pinnedFirst: "true",
                excludeRemovedComments: "true",
                excludeDeletedComments: "true",
                excludeCommentPendingApproval: "true",
                excludeCommentWithApprovedFalse: "true",
                excludeCommentsWithDifferentCommunityAddress: "true"
            });
            expect(Object.keys(community.pageSorts?.posts ?? {}).sort()).to.deep.equal(["active", "new"]);
        });

        it("re-sorting the embedded page with the package the community names under community.pageSorts[].name reproduces the community's order, once the caller walked the replies", async () => {
            const published = community.pageSorts!.posts![PAGE_SORTS_TEST_COMMUNITY.sortName];
            const page = community.posts.pages[PAGE_SORTS_TEST_COMMUNITY.sortName]!;
            expect(titlesOf(page.comments)).to.deep.equal(["page-sorts a", "page-sorts c", "page-sorts b"]);

            // The lookup a UI does: the package it installed under the published name, or a built-in
            const factory = pkc.settings.pageSorts?.[published.name!] ?? builtInPageSorts[published.name!];
            expect(factory, "the package must be installed on the client under the published name").to.exist;
            const pageSortSettings = { name: published.name, options: published.publicOptions };
            expect(
                (factory as PageSortFileFactory)({ pageSortSettings }).requireReplies,
                "the no-bump sort declares it needs the reply set"
            ).to.be.true;

            // A package with requireReplies cannot score without the reply set: the UI walks them first
            expect(() => resortPageLikeAUi({ comments: page.comments, factory, pageSortSettings, baseTimestamp: timestamp() })).to.throw(
                /requireReplies/
            );

            // The whole board fits in one chunk, so every thread embeds its replies as the whole set; the walk reads them
            const replies = await walkRepliesOfPage({ comments: page.comments, pkc });
            expect(replies.map((entry) => entry.comment.content).sort()).to.deep.equal(
                [PAGE_SORTS_TEST_COMMUNITY.noBumpKeyword, "bumps a"].sort()
            );
            const resorted = resortPageLikeAUi({
                comments: shuffled(page.comments),
                factory,
                pageSortSettings,
                baseTimestamp: timestamp(),
                replies
            });
            expect(titlesOf(resorted)).to.deep.equal(titlesOf(page.comments));
        });

        it("the same page re-sorted with a built-in gives that sort's order: new, and plain active from the CommentUpdate's bump time", () => {
            const page = community.posts.pages[PAGE_SORTS_TEST_COMMUNITY.sortName]!;
            const options = community.pageSorts!.posts![PAGE_SORTS_TEST_COMMUNITY.sortName].publicOptions!;
            const byNew = resortPageLikeAUi({
                comments: page.comments,
                factory: builtInPageSorts.new,
                pageSortSettings: { name: "new", options },
                baseTimestamp: timestamp()
            });
            expect(titlesOf(byNew)).to.deep.equal(["page-sorts c", "page-sorts b", "page-sorts a"]);

            // The plain built-in `active` needs no reply set: it reads commentUpdate.lastReplyTimestamp, so the sage reply bumps b
            expect((builtInPageSorts.active as PageSortFileFactory)({ pageSortSettings: { name: "active" } }).requireReplies).to.not.be
                .true;
            const byActive = resortPageLikeAUi({
                comments: shuffled(page.comments),
                factory: builtInPageSorts.active,
                pageSortSettings: { name: "active", options },
                baseTimestamp: timestamp()
            });
            expect(titlesOf(byActive)).to.deep.equal(["page-sorts a", "page-sorts b", "page-sorts c"]);
        });

        it("a package whose score returns null drops the comment on the client too, from that sort only", () => {
            const page = community.posts.pages[PAGE_SORTS_TEST_COMMUNITY.sortName]!;
            const b = page.comments.find((comment) => comment.title === "page-sorts b")!;
            const a = page.comments.find((comment) => comment.title === "page-sorts a")!;
            const bReplies = b.replies!.pages[Object.keys(b.replies!.pages)[0]]!.comments;
            const aReplies = a.replies!.pages[Object.keys(a.replies!.pages)[0]]!.comments;
            expect(bReplies.map((reply) => reply.content)).to.deep.equal([PAGE_SORTS_TEST_COMMUNITY.noBumpKeyword]);

            const factory = keywordFilterPageSort as PageSortFileFactoryInput;
            const pageSortSettings = { name: "keywordFilter", options: { dropKeywords: PAGE_SORTS_TEST_COMMUNITY.noBumpKeyword } };
            expect(resortPageLikeAUi({ comments: bReplies, factory, pageSortSettings, baseTimestamp: timestamp() })).to.deep.equal([]);
            expect(
                resortPageLikeAUi({ comments: aReplies, factory, pageSortSettings, baseTimestamp: timestamp() }).map(
                    (reply) => reply.content
                )
            ).to.deep.equal(["bumps a"]);
        });
    });
});

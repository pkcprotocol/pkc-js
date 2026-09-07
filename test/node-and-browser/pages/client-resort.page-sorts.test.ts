import { beforeAll, afterAll, describe, it, expect } from "vitest";
import signers from "../../fixtures/signers.js";
import activeNoBumpKeywordPageSort from "../../fixtures/page-sorts/active-no-bump-keyword.js";
import keywordFilterPageSort from "../../fixtures/page-sorts/keyword-filter.js";
import { walkRepliesOfPage } from "./page-sorts-client-test-util.js";
import {
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue,
    PAGE_SORTS_TEST_COMMUNITY
} from "../../../dist/node/test/test-util.js";
import { sortPageComments, instantiatePageSortFile, pageSorts as builtInPageSorts } from "../../../dist/node/index.js";
import { DEFAULT_RESERVED_OPTIONS } from "../../../dist/node/pages/page-sort-options.js";
import { timestamp } from "../../../dist/node/util.js";

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { PageTypeJson } from "../../../dist/node/pages/types.js";
import type { PageSortFileFactoryInput } from "../../../dist/node/community/types.js";

const communityAddress = signers[12].address; // subForPageSorts on the test server

const titlesOf = (comments: PageTypeJson["comments"]) => comments.map((comment) => comment.title);
const shuffled = <T>(items: T[]): T[] => [...items].reverse();

// A client can reproduce a community's page order, or apply any other sort it has, from the embedded page alone:
// the community publishes every option each sort runs with (community.pageSorts[sortName].publicOptions) and the
// package's per-comment `score` needs no database. Registering the fixture under the name the community names it
// by (community.pageSorts[sortName].name) is what a UI does with an installed page-sort package (issue #73).
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

        it("re-sorting the embedded page with the package registered under community.pageSorts[].name reproduces the community's order, once the caller walked the replies", async () => {
            const published = community.pageSorts!.posts![PAGE_SORTS_TEST_COMMUNITY.sortName];
            const page = community.posts.pages[PAGE_SORTS_TEST_COMMUNITY.sortName]!;
            expect(titlesOf(page.comments)).to.deep.equal(["page-sorts a", "page-sorts c", "page-sorts b"]);

            // The lookup a UI does: the instance's registered packages first (the `pageSorts` PKC option), then the built-ins
            const factory = pkc.settings.pageSorts?.[published.name!] ?? builtInPageSorts[published.name!];
            expect(factory, "the package must be registered on the client under the published name").to.exist;
            const file = instantiatePageSortFile({ factory, pageSortSettings: { name: published.name, options: published.publicOptions } });
            expect(file.requireReplies, "the no-bump sort declares it needs the reply set").to.be.true;

            // A file with requireReplies cannot score without the reply set, and the error says so
            expect(() =>
                sortPageComments({
                    comments: page.comments,
                    file,
                    options: published.publicOptions!,
                    baseTimestamp: timestamp(),
                    communityAddress: community.address
                })
            )
                .to.throw()
                .with.property("code", "ERR_PAGE_SORT_REPLIES_REQUIRED");

            // The whole board fits in one chunk, so every thread embeds its replies as the whole set; the walk reads them
            const replies = await walkRepliesOfPage({ comments: page.comments, pkc });
            expect(replies.map((entry) => entry.comment.content).sort()).to.deep.equal([
                PAGE_SORTS_TEST_COMMUNITY.noBumpKeyword,
                "bumps a"
            ]);
            const resorted = sortPageComments({
                comments: shuffled(page.comments),
                file,
                options: published.publicOptions!,
                baseTimestamp: timestamp(),
                communityAddress: community.address,
                replies
            });
            expect(titlesOf(resorted)).to.deep.equal(titlesOf(page.comments));
        });

        it("the same page re-sorted with a built-in gives that sort's order: new, and plain active from the CommentUpdate's bump time", () => {
            const page = community.posts.pages[PAGE_SORTS_TEST_COMMUNITY.sortName]!;
            const publishedOptions = community.pageSorts!.posts![PAGE_SORTS_TEST_COMMUNITY.sortName].publicOptions!;
            const newFile = instantiatePageSortFile({ factory: builtInPageSorts.new, pageSortSettings: { name: "new" } });
            const byNew = sortPageComments({
                comments: page.comments,
                file: newFile,
                options: publishedOptions,
                baseTimestamp: timestamp()
            });
            expect(titlesOf(byNew)).to.deep.equal(["page-sorts c", "page-sorts b", "page-sorts a"]);

            // The plain built-in `active` needs no reply set: it reads commentUpdate.lastReplyTimestamp, so the sage reply bumps b
            const activeFile = instantiatePageSortFile({ factory: builtInPageSorts.active, pageSortSettings: { name: "active" } });
            expect(activeFile.requireReplies).to.not.be.true;
            const byActive = sortPageComments({
                comments: shuffled(page.comments),
                file: activeFile,
                options: publishedOptions,
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

            const file = instantiatePageSortFile({
                factory: keywordFilterPageSort as PageSortFileFactoryInput,
                pageSortSettings: { name: "keywordFilter", options: { dropKeywords: PAGE_SORTS_TEST_COMMUNITY.noBumpKeyword } }
            });
            const options = { ...DEFAULT_RESERVED_OPTIONS.replies, dropKeywords: PAGE_SORTS_TEST_COMMUNITY.noBumpKeyword };
            expect(sortPageComments({ comments: bReplies, file, options, baseTimestamp: timestamp() })).to.deep.equal([]);
            expect(
                sortPageComments({ comments: aReplies, file, options, baseTimestamp: timestamp() }).map((reply) => reply.content)
            ).to.deep.equal(["bumps a"]);
        });
    });
});

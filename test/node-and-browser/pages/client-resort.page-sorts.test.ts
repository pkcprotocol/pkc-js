import { beforeAll, afterAll, describe, it, expect } from "vitest";
import signers from "../../fixtures/signers.js";
import activeNoBumpKeywordPageSort from "../../fixtures/page-sorts/active-no-bump-keyword.js";
import {
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue,
    PAGE_SORTS_TEST_COMMUNITY
} from "../../../dist/node/test/test-util.js";
import { sortPageComments, instantiatePageSortFile, pageSorts as builtInPageSorts } from "../../../dist/node/index.js";
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

        it("re-sorting the embedded page with the package registered under community.pageSorts[].name reproduces the community's order", () => {
            const published = community.pageSorts!.posts![PAGE_SORTS_TEST_COMMUNITY.sortName];
            const page = community.posts.pages[PAGE_SORTS_TEST_COMMUNITY.sortName]!;
            expect(titlesOf(page.comments)).to.deep.equal(["page-sorts a", "page-sorts c", "page-sorts b"]);

            // The lookup a UI does: the instance's registered packages first (the `pageSorts` PKC option), then the built-ins
            const factory = pkc.settings.pageSorts?.[published.name!] ?? builtInPageSorts[published.name!];
            expect(factory, "the package must be registered on the client under the published name").to.exist;
            const file = instantiatePageSortFile({ factory, pageSortSettings: { name: published.name, options: published.publicOptions } });
            const resorted = sortPageComments({
                comments: shuffled(page.comments),
                file,
                options: published.publicOptions!,
                baseTimestamp: timestamp(),
                communityAddress: community.address
            });
            expect(titlesOf(resorted)).to.deep.equal(titlesOf(page.comments));
        });

        it("the same page re-sorted with a built-in gives that sort's order, and plain active differs from the no-bump order", () => {
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

            // The plain built-in `active` scores over SQL only: it cannot re-sort on a client, and the error says so
            const activeFile = instantiatePageSortFile({ factory: builtInPageSorts.active, pageSortSettings: { name: "active" } });
            expect(() =>
                sortPageComments({ comments: page.comments, file: activeFile, options: publishedOptions, baseTimestamp: timestamp() })
            )
                .to.throw()
                .with.property("code", "ERR_PAGE_SORT_FILE_HAS_NO_CLIENT_SCORER");
        });
    });
});

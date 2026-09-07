import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { it, expect } from "vitest";
import { v4 as uuidV4 } from "uuid";
import { mockPKC, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../../dist/node/test/test-util.js";
import { createCommunityWithDefaultDb, regenerateAllCommentUpdates, seedComments } from "./page-sorts-test-util.js";

import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";

const sortNamesOf = (community: LocalCommunity, scope: "posts" | "replies") =>
    (community._pageSorts?.[scope] ?? []).map((sort) => sort.sortName).sort();

// An edit carrying settings.pages must be atomic with the rest of the edit: nothing about the instance or the DB
// changes unless the whole edit is accepted and persisted. Both tests drive a LocalCommunity's edit path and read its
// DB and private state, which only exist in this process (not over RPC).
describeSkipIfRpc.concurrent("settings.pages: edit atomicity", () => {
    it("a rejected edit leaves the regeneration flags and the instance's page sorts untouched", async () => {
        const context = await createCommunityWithDefaultDb();
        try {
            await seedComments(context.community, [{ label: "post", children: [{ label: "reply" }] }]);
            await regenerateAllCommentUpdates(context.community);
            await context.community._ensurePageSortsLoaded();
            const repliesBefore = sortNamesOf(context.community, "replies");
            expect(repliesBefore).to.deep.equal(["best", "new", "newFlat", "old", "oldFlat"]);

            let thrown: { code?: string } | undefined;
            try {
                await context.community.edit({
                    address: "Has-Capital.bso", // rejected by address validation, after settings.pages resolves
                    settings: { ...context.community.settings, pages: { replies: [{ name: "old", preloaded: true }] } }
                });
            } catch (e) {
                thrown = e as { code?: string };
            }
            expect(thrown?.code).to.equal("ERR_COMMUNITY_NAME_HAS_CAPITAL_LETTER");

            await context.community._dbHandler.initDbIfNeeded();
            expect(context.community.settings?.pages, "settings.pages must not have changed").to.be.undefined;
            expect(context.community._dbHandler.queryCommentsToBeUpdated(), "no comment may be flagged by a rejected edit").to.deep.equal(
                []
            );
            expect(sortNamesOf(context.community, "replies"), "the instance keeps running the old sorts").to.deep.equal(repliesBefore);
        } finally {
            await context.cleanup();
        }
    });

    it("an address change on a started community restarts it with the new page sorts, not the old ones", async () => {
        const pkc = await mockPKC();
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        community.on("error", () => {}); // the new domain does not resolve; that verification error is expected
        await community.start();
        try {
            await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
            expect(sortNamesOf(community, "posts")).to.deep.equal(
                ["hot", "new", "active", "topHour", "topDay", "topWeek", "topMonth", "topYear", "topAll"].sort()
            );

            await community.edit({
                address: `page-sorts-atomicity-${uuidV4()}.bso`,
                settings: { ...community.settings, pages: { posts: [{ name: "new", preloaded: true }] } }
            });

            expect(community.settings?.pages).to.deep.equal({ posts: [{ name: "new", preloaded: true }] });
            expect(sortNamesOf(community, "posts"), "generation must use the sorts the edit persisted").to.deep.equal(["new"]);
            expect(community.pageSorts?.posts && Object.keys(community.pageSorts.posts)).to.deep.equal(["new"]);
        } finally {
            await community.stop();
            await pkc.destroy();
        }
    });
});

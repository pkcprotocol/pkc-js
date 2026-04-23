import { mockPKC, publishRandomPost, createSubWithNoChallenge, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { itSkipIfRpc } from "../../helpers/conditional-tests.js";
import { describe, beforeAll, afterAll, it, expect } from "vitest";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";

describe("CID-ref posts preservation when sharing community state between instances", () => {
    let pkc: PKCType;

    beforeAll(async () => {
        pkc = await mockPKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    // RPC skipped: test accesses internal community state directly (posts.pages) which is only
    // available on LocalCommunity, not the RPC wrapper
    itSkipIfRpc("Cloned community instance preserves preloaded posts.pages data from started community", async () => {
        const community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity | RpcLocalCommunity;
        await community.start();
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => typeof community.updatedAt === "number"
        });

        // Publish a post
        await publishRandomPost({ communityAddress: community.address, pkc });

        // Wait for the ORIGINAL community to have preloaded posts pages
        // (don't use waitTillPostInCommunityPages as it creates a new instance which hits the same bug)
        await resolveWhenConditionIsTrue({
            toUpdate: community,
            predicate: async () => {
                const hotPage = community.posts?.pages?.hot;
                return Boolean(hotPage && hotPage.comments.length > 0);
            }
        });

        // Verify the original community has preloaded page data
        expect(community.posts?.pages?.hot?.comments.length).to.be.greaterThan(0);

        // Clone the community via createCommunity — this goes through
        // toJSONInternalAfterFirstUpdate() → initInternalCommunityAfterFirstUpdateNoMerge()
        const clonedCommunity = (await pkc.createCommunity(community)) as LocalCommunity | RpcLocalCommunity;

        // The cloned community must preserve preloaded posts.pages data.
        // Bug: deriveDbPosts in toJSONInternalAfterFirstUpdate strips page data,
        // causing cloned instances to have empty pages: {} and breaking reply
        // CommentUpdate resolution via handleUpdateEventFromPost.
        expect(clonedCommunity.posts).to.exist;
        expect(clonedCommunity.posts?.pages?.hot).to.exist;
        expect(clonedCommunity.posts?.pages?.hot?.comments.length).to.be.greaterThan(0);

        await community.delete();
    });
});

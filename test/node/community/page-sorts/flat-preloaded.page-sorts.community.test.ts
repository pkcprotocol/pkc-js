import { describeSkipIfRpc } from "../../../helpers/conditional-tests.js";
import { it, expect, beforeAll, afterAll } from "vitest";
import {
    mockPKC,
    createSubWithNoChallenge,
    publishRandomPost,
    publishRandomReply,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";

import type { PKC as PKCType } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { CommentIpfsWithCidDefined } from "../../../../dist/node/publications/comment/types.js";

// A flat reply sort marked preloaded embeds the post's flattened subtree under update.replies.pages; the CommentUpdate
// verifier (community-side on publish, client-side on update) must verify that page against the post only, since its
// entries are not all direct replies. Needs a LocalCommunity whose owner PKC validates pages, so it cannot run over RPC.
describeSkipIfRpc("settings.pages: preloaded flat reply sort", () => {
    let pkc: PKCType;
    let community: LocalCommunity;
    const communityErrors: Error[] = [];
    beforeAll(async () => {
        pkc = await mockPKC({ validatePages: true });
        community = (await createSubWithNoChallenge({}, pkc)) as LocalCommunity;
        await community.edit({ settings: { ...community.settings, pages: { replies: [{ name: "newFlat", preloaded: true }] } } });
        community.on("error", (error) => communityErrors.push(error));
        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });
    });
    afterAll(async () => {
        await community.stop();
        await pkc.destroy();
    });

    it("a post with a depth-2 reply still gets a CommentUpdate whose preloaded newFlat page holds both replies", async () => {
        const post = await publishRandomPost({ communityAddress: community.address, pkc });
        const reply = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, pkc });
        const grandchild = await publishRandomReply({ parentComment: reply as CommentIpfsWithCidDefined, pkc });

        const postInstance = await pkc.createComment({ cid: post.cid! });
        await postInstance.update();
        try {
            await resolveWhenConditionIsTrue({
                toUpdate: postInstance,
                predicate: async () => (postInstance.replyCount ?? 0) >= 2 && Boolean(postInstance.replies.pages.newFlat)
            });
        } finally {
            await postInstance.stop();
        }
        const flatComments = postInstance.replies.pages.newFlat?.comments ?? [];
        expect(flatComments.map((entry) => entry.cid).sort()).to.deep.equal([reply.cid, grandchild.cid].sort());
        // A flat page is one level: every descendant is an entry of the array, so no entry carries its own nested replies
        for (const entry of flatComments) expect(entry.replies, `flat entry ${entry.cid} must not nest replies`).to.be.undefined;
        expect(flatComments.map((entry) => entry.depth).sort()).to.deep.equal([1, 2]);
        expect(communityErrors.map((e) => (e as { code?: string }).code)).to.not.include("ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID");
    });
});

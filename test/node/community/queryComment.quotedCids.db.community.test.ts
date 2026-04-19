// Test that dbHandler.queryComment returns quotedCids as a proper array, not a JSON string

import { mockPKC, publishRandomPost, publishRandomReply, resolveWhenConditionIsTrue } from "../../../dist/node/test/test-util.js";
import { describeSkipIfRpc } from "../../helpers/conditional-tests.js";
import { it, beforeAll, afterAll, expect } from "vitest";
import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { LocalCommunity } from "../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../dist/node/community/rpc-local-community.js";
import type { SignerType } from "../../../dist/node/signer/types.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";

describeSkipIfRpc("dbHandler.queryComment returns quotedCids as array", async () => {
    let pkc: PKCType;
    let community: LocalCommunity | RpcLocalCommunity;
    let modSigner: SignerType;
    let post: Comment;
    let replyWithQuotedCids: Comment;

    beforeAll(async () => {
        pkc = await mockPKC();
        community = (await pkc.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        modSigner = await pkc.createSigner();

        await community.edit({
            settings: { challenges: [] },
            roles: {
                [modSigner.address]: { role: "moderator" }
            }
        });

        await community.start();
        await resolveWhenConditionIsTrue({ toUpdate: community, predicate: async () => typeof community.updatedAt === "number" });

        // Publish a post to quote
        post = await publishRandomPost({ communityAddress: community.address, pkc: pkc, postProps: { signer: modSigner } });

        // Publish a reply that quotes the post
        replyWithQuotedCids = await publishRandomReply({
            parentComment: post as CommentIpfsWithCidDefined,
            pkc: pkc,
            commentProps: {
                signer: modSigner,
                quotedCids: [post.cid!]
            }
        });
    });

    afterAll(async () => {
        await community.delete();
        await pkc.destroy();
    });

    it("queryComment returns quotedCids as a proper array, not a JSON string", () => {
        const row = (community as LocalCommunity)._dbHandler.queryComment(replyWithQuotedCids.cid!);
        expect(row).to.exist;
        expect(row!.quotedCids).to.be.an("array");
        expect(row!.quotedCids).to.not.be.a("string");
        expect(row!.quotedCids).to.deep.equal([post.cid]);
    });

    it("queryComment returns undefined quotedCids for comments without quotes", () => {
        const row = (community as LocalCommunity)._dbHandler.queryComment(post.cid!);
        expect(row).to.exist;
        expect(row!.quotedCids).to.be.undefined;
    });
});

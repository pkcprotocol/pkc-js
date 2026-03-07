// Test that dbHandler.queryComment returns quotedCids as a proper array, not a JSON string

import {
    mockPlebbit,
    publishRandomPost,
    publishRandomReply,
    resolveWhenConditionIsTrue,
    describeSkipIfRpc
} from "../../../dist/node/test/test-util.js";
import { it, beforeAll, afterAll, expect } from "vitest";
import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { SignerType } from "../../../dist/node/signer/types.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";

describeSkipIfRpc("dbHandler.queryComment returns quotedCids as array", async () => {
    let plebbit: PlebbitType;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let modSigner: SignerType;
    let post: Comment;
    let replyWithQuotedCids: Comment;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        subplebbit = (await plebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        modSigner = await plebbit.createSigner();

        await subplebbit.edit({
            settings: { challenges: [] },
            roles: {
                [modSigner.address]: { role: "moderator" }
            }
        });

        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        // Publish a post to quote
        post = await publishRandomPost({ subplebbitAddress: subplebbit.address, plebbit: plebbit, postProps: { signer: modSigner } });

        // Publish a reply that quotes the post
        replyWithQuotedCids = await publishRandomReply({
            parentComment: post as CommentIpfsWithCidDefined,
            plebbit: plebbit,
            commentProps: {
                signer: modSigner,
                quotedCids: [post.cid!]
            }
        });
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
    });

    it("queryComment returns quotedCids as a proper array, not a JSON string", () => {
        const row = (subplebbit as LocalSubplebbit)._dbHandler.queryComment(replyWithQuotedCids.cid!);
        expect(row).to.exist;
        expect(row!.quotedCids).to.be.an("array");
        expect(row!.quotedCids).to.not.be.a("string");
        expect(row!.quotedCids).to.deep.equal([post.cid]);
    });

    it("queryComment returns undefined quotedCids for comments without quotes", () => {
        const row = (subplebbit as LocalSubplebbit)._dbHandler.queryComment(post.cid!);
        expect(row).to.exist;
        expect(row!.quotedCids).to.be.undefined;
    });
});

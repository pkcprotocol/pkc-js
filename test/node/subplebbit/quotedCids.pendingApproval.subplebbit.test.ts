// Test that quoting a comment in pendingApproval state is rejected

import {
    mockPlebbit,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    publishRandomPost,
    generateMockComment,
    createPendingApprovalChallenge,
    describeSkipIfRpc,
    publishRandomReply
} from "../../../dist/node/test/test-util.js";
import { messages } from "../../../dist/node/errors.js";
import { it, beforeAll, afterAll, expect } from "vitest";
import type { Plebbit as PlebbitType } from "../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { LocalSubplebbit } from "../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { SignerType } from "../../../dist/node/signer/types.js";
import type { CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";

const pendingApprovalCommentProps = { challengeRequest: { challengeAnswers: ["pending"] } };

describeSkipIfRpc("quotedCids with pending approval comments", async () => {
    let plebbit: PlebbitType;
    let subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    let modSigner: SignerType;
    let approvedPost: Comment;
    let approvedReply: Comment;
    let pendingReply: Comment;

    beforeAll(async () => {
        plebbit = await mockPlebbit();
        subplebbit = (await plebbit.createSubplebbit()) as LocalSubplebbit | RpcLocalSubplebbit;
        subplebbit.setMaxListeners(100);
        modSigner = await plebbit.createSigner();

        await subplebbit.edit({
            settings: { challenges: [createPendingApprovalChallenge()] },
            roles: {
                [modSigner.address]: { role: "moderator" }
            }
        });

        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

        // Publish an approved post (using mod signer bypasses challenge)
        approvedPost = await publishRandomPost({
            communityAddress: subplebbit.address,
            plebbit: plebbit,
            postProps: { signer: modSigner }
        });

        // Publish an approved reply under the post (mod signer bypasses challenge)
        approvedReply = await publishRandomReply({
            parentComment: approvedPost as CommentIpfsWithCidDefined,
            plebbit: plebbit,
            commentProps: { signer: modSigner }
        });

        // Publish a reply that goes to pending approval (under the same post)
        const pendingReplyComment = await generateMockComment(approvedPost as CommentIpfsWithCidDefined, plebbit, false, {
            content: "Pending reply " + Math.random(),
            ...pendingApprovalCommentProps
        });

        pendingReplyComment.once("challenge", () => {
            throw Error("Should not receive challenge with challengeRequest props");
        });

        await publishWithExpectedResult({ publication: pendingReplyComment, expectedChallengeSuccess: true }); // pending approval is technically challengeSuccess = true

        if (!pendingReplyComment.pendingApproval) throw Error("The reply did not go to pending approval");
        pendingReply = pendingReplyComment;
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
    });

    it("Reply quoting a pending approval comment is rejected", async () => {
        expect(pendingReply.cid).to.be.a("string");
        expect(pendingReply.pendingApproval).to.be.true;

        // Create a reply that tries to quote the pending comment (under the same post)
        const reply = await generateMockComment(approvedPost as CommentIpfsWithCidDefined, plebbit, false, {
            signer: modSigner,
            quotedCids: [pendingReply.cid!]
        });

        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_QUOTED_CID_IS_PENDING_APPROVAL
        });
    });

    it("Reply quoting approved comment and pending comment is rejected", async () => {
        // Quoting both an approved reply and a pending reply should fail
        const reply = await generateMockComment(approvedPost as CommentIpfsWithCidDefined, plebbit, false, {
            signer: modSigner,
            quotedCids: [approvedReply.cid!, pendingReply.cid!]
        });

        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_QUOTED_CID_IS_PENDING_APPROVAL
        });
    });

    it("Reply quoting only approved comments succeeds", async () => {
        // Quoting only the approved post and reply should succeed
        const quotedCids = [approvedPost.cid!, approvedReply.cid!];
        const reply = await generateMockComment(approvedPost as CommentIpfsWithCidDefined, plebbit, false, {
            signer: modSigner,
            quotedCids
        });

        await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
        expect(reply.raw.comment?.quotedCids).to.deep.equal(quotedCids);
    });
});

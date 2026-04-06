import {
    signers,
    validCommentIpfsFixture,
    DUMMY_CID,
    buildNewFormatCommentIpfs,
    buildOldFormatCommentIpfs,
    buildNewFormatCommentPubsubMessage,
    expectDeferredUnsignedLocalPublication,
    expectEagerSignedLocalPublication
} from "../community-fields-test-util.js";
import { mockRemotePKC } from "../../../../dist/node/test/test-util.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";

describe("Comment - community fields", () => {
    let pkc: PKC;

    beforeAll(async () => {
        pkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    // ─── Minimal CID path (Path 6) ───

    describe("minimal CID path", () => {
        it("sets communityPublicKey when provided alongside domain communityAddress", async () => {
            const comment = await pkc.createComment({
                cid: DUMMY_CID,
                communityAddress: "x.sol",
                communityPublicKey: signers[0].address
            });
            expect(comment.communityAddress).to.equal("x.sol");
            expect(comment.communityPublicKey).to.equal(signers[0].address);
            expect(comment.communityName).to.equal("x.sol");
        });

        it("domain communityAddress without communityPublicKey: communityName derived", async () => {
            const comment = await pkc.createComment({
                cid: DUMMY_CID,
                communityAddress: "x.sol"
            });
            expect(comment.communityAddress).to.equal("x.sol");
            expect(comment.communityPublicKey).to.be.undefined;
            expect(comment.communityName).to.equal("x.sol");
        });

        it("sets both communityPublicKey and communityName when both provided", async () => {
            const comment = await pkc.createComment({
                cid: DUMMY_CID,
                communityAddress: "myforum.eth",
                communityPublicKey: signers[0].address,
                communityName: "myforum.eth"
            });
            expect(comment.communityAddress).to.equal("myforum.eth");
            expect(comment.communityPublicKey).to.equal(signers[0].address);
            expect(comment.communityName).to.equal("myforum.eth");
        });
    });

    // ─── Unsigned creation (with signer) ───

    describe("unsigned creation", () => {
        it("domain communityAddress only: communityName derived, communityPublicKey undefined", async () => {
            const signer = await pkc.createSigner();
            const comment = await pkc.createComment({
                communityAddress: "test.eth",
                content: "test",
                title: "test",
                signer
            });
            expect(comment.communityAddress).to.equal("test.eth");
            expect(comment.communityPublicKey).to.be.undefined;
            expect(comment.communityName).to.equal("test.eth");
            expectDeferredUnsignedLocalPublication(comment);
        });

        it("domain communityAddress + communityPublicKey eagerly signs and derives communityName", async () => {
            const signer = await pkc.createSigner();
            const comment = await pkc.createComment({
                communityAddress: "myforum.eth",
                communityPublicKey: signers[0].address,
                content: "test",
                title: "test",
                signer
            });
            expect(comment.communityAddress).to.equal("myforum.eth");
            expect(comment.communityPublicKey).to.equal(signers[0].address);
            expect(comment.communityName).to.equal("myforum.eth");
            expectEagerSignedLocalPublication({
                publication: comment,
                type: "comment",
                communityPublicKey: signers[0].address,
                communityName: "myforum.eth"
            });
        });

        it("non-domain communityAddress eagerly signs with derived communityPublicKey", async () => {
            const signer = await pkc.createSigner();
            const comment = await pkc.createComment({
                communityAddress: signers[0].address,
                content: "test",
                title: "test",
                signer
            });
            expect(comment.communityAddress).to.equal(signers[0].address);
            expect(comment.communityPublicKey).to.equal(signers[0].address);
            expect(comment.communityName).to.be.undefined;
            expectEagerSignedLocalPublication({
                publication: comment,
                type: "comment",
                communityPublicKey: signers[0].address
            });
        });
    });

    // ─── CommentIpfs with signature (Path 2) ───

    describe("CommentIpfs with signature", () => {
        it("extracts communityPublicKey and communityName from new-format CommentIpfs", async () => {
            const commentIpfs = await buildNewFormatCommentIpfs({
                communityPublicKey: signers[0].address,
                communityName: "test.eth",
                signer: signers[0]
            });

            const comment = await pkc.createComment({ ...commentIpfs, cid: DUMMY_CID } as any);
            expect(comment.communityAddress).to.equal("test.eth");
            expect(comment.communityPublicKey).to.equal(signers[0].address);
            expect(comment.communityName).to.equal("test.eth");
        });

        it("extracts communityPublicKey only from new-format CommentIpfs without communityName", async () => {
            const commentIpfs = await buildNewFormatCommentIpfs({
                communityPublicKey: signers[0].address,
                signer: signers[0]
            });

            const comment = await pkc.createComment({ ...commentIpfs, cid: DUMMY_CID } as any);
            expect(comment.communityAddress).to.equal(signers[0].address);
            expect(comment.communityPublicKey).to.equal(signers[0].address);
            expect(comment.communityName).to.be.undefined;
        });

        it("backward compat: old communityAddress (domain) sets communityName, communityPublicKey undefined", async () => {
            const commentIpfs = await buildOldFormatCommentIpfs({
                subplebbitAddress: "test.eth",
                signer: signers[0]
            });

            const comment = await pkc.createComment({ ...commentIpfs, cid: DUMMY_CID } as any);
            expect(comment.communityAddress).to.equal("test.eth");
            expect(comment.communityName).to.equal("test.eth");
            expect(comment.communityPublicKey).to.be.undefined;
        });

        it("backward compat: old communityAddress (IPNS key) sets communityPublicKey, communityName undefined", async () => {
            const comment = await pkc.createComment({ ...validCommentIpfsFixture, cid: DUMMY_CID } as any);
            expect(comment.communityAddress).to.equal(signers[0].address);
            expect(comment.communityPublicKey).to.equal(signers[0].address);
            expect(comment.communityName).to.be.undefined;
        });
    });

    // ─── CommentPubsubMessage (Path 4) ───

    describe("CommentPubsubMessage", () => {
        it("extracts communityPublicKey and communityName from signed PubsubMessage", async () => {
            const pubsubMsg = await buildNewFormatCommentPubsubMessage({
                communityPublicKey: signers[0].address,
                communityName: "test.eth",
                signer: signers[0]
            });

            const comment = await pkc.createComment(pubsubMsg as any);
            expect(comment.communityAddress).to.equal("test.eth");
            expect(comment.communityPublicKey).to.equal(signers[0].address);
            expect(comment.communityName).to.equal("test.eth");
        });

        it("extracts communityPublicKey only from signed PubsubMessage without communityName", async () => {
            const pubsubMsg = await buildNewFormatCommentPubsubMessage({
                communityPublicKey: signers[0].address,
                signer: signers[0]
            });

            const comment = await pkc.createComment(pubsubMsg as any);
            expect(comment.communityAddress).to.equal(signers[0].address);
            expect(comment.communityPublicKey).to.equal(signers[0].address);
            expect(comment.communityName).to.be.undefined;
        });
    });

    // ─── Copy from instance (Path 1) ───

    describe("copy from instance", () => {
        it("preserves community fields when creating from a JSONified comment with raw.comment", async () => {
            const commentIpfs = await buildNewFormatCommentIpfs({
                communityPublicKey: signers[0].address,
                communityName: "test.eth",
                signer: signers[0]
            });
            const originalComment = await pkc.createComment({ ...commentIpfs, cid: DUMMY_CID } as any);

            const json = JSON.parse(JSON.stringify(originalComment));
            const copiedComment = await pkc.createComment(json);

            expect(copiedComment.communityAddress).to.equal("test.eth");
            expect(copiedComment.communityPublicKey).to.equal(signers[0].address);
            expect(copiedComment.communityName).to.equal("test.eth");
        });
    });
});

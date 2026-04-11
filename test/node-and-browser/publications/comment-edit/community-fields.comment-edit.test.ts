import {
    signers,
    DUMMY_COMMENT_CID,
    buildSignedPubsubMessage,
    expectDeferredUnsignedLocalPublication,
    expectEagerSignedLocalPublication
} from "../community-fields-test-util.js";
import { mockRemotePKC } from "../../../../dist/node/test/test-util.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";

const EDIT_FIELDS = {
    extraSignedPropertyNames: ["commentCid", "content"],
    extraFields: { commentCid: DUMMY_COMMENT_CID, content: "edited" }
};

describe("CommentEdit - community fields", () => {
    let pkc: PKC;

    beforeAll(async () => {
        pkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it("unsigned creation with domain communityAddress only: communityName derived, communityPublicKey undefined", async () => {
        const signer = await pkc.createSigner();
        const edit = await pkc.createCommentEdit({
            communityAddress: "test.eth",
            commentCid: DUMMY_COMMENT_CID,
            content: "edited",
            signer
        });
        expect(edit.communityAddress).to.equal("test.eth");
        expect(edit.communityPublicKey).to.be.undefined;
        expect(edit.communityName).to.equal("test.eth");
        expectDeferredUnsignedLocalPublication(edit);
    });

    it("domain communityAddress + communityPublicKey eagerly signs and derives communityName", async () => {
        const signer = await pkc.createSigner();
        const edit = await pkc.createCommentEdit({
            communityAddress: "myforum.eth",
            communityPublicKey: signers[0].address,
            commentCid: DUMMY_COMMENT_CID,
            content: "edited",
            signer
        });
        expect(edit.communityAddress).to.equal("myforum.eth");
        expect(edit.communityPublicKey).to.equal(signers[0].address);
        expect(edit.communityName).to.equal("myforum.eth");
        expectEagerSignedLocalPublication({
            publication: edit,
            type: "commentEdit",
            communityPublicKey: signers[0].address,
            communityName: "myforum.eth"
        });
    });

    it("non-domain communityAddress eagerly signs with derived communityPublicKey", async () => {
        const signer = await pkc.createSigner();
        const edit = await pkc.createCommentEdit({
            communityAddress: signers[0].address,
            commentCid: DUMMY_COMMENT_CID,
            content: "edited",
            signer
        });
        expect(edit.communityAddress).to.equal(signers[0].address);
        expect(edit.communityPublicKey).to.equal(signers[0].address);
        expect(edit.communityName).to.be.undefined;
        expectEagerSignedLocalPublication({
            publication: edit,
            type: "commentEdit",
            communityPublicKey: signers[0].address
        });
    });

    it("only communityPublicKey: derives communityAddress, eagerly signs", async () => {
        const signer = await pkc.createSigner();
        const edit = await pkc.createCommentEdit({
            communityPublicKey: signers[0].address,
            commentCid: DUMMY_COMMENT_CID,
            content: "edited",
            signer
        });
        expect(edit.communityAddress).to.equal(signers[0].address);
        expect(edit.communityPublicKey).to.equal(signers[0].address);
        expect(edit.communityName).to.be.undefined;
        expectEagerSignedLocalPublication({
            publication: edit,
            type: "commentEdit",
            communityPublicKey: signers[0].address
        });
    });

    it("only communityName: derives communityAddress, deferred signing", async () => {
        const signer = await pkc.createSigner();
        const edit = await pkc.createCommentEdit({
            communityName: "test.eth",
            commentCid: DUMMY_COMMENT_CID,
            content: "edited",
            signer
        });
        expect(edit.communityAddress).to.equal("test.eth");
        expect(edit.communityPublicKey).to.be.undefined;
        expect(edit.communityName).to.equal("test.eth");
        expectDeferredUnsignedLocalPublication(edit);
    });

    it("communityPublicKey + communityName: derives communityAddress from name, eagerly signs", async () => {
        const signer = await pkc.createSigner();
        const edit = await pkc.createCommentEdit({
            communityPublicKey: signers[0].address,
            communityName: "myforum.eth",
            commentCid: DUMMY_COMMENT_CID,
            content: "edited",
            signer
        });
        expect(edit.communityAddress).to.equal("myforum.eth");
        expect(edit.communityPublicKey).to.equal(signers[0].address);
        expect(edit.communityName).to.equal("myforum.eth");
        expectEagerSignedLocalPublication({
            publication: edit,
            type: "commentEdit",
            communityPublicKey: signers[0].address,
            communityName: "myforum.eth"
        });
    });

    it("throws when none of communityAddress, communityPublicKey, communityName provided", async () => {
        const signer = await pkc.createSigner();
        await expect(
            pkc.createCommentEdit({
                commentCid: DUMMY_COMMENT_CID,
                content: "edited",
                signer
            } as any)
        ).rejects.toThrow();
    });

    it("signed PubsubMessage with communityPublicKey + communityName sets both", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            communityPublicKey: signers[0].address,
            communityName: "test.eth",
            ...EDIT_FIELDS
        });

        const edit = await pkc.createCommentEdit(signedMsg as any);
        expect(edit.communityAddress).to.equal("test.eth");
        expect(edit.communityPublicKey).to.equal(signers[0].address);
        expect(edit.communityName).to.equal("test.eth");
    });

    it("backward compat: signed PubsubMessage with old communityAddress (domain) sets communityName", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            subplebbitAddress: "test.eth",
            ...EDIT_FIELDS
        });

        const edit = await pkc.createCommentEdit(signedMsg as any);
        expect(edit.communityAddress).to.equal("test.eth");
        expect(edit.communityName).to.equal("test.eth");
        expect(edit.communityPublicKey).to.be.undefined;
    });

    it("backward compat: signed PubsubMessage with old communityAddress (IPNS key) sets communityPublicKey", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            subplebbitAddress: signers[0].address,
            ...EDIT_FIELDS
        });

        const edit = await pkc.createCommentEdit(signedMsg as any);
        expect(edit.communityAddress).to.equal(signers[0].address);
        expect(edit.communityPublicKey).to.equal(signers[0].address);
        expect(edit.communityName).to.be.undefined;
    });
});

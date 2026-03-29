import { signers, DUMMY_COMMENT_CID, buildSignedPubsubMessage } from "../community-fields-test-util.js";
import { mockRemotePlebbit } from "../../../../dist/node/test/test-util.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";

const EDIT_FIELDS = {
    extraSignedPropertyNames: ["commentCid", "content"],
    extraFields: { commentCid: DUMMY_COMMENT_CID, content: "edited" }
};

describe("CommentEdit - community fields", () => {
    let plebbit: Plebbit;

    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it("unsigned creation with domain communityAddress only: communityName derived, communityPublicKey undefined", async () => {
        const signer = await plebbit.createSigner();
        const edit = await plebbit.createCommentEdit({
            communityAddress: "test.eth",
            commentCid: DUMMY_COMMENT_CID,
            content: "edited",
            signer
        });
        expect(edit.communityAddress).to.equal("test.eth");
        expect(edit.communityPublicKey).to.be.undefined;
        expect(edit.communityName).to.equal("test.eth");
    });

    it("unsigned creation with communityPublicKey + communityName: both set", async () => {
        const signer = await plebbit.createSigner();
        const edit = await plebbit.createCommentEdit({
            communityAddress: "myforum.eth",
            communityPublicKey: signers[0].address,
            communityName: "myforum.eth",
            commentCid: DUMMY_COMMENT_CID,
            content: "edited",
            signer
        });
        expect(edit.communityAddress).to.equal("myforum.eth");
        expect(edit.communityPublicKey).to.equal(signers[0].address);
        expect(edit.communityName).to.equal("myforum.eth");
    });

    it("signed PubsubMessage with communityPublicKey + communityName sets both", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            communityPublicKey: signers[0].address,
            communityName: "test.eth",
            ...EDIT_FIELDS
        });

        const edit = await plebbit.createCommentEdit(signedMsg as any);
        expect(edit.communityAddress).to.equal("test.eth");
        expect(edit.communityPublicKey).to.equal(signers[0].address);
        expect(edit.communityName).to.equal("test.eth");
    });

    it("backward compat: signed PubsubMessage with old subplebbitAddress (domain) sets communityName", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            subplebbitAddress: "test.eth",
            ...EDIT_FIELDS
        });

        const edit = await plebbit.createCommentEdit(signedMsg as any);
        expect(edit.communityAddress).to.equal("test.eth");
        expect(edit.communityName).to.equal("test.eth");
        expect(edit.communityPublicKey).to.be.undefined;
    });

    it("backward compat: signed PubsubMessage with old subplebbitAddress (IPNS key) sets communityPublicKey", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            subplebbitAddress: signers[0].address,
            ...EDIT_FIELDS
        });

        const edit = await plebbit.createCommentEdit(signedMsg as any);
        expect(edit.communityAddress).to.equal(signers[0].address);
        expect(edit.communityPublicKey).to.equal(signers[0].address);
        expect(edit.communityName).to.be.undefined;
    });
});

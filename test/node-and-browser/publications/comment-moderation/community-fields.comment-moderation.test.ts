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

const MOD_FIELDS = {
    extraSignedPropertyNames: ["commentCid", "commentModeration"],
    extraFields: { commentCid: DUMMY_COMMENT_CID, commentModeration: { reason: "test moderation" } }
};

describe("CommentModeration - community fields", () => {
    let pkc: PKC;

    beforeAll(async () => {
        pkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it("unsigned creation with domain communityAddress only: communityName derived, communityPublicKey undefined", async () => {
        const signer = await pkc.createSigner();
        const mod = await pkc.createCommentModeration({
            communityAddress: "test.eth",
            commentCid: DUMMY_COMMENT_CID,
            commentModeration: { reason: "test" },
            signer
        });
        expect(mod.communityAddress).to.equal("test.eth");
        expect(mod.communityPublicKey).to.be.undefined;
        expect(mod.communityName).to.equal("test.eth");
        expectDeferredUnsignedLocalPublication(mod);
    });

    it("domain communityAddress + communityPublicKey eagerly signs and derives communityName", async () => {
        const signer = await pkc.createSigner();
        const mod = await pkc.createCommentModeration({
            communityAddress: "myforum.eth",
            communityPublicKey: signers[0].address,
            commentCid: DUMMY_COMMENT_CID,
            commentModeration: { reason: "test" },
            signer
        });
        expect(mod.communityAddress).to.equal("myforum.eth");
        expect(mod.communityPublicKey).to.equal(signers[0].address);
        expect(mod.communityName).to.equal("myforum.eth");
        expectEagerSignedLocalPublication({
            publication: mod,
            type: "commentModeration",
            communityPublicKey: signers[0].address,
            communityName: "myforum.eth"
        });
    });

    it("non-domain communityAddress eagerly signs with derived communityPublicKey", async () => {
        const signer = await pkc.createSigner();
        const mod = await pkc.createCommentModeration({
            communityAddress: signers[0].address,
            commentCid: DUMMY_COMMENT_CID,
            commentModeration: { reason: "test" },
            signer
        });
        expect(mod.communityAddress).to.equal(signers[0].address);
        expect(mod.communityPublicKey).to.equal(signers[0].address);
        expect(mod.communityName).to.be.undefined;
        expectEagerSignedLocalPublication({
            publication: mod,
            type: "commentModeration",
            communityPublicKey: signers[0].address
        });
    });

    it("signed PubsubMessage with communityPublicKey + communityName sets both", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            communityPublicKey: signers[0].address,
            communityName: "test.eth",
            ...MOD_FIELDS
        });

        const mod = await pkc.createCommentModeration(signedMsg as any);
        expect(mod.communityAddress).to.equal("test.eth");
        expect(mod.communityPublicKey).to.equal(signers[0].address);
        expect(mod.communityName).to.equal("test.eth");
    });

    it("backward compat: signed PubsubMessage with old communityAddress (domain) sets communityName", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            subplebbitAddress: "test.eth",
            ...MOD_FIELDS
        });

        const mod = await pkc.createCommentModeration(signedMsg as any);
        expect(mod.communityAddress).to.equal("test.eth");
        expect(mod.communityName).to.equal("test.eth");
        expect(mod.communityPublicKey).to.be.undefined;
    });

    it("backward compat: signed PubsubMessage with old communityAddress (IPNS key) sets communityPublicKey", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            subplebbitAddress: signers[0].address,
            ...MOD_FIELDS
        });

        const mod = await pkc.createCommentModeration(signedMsg as any);
        expect(mod.communityAddress).to.equal(signers[0].address);
        expect(mod.communityPublicKey).to.equal(signers[0].address);
        expect(mod.communityName).to.be.undefined;
    });
});

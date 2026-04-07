import {
    signers,
    buildSignedPubsubMessage,
    expectDeferredUnsignedLocalPublication,
    expectEagerSignedLocalPublication
} from "../community-fields-test-util.js";
import { mockRemotePKC } from "../../../../dist/node/test/test-util.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";

const SUB_EDIT_FIELDS = {
    extraSignedPropertyNames: ["communityEdit"],
    extraFields: { communityEdit: { description: "test edit" } }
};

describe("CommunityEdit - community fields", () => {
    let pkc: PKC;

    beforeAll(async () => {
        pkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it("unsigned creation with domain communityAddress only: communityName derived, communityPublicKey undefined", async () => {
        const signer = await pkc.createSigner();
        const subEdit = await pkc.createCommunityEdit({
            communityAddress: "test.eth",
            communityEdit: { description: "test" },
            signer
        });
        expect(subEdit.communityAddress).to.equal("test.eth");
        expect(subEdit.communityPublicKey).to.be.undefined;
        expect(subEdit.communityName).to.equal("test.eth");
        expectDeferredUnsignedLocalPublication(subEdit);
    });

    it("domain communityAddress + communityPublicKey eagerly signs and derives communityName", async () => {
        const signer = await pkc.createSigner();
        const subEdit = await pkc.createCommunityEdit({
            communityAddress: "myforum.eth",
            communityPublicKey: signers[0].address,
            communityEdit: { description: "test" },
            signer
        });
        expect(subEdit.communityAddress).to.equal("myforum.eth");
        expect(subEdit.communityPublicKey).to.equal(signers[0].address);
        expect(subEdit.communityName).to.equal("myforum.eth");
        expectEagerSignedLocalPublication({
            publication: subEdit,
            type: "communityEdit",
            communityPublicKey: signers[0].address,
            communityName: "myforum.eth"
        });
    });

    it("non-domain communityAddress eagerly signs with derived communityPublicKey", async () => {
        const signer = await pkc.createSigner();
        const subEdit = await pkc.createCommunityEdit({
            communityAddress: signers[0].address,
            communityEdit: { description: "test" },
            signer
        });
        expect(subEdit.communityAddress).to.equal(signers[0].address);
        expect(subEdit.communityPublicKey).to.equal(signers[0].address);
        expect(subEdit.communityName).to.be.undefined;
        expectEagerSignedLocalPublication({
            publication: subEdit,
            type: "communityEdit",
            communityPublicKey: signers[0].address
        });
    });

    it("signed PubsubMessage with communityPublicKey + communityName sets both", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            communityPublicKey: signers[0].address,
            communityName: "test.eth",
            ...SUB_EDIT_FIELDS
        });

        const subEdit = await pkc.createCommunityEdit(signedMsg as any);
        expect(subEdit.communityAddress).to.equal("test.eth");
        expect(subEdit.communityPublicKey).to.equal(signers[0].address);
        expect(subEdit.communityName).to.equal("test.eth");
    });

    // No backward compat tests for CommunityEdit: its schema is strict and rejects
    // the old communityAddress field (CommunityEditPubsubMessagePublicationSchema.safeParse
    // without .loose()). This is correct because CommunityEdit is a write-only pubsub message,
    // not a historical record that might be stored in the old format.
});

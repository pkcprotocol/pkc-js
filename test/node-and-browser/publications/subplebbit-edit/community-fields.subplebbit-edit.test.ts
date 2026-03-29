import { signers, buildSignedPubsubMessage } from "../community-fields-test-util.js";
import { mockRemotePlebbit } from "../../../../dist/node/test/test-util.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";

const SUB_EDIT_FIELDS = {
    extraSignedPropertyNames: ["subplebbitEdit"],
    extraFields: { subplebbitEdit: { description: "test edit" } }
};

describe("SubplebbitEdit - community fields", () => {
    let plebbit: Plebbit;

    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it("unsigned creation with domain communityAddress only: communityName derived, communityPublicKey undefined", async () => {
        const signer = await plebbit.createSigner();
        const subEdit = await plebbit.createSubplebbitEdit({
            communityAddress: "test.eth",
            subplebbitEdit: { description: "test" },
            signer
        });
        expect(subEdit.communityAddress).to.equal("test.eth");
        expect(subEdit.communityPublicKey).to.be.undefined;
        expect(subEdit.communityName).to.equal("test.eth");
    });

    it("unsigned creation with communityPublicKey + communityName: both set", async () => {
        const signer = await plebbit.createSigner();
        const subEdit = await plebbit.createSubplebbitEdit({
            communityAddress: "myforum.eth",
            communityPublicKey: signers[0].address,
            communityName: "myforum.eth",
            subplebbitEdit: { description: "test" },
            signer
        });
        expect(subEdit.communityAddress).to.equal("myforum.eth");
        expect(subEdit.communityPublicKey).to.equal(signers[0].address);
        expect(subEdit.communityName).to.equal("myforum.eth");
    });

    it("signed PubsubMessage with communityPublicKey + communityName sets both", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            communityPublicKey: signers[0].address,
            communityName: "test.eth",
            ...SUB_EDIT_FIELDS
        });

        const subEdit = await plebbit.createSubplebbitEdit(signedMsg as any);
        expect(subEdit.communityAddress).to.equal("test.eth");
        expect(subEdit.communityPublicKey).to.equal(signers[0].address);
        expect(subEdit.communityName).to.equal("test.eth");
    });

    // No backward compat tests for SubplebbitEdit: its schema is strict and rejects
    // the old subplebbitAddress field (SubplebbitEditPubsubMessagePublicationSchema.safeParse
    // without .loose()). This is correct because SubplebbitEdit is a write-only pubsub message,
    // not a historical record that might be stored in the old format.
});

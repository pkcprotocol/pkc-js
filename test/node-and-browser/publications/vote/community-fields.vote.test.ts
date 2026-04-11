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

const VOTE_FIELDS = { extraSignedPropertyNames: ["commentCid", "vote"], extraFields: { commentCid: DUMMY_COMMENT_CID, vote: 1 } };

describe("Vote - community fields", () => {
    let pkc: PKC;

    beforeAll(async () => {
        pkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it("unsigned creation with domain communityAddress only: communityName derived, communityPublicKey undefined", async () => {
        const signer = await pkc.createSigner();
        const vote = await pkc.createVote({
            communityAddress: "test.eth",
            commentCid: DUMMY_COMMENT_CID,
            vote: 1,
            signer
        });
        expect(vote.communityAddress).to.equal("test.eth");
        expect(vote.communityPublicKey).to.be.undefined;
        expect(vote.communityName).to.equal("test.eth");
        expectDeferredUnsignedLocalPublication(vote);
    });

    it("domain communityAddress + communityPublicKey eagerly signs and derives communityName", async () => {
        const signer = await pkc.createSigner();
        const vote = await pkc.createVote({
            communityAddress: "myforum.eth",
            communityPublicKey: signers[0].address,
            commentCid: DUMMY_COMMENT_CID,
            vote: 1,
            signer
        });
        expect(vote.communityAddress).to.equal("myforum.eth");
        expect(vote.communityPublicKey).to.equal(signers[0].address);
        expect(vote.communityName).to.equal("myforum.eth");
        expectEagerSignedLocalPublication({
            publication: vote,
            type: "vote",
            communityPublicKey: signers[0].address,
            communityName: "myforum.eth"
        });
    });

    it("non-domain communityAddress eagerly signs with derived communityPublicKey", async () => {
        const signer = await pkc.createSigner();
        const vote = await pkc.createVote({
            communityAddress: signers[0].address,
            commentCid: DUMMY_COMMENT_CID,
            vote: 1,
            signer
        });
        expect(vote.communityAddress).to.equal(signers[0].address);
        expect(vote.communityPublicKey).to.equal(signers[0].address);
        expect(vote.communityName).to.be.undefined;
        expectEagerSignedLocalPublication({
            publication: vote,
            type: "vote",
            communityPublicKey: signers[0].address
        });
    });

    it("only communityPublicKey: derives communityAddress, eagerly signs", async () => {
        const signer = await pkc.createSigner();
        const vote = await pkc.createVote({
            communityPublicKey: signers[0].address,
            commentCid: DUMMY_COMMENT_CID,
            vote: 1,
            signer
        });
        expect(vote.communityAddress).to.equal(signers[0].address);
        expect(vote.communityPublicKey).to.equal(signers[0].address);
        expect(vote.communityName).to.be.undefined;
        expectEagerSignedLocalPublication({
            publication: vote,
            type: "vote",
            communityPublicKey: signers[0].address
        });
    });

    it("only communityName: derives communityAddress, deferred signing", async () => {
        const signer = await pkc.createSigner();
        const vote = await pkc.createVote({
            communityName: "test.eth",
            commentCid: DUMMY_COMMENT_CID,
            vote: 1,
            signer
        });
        expect(vote.communityAddress).to.equal("test.eth");
        expect(vote.communityPublicKey).to.be.undefined;
        expect(vote.communityName).to.equal("test.eth");
        expectDeferredUnsignedLocalPublication(vote);
    });

    it("communityPublicKey + communityName: derives communityAddress from name, eagerly signs", async () => {
        const signer = await pkc.createSigner();
        const vote = await pkc.createVote({
            communityPublicKey: signers[0].address,
            communityName: "myforum.eth",
            commentCid: DUMMY_COMMENT_CID,
            vote: 1,
            signer
        });
        expect(vote.communityAddress).to.equal("myforum.eth");
        expect(vote.communityPublicKey).to.equal(signers[0].address);
        expect(vote.communityName).to.equal("myforum.eth");
        expectEagerSignedLocalPublication({
            publication: vote,
            type: "vote",
            communityPublicKey: signers[0].address,
            communityName: "myforum.eth"
        });
    });

    it("throws when none of communityAddress, communityPublicKey, communityName provided", async () => {
        const signer = await pkc.createSigner();
        await expect(
            pkc.createVote({
                commentCid: DUMMY_COMMENT_CID,
                vote: 1,
                signer
            } as any)
        ).rejects.toThrow();
    });

    it("signed PubsubMessage with communityPublicKey + communityName sets both", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            communityPublicKey: signers[0].address,
            communityName: "test.eth",
            ...VOTE_FIELDS
        });

        const vote = await pkc.createVote(signedMsg as any);
        expect(vote.communityAddress).to.equal("test.eth");
        expect(vote.communityPublicKey).to.equal(signers[0].address);
        expect(vote.communityName).to.equal("test.eth");
    });

    it("backward compat: signed PubsubMessage with old communityAddress (domain) sets communityName", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            subplebbitAddress: "test.eth",
            ...VOTE_FIELDS
        });

        const vote = await pkc.createVote(signedMsg as any);
        expect(vote.communityAddress).to.equal("test.eth");
        expect(vote.communityName).to.equal("test.eth");
        expect(vote.communityPublicKey).to.be.undefined;
    });

    it("backward compat: signed PubsubMessage with old communityAddress (IPNS key) sets communityPublicKey", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            subplebbitAddress: signers[0].address,
            ...VOTE_FIELDS
        });

        const vote = await pkc.createVote(signedMsg as any);
        expect(vote.communityAddress).to.equal(signers[0].address);
        expect(vote.communityPublicKey).to.equal(signers[0].address);
        expect(vote.communityName).to.be.undefined;
    });
});

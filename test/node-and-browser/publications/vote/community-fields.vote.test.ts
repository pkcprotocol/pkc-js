import {
    signers,
    DUMMY_COMMENT_CID,
    buildSignedPubsubMessage,
    expectDeferredUnsignedLocalPublication,
    expectEagerSignedLocalPublication
} from "../community-fields-test-util.js";
import { mockRemotePlebbit } from "../../../../dist/node/test/test-util.js";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../../dist/node/pkc/pkc.js";

const VOTE_FIELDS = { extraSignedPropertyNames: ["commentCid", "vote"], extraFields: { commentCid: DUMMY_COMMENT_CID, vote: 1 } };

describe("Vote - community fields", () => {
    let plebbit: Plebbit;

    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it("unsigned creation with domain communityAddress only: communityName derived, communityPublicKey undefined", async () => {
        const signer = await plebbit.createSigner();
        const vote = await plebbit.createVote({
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
        const signer = await plebbit.createSigner();
        const vote = await plebbit.createVote({
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
        const signer = await plebbit.createSigner();
        const vote = await plebbit.createVote({
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

    it("signed PubsubMessage with communityPublicKey + communityName sets both", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            communityPublicKey: signers[0].address,
            communityName: "test.eth",
            ...VOTE_FIELDS
        });

        const vote = await plebbit.createVote(signedMsg as any);
        expect(vote.communityAddress).to.equal("test.eth");
        expect(vote.communityPublicKey).to.equal(signers[0].address);
        expect(vote.communityName).to.equal("test.eth");
    });

    it("backward compat: signed PubsubMessage with old subplebbitAddress (domain) sets communityName", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            subplebbitAddress: "test.eth",
            ...VOTE_FIELDS
        });

        const vote = await plebbit.createVote(signedMsg as any);
        expect(vote.communityAddress).to.equal("test.eth");
        expect(vote.communityName).to.equal("test.eth");
        expect(vote.communityPublicKey).to.be.undefined;
    });

    it("backward compat: signed PubsubMessage with old subplebbitAddress (IPNS key) sets communityPublicKey", async () => {
        const signedMsg = await buildSignedPubsubMessage({
            signer: signers[0],
            subplebbitAddress: signers[0].address,
            ...VOTE_FIELDS
        });

        const vote = await plebbit.createVote(signedMsg as any);
        expect(vote.communityAddress).to.equal(signers[0].address);
        expect(vote.communityPublicKey).to.equal(signers[0].address);
        expect(vote.communityName).to.be.undefined;
    });
});

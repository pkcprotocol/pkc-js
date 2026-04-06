import { beforeAll, afterAll } from "vitest";
import signers from "../../fixtures/signers.js";
import { describeSkipIfRpc, mockPKCNoDataPathWithOnlyKuboClient } from "../../../dist/node/test/test-util.js";
import { messages } from "../../../dist/node/errors.js";
import { verifyVote, signVote } from "../../../dist/node/signer/signatures.js";
import * as remeda from "remeda";
import { timestamp } from "../../../dist/node/util.js";
import validVoteFixture from "../../fixtures/valid_vote.json" with { type: "json" };

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type { RemoteCommunity } from "../../../dist/node/community/remote-community.js";
import type { VoteOptionsToSign, VoteSignature, VotePubsubMessagePublication } from "../../../dist/node/publications/vote/types.js";

describe.concurrent("Sign Vote", async () => {
    let pkc: PKCType;
    let community: RemoteCommunity;
    let voteProps: Omit<VoteOptionsToSign, "signer">;
    let voteSignature: VoteSignature;
    beforeAll(async () => {
        pkc = await mockPKCNoDataPathWithOnlyKuboClient();
        community = await pkc.getCommunity({ address: signers[0].address });

        voteProps = {
            author: { displayName: "Voter" },
            communityAddress: community.address,
            commentCid: community.lastPostCid!,
            timestamp: timestamp(),
            vote: 1,
            protocolVersion: "1.0.0"
        };
        voteSignature = await signVote({ vote: { ...voteProps, signer: signers[7] }, plebbit: pkc });
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Can sign and validate Vote correctly`, async () => {
        const verification = await verifyVote({
            vote: { ...remeda.omit(voteProps, ["communityAddress"]), signature: voteSignature } as VotePubsubMessagePublication,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it(`signVote throws with author.name not being a domain`, async () => {
        const cloneVote = remeda.clone(voteProps);
        cloneVote.author = { name: "gibbreish" };
        try {
            await signVote({ vote: { ...cloneVote, signer: signers[7] }, plebbit: pkc });
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as { code: string }).code).to.equal("ERR_AUTHOR_ADDRESS_IS_NOT_A_DOMAIN_OR_B58");
        }
    });
    it(`signVote allows author to be omitted`, async () => {
        const signature = await signVote({
            vote: { ...remeda.omit(voteProps, ["author"]), signer: signers[7] } as VoteOptionsToSign,
            plebbit: pkc
        });
        expect(signature.publicKey).to.equal(signers[7].publicKey);
    });
});

// Clients of RPC will trust the response of RPC and won't validate
describeSkipIfRpc.concurrent("Verify vote", async () => {
    let pkc: PKCType;
    beforeAll(async () => {
        pkc = await mockPKCNoDataPathWithOnlyKuboClient();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Valid vote signature fixture is validated correctly`, async () => {
        const vote = remeda.clone(validVoteFixture) as unknown as VotePubsubMessagePublication;
        const verification = await verifyVote({
            vote,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(verification).to.deep.equal({ valid: true });
    });

    it(`Invalid vote signature gets invalidated correctly`, async () => {
        const vote = remeda.clone(validVoteFixture) as unknown as VotePubsubMessagePublication;
        vote.commentCid += "1234"; // Should invalidate signature
        const verification = await verifyVote({
            vote,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
    });

    it(`verifyVote invalidates a vote with tampered author.name`, async () => {
        const vote = remeda.clone(validVoteFixture) as unknown as VotePubsubMessagePublication;
        vote.author = { ...(vote.author || {}), name: "gibbresish" };
        const verification = await verifyVote({
            vote,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        // Modifying author.name without re-signing invalidates the signature
        expect(verification).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
    });
    it("verifyVote validates a vote that was signed without author", async () => {
        const signer = signers[7];
        const voteToSign: VoteOptionsToSign = {
            communityAddress: signers[0].address,
            commentCid: "QmTest",
            timestamp: timestamp(),
            vote: 1,
            protocolVersion: "1.0.0",
            signer
        };
        const vote: VotePubsubMessagePublication = {
            ...remeda.omit(voteToSign, ["signer", "communityAddress"]),
            signature: await signVote({ vote: voteToSign, plebbit: pkc })
        };
        const verification = await verifyVote({
            vote,
            resolveAuthorNames: pkc.resolveAuthorNames,
            clientsManager: pkc._clientsManager
        });
        expect(verification).to.deep.equal({ valid: true });
    });
});

import {
    mockPKC,
    generateMockPost,
    generatePostToAnswerMathQuestion,
    resolveWhenConditionIsTrue
} from "../../../../dist/node/test/test-util.js";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import { omitRuntimeAuthorFields } from "../../../../dist/node/publications/publication-author.js";
import { describe, beforeAll, afterAll, it } from "vitest";
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { LocalCommunity } from "../../../../dist/node/runtime/node/community/local-community.js";
import type { RpcLocalCommunity } from "../../../../dist/node/community/rpc-local-community.js";
import type { SignerType } from "../../../../dist/node/signer/types.js";
import type {
    DecryptedChallengeRequestMessageTypeWithCommunityAuthor,
    DecryptedChallengeMessageType,
    DecryptedChallengeAnswerMessageType,
    DecryptedChallengeVerificationMessageType
} from "../../../../dist/node/pubsub-messages/types.js";

describe.sequential("Validate props of subplebbit Pubsub messages", async () => {
    let plebbit: PKC;
    let subplebbit: LocalCommunity | RpcLocalCommunity;
    let commentSigner: SignerType;
    beforeAll(async () => {
        plebbit = await mockPKC();
        subplebbit = (await plebbit.createCommunity()) as LocalCommunity | RpcLocalCommunity;
        const challenges = [{ name: "question", options: { question: "1+1=?", answer: "2" } }];
        await subplebbit.edit({ settings: { challenges } });

        await subplebbit.start();
        await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });
        commentSigner = await plebbit.createSigner(); // We're using the same signer for publishing so that publication.author.subplebbit is defined
    });

    afterAll(async () => {
        await subplebbit.delete();
        await plebbit.destroy();
    });

    it(`Validate props of challengerequest`, async () => {
        const comment = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: plebbit,
            postProps: { signer: commentSigner }
        });
        const challengeRequestPromise = new Promise<DecryptedChallengeRequestMessageTypeWithCommunityAuthor>((resolve) =>
            subplebbit.once("challengerequest", resolve)
        );
        await comment.publish();
        const request = await challengeRequestPromise;
        // request.comment has runtime author fields (address, publicKey) added by _buildRuntimeChallengeRequest,
        // while raw.pubsubMessageToPublish returns wire-only data without those fields
        const requestCommentWire = { ...request.comment, author: omitRuntimeAuthorFields(request.comment!.author) };
        expect(deterministicStringify(requestCommentWire)).to.equal(deterministicStringify(comment.raw.pubsubMessageToPublish!));
        expect(request.challengeRequestId.constructor.name).to.equal("Uint8Array");
        expect(request.challengeRequestId.length).to.equal(38);
        expect(request.type).to.equal("CHALLENGEREQUEST");
        expect(request.acceptedChallengeTypes).to.be.a("array");
        expect(request.encrypted).to.be.a("object");
        expect(request.encrypted.ciphertext.constructor.name).to.equal("Uint8Array");
        expect(request.encrypted.iv.constructor.name).to.equal("Uint8Array");
        expect(request.encrypted.tag.constructor.name).to.equal("Uint8Array");
        expect(request.encrypted.type).to.equal("ed25519-aes-gcm");
        expect(request.protocolVersion).to.be.a("string");
        expect(request.signature).to.be.a("object");
        expect(request.signature.signature.constructor.name).to.equal("Uint8Array");
        expect(request.signature.signature.length).to.equal(64);
        expect(request.signature.publicKey.constructor.name).to.equal("Uint8Array");
        expect(request.signature.publicKey.length).to.equal(32);
        expect(request.signature.signedPropertyNames.sort()).to.deep.equal(
            ["type", "challengeRequestId", "encrypted", "acceptedChallengeTypes", "timestamp", "userAgent", "protocolVersion"].sort()
        );
        expect(request.signature.type).to.equal("ed25519");
        expect(request.timestamp).to.be.a("number");
        expect(request.userAgent).to.be.a("string");
    });

    it(`Validate props of challenge`, async () => {
        const comment = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: plebbit,
            postProps: { signer: commentSigner }
        });
        const challengePromise = new Promise<DecryptedChallengeMessageType>((resolve) => subplebbit.once("challenge", resolve));

        await comment.publish();
        const challenge = await challengePromise;
        expect(challenge.challengeRequestId.constructor.name).to.equal("Uint8Array");
        expect(challenge.challengeRequestId.length).to.equal(38);
        expect(challenge.type).to.equal("CHALLENGE");
        expect(challenge.challenges).to.be.a("array");
        expect(challenge.challenges[0].challenge).to.be.a("string");
        expect(challenge.challenges[0].type).to.equal("text/plain");

        expect(challenge.encrypted).to.be.a("object");
        expect(challenge.encrypted.ciphertext.constructor.name).to.equal("Uint8Array");
        expect(challenge.encrypted.iv.constructor.name).to.equal("Uint8Array");
        expect(challenge.encrypted.tag.constructor.name).to.equal("Uint8Array");
        expect(challenge.encrypted.type).to.equal("ed25519-aes-gcm");
        expect(challenge.protocolVersion).to.be.a("string");
        expect(challenge.signature).to.be.a("object");
        expect(challenge.signature.signature.constructor.name).to.equal("Uint8Array");
        expect(challenge.signature.signature.length).to.equal(64);
        expect(challenge.signature.publicKey.constructor.name).to.equal("Uint8Array");
        expect(challenge.signature.publicKey.length).to.equal(32);
        expect(challenge.signature.signedPropertyNames.sort()).to.deep.equal(
            ["type", "challengeRequestId", "encrypted", "timestamp", "userAgent", "protocolVersion"].sort()
        );
        expect(challenge.signature.type).to.equal("ed25519");
        expect(challenge.timestamp).to.be.a("number");
        expect(challenge.userAgent).to.be.a("string");
    });

    it(`Validate props of challengeanswer`, async () => {
        const comment = await generatePostToAnswerMathQuestion({ communityAddress: subplebbit.address, signer: commentSigner }, plebbit);

        const challengeAnswerPromise = new Promise<DecryptedChallengeAnswerMessageType>((resolve) =>
            subplebbit.once("challengeanswer", resolve)
        );
        const challengeVerificationPromise = new Promise<DecryptedChallengeVerificationMessageType>((resolve) =>
            comment.once("challengeverification", resolve)
        );
        await comment.publish();

        const challengeAnswer = await challengeAnswerPromise;
        await challengeVerificationPromise;
        expect(challengeAnswer.challengeRequestId.constructor.name).to.equal("Uint8Array");
        expect(challengeAnswer.challengeRequestId.length).to.equal(38);
        expect(challengeAnswer.type).to.equal("CHALLENGEANSWER");
        expect(challengeAnswer.challengeAnswers).to.deep.equal(["2"]);
        expect(challengeAnswer.encrypted).to.be.a("object");
        expect(challengeAnswer.encrypted.ciphertext.constructor.name).to.equal("Uint8Array");
        expect(challengeAnswer.encrypted.iv.constructor.name).to.equal("Uint8Array");
        expect(challengeAnswer.encrypted.tag.constructor.name).to.equal("Uint8Array");
        expect(challengeAnswer.encrypted.type).to.equal("ed25519-aes-gcm");
        expect(challengeAnswer.protocolVersion).to.be.a("string");
        expect(challengeAnswer.signature).to.be.a("object");
        expect(challengeAnswer.signature.signature.constructor.name).to.equal("Uint8Array");
        expect(challengeAnswer.signature.signature.length).to.equal(64);
        expect(challengeAnswer.signature.publicKey.constructor.name).to.equal("Uint8Array");
        expect(challengeAnswer.signature.publicKey.length).to.equal(32);
        expect(challengeAnswer.signature.signedPropertyNames.sort()).to.deep.equal(
            ["type", "challengeRequestId", "encrypted", "timestamp", "userAgent", "protocolVersion"].sort()
        );
        expect(challengeAnswer.signature.type).to.equal("ed25519");
        expect(challengeAnswer.timestamp).to.be.a("number");
        expect(challengeAnswer.userAgent).to.be.a("string");
    });

    it(`Validate props of challengeverification (challengeSuccess=false)`, async () => {
        // Use generateMockPost instead of generatePostToAnswerMathQuestion so we can provide a wrong answer
        const comment = await generateMockPost({
            communityAddress: subplebbit.address,
            plebbit: plebbit,
            postProps: { signer: commentSigner }
        });

        // Set up to answer with a wrong answer
        comment.once("challenge", async () => {
            await comment.publishChallengeAnswers(["12345"]); // wrong answer here
        });

        const challengeVerificationPromise = new Promise<DecryptedChallengeVerificationMessageType>((resolve) =>
            subplebbit.once("challengeverification", resolve)
        );

        await comment.publish();
        const challengeVerifcation = await challengeVerificationPromise;
        expect(challengeVerifcation.challengeRequestId.constructor.name).to.equal("Uint8Array");
        expect(challengeVerifcation.challengeRequestId.length).to.equal(38);
        expect(challengeVerifcation.type).to.equal("CHALLENGEVERIFICATION");
        expect(challengeVerifcation.challengeErrors).to.deep.equal({ 0: "Wrong answer." });
        expect(challengeVerifcation.challengeSuccess).to.be.false;
        expect(challengeVerifcation.encrypted).to.be.undefined;
        expect(challengeVerifcation.comment).to.be.undefined;
        expect(challengeVerifcation.reason).to.be.undefined;
        expect(challengeVerifcation.protocolVersion).to.be.a("string");
        expect(challengeVerifcation.signature).to.be.a("object");
        expect(challengeVerifcation.signature.signature.constructor.name).to.equal("Uint8Array");
        expect(challengeVerifcation.signature.signature.length).to.equal(64);
        expect(challengeVerifcation.signature.publicKey.constructor.name).to.equal("Uint8Array");
        expect(challengeVerifcation.signature.publicKey.length).to.equal(32);
        expect(challengeVerifcation.signature.signedPropertyNames.sort()).to.deep.equal(
            ["type", "challengeRequestId", "challengeSuccess", "challengeErrors", "timestamp", "userAgent", "protocolVersion"].sort()
        );
        expect(challengeVerifcation.signature.type).to.equal("ed25519");
        expect(challengeVerifcation.timestamp).to.be.a("number");
        expect(challengeVerifcation.userAgent).to.be.a("string");
    });

    it(`Validate props of challengeverification (challengeSuccess=true)`, async () => {
        const comment = await generatePostToAnswerMathQuestion({ communityAddress: subplebbit.address, signer: commentSigner }, plebbit);

        const challengeVerificationPromise = new Promise<DecryptedChallengeVerificationMessageType>((resolve) =>
            subplebbit.once("challengeverification", resolve)
        );
        const commentChallengeVerificationPromise = new Promise<DecryptedChallengeVerificationMessageType>((resolve) =>
            comment.once("challengeverification", resolve)
        );
        await comment.publish();
        const [challengeVerifcation] = await Promise.all([challengeVerificationPromise, commentChallengeVerificationPromise]);
        expect(challengeVerifcation.challengeRequestId.constructor.name).to.equal("Uint8Array");
        expect(challengeVerifcation.challengeRequestId.length).to.equal(38);
        expect(challengeVerifcation.type).to.equal("CHALLENGEVERIFICATION");
        expect(challengeVerifcation.challengeErrors).to.be.undefined;
        expect(challengeVerifcation.challengeSuccess).to.be.true;
        expect(challengeVerifcation.encrypted).to.be.a("object");
        expect(challengeVerifcation.encrypted!.ciphertext.constructor.name).to.equal("Uint8Array");
        expect(challengeVerifcation.encrypted!.iv.constructor.name).to.equal("Uint8Array");
        expect(challengeVerifcation.encrypted!.tag.constructor.name).to.equal("Uint8Array");
        expect(challengeVerifcation.encrypted!.type).to.equal("ed25519-aes-gcm");
        expect(challengeVerifcation.comment).to.be.a("object");
        expect(challengeVerifcation.commentUpdate).to.be.a("object");
        expect(challengeVerifcation.commentUpdate!.author!.subplebbit).to.be.a("object");
        expect(challengeVerifcation.commentUpdate!.number).to.be.a("number");
        expect(challengeVerifcation.commentUpdate!.postNumber).to.be.a("number");
        expect(comment.number).to.equal(challengeVerifcation.commentUpdate!.number);
        expect(comment.postNumber).to.equal(challengeVerifcation.commentUpdate!.postNumber);
        expect(challengeVerifcation.reason).to.be.undefined;
        expect(challengeVerifcation.protocolVersion).to.be.a("string");
        expect(challengeVerifcation.signature).to.be.a("object");
        expect(challengeVerifcation.signature.signature.constructor.name).to.equal("Uint8Array");
        expect(challengeVerifcation.signature.signature.length).to.equal(64);
        expect(challengeVerifcation.signature.publicKey.constructor.name).to.equal("Uint8Array");
        expect(challengeVerifcation.signature.publicKey.length).to.equal(32);
        expect(challengeVerifcation.signature.signedPropertyNames.sort()).to.deep.equal(
            ["protocolVersion", "userAgent", "type", "challengeRequestId", "encrypted", "challengeSuccess", "timestamp"].sort()
        );
        expect(challengeVerifcation.signature.type).to.equal("ed25519");
        expect(challengeVerifcation.timestamp).to.be.a("number");
        expect(challengeVerifcation.userAgent).to.be.a("string");
    });
});

import signers from "../../fixtures/signers.js";
import { generatePostToAnswerMathQuestion, getAvailablePlebbitConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { Plebbit } from "../../../dist/node/plebbit/plebbit.js";

import { stringify as deterministicStringify } from "safe-stable-stringify";

// Types for pubsub message validation
type EncryptedField = {
    ciphertext: { constructor: { name: string } };
    iv: { constructor: { name: string } };
    tag: { constructor: { name: string } };
    type: string;
};

type SignatureField = {
    signature: { constructor: { name: string }; length: number };
    publicKey: { constructor: { name: string }; length: number };
    signedPropertyNames: string[];
    type: string;
};

type ChallengeRequest = {
    comment: Record<string, unknown>;
    challengeRequestId: { constructor: { name: string }; length: number };
    type: string;
    acceptedChallengeTypes: unknown[];
    encrypted: EncryptedField;
    protocolVersion: string;
    signature: SignatureField;
    timestamp: number;
    userAgent: string;
};

type Challenge = {
    challengeRequestId: { constructor: { name: string }; length: number };
    type: string;
    challenges: Array<{ challenge: string; index?: number; type: string }>;
    encrypted: EncryptedField;
    protocolVersion: string;
    signature: SignatureField;
    timestamp: number;
    userAgent: string;
};

type ChallengeAnswer = {
    challengeRequestId: { constructor: { name: string }; length: number };
    type: string;
    challengeAnswers: string[];
    encrypted: EncryptedField;
    protocolVersion: string;
    signature: SignatureField;
    timestamp: number;
    userAgent: string;
};

type ChallengeVerification = {
    challengeRequestId: { constructor: { name: string }; length: number };
    type: string;
    challengeErrors?: Record<number, string>;
    challengeSuccess: boolean;
    encrypted?: EncryptedField;
    publication?: unknown;
    comment?: Record<string, unknown>;
    commentUpdate?: { author: { subplebbit: unknown } };
    reason?: string;
    protocolVersion: string;
    signature: SignatureField;
    timestamp: number;
    userAgent: string;
};

const mathCliSubplebbitAddress = signers[1].address;

getAvailablePlebbitConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    describe.concurrent(`Validate props of publication Pubsub messages - ${config.name}`, async () => {
        let plebbit: Plebbit;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`Validate props of challengerequest`, async () => {
            const comment = await generatePostToAnswerMathQuestion({ communityAddress: mathCliSubplebbitAddress }, plebbit);

            const requestPromise = new Promise<ChallengeRequest>((resolve) =>
                comment.once("challengerequest", resolve as (req: unknown) => void)
            );
            await comment.publish();
            const request = await requestPromise;
            expect(deterministicStringify(request.comment)).to.equal(deterministicStringify(comment.raw.pubsubMessageToPublish!));
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
            expect(request.signature.signedPropertyNames.sort()).to.deep.equal([
                "acceptedChallengeTypes",
                "challengeRequestId",
                "encrypted",
                "protocolVersion",
                "timestamp",
                "type",
                "userAgent"
            ]);
            expect(request.signature.type).to.equal("ed25519");
            expect(request.timestamp).to.be.a("number");
            expect(request.userAgent).to.be.a("string");
        });

        it(`Validate props of challenge`, async () => {
            const comment = await generatePostToAnswerMathQuestion({ communityAddress: mathCliSubplebbitAddress }, plebbit);

            const challengePromise = new Promise<Challenge>((resolve) => comment.once("challenge", resolve as (msg: unknown) => void));
            await comment.publish();
            const challenge = await challengePromise;
            expect(challenge.challengeRequestId.constructor.name).to.equal("Uint8Array");
            expect(challenge.challengeRequestId.length).to.equal(38);
            expect(challenge.type).to.equal("CHALLENGE");
            expect(challenge.challenges).to.be.a("array");
            expect(challenge.challenges[0].challenge).to.be.a("string");
            expect(challenge.challenges[0].index).to.be.undefined; // you can get index from array
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
            expect(challenge.signature.signedPropertyNames.sort()).to.deep.equal([
                "challengeRequestId",
                "encrypted",
                "protocolVersion",
                "timestamp",
                "type",
                "userAgent"
            ]);
            expect(challenge.signature.type).to.equal("ed25519");
            expect(challenge.timestamp).to.be.a("number");
            expect(challenge.userAgent).to.be.a("string");
        });

        it(`Validate props of challengeanswer`, async () => {
            const comment = await generatePostToAnswerMathQuestion({ communityAddress: mathCliSubplebbitAddress }, plebbit);

            const challengeAnswerPromise = new Promise<ChallengeAnswer>((resolve) =>
                comment.once("challengeanswer", resolve as (msg: unknown) => void)
            );
            await comment.publish();
            const challengeAnswer = await challengeAnswerPromise;
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
            expect(challengeAnswer.signature.signedPropertyNames.sort()).to.deep.equal([
                "challengeRequestId",
                "encrypted",
                "protocolVersion",
                "timestamp",
                "type",
                "userAgent"
            ]);
            expect(challengeAnswer.signature.type).to.equal("ed25519");
            expect(challengeAnswer.timestamp).to.be.a("number");
            expect(challengeAnswer.userAgent).to.be.a("string");
        });

        it(`Validate props of challengeverification (challengeSuccess=false)`, async () => {
            const comment = await generatePostToAnswerMathQuestion({ communityAddress: mathCliSubplebbitAddress }, plebbit);

            comment.removeAllListeners("challenge");
            const challengePromise = new Promise((resolve) => comment.once("challenge", resolve));
            await comment.publish();
            await challengePromise;
            const challengeVerificationPromise = new Promise<ChallengeVerification>((resolve) =>
                comment.once("challengeverification", resolve as (msg: unknown) => void)
            );
            await comment.publishChallengeAnswers(["12345"]); // wrong answer here
            const challengeVerifcation = await challengeVerificationPromise;
            expect(challengeVerifcation.challengeRequestId.constructor.name).to.equal("Uint8Array");
            expect(challengeVerifcation.challengeRequestId.length).to.equal(38);
            expect(challengeVerifcation.type).to.equal("CHALLENGEVERIFICATION");
            expect(challengeVerifcation.challengeErrors).to.deep.equal({ 0: "Wrong answer." });
            expect(challengeVerifcation.challengeSuccess).to.be.false;
            expect(challengeVerifcation.encrypted).to.be.undefined;
            expect(challengeVerifcation.publication).to.be.undefined;
            expect(challengeVerifcation.comment).to.be.undefined;
            expect(challengeVerifcation.commentUpdate).to.be.undefined;

            expect(challengeVerifcation.reason).to.be.undefined;
            expect(challengeVerifcation.protocolVersion).to.be.a("string");
            expect(challengeVerifcation.signature).to.be.a("object");
            expect(challengeVerifcation.signature.signature.constructor.name).to.equal("Uint8Array");
            expect(challengeVerifcation.signature.signature.length).to.equal(64);
            expect(challengeVerifcation.signature.publicKey.constructor.name).to.equal("Uint8Array");
            expect(challengeVerifcation.signature.publicKey.length).to.equal(32);
            expect(challengeVerifcation.signature.signedPropertyNames.sort()).to.deep.equal([
                "challengeErrors",
                "challengeRequestId",
                "challengeSuccess",
                "protocolVersion",
                "timestamp",
                "type",
                "userAgent"
            ]);
            expect(challengeVerifcation.signature.type).to.equal("ed25519");
            expect(challengeVerifcation.timestamp).to.be.a("number");
            expect(challengeVerifcation.userAgent).to.be.a("string");
        });

        it(`Validate props of challengeverification (challengeSuccess=true)`, async () => {
            const comment = await generatePostToAnswerMathQuestion({ communityAddress: mathCliSubplebbitAddress }, plebbit);

            const challengeVerificationPromise = new Promise<ChallengeVerification>((resolve) =>
                comment.once("challengeverification", resolve as (msg: unknown) => void)
            );
            await comment.publish();
            const challengeVerifcation = await challengeVerificationPromise;
            expect(challengeVerifcation.challengeRequestId.constructor.name).to.equal("Uint8Array");
            expect(challengeVerifcation.challengeRequestId.length).to.equal(38);
            expect(challengeVerifcation.type).to.equal("CHALLENGEVERIFICATION");
            expect(challengeVerifcation.challengeErrors).to.be.undefined;
            expect(challengeVerifcation.challengeSuccess).to.be.true;
            expect(challengeVerifcation.encrypted).to.be.a("object");
            expect(challengeVerifcation.encrypted.ciphertext.constructor.name).to.equal("Uint8Array");
            expect(challengeVerifcation.encrypted.iv.constructor.name).to.equal("Uint8Array");
            expect(challengeVerifcation.encrypted.tag.constructor.name).to.equal("Uint8Array");
            expect(challengeVerifcation.encrypted.type).to.equal("ed25519-aes-gcm");
            expect(challengeVerifcation.publication).to.be.undefined;
            expect(challengeVerifcation.comment).to.be.a("object");
            expect(challengeVerifcation.commentUpdate).to.be.a("object");
            expect(challengeVerifcation.commentUpdate.author.subplebbit).to.be.a("object");
            expect(challengeVerifcation.reason).to.be.undefined;
            expect(challengeVerifcation.protocolVersion).to.be.a("string");
            expect(challengeVerifcation.signature).to.be.a("object");
            expect(challengeVerifcation.signature.signature.constructor.name).to.equal("Uint8Array");
            expect(challengeVerifcation.signature.signature.length).to.equal(64);
            expect(challengeVerifcation.signature.publicKey.constructor.name).to.equal("Uint8Array");
            expect(challengeVerifcation.signature.publicKey.length).to.equal(32);
            expect(challengeVerifcation.signature.signedPropertyNames.sort()).to.deep.equal([
                "challengeRequestId",
                "challengeSuccess",
                "encrypted",
                "protocolVersion",
                "timestamp",
                "type",
                "userAgent"
            ]);
            expect(challengeVerifcation.signature.type).to.equal("ed25519");
            expect(challengeVerifcation.timestamp).to.be.a("number");
            expect(challengeVerifcation.userAgent).to.be.a("string");
        });
    });
});

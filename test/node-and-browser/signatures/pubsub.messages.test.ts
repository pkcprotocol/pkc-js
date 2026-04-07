import { beforeAll, afterAll } from "vitest";
import { generateMockPost, publishWithExpectedResult, getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";
import {
    verifyChallengeRequest,
    verifyChallengeAnswer,
    signChallengeAnswer,
    verifyChallengeMessage,
    verifyChallengeVerification,
    signChallengeRequest,
    verifyCommentPubsubMessage
} from "../../../dist/node/signer/signatures.js";
import signers from "../../fixtures/signers.js";
import { messages } from "../../../dist/node/errors.js";
import * as remeda from "remeda";
import { default as PKCJsVersion } from "../../../dist/node/version.js";
import { encode as cborgEncode, decode as cborgDecode } from "cborg";
import { getBufferedPKCAddressFromPublicKey } from "../../../dist/node/signer/util.js";
import { encryptEd25519AesGcm } from "../../../dist/node/signer/index.js";
import { timestamp } from "../../../dist/node/util.js";
import validChallengeRequestFixture from "../../fixtures/signatures/challenges/valid_challenge_request.json" with { type: "json" };
import validChallengeFixture from "../../fixtures/signatures/challenges/valid_challenge_message.json" with { type: "json" };
import validChallengeAnswerFixture from "../../fixtures/signatures/challenges/valid_challenge_answer.json" with { type: "json" };
import validChallengeVerificationFixture from "../../fixtures/signatures/challenges/valid_challenge_verification.json" with { type: "json" };

import type { PKC as PKCType } from "../../../dist/node/pkc/pkc.js";
import type {
    DecryptedChallengeRequestMessageType,
    DecryptedChallengeMessageType,
    DecryptedChallengeAnswerMessageType,
    DecryptedChallengeVerificationMessageType,
    ChallengeRequestMessageType,
    ChallengeMessageType,
    ChallengeAnswerMessageType,
    ChallengeVerificationMessageType
} from "../../../dist/node/pubsub-messages/types.js";
import type { PubsubSubscriptionHandler } from "../../../dist/node/types.js";

// Helper to access private _handleChallengeExchange for testing
type PublicationWithPrivateHandler = { _handleChallengeExchange: PubsubSubscriptionHandler };

const mathCliCommunityAddress = signers[1].address;

const parsePubsubMsgFixture = <T extends Record<string, unknown>>(json: T): T => {
    // Convert stringified pubsub msg with buffers to regular pubsub msg with uint8Array for buffers
    const isBuffer = (obj: Record<string, unknown>) => Object.keys(obj).every((key) => /\d/.test(key));
    const parsed: Record<string, unknown> = {};
    for (const key of Object.keys(json)) {
        if (remeda.isPlainObject(json[key]) && isBuffer(json[key] as Record<string, unknown>))
            parsed[key] = Uint8Array.from(Object.values(json[key] as Record<string, unknown>) as number[]);
        else if (remeda.isPlainObject(json[key])) parsed[key] = parsePubsubMsgFixture(json[key] as Record<string, unknown>);
        else parsed[key] = json[key];
    }
    return parsed as T;
};

// Clients of RPC will trust the response of RPC and won't validate

getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).forEach((config) => {
    describe.concurrent("challengerequest - " + config.name, async () => {
        let pkc: PKCType;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`valid challengerequest fixture from previous version can be validated`, async () => {
            const request = parsePubsubMsgFixture(remeda.clone(validChallengeRequestFixture)) as unknown as ChallengeRequestMessageType;
            const verificaiton = await verifyChallengeRequest({ request, validateTimestampRange: false });
            expect(verificaiton).to.deep.equal({ valid: true });
        });

        it(`challenge request with challengeRequestId that is not derived from signer is invalidated`, async () => {
            const request = parsePubsubMsgFixture(remeda.clone(validChallengeRequestFixture)) as unknown as ChallengeRequestMessageType;
            request.challengeRequestId[0] += 1; // Invalidate challengeRequestId
            const verificaiton = await verifyChallengeRequest({ request, validateTimestampRange: false });
            expect(verificaiton).to.deep.equal({ valid: false, reason: messages.ERR_CHALLENGE_REQUEST_ID_NOT_DERIVED_FROM_SIGNATURE });
        });

        it(`challenge request with outdated timestamp is invalidated`, async () => {
            const comment = await generateMockPost({
                communityAddress: signers[0].address,
                pkc: pkc,
                postProps: { signer: signers[5] }
            });
            const challengeRequestPromise = new Promise<DecryptedChallengeRequestMessageType>((resolve) =>
                comment.once("challengerequest", resolve)
            );
            await comment.publish();
            const challengeRequest = await challengeRequestPromise;
            const challengeRequestToEdit = remeda.omit(remeda.clone(challengeRequest), [
                "comment",
                "challengeAnswers",
                "challengeCommentCids"
            ]);
            challengeRequestToEdit.timestamp = timestamp() - 6 * 60; // Should be invalidated now
            const signer = Object.values(comment._challengeExchanges)[0].signer!;
            challengeRequestToEdit.signature = await signChallengeRequest({ request: challengeRequestToEdit, signer });
            const verificaiton = await verifyChallengeRequest({ request: challengeRequestToEdit, validateTimestampRange: true });
            expect(verificaiton).to.deep.equal({ valid: false, reason: messages.ERR_PUBSUB_MSG_TIMESTAMP_IS_OUTDATED });
        });

        it(`Valid live ChallengeRequest gets validated correctly`, async () => {
            const comment = await generateMockPost({
                communityAddress: signers[0].address,
                pkc: pkc,
                postProps: { signer: signers[5] }
            });
            const challengeRequestPromise = new Promise<DecryptedChallengeRequestMessageType>((resolve) =>
                comment.once("challengerequest", resolve)
            );

            await comment.publish();
            const challengeRequest = await challengeRequestPromise;
            const requestToValidate = remeda.omit(challengeRequest, ["comment", "challengeAnswers", "challengeCommentCids"]);
            const verificaiton = await verifyChallengeRequest({ request: requestToValidate, validateTimestampRange: false });
            expect(verificaiton).to.deep.equal({ valid: true });
        });

        it(`Sub responds with error to a challenge request whose comment can't be decrypted`, async () => {
            const comment = await generateMockPost({
                communityAddress: signers[0].address,
                pkc: pkc,
                postProps: { content: "Test content" }
            });
            const originalPublish = comment._clientsManager.pubsubPublishOnProvider.bind(comment._clientsManager);
            comment._clientsManager.pubsubPublishOnProvider = (async () => {}) as typeof comment._clientsManager.pubsubPublishOnProvider;

            const challengeRequestPromise = new Promise<DecryptedChallengeRequestMessageType>((resolve) =>
                comment.once("challengerequest", resolve)
            );

            await comment.publish();
            const challengeRequest = await challengeRequestPromise;

            const challengeRequestToModify = remeda.omit(challengeRequest, ["comment", "challengeCommentCids", "challengeAnswers"]);
            const pubsubSigner = Object.values(comment._challengeExchanges)[0].signer!;
            challengeRequestToModify.encrypted = await encryptEd25519AesGcm(
                JSON.stringify(comment.toJSONPubsubRequestToEncrypt()),
                pubsubSigner.privateKey,
                signers[5].publicKey // Use a public key that cannot be decrypted for the community
            );

            challengeRequestToModify.signature = await signChallengeRequest({ request: challengeRequestToModify, signer: pubsubSigner });

            try {
                await originalPublish(
                    comment._community!.pubsubTopic!,
                    challengeRequestToModify,
                    Object.values(comment._challengeExchanges)[0].providerUrl
                );
            } catch (error) {
                console.log(error);
            }

            const verificationMsg = await new Promise<DecryptedChallengeVerificationMessageType>((resolve) =>
                comment.once("challengeverification", resolve)
            );
            expect(verificationMsg.challengeSuccess).to.be.false;
            expect(verificationMsg.reason).to.equal(messages.ERR_COMMUNITY_FAILED_TO_DECRYPT_PUBSUB_MSG);
            expect("publication" in verificationMsg).to.be.false;
            expect(verificationMsg.comment).to.be.undefined;
            expect(verificationMsg.commentUpdate).to.be.undefined;
        });

        it(`Sub responds with error to a challenge request with invalid pubsubMessage.encrypted.comment.signature`, async () => {
            const comment = await generateMockPost({ communityAddress: signers[0].address, pkc: pkc });
            const originalPublish = comment._clientsManager.pubsubPublishOnProvider.bind(comment._clientsManager);
            comment._clientsManager.pubsubPublishOnProvider = (async () => {}) as typeof comment._clientsManager.pubsubPublishOnProvider;

            const challengeRequestPromise = new Promise<DecryptedChallengeRequestMessageType>((resolve) =>
                comment.once("challengerequest", resolve)
            );

            try {
                await comment.publish();
            } catch {}

            const challengeRequest = await challengeRequestPromise;
            comment._clientsManager.pubsubPublishOnProvider = originalPublish;

            const commentObjToEncrypt = JSON.parse(JSON.stringify(comment.toJSONPubsubRequestToEncrypt()));

            expect(
                await verifyCommentPubsubMessage({
                    comment: commentObjToEncrypt.comment,
                    resolveAuthorNames: pkc.resolveAuthorNames,
                    clientsManager: comment._clientsManager
                })
            ).to.deep.equal({
                valid: true
            });
            commentObjToEncrypt.comment.timestamp += 1; // Should invalidate signature
            expect(
                await verifyCommentPubsubMessage({
                    comment: commentObjToEncrypt.comment,
                    resolveAuthorNames: false,
                    clientsManager: comment._clientsManager
                })
            ).to.deep.equal({
                valid: false,
                reason: messages.ERR_SIGNATURE_IS_INVALID
            });

            const challengeRequestToModify = remeda.omit(challengeRequest, ["comment", "challengeCommentCids", "challengeAnswers"]);
            const pubsubSigner = Object.values(comment._challengeExchanges)[0].signer!;

            challengeRequestToModify.encrypted = await encryptEd25519AesGcm(
                JSON.stringify(commentObjToEncrypt),
                pubsubSigner.privateKey,
                comment._community!.encryption!.publicKey
            );

            challengeRequestToModify.signature = await signChallengeRequest({ request: challengeRequestToModify, signer: pubsubSigner });

            await comment._clientsManager.pubsubPublish(comment._community!.pubsubTopic!, challengeRequestToModify);

            const verificationMsg = await new Promise<DecryptedChallengeVerificationMessageType>((resolve) =>
                comment.once("challengeverification", resolve)
            );

            expect(verificationMsg.challengeSuccess).to.be.false;
            expect(verificationMsg.reason).to.equal(messages.ERR_SIGNATURE_IS_INVALID);
            expect(verificationMsg.comment).to.be.undefined;
            expect(verificationMsg.encrypted).to.be.undefined;
        });

        it(`Sub ignores a challenge request with invalid pubsubMessage.signature`, async () => {
            // This test case also includes challengeRequestId not being derived from signer since it's caught by verifyChallengeRequest
            const comment = await generateMockPost({
                communityAddress: signers[0].address,
                pkc: pkc,
                postProps: { signer: signers[6] }
            });
            const challengeRequestPromise = new Promise<DecryptedChallengeRequestMessageType>((resolve) =>
                comment.once("challengerequest", resolve)
            );

            await Promise.all([new Promise((resolve) => comment.once("challengeverification", resolve)), comment.publish()]);

            const challengeRequest = await challengeRequestPromise;
            const requestWithInvalidSignature = remeda.omit(remeda.clone(challengeRequest), [
                "comment",
                "challengeCommentCids",
                "challengeAnswers"
            ]);
            requestWithInvalidSignature.acceptedChallengeTypes.push("test"); // Signature should be invalid after
            const verificaiton = await verifyChallengeRequest({ request: requestWithInvalidSignature, validateTimestampRange: false });
            expect(verificaiton).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });

            await pkc._clientsManager.pubsubPublish(comment._community!.pubsubTopic!, requestWithInvalidSignature);

            await new Promise<void>(async (resolve) => {
                const subMethod: PubsubSubscriptionHandler = (pubsubMsg) => {
                    const msgParsed = cborgDecode(pubsubMsg.data) as ChallengeVerificationMessageType;
                    if (
                        msgParsed.type === "CHALLENGEVERIFICATION" &&
                        msgParsed.challengeRequestId === requestWithInvalidSignature.challengeRequestId
                    ) {
                        expect.fail("Community should not respond to a challenge request with invalid signature");
                    }
                };
                await pkc._clientsManager.pubsubSubscribe(comment._community!.pubsubTopic!, subMethod);
                await new Promise<void>((resolve) => setTimeout(resolve, 5000)); // Wait 5s for community response, if we didn't get a response then the request has been ignored
                resolve();
            });
        });
    });

    // Clients of RPC will trust the response of RPC and won't validate
    describe.concurrent(`challengemessage - ` + config.name, async () => {
        let pkc: PKCType;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`valid challengemessage fixture from previous version can be validated`, async () => {
            const challenge = parsePubsubMsgFixture(remeda.clone(validChallengeFixture)) as unknown as ChallengeMessageType;
            const verificaiton = await verifyChallengeMessage({
                challenge,
                pubsubTopic: "12D3KooWANwdyPERMQaCgiMnTT1t3Lr4XLFbK1z4ptFVhW2ozg1z",
                validateTimestampRange: false
            });
            expect(verificaiton).to.deep.equal({ valid: true });
        });

        it(`Invalid ChallengeMessage gets invalidated correctly`, async () => {
            const challenge = parsePubsubMsgFixture(remeda.clone(validChallengeFixture)) as unknown as ChallengeMessageType;
            challenge.timestamp -= 1234; // Should invalidate signature
            const verificaiton = await verifyChallengeMessage({
                challenge,
                pubsubTopic: "12D3KooWANwdyPERMQaCgiMnTT1t3Lr4XLFbK1z4ptFVhW2ozg1z",
                validateTimestampRange: false
            });
            expect(verificaiton).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
        });

        it(`challenge message signed by other than community.pubsubTopic is invalidated`, async () => {
            const challenge = parsePubsubMsgFixture(remeda.clone(validChallengeFixture)) as unknown as ChallengeMessageType;
            const verificaiton = await verifyChallengeMessage({
                challenge,
                pubsubTopic: (await pkc.createSigner()).address,
                validateTimestampRange: false
            }); // Random pubsub topic
            expect(verificaiton).to.deep.equal({ valid: false, reason: messages.ERR_CHALLENGE_MSG_SIGNER_IS_NOT_COMMUNITY });
        });
        it(`Valid live challengemessage gets validated correctly`, async () => {
            const comment = await generateMockPost({
                communityAddress: mathCliCommunityAddress,
                pkc: pkc,
                postProps: { signer: signers[6] }
            });
            comment.removeAllListeners();

            await comment.publish();

            const challengePubsubMsg = await new Promise<DecryptedChallengeMessageType>((resolve) => comment.once("challenge", resolve));

            const challengePubsubMsgNoExtraProps = remeda.omit(challengePubsubMsg, ["challenges"]);

            const verification = await verifyChallengeMessage({
                challenge: challengePubsubMsgNoExtraProps,
                pubsubTopic: mathCliCommunityAddress,
                validateTimestampRange: false
            });
            expect(verification).to.deep.equal({ valid: true });
        });
    });

    // Clients of RPC will trust the response of RPC and won't validate
    describe.concurrent("challengeanswer - " + config.name, async () => {
        let pkc: PKCType;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`valid challengeanswer fixture from previous version can be validated`, async () => {
            const answer = parsePubsubMsgFixture(remeda.clone(validChallengeAnswerFixture)) as unknown as ChallengeAnswerMessageType;
            const verificaiton = await verifyChallengeAnswer({ answer, validateTimestampRange: false });
            expect(verificaiton).to.deep.equal({ valid: true });
        });

        it(`challenge answer with challengeRequestId that is not derived from signer is invalidated`, async () => {
            const answer = parsePubsubMsgFixture(remeda.clone(validChallengeAnswerFixture)) as unknown as ChallengeAnswerMessageType;
            answer.challengeRequestId[0] += 1; // Invalidate challenge request id
            const verificaiton = await verifyChallengeAnswer({ answer, validateTimestampRange: false });
            expect(verificaiton).to.deep.equal({ valid: false, reason: messages.ERR_CHALLENGE_REQUEST_ID_NOT_DERIVED_FROM_SIGNATURE });
        });

        it(`Valid live ChallengeAnswer gets validated correctly`, async () => {
            const comment = await generateMockPost({
                communityAddress: mathCliCommunityAddress,
                pkc: pkc,
                postProps: { signer: signers[5] }
            });
            comment.removeAllListeners();
            await comment.publish();

            comment.once("challenge", () => comment.publishChallengeAnswers(["2"]));

            const challengeAnswerPubsubMsg = await new Promise<DecryptedChallengeAnswerMessageType>((resolve) =>
                comment.once("challengeanswer", resolve)
            );
            const challengeAnswerPubsubMsgNoExtraProps = remeda.omit(challengeAnswerPubsubMsg, ["challengeAnswers"]);
            const verificaiton = await verifyChallengeAnswer({
                answer: challengeAnswerPubsubMsgNoExtraProps,
                validateTimestampRange: false
            });
            expect(verificaiton).to.deep.equal({ valid: true });
        });

        it(`Sub ignores a challenge answer with invalid answer.signature`, async () => {
            // Test includes cases where challengeRequestId is not derived from the signer of the message because verifyChallengeAnswer checks for that too
            const comment = await generateMockPost({
                communityAddress: mathCliCommunityAddress,
                pkc: pkc,
                postProps: { signer: signers[6] }
            });

            comment.removeAllListeners();
            const challengeRequestPromise = new Promise<DecryptedChallengeRequestMessageType>((resolve) =>
                comment.once("challengerequest", resolve)
            );
            const challengePromise = new Promise<DecryptedChallengeMessageType>((resolve) => comment.once("challenge", resolve));

            await comment.publish();

            const challengeRequest = await challengeRequestPromise;
            const challenge = await challengePromise;

            await comment._pkc._clientsManager.pubsubUnsubscribe(
                comment._community!.pubsubTopic!,
                (comment as unknown as PublicationWithPrivateHandler)._handleChallengeExchange
            );
            const toSignAnswer = {
                type: "CHALLENGEANSWER" as const,
                challengeRequestId: challengeRequest.challengeRequestId,
                encrypted: JSON.stringify([2]),
                userAgent: PKCJsVersion.USER_AGENT,
                protocolVersion: PKCJsVersion.PROTOCOL_VERSION,
                timestamp: Math.round(Date.now() / 1000)
            } as unknown as Omit<ChallengeAnswerMessageType, "signature">;

            const pubsubSigner = Object.values(comment._challengeExchanges)[0].signer!;
            const challengeAnswer = {
                ...toSignAnswer,
                signature: await signChallengeAnswer({ challengeAnswer: toSignAnswer, signer: pubsubSigner })
            } as unknown as ChallengeAnswerMessageType;
            expect(await verifyChallengeAnswer({ answer: challengeAnswer, validateTimestampRange: false })).to.deep.equal({ valid: true });

            challengeAnswer.timestamp += 123; // Invalidate signature
            const verification = await verifyChallengeAnswer({ answer: challengeAnswer, validateTimestampRange: false });
            expect(verification).to.deep.equal({
                valid: false,
                reason: messages.ERR_SIGNATURE_IS_INVALID
            });

            await pkc._clientsManager.pubsubPublish(comment._community!.pubsubTopic!, challengeAnswer);

            const subMethod: PubsubSubscriptionHandler = (pubsubMsg) => {
                const msgParsed = cborgDecode(pubsubMsg.data) as ChallengeVerificationMessageType;
                if (msgParsed.type === "CHALLENGEVERIFICATION" && msgParsed.challengeRequestId === challengeRequest.challengeRequestId) {
                    expect.fail("Community should ignore a challenge answer with invalid signature");
                }
            };

            await pkc._clientsManager.pubsubSubscribe(comment._community!.pubsubTopic!, subMethod);
            await new Promise<void>((resolve) => setTimeout(resolve, 5000)); // Wait 5s for community response, if we didn't get a response then the answer has been ignored
        });

        it(`Sub responds with error to a challenge answer with answers that can't be decrypted`, async () => {
            const tempPKC = await config.pkcInstancePromise();
            const comment = await generateMockPost({ communityAddress: mathCliCommunityAddress, pkc: tempPKC });
            comment.removeAllListeners("challenge");

            const originalPublish = comment._clientsManager.pubsubPublishOnProvider.bind(comment._clientsManager);

            comment.once("challenge", async (challengeMsg) => {
                const pubsubSigner = Object.values(comment._challengeExchanges)[0].signer!;
                comment._clientsManager.pubsubPublishOnProvider =
                    (async () => {}) as typeof comment._clientsManager.pubsubPublishOnProvider; // Disable publishing

                await comment.publishChallengeAnswers(["test hello"]);
                // comment._challengeAnswer should be defined now

                const challengeAnswersPubsubMessage = Object.values(comment._challengeExchanges).find(
                    (exchange) => exchange.challengeAnswer
                )!.challengeAnswer!;

                const challengeAnswerToModify = remeda.omit(challengeAnswersPubsubMessage, ["challengeAnswers"]);
                challengeAnswerToModify.encrypted = await encryptEd25519AesGcm(
                    JSON.stringify({}),
                    pubsubSigner.privateKey,
                    signers[5].publicKey // Use a public key that cannot be decrypted for the community
                );
                challengeAnswerToModify.signature = await signChallengeAnswer({
                    challengeAnswer: challengeAnswerToModify,
                    signer: pubsubSigner
                });
                await originalPublish(
                    comment._community!.pubsubTopic!,
                    challengeAnswerToModify,
                    Object.values(comment._challengeExchanges)[0].providerUrl
                );
            });

            await publishWithExpectedResult({
                publication: comment,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMUNITY_FAILED_TO_DECRYPT_PUBSUB_MSG
            });
            await tempPKC.destroy();
        });

        it(`Sub responds with error to challenge answer whose id not registered (no challenge request with same id)`, async () => {
            const comment = await generateMockPost({
                communityAddress: mathCliCommunityAddress,
                pkc: pkc,
                postProps: { signer: signers[6] }
            });

            comment.removeAllListeners();
            await comment.publish();

            await new Promise<DecryptedChallengeMessageType>((resolve) => comment.once("challenge", resolve));

            await comment._pkc._clientsManager.pubsubUnsubscribe(
                comment._community!.pubsubTopic!,
                (comment as unknown as PublicationWithPrivateHandler)._handleChallengeExchange
            );
            const pubsubSigner = await pkc.createSigner();
            const differentChallengeRequestId = await getBufferedPKCAddressFromPublicKey(pubsubSigner.publicKey);
            const encrypted = await encryptEd25519AesGcm(
                JSON.stringify({ challengeAnswers: ["2"] }),
                pubsubSigner.privateKey,
                comment._community!.encryption!.publicKey
            );
            const toSignAnswer = {
                type: "CHALLENGEANSWER" as const,
                challengeRequestId: differentChallengeRequestId,
                userAgent: PKCJsVersion.USER_AGENT,
                protocolVersion: PKCJsVersion.PROTOCOL_VERSION,
                timestamp: Math.round(Date.now() / 1000),
                encrypted
            } as unknown as Omit<ChallengeAnswerMessageType, "signature">;
            const challengeAnswer = {
                ...toSignAnswer,
                signature: await signChallengeAnswer({ challengeAnswer: toSignAnswer, signer: pubsubSigner })
            } as unknown as ChallengeAnswerMessageType;
            expect(await verifyChallengeAnswer({ answer: challengeAnswer, validateTimestampRange: false })).to.deep.equal({ valid: true });

            await pkc._clientsManager.pubsubPublish(comment._community!.pubsubTopic!, challengeAnswer);

            const challengeVerification = await new Promise<ChallengeVerificationMessageType>((resolve) =>
                pkc._clientsManager.pubsubSubscribe(comment._community!.pubsubTopic!, ((pubsubMsg: { data: Uint8Array }) => {
                    const msgParsed = cborgDecode(pubsubMsg.data) as ChallengeVerificationMessageType;
                    if (
                        msgParsed.type === "CHALLENGEVERIFICATION" &&
                        msgParsed.challengeRequestId.toString() === toSignAnswer.challengeRequestId.toString()
                    )
                        resolve(msgParsed);
                }) as PubsubSubscriptionHandler)
            );

            expect(challengeVerification.challengeSuccess).to.be.false;
            expect(challengeVerification.reason).to.equal(messages.ERR_CHALLENGE_ANSWER_WITH_NO_CHALLENGE_REQUEST);
            expect("publication" in challengeVerification).to.be.false;
            expect("comment" in challengeVerification).to.be.false;
            expect("commentUpdate" in challengeVerification).to.be.false;
            expect(challengeVerification.encrypted).to.be.undefined;
            pkc._clientsManager.pubsubUnsubscribe(comment._community!.pubsubTopic!);
        });
    });

    // Clients of RPC will trust the response of RPC and won't validate
    describe.concurrent("challengeverification - " + config.name, async () => {
        let pkc: PKCType;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`valid challengeverification fixture from previous version can be validated`, async () => {
            const challengeVerification = parsePubsubMsgFixture(
                remeda.clone(validChallengeVerificationFixture)
            ) as unknown as ChallengeVerificationMessageType;
            const verificaiton = await verifyChallengeVerification({
                verification: challengeVerification,
                pubsubTopic: signers[0].address,
                validateTimestampRange: false
            });
            expect(verificaiton).to.deep.equal({ valid: true });
        });
        it(`Valid live challengeverification gets validated correctly`, async () => {
            const comment = await generateMockPost({
                communityAddress: signers[0].address,
                pkc: pkc,
                postProps: { signer: signers[6] }
            });
            await comment.publish();

            const challengeVerification = await new Promise<DecryptedChallengeVerificationMessageType>((resolve) =>
                comment.once("challengeverification", resolve)
            );
            const challengeVerificationNoExtraProps = remeda.omit(challengeVerification, ["comment", "commentUpdate"]);
            const verification = await verifyChallengeVerification({
                verification: challengeVerificationNoExtraProps,
                pubsubTopic: signers[0].address,
                validateTimestampRange: false
            });
            expect(verification).to.deep.equal({ valid: true });
        });
        it(`Invalid challengeverification gets invalidated correctly`, async () => {
            const challengeVerification = parsePubsubMsgFixture(
                remeda.clone(validChallengeVerificationFixture)
            ) as unknown as ChallengeVerificationMessageType;
            challengeVerification.timestamp -= 1234; // Invalidate signature
            const verificaiton = await verifyChallengeVerification({
                verification: challengeVerification,
                pubsubTopic: signers[0].address,
                validateTimestampRange: false
            });
            expect(verificaiton).to.deep.equal({ valid: false, reason: messages.ERR_SIGNATURE_IS_INVALID });
        });
    });
});

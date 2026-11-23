import signers from "../../fixtures/signers.js";
import {
    generateMockPost,
    setExtraPropOnChallengeRequestAndSign,
    publishChallengeVerificationMessageWithEncryption,
    publishChallengeMessageWithExtraProps,
    publishChallengeAnswerMessageWithExtraProps,
    publishChallengeVerificationMessageWithExtraProps,
    getAvailablePKCConfigsToTestAgainst
} from "../../../dist/node/test/test-util.js";
import validCommentUpdateFixture from "../../fixtures/signatures/comment/commentUpdate/valid_comment_update.json" with { type: "json" };
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { keys, omit } from "remeda";
import { describe, it, beforeAll, afterAll, expect } from "vitest";

import { _signJson, _signPubsubMsg } from "../../../dist/node/signer/signatures.js";
import { messages } from "../../../dist/node/errors.js";
import Logger from "@pkcprotocol/pkc-logger";
import type { PKC } from "../../../dist/node/pkc/pkc.js";

// Types for pubsub messages and errors
type PKCError = {
    code: string;
    details: { reason: string };
};

type ChallengeMessage = {
    extraProp?: unknown;
};

type ChallengeVerification = {
    challengeSuccess: boolean;
    reason?: string;
    publication?: unknown;
    comment?: unknown;
    commentUpdate?: unknown;
    extraProp?: unknown;
};

const mathCliCommunityAddress = signers[1].address;

// TODO make these tests work with RPC clients
getAvailablePKCConfigsToTestAgainst({ includeOnlyTheseTests: ["remote-kubo-rpc", "remote-libp2pjs"] }).map((config) => {
    describe.sequential(`Publishing  and receiving pubsub messages with extra props - ${config.name}`, async () => {
        let pkc: PKC;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        describe.sequential(`ChallengeRequest with extra props`, async () => {
            it(`A challenge request with an extra prop not included in signature.signedPropertyNames will get ignored`, async () => {
                const post = await generateMockPost({ communityAddress: signers[0].address, pkc: pkc });
                const extraProps = { extraProp: 1234 };
                await setExtraPropOnChallengeRequestAndSign({
                    publication: post,
                    extraProps,
                    includeExtraPropsInRequestSignedPropertyNames: false
                });
                let responseOfSub: unknown;
                let requestFromEvent: Record<string, unknown> | undefined;

                post.once("challengeverification", (request: unknown) => (responseOfSub = request));
                post.once("challengerequest", (request: Record<string, unknown>) => {
                    requestFromEvent = request;
                });

                await post.publish();

                expect(requestFromEvent!.extraProp).to.equal(extraProps.extraProp);

                // will get ignored because the signature of request is invalid, which means all peers on the network will validate that
                // No need to publish a challenge verification
                await new Promise((resolve) => setTimeout(resolve, 2000));
                expect(responseOfSub).to.be.undefined;
                await post.stop();
            });

            it(`Can publish a challenge request with extra prop, as long as extra props is part of request.signature.signedPropertyNames`, async () => {
                const post = await generateMockPost({ communityAddress: signers[0].address, pkc: pkc });
                const extraProps = { extraProp: 1234 };
                await setExtraPropOnChallengeRequestAndSign({
                    publication: post,
                    extraProps,
                    includeExtraPropsInRequestSignedPropertyNames: true
                });

                let requestFromEvent: Record<string, unknown> | undefined;

                post.once("challengerequest", (request: Record<string, unknown>) => (requestFromEvent = request));
                await post.publish();

                expect(requestFromEvent).to.be.a("object");
                expect(requestFromEvent!.extraProp).to.equal(extraProps.extraProp);

                // TODO need to test challenge request on the community side as well

                const challengeVerification = await new Promise((resolve) => post.once("challengeverification", resolve)); // we received a challenge verification, meaning there is no issue with challenge request

                expect(challengeVerification).to.be.a("object");
                await post.stop();
            });
        });

        describe.sequential(`ChallengeMessage with extra props`, async () => {
            // A message whose signature does not hold is not from the community, so it is logged and dropped: no "error"
            // event and no state change. Anyone on the topic can send one for a challengeRequestId they saw (#530)
            it(`A challenge message with an extra prop not included in signature.signedPropertyNames is dropped without an error`, async () => {
                const pubsubSigner = await pkc.createSigner();
                const post = await generateMockPost({ communityAddress: signers[0].address, pkc: pkc });

                post._getCommunityCache = (): ReturnType<typeof post._getCommunityCache> => ({
                    address: post.communityAddress,
                    publicKey: pubsubSigner.publicKey,
                    pubsubTopic: pubsubSigner.address,
                    encryption: {
                        type: "ed25519-aes-gcm",
                        publicKey: pubsubSigner.publicKey
                    }
                });
                const extraProps = { extraProp: 1234 };

                await post.publish();

                const errors: (PKCError | Error)[] = [];
                post.on("error", (error) => errors.push(error));
                const publishingStates: string[] = [];
                post.on("publishingstatechange", (state) => publishingStates.push(state));

                await publishChallengeMessageWithExtraProps({
                    publication: post,
                    pubsubSigner,
                    extraProps,
                    includeExtraPropsInChallengeSignedPropertyNames: false
                });
                // The valid challenge that follows shows the invalid one was handled and dropped
                const emittedChallenge = new Promise<ChallengeMessage>((resolve) =>
                    post.once("challenge", resolve as (msg: unknown) => void)
                );
                await publishChallengeMessageWithExtraProps({
                    publication: post,
                    pubsubSigner,
                    extraProps: {},
                    includeExtraPropsInChallengeSignedPropertyNames: false
                });

                expect((await emittedChallenge).extraProp).to.be.undefined;
                expect(errors).to.deep.equal([]);
                expect(publishingStates).to.not.include("failed");
                await post.stop();
            });

            it(`A challenge message with an extra prop included in signature.signedPropertyNames will be accepted`, async () => {
                const pubsubSigner = await pkc.createSigner();
                const post = await generateMockPost({ communityAddress: signers[0].address, pkc: pkc });

                post._getCommunityCache = (): ReturnType<typeof post._getCommunityCache> => ({
                    address: post.communityAddress,
                    publicKey: pubsubSigner.publicKey,
                    pubsubTopic: pubsubSigner.address,
                    encryption: {
                        type: "ed25519-aes-gcm",
                        publicKey: pubsubSigner.publicKey
                    }
                });
                const extraProps = { extraProp: 1234 };

                await post.publish();

                await publishChallengeMessageWithExtraProps({
                    publication: post,
                    pubsubSigner,
                    extraProps,
                    includeExtraPropsInChallengeSignedPropertyNames: true
                });

                const emittedChallenge = await new Promise<ChallengeMessage>((resolve) =>
                    post.once("challenge", resolve as (msg: unknown) => void)
                );

                expect(emittedChallenge.extraProp).to.equal(extraProps.extraProp);

                await post.stop();
            });
        });

        describe.sequential(`ChallengeAnswerMessage with extra props`, async () => {
            it(`A challenge answer message with an extra prop not included in signature.signedPropertyNames will get ignored`, async () => {
                const post = await generateMockPost({ communityAddress: mathCliCommunityAddress, pkc: pkc });
                await post.publish();

                await new Promise((resolve) => post.once("challenge", resolve));

                const extraProps = { extraProp: "1234" };
                await publishChallengeAnswerMessageWithExtraProps({
                    publication: post,
                    challengeAnswers: { "0": "2" },
                    extraProps,
                    includeExtraPropsInChallengeSignedPropertyNames: false
                });

                let challengeVerifcation;

                post.once("challengeverification", (_verif) => (challengeVerifcation = _verif));

                await new Promise((resolve) => setTimeout(resolve, pkc.publishInterval * 2));
                expect(challengeVerifcation).to.be.undefined; // should be ignored
                await post.stop();
            });

            it(`A challenge answer message with an extra prop included in signature.signedPropertyNames will be accepted`, async () => {
                const post = await generateMockPost({ communityAddress: mathCliCommunityAddress, pkc: pkc });
                await post.publish();

                await new Promise((resolve) => post.once("challenge", resolve));

                const extraProps = { extraProp: "1234" };
                await publishChallengeAnswerMessageWithExtraProps({
                    publication: post,
                    challengeAnswers: { "0": "2" },
                    extraProps,
                    includeExtraPropsInChallengeSignedPropertyNames: true
                });

                const challengeVerification = await new Promise<ChallengeVerification>((resolve) =>
                    post.once("challengeverification", resolve as (msg: unknown) => void)
                );
                expect(challengeVerification.challengeSuccess).to.be.true;
                expect(challengeVerification.reason).to.be.undefined;
                expect(challengeVerification.publication).to.be.undefined;
                expect(challengeVerification.comment).to.be.a("object");
                expect(challengeVerification.commentUpdate).to.be.a("object");

                await post.stop();
            });
        });

        describe.sequential(`ChallengeVerification with extra props`, async () => {
            it(`A challenge verification message with an extra prop not included in signature.signedPropertyNames is dropped without an error`, async () => {
                const pubsubSigner = await pkc.createSigner();
                const post = await generateMockPost({ communityAddress: signers[0].address, pkc: pkc });

                post._getCommunityCache = (): ReturnType<typeof post._getCommunityCache> => ({
                    address: post.communityAddress,
                    publicKey: pubsubSigner.publicKey,
                    pubsubTopic: pubsubSigner.address,
                    encryption: {
                        type: "ed25519-aes-gcm",
                        publicKey: pubsubSigner.publicKey
                    }
                });
                const extraProps = { extraProp: 1234 };

                await post.publish();

                const errors: (PKCError | Error)[] = [];
                post.on("error", (error) => errors.push(error));

                await publishChallengeVerificationMessageWithExtraProps({
                    publication: post,
                    pubsubSigner,
                    extraProps,
                    includeExtraPropsInChallengeSignedPropertyNames: false
                });
                // The valid verification that follows shows the invalid one was handled and dropped
                const emittedChallengeVerification = new Promise<ChallengeVerification>((resolve) =>
                    post.once("challengeverification", resolve as (msg: unknown) => void)
                );
                await publishChallengeVerificationMessageWithExtraProps({
                    publication: post,
                    pubsubSigner,
                    extraProps: {},
                    includeExtraPropsInChallengeSignedPropertyNames: false
                });

                expect((await emittedChallengeVerification).extraProp).to.be.undefined;
                // No assertion on publishingState here: the valid verification this helper sends is itself a failed
                // verdict. publication-state-machine.test.ts pins that the dropped message leaves the state alone
                expect(errors).to.deep.equal([]);
                await post.stop();
            });

            it(`A challenge verification message with an extra prop included in signature.signedPropertyNames will be accepted`, async () => {
                const pubsubSigner = await pkc.createSigner();
                const post = await generateMockPost({ communityAddress: signers[0].address, pkc: pkc });

                post._getCommunityCache = (): ReturnType<typeof post._getCommunityCache> => ({
                    address: post.communityAddress,
                    publicKey: pubsubSigner.publicKey,
                    pubsubTopic: pubsubSigner.address,
                    encryption: {
                        type: "ed25519-aes-gcm",
                        publicKey: pubsubSigner.publicKey
                    }
                });
                const extraProps = { extraProp: 1234 };

                await post.publish();

                await publishChallengeVerificationMessageWithExtraProps({
                    publication: post,
                    pubsubSigner,
                    extraProps,
                    includeExtraPropsInChallengeSignedPropertyNames: true
                });

                const emittedChallengeVerification = await new Promise<ChallengeVerification>((resolve) =>
                    post.once("challengeverification", resolve as (msg: unknown) => void)
                );

                expect(emittedChallengeVerification.extraProp).to.equal(extraProps.extraProp);

                await post.stop();
            });

            it(`A challenge verification message with extra prop in challengeVerification.encrypted will be accepted`, async () => {
                const pubsubSigner = await pkc.createSigner();
                const post = await generateMockPost({ communityAddress: signers[0].address, pkc: pkc });

                post._getCommunityCache = (): ReturnType<typeof post._getCommunityCache> => ({
                    address: post.communityAddress,
                    publicKey: pubsubSigner.publicKey,
                    pubsubTopic: pubsubSigner.address,
                    encryption: {
                        type: "ed25519-aes-gcm",
                        publicKey: pubsubSigner.publicKey
                    }
                });

                // Trigger deferred signing so pubsubMessageToPublish is populated before we compute the CID
                if (!post.raw.pubsubMessageToPublish) {
                    await post._initCommunity();
                    await post._signPublicationWithCommunityFields();
                }
                const mockCommentIpfs = { ...post.raw.pubsubMessageToPublish, depth: 0 };

                const commentUpdate = JSON.parse(JSON.stringify(validCommentUpdateFixture));
                commentUpdate.cid = await calculateIpfsHash(JSON.stringify(mockCommentIpfs));

                const extraPropsInEncrypted = { extraProp: 1234 };

                const log = Logger("pkc-js:test:backward-compat-pubsub");
                commentUpdate.signature = await _signJson(keys(omit(commentUpdate, ["signature"])), commentUpdate, pubsubSigner, log);

                await post.publish();

                await publishChallengeVerificationMessageWithEncryption(post, pubsubSigner, {
                    commentUpdate,
                    comment: mockCommentIpfs,
                    ...extraPropsInEncrypted
                });

                // verification.encrypted should decrypt to {comment, commentUpdate, extraProp}

                const challengeVerification = await new Promise<ChallengeVerification>((resolve) =>
                    post.once("challengeverification", resolve as (msg: unknown) => void)
                );

                await post.stop();
                expect(challengeVerification.extraProp).to.equal(extraPropsInEncrypted.extraProp);
            });
        });
    });
});

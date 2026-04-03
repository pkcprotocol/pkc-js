import signers from "../../../fixtures/signers.js";
import {
    getAvailablePlebbitConfigsToTestAgainst,
    addStringToIpfs,
    resolveWhenConditionIsTrue,
    publishRandomPost,
    generateMockPost,
    publishChallengeVerificationMessageWithEncryption,
    mockPostToReturnSpecificCommentUpdate,
    itSkipIfRpc,
    isPlebbitFetchingUsingGateways
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { _signJson } from "../../../../dist/node/signer/signatures.js";
import validCommentUpdateFixture from "../../../fixtures/signatures/comment/commentUpdate/valid_comment_update.json" with { type: "json" };
import * as remeda from "remeda";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { describe, it, beforeAll, afterAll } from "vitest";
import Logger from "@pkc/pkc-logger";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { RemoteSubplebbit } from "../../../../dist/node/subplebbit/remote-subplebbit.js";
import type { PlebbitError } from "../../../../dist/node/plebbit-error.js";

const log = Logger("pkc-js:test:backward-compatibility-commentupdate");

type CommentWithExtraProp = Comment & { extraPropUpdate?: string };
type AuthorWithExtraProp = { extraPropUpdate?: string };
type ChallengeVerificationWithExtraProp = { commentUpdate?: { extraProp?: number; author?: { extraProp?: number } } };

const subplebbitAddress = signers[0].address;

const subWithNoResponseSigner = signers[4]; // this sub will never respond via pubsub

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe(`Loading CommentUpdate with extra prop - ${config.name}`, async () => {
        let plebbit: Plebbit;
        let post: Comment;
        let subplebbit: RemoteSubplebbit;
        const extraProps = { extraPropUpdate: "1234" };

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
            subplebbit = await plebbit.getSubplebbit({ address: subplebbitAddress });

            post = await publishRandomPost({ communityAddress: subplebbit.address, plebbit: plebbit });
            await post.update();
            await resolveWhenConditionIsTrue({ toUpdate: post, predicate: async () => typeof post.updatedAt === "number" });
            await post.stop();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        itSkipIfRpc(`Loading CommentUpdate whose extra props are not in signedPropertyNames should throw`, async () => {
            const invalidCommentUpdate = remeda.clone(post.raw.commentUpdate);
            Object.assign(invalidCommentUpdate, extraProps);

            const postToUpdate = await plebbit.getComment({ cid: post.cid });
            let updateEmitted = false;
            const errorPromise = new Promise((resolve) => postToUpdate.once("error", resolve));

            // should emit an error because we did not include extraProp in signedPropertyNames

            await postToUpdate.update();
            postToUpdate.once("update", () => (updateEmitted = true));
            mockPostToReturnSpecificCommentUpdate(postToUpdate, JSON.stringify(invalidCommentUpdate));

            const error = (await errorPromise) as PlebbitError;

            await postToUpdate.stop();

            expect(updateEmitted).to.be.false;

            expect(postToUpdate.updatedAt).to.be.undefined; // should not accept the comment update

            if (!isPlebbitFetchingUsingGateways(plebbit)) {
                expect(error.code).to.equal("ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID");
                expect(error.details.signatureValidity).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_COMMENT_UPDATE_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
                });
            } else {
                // gateways
                expect(error.code).to.equal("ERR_FAILED_TO_FETCH_COMMENT_UPDATE_FROM_GATEWAYS");
                expect((error.details.gatewayToError as Record<string, PlebbitError>)["http://localhost:18080"].code).to.equal(
                    "ERR_COMMENT_UPDATE_SIGNATURE_IS_INVALID"
                );
                expect(
                    (error.details.gatewayToError as Record<string, PlebbitError>)["http://localhost:18080"].details.signatureValidity
                ).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_COMMENT_UPDATE_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
                });
            }
        });
        itSkipIfRpc(`Can load CommentUpdate with extra props if they're included in signedPropertyNames`, async () => {
            const commentUpdateWithExtraProps = remeda.clone(post.raw.commentUpdate);
            Object.assign(commentUpdateWithExtraProps, extraProps);

            commentUpdateWithExtraProps.signature = await _signJson(
                [...commentUpdateWithExtraProps.signature.signedPropertyNames, ...Object.keys(extraProps)],
                commentUpdateWithExtraProps,
                signers[0],
                log
            );

            const postToUpdate = await plebbit.getComment({ cid: post.cid });

            await postToUpdate.update();
            mockPostToReturnSpecificCommentUpdate(postToUpdate, JSON.stringify(commentUpdateWithExtraProps));

            await resolveWhenConditionIsTrue({ toUpdate: postToUpdate, predicate: async () => typeof postToUpdate.updatedAt === "number" });

            await postToUpdate.stop();

            expect(postToUpdate.updatedAt).to.be.be.a("number"); // should accept the comment update with extra props

            // should accept the comment update because the extra prop is part of signedPropertyNames

            const shapes = [
                postToUpdate,
                postToUpdate.raw.commentUpdate,
                await plebbit.createComment(postToUpdate),
                await plebbit.createComment(JSON.parse(JSON.stringify(postToUpdate)))
            ];

            for (const shape of shapes) expect((shape as CommentWithExtraProp).extraPropUpdate).to.equal(extraProps.extraPropUpdate);
        });

        itSkipIfRpc(`Can load CommentUpdate with extra props in commentUpdate.author`, async () => {
            const commentUpdateWithExtraProps = remeda.clone(post.raw.commentUpdate);
            Object.assign(commentUpdateWithExtraProps.author, extraProps);

            commentUpdateWithExtraProps.signature = await _signJson(
                commentUpdateWithExtraProps.signature.signedPropertyNames,
                commentUpdateWithExtraProps,
                signers[0],
                log
            );

            const postToUpdate = await plebbit.getComment({ cid: post.cid });

            await postToUpdate.update();
            mockPostToReturnSpecificCommentUpdate(postToUpdate, JSON.stringify(commentUpdateWithExtraProps));

            await resolveWhenConditionIsTrue({ toUpdate: postToUpdate, predicate: async () => typeof postToUpdate.updatedAt === "number" });

            await postToUpdate.stop();

            expect(postToUpdate.updatedAt).to.be.be.a("number"); // should accept the comment update with extra props

            const shapes = [
                postToUpdate,
                postToUpdate.raw.commentUpdate,
                await plebbit.createComment(postToUpdate),
                await plebbit.createComment(JSON.parse(JSON.stringify(postToUpdate)))
            ];

            for (const commentShape of shapes)
                expect((commentShape.author as AuthorWithExtraProp).extraPropUpdate).to.equal(extraProps.extraPropUpdate);
        });

        itSkipIfRpc(`Can load pages with CommentUpdate that has extra props in them`, async () => {
            const commentUpdateWithExtraProps = JSON.parse(JSON.stringify(post.raw.commentUpdate));
            Object.assign(commentUpdateWithExtraProps, extraProps);

            commentUpdateWithExtraProps.signature = await _signJson(
                [...commentUpdateWithExtraProps.signature.signedPropertyNames, ...Object.keys(extraProps)],
                commentUpdateWithExtraProps,
                signers[0],
                log
            );

            const pageIpfs = subplebbit.raw.subplebbitIpfs.posts.pages.hot;

            pageIpfs.comments.push({
                comment: post.raw.comment,
                commentUpdate: commentUpdateWithExtraProps
            });

            const pageIpfsCid = await addStringToIpfs(JSON.stringify(pageIpfs));

            subplebbit.posts.pageCids.new = pageIpfsCid; // just so that it wouldn't throw

            const fetchedPage = await subplebbit.posts.getPage({ cid: pageIpfsCid }); // If this succeeds, it means signature has been verified and everything

            const commentInPageJson = fetchedPage.comments[fetchedPage.comments.length - 1];

            const shapes = [
                commentInPageJson,
                JSON.parse(JSON.stringify(commentInPageJson)),
                await plebbit.createComment(commentInPageJson),
                await plebbit.createComment(await plebbit.createComment(commentInPageJson))
            ];
            for (const shape of shapes) expect((shape as CommentWithExtraProp).extraPropUpdate).to.equal(extraProps.extraPropUpdate);
        });

        itSkipIfRpc(`Can load pages with CommentUpdate that has extra props in commentUpdate.author`, async () => {
            const commentUpdateWithExtraProps = JSON.parse(JSON.stringify(post.raw.commentUpdate));
            Object.assign(commentUpdateWithExtraProps.author, extraProps);

            commentUpdateWithExtraProps.signature = await _signJson(
                commentUpdateWithExtraProps.signature.signedPropertyNames,
                commentUpdateWithExtraProps,
                signers[0],
                log
            );

            const pageIpfs = JSON.parse(await plebbit.fetchCid({ cid: subplebbit.posts.pageCids.new }));

            pageIpfs.comments.push({
                comment: post.raw.comment,
                commentUpdate: commentUpdateWithExtraProps
            });

            const pageIpfsCid = await addStringToIpfs(JSON.stringify(pageIpfs));
            subplebbit.posts.pageCids.new = pageIpfsCid; // just so that it wouldn't throw

            const fetchedPage = await subplebbit.posts.getPage({ cid: pageIpfsCid }); // If this succeeds, it means signature has been verified and everything

            const commentInPageJson = fetchedPage.comments[fetchedPage.comments.length - 1];

            const shapes = [
                commentInPageJson,
                JSON.parse(JSON.stringify(commentInPageJson)),
                await plebbit.createComment(commentInPageJson),
                await plebbit.createComment(await plebbit.createComment(commentInPageJson))
            ];
            for (const shape of shapes) expect((shape.author as AuthorWithExtraProp).extraPropUpdate).to.equal(extraProps.extraPropUpdate);
        });
    });

    describe.concurrent(`Extra props in decryptedChallengeVerification.commentUpdate - ${config.name}`, async () => {
        let plebbit: Plebbit;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`Extra props in decryptedVerification.commentUpdate should fail if they're not part of commentUpdate.signature.signedPropertyNames`, async () => {
            const post = await generateMockPost({ communityAddress: subWithNoResponseSigner.address, plebbit: plebbit });

            const commentUpdate = JSON.parse(JSON.stringify(validCommentUpdateFixture));
            const extraProps = { extraProp: 1234 };

            Object.assign(commentUpdate, extraProps);

            const errorPromise = new Promise((resolve) => post.once("error", resolve));

            const challengeRequestPromise = new Promise((resolve) => post.once("challengerequest", resolve));
            await post.publish();
            await challengeRequestPromise;

            await publishChallengeVerificationMessageWithEncryption(post, subWithNoResponseSigner, {
                commentUpdate,
                comment: { ...post.raw.pubsubMessageToPublish, depth: 0 }
            });

            const error = (await errorPromise) as PlebbitError;

            expect(error.code).to.equal("ERR_SUB_SENT_CHALLENGE_VERIFICATION_WITH_INVALID_COMMENTUPDATE");
            expect(error.details.reason).to.equal(messages["ERR_COMMENT_UPDATE_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES"]);
            await post.stop();
        });
        it(`Extra props in decryptedVerification.commentUpdate should be accepted if they're part of commentUpdate.signature.signedPropertyNames`, async () => {
            const post = await generateMockPost({ communityAddress: subWithNoResponseSigner.address, plebbit: plebbit });

            const challengeRequestPromise = new Promise((resolve) => post.once("challengerequest", resolve));
            await post.publish();
            await challengeRequestPromise;

            const mockCommentIpfs = { ...post.raw.pubsubMessageToPublish, depth: 0 };

            const commentUpdate = JSON.parse(JSON.stringify(validCommentUpdateFixture));
            commentUpdate.cid = await calculateIpfsHash(JSON.stringify(mockCommentIpfs));

            const extraProps = { extraProp: 1234 };

            Object.assign(commentUpdate, extraProps);

            commentUpdate.signature = await _signJson(
                remeda.keys.strict(remeda.omit(commentUpdate, ["signature"])),
                commentUpdate,
                subWithNoResponseSigner,
                log
            );

            const verificationPromise = new Promise((resolve) => post.once("challengeverification", resolve));

            await publishChallengeVerificationMessageWithEncryption(post, subWithNoResponseSigner, {
                commentUpdate,
                comment: mockCommentIpfs
            });

            const challengeVerification = (await verificationPromise) as ChallengeVerificationWithExtraProp;
            await post.stop();
            expect(challengeVerification.commentUpdate?.extraProp).to.equal(extraProps.extraProp);

            expect((post as Comment & { extraProp?: number }).extraProp).to.equal(extraProps.extraProp);
        });

        it(`Extra props in decryptedVerification.commentUpdate.author should be accepted`, async () => {
            const post = await generateMockPost({ communityAddress: subWithNoResponseSigner.address, plebbit: plebbit });

            const challengeRequestPromise = new Promise((resolve) => post.once("challengerequest", resolve));
            await post.publish();
            await challengeRequestPromise;

            const mockCommentIpfs = { ...post.raw.pubsubMessageToPublish, depth: 0 };

            const commentUpdate = JSON.parse(JSON.stringify(validCommentUpdateFixture));
            commentUpdate.cid = await calculateIpfsHash(JSON.stringify(mockCommentIpfs));

            const extraProps = { extraProp: 1234 };

            Object.assign(commentUpdate.author, extraProps);

            commentUpdate.signature = await _signJson(
                remeda.keys.strict(remeda.omit(commentUpdate, ["signature"])),
                commentUpdate,
                subWithNoResponseSigner,
                log
            );

            const verificationPromise = new Promise((resolve) => post.once("challengeverification", resolve));

            await publishChallengeVerificationMessageWithEncryption(post, subWithNoResponseSigner, {
                commentUpdate,
                comment: mockCommentIpfs
            });

            const challengeVerification = (await verificationPromise) as ChallengeVerificationWithExtraProp;
            await post.stop();
            expect(challengeVerification.commentUpdate?.author?.extraProp).to.equal(extraProps.extraProp);

            expect((post.author as { extraProp?: number }).extraProp).to.equal(extraProps.extraProp);
        });
    });
});

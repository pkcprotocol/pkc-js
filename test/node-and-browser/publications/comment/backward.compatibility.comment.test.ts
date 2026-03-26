import signers from "../../../fixtures/signers.js";
import {
    generateMockPost,
    setExtraPropOnCommentAndSign,
    getAvailablePlebbitConfigsToTestAgainst,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    iterateThroughPagesToFindCommentInParentPagesInstance,
    waitTillPostInSubplebbitPages,
    addStringToIpfs
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { _signJson } from "../../../../dist/node/signer/signatures.js";
import { getPlebbitAddressFromPublicKeySync } from "../../../../dist/node/signer/util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import validPageIpfsFixture from "../../../fixtures/valid_page.json" with { type: "json" };
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentWithinRepliesPostsPageJson } from "../../../../dist/node/publications/comment/types.js";

type CommentWithExtraProp = Comment & { extraProp?: string };
type AuthorWithExtraProp = { extraProp?: string };
type LegacyRawAuthor = { address?: string; name?: string; publicKey?: string };

const subplebbitAddress = signers[0].address;

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe.sequential(`Comments with extra props - ${config.name}`, async () => {
        let plebbit: Plebbit;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });
        afterAll(async () => {
            await plebbit.destroy();
        });

        describe(`Comments with extra props in challengeRequest.encrypted - ${config.name}`, async () => {
            it(`An extra prop in challengeRequest.encrypted should be accepted by the sub`, async () => {
                const comment = await generateMockPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
                (comment as Comment & { challengeRequest: { extraProp: string } }).challengeRequest = { extraProp: "1234" };
                const challengeRequestPromise = new Promise((resolve) => comment.once("challengerequest", resolve));

                await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });
                const challengeRequest = (await challengeRequestPromise) as { extraProp?: string };
                expect(challengeRequest.extraProp).to.equal("1234");
            });
        });

        describe.sequential(`Publishing comments with extra props - ${config.name}`, async () => {
            it(`A CommentPubsub with a field not included in signature.signedPropertyNames will be rejected`, async () => {
                // Skip for rpc because it's gonna throw due to invalid signature
                const post = await generateMockPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
                const extraProps = { extraProp: "1234" };
                await setExtraPropOnCommentAndSign(post, extraProps, false);

                const challengeRequestPromise = new Promise((resolve) => post.once("challengerequest", resolve));
                await publishWithExpectedResult({
                    publication: post,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_COMMENT_PUBSUB_RECORD_INCLUDES_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
                });
                const challengeRequest = (await challengeRequestPromise) as { comment?: { extraProp?: string } };
                expect(challengeRequest.comment?.extraProp).to.equal(extraProps.extraProp);
            });

            it(`A CommentPubsub with an extra field as a reserved field name will be rejected`, async () => {
                const post = await generateMockPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
                const extraProps = { cid: "1234" };
                await setExtraPropOnCommentAndSign(post, extraProps, true);

                const challengeRequestPromise = new Promise((resolve) => post.once("challengerequest", resolve));

                await publishWithExpectedResult({
                    publication: post,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_COMMENT_HAS_RESERVED_FIELD
                });
                const challengeRequest = (await challengeRequestPromise) as { comment?: { cid?: string } };
                expect(challengeRequest.comment?.cid).to.equal(extraProps.cid);
            });

            it(`A CommentPubsub with an extra field included in signature.signedPropertyNames will be accepted`, async () => {
                const post = await generateMockPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
                const extraProps = { extraProp: "1234" };
                await setExtraPropOnCommentAndSign(post, extraProps, true);

                const challengeVerificationPromise = new Promise((resolve) => post.once("challengeverification", resolve));

                const challengeRequestPromise = new Promise((resolve) => post.once("challengerequest", resolve));

                await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
                const challengeRequest = (await challengeRequestPromise) as { comment?: { extraProp?: string } };
                expect(challengeRequest.comment?.extraProp).to.equal(extraProps.extraProp);
                const challengeVerification = (await challengeVerificationPromise) as { comment?: { extraProp?: string } };
                expect(challengeVerification.comment?.extraProp).to.equal(extraProps.extraProp);
                expect((post as CommentWithExtraProp).extraProp).to.equal(extraProps.extraProp);
            });
        });

        describe.sequential(`Loading comments with extra prop`, async () => {
            let commentWithExtraProps: Comment;
            let extraProps: { extraProp: string };

            beforeAll(async () => {
                commentWithExtraProps = await generateMockPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
                extraProps = { extraProp: "1234" };
                await setExtraPropOnCommentAndSign(commentWithExtraProps, extraProps, true);
                await publishWithExpectedResult({ publication: commentWithExtraProps, expectedChallengeSuccess: true });
                await waitTillPostInSubplebbitPages(commentWithExtraProps as Parameters<typeof waitTillPostInSubplebbitPages>[0], plebbit);
            });
            it(`Can load CommentIpfs with extra props`, async () => {
                const loadedCommentWithExtraProps = await plebbit.getComment({ cid: commentWithExtraProps.cid });

                // we wanna make sure the extra prop exists on all shapes
                const shapes = [
                    loadedCommentWithExtraProps.raw.comment,
                    loadedCommentWithExtraProps,
                    JSON.parse(JSON.stringify(loadedCommentWithExtraProps)),
                    await plebbit.createComment(loadedCommentWithExtraProps),
                    await plebbit.createComment(JSON.parse(JSON.stringify(loadedCommentWithExtraProps)))
                ];

                for (const shape of shapes) expect((shape as CommentWithExtraProp).extraProp).to.equal(extraProps.extraProp);
            });

            it(`Can load pages with comments that has extra props in them`, async () => {
                const subplebbit = await plebbit.createSubplebbit({ address: commentWithExtraProps.communityAddress });
                await subplebbit.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: subplebbit,
                    predicate: async () => {
                        const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(
                            commentWithExtraProps.cid!,
                            subplebbit.posts
                        );
                        return (commentInPage as CommentWithExtraProp | undefined)?.extraProp === extraProps.extraProp;
                    }
                });

                const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(
                    commentWithExtraProps.cid!,
                    subplebbit.posts
                );

                const shapes = [
                    JSON.parse(JSON.stringify(commentInPage)),
                    await plebbit.createComment(commentInPage!),
                    await plebbit.createComment(await plebbit.createComment(commentInPage!))
                ];

                for (const shape of shapes) expect((shape as CommentWithExtraProp).extraProp).to.equal(extraProps.extraProp);
                await subplebbit.stop();
            });
        });
    });

    describe.sequential(`Comments with extra props in author`, async () => {
        let plebbit: Plebbit;
        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });
        afterAll(async () => {
            await plebbit.destroy();
        });
        describe.sequential(`Publishing comment with extra props in author field - ${config.name}`, async () => {
            it(`Publishing with extra prop for author should fail if it's a reserved field`, async () => {
                const post = await generateMockPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
                await setExtraPropOnCommentAndSign(
                    post,
                    { author: { ...post.raw.pubsubMessageToPublish.author, subplebbit: "random" } },
                    true
                );

                const challengeRequestPromise = new Promise((resolve) => post.once("challengerequest", resolve));

                await publishWithExpectedResult({
                    publication: post,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_PUBLICATION_AUTHOR_HAS_RESERVED_FIELD
                });
                const challengeRequest = (await challengeRequestPromise) as { comment?: { author?: { subplebbit?: string } } };
                expect(challengeRequest.comment?.author?.subplebbit).to.equal("random");
            });
            it(`Publishing with extra prop for author should succeed`, async () => {
                const post = await generateMockPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
                const extraProps = { extraProp: "1234" };
                await setExtraPropOnCommentAndSign(post, { author: { ...post.raw.pubsubMessageToPublish.author, ...extraProps } }, true);

                const challengeRequestPromise = new Promise((resolve) => post.once("challengerequest", resolve));

                await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
                const challengeRequest = (await challengeRequestPromise) as { comment?: { author?: { extraProp?: string } } };
                expect(challengeRequest.comment?.author?.extraProp).to.equal(extraProps.extraProp);
                expect((post.author as AuthorWithExtraProp).extraProp).to.equal(extraProps.extraProp);
            });
        });

        describe.sequential(`Loading a comment with author.extraProp - ${config.name}`, async () => {
            let postWithExtraAuthorProp: Comment;
            const extraProps = { extraProp: "1234" };

            beforeAll(async () => {
                postWithExtraAuthorProp = await generateMockPost({ communityAddress: subplebbitAddress, plebbit: plebbit });
                await setExtraPropOnCommentAndSign(
                    postWithExtraAuthorProp,
                    { author: { ...postWithExtraAuthorProp.raw.pubsubMessageToPublish.author, ...extraProps } },
                    true
                );

                await publishWithExpectedResult({ publication: postWithExtraAuthorProp, expectedChallengeSuccess: true });
            });
            it.sequential(`Can load a CommentIpfs with author.extraProp`, async () => {
                const loadedPost = await plebbit.getComment({ cid: postWithExtraAuthorProp.cid });

                const loadedPostFromCreate = await plebbit.createComment({ cid: postWithExtraAuthorProp.cid });
                await loadedPostFromCreate.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: loadedPostFromCreate,
                    predicate: async () => typeof loadedPostFromCreate.updatedAt === "number"
                });
                await loadedPostFromCreate.stop();

                const shapes = [
                    loadedPost,
                    JSON.parse(JSON.stringify(loadedPost)),
                    await plebbit.createComment(loadedPost),
                    await plebbit.createComment(JSON.parse(JSON.stringify(loadedPost))),
                    loadedPostFromCreate,
                    JSON.parse(JSON.stringify(loadedPostFromCreate)),
                    await plebbit.createComment(loadedPostFromCreate),
                    await plebbit.createComment(JSON.parse(JSON.stringify(loadedPostFromCreate)))
                ];

                for (const shape of shapes) expect((shape.author as AuthorWithExtraProp).extraProp).to.equal(extraProps.extraProp);
            });
            it(`Can load a page with comment.author.extraProp`, async () => {
                await waitTillPostInSubplebbitPages(
                    postWithExtraAuthorProp as Parameters<typeof waitTillPostInSubplebbitPages>[0],
                    plebbit
                );

                const subplebbit = await plebbit.createSubplebbit({ address: postWithExtraAuthorProp.communityAddress });
                await subplebbit.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: subplebbit,
                    predicate: async () => {
                        const postInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(
                            postWithExtraAuthorProp.cid!,
                            subplebbit.posts
                        );
                        return (postInPage?.author as AuthorWithExtraProp | undefined)?.extraProp === extraProps.extraProp;
                    }
                });
                const postInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(
                    postWithExtraAuthorProp.cid!,
                    subplebbit.posts
                );
                // postInPage is the json representation of page.comments

                const shapes = [postInPage, await plebbit.createComment(postInPage!)];

                for (const shape of shapes) expect((shape!.author as AuthorWithExtraProp).extraProp).to.equal(extraProps.extraProp);
                await subplebbit.stop();
            });
        });
    });

    describe.sequential(`Loading legacy pages with old author.address wire field - ${config.name}`, async () => {
        let plebbit: Plebbit;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        it(`loads a legacy page and computes runtime author fields without rewriting raw wire author`, async () => {
            const pageCid = await addStringToIpfs(JSON.stringify(validPageIpfsFixture));
            const subplebbit = await plebbit.getSubplebbit({ address: subplebbitAddress });
            const loadedPage = await subplebbit.posts.getPage({ cid: pageCid });

            const legacyDomainComment = loadedPage.comments.find(
                (comment) =>
                    typeof (comment.raw.comment.author as LegacyRawAuthor | undefined)?.address === "string" &&
                    (comment.raw.comment.author as LegacyRawAuthor).address!.includes(".")
            ) as CommentWithinRepliesPostsPageJson | undefined;
            const legacyBase58Comment = loadedPage.comments.find(
                (comment) =>
                    typeof (comment.raw.comment.author as LegacyRawAuthor | undefined)?.address === "string" &&
                    !(comment.raw.comment.author as LegacyRawAuthor).address!.includes(".")
            ) as CommentWithinRepliesPostsPageJson | undefined;

            expect(legacyDomainComment).to.exist;
            expect(legacyBase58Comment).to.exist;

            const expectedDomainPublicKey = getPlebbitAddressFromPublicKeySync(legacyDomainComment!.raw.comment.signature.publicKey);
            expect(legacyDomainComment!.author.publicKey).to.equal(expectedDomainPublicKey);
            expect(legacyDomainComment!.author.name).to.equal("plebbit.eth");
            expect(legacyDomainComment!.author.address).to.equal("plebbit.eth");
            expect((legacyDomainComment!.raw.comment.author as LegacyRawAuthor).address).to.equal("plebbit.eth");
            expect((legacyDomainComment!.raw.comment.author as LegacyRawAuthor).name).to.be.undefined;
            expect((legacyDomainComment!.raw.comment.author as LegacyRawAuthor).publicKey).to.be.undefined;

            const expectedBase58PublicKey = getPlebbitAddressFromPublicKeySync(legacyBase58Comment!.raw.comment.signature.publicKey);
            expect(legacyBase58Comment!.author.publicKey).to.equal(expectedBase58PublicKey);
            expect(legacyBase58Comment!.author.name).to.be.undefined;
            expect(legacyBase58Comment!.author.address).to.equal(expectedBase58PublicKey);
            expect((legacyBase58Comment!.raw.comment.author as LegacyRawAuthor).address).to.equal(expectedBase58PublicKey);
            expect((legacyBase58Comment!.raw.comment.author as LegacyRawAuthor).name).to.be.undefined;
            expect((legacyBase58Comment!.raw.comment.author as LegacyRawAuthor).publicKey).to.be.undefined;
        });
    });
});

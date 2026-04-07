import signers from "../../../fixtures/signers.js";
import {
    generateMockPost,
    setExtraPropOnCommentAndSign,
    getAvailablePKCConfigsToTestAgainst,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    iterateThroughPagesToFindCommentInParentPagesInstance,
    waitTillPostInCommunityPages,
    addStringToIpfs,
    isPKCFetchingUsingGateways
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { _signJson } from "../../../../dist/node/signer/signatures.js";
import { getPKCAddressFromPublicKeySync } from "../../../../dist/node/signer/util.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import validPageIpfsFixture from "../../../fixtures/valid_page.json" with { type: "json" };
import type { PKC } from "../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { CommentWithinRepliesPostsPageJson } from "../../../../dist/node/publications/comment/types.js";
import type { PKCError } from "../../../../dist/node/pkc-error.js";

type CommentWithExtraProp = Comment & { extraProp?: string };
type AuthorWithExtraProp = { extraProp?: string };

const communityAddress = signers[0].address;

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.sequential(`Comments with extra props - ${config.name}`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });
        afterAll(async () => {
            await pkc.destroy();
        });

        describe(`Comments with extra props in challengeRequest.encrypted - ${config.name}`, async () => {
            it(`An extra prop in challengeRequest.encrypted should be accepted by the sub`, async () => {
                const comment = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
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
                const post = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
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
                const post = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
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
                const post = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
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
                commentWithExtraProps = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
                extraProps = { extraProp: "1234" };
                await setExtraPropOnCommentAndSign(commentWithExtraProps, extraProps, true);
                await publishWithExpectedResult({ publication: commentWithExtraProps, expectedChallengeSuccess: true });
                await waitTillPostInCommunityPages(commentWithExtraProps as Parameters<typeof waitTillPostInCommunityPages>[0], pkc);
            });
            it(`Can load CommentIpfs with extra props`, async () => {
                const loadedCommentWithExtraProps = await pkc.getComment({ cid: commentWithExtraProps.cid });

                // we wanna make sure the extra prop exists on all shapes
                const shapes = [
                    loadedCommentWithExtraProps.raw.comment,
                    loadedCommentWithExtraProps,
                    JSON.parse(JSON.stringify(loadedCommentWithExtraProps)),
                    await pkc.createComment(loadedCommentWithExtraProps),
                    await pkc.createComment(JSON.parse(JSON.stringify(loadedCommentWithExtraProps)))
                ];

                for (const shape of shapes) expect((shape as CommentWithExtraProp).extraProp).to.equal(extraProps.extraProp);
            });

            it(`Can load pages with comments that has extra props in them`, async () => {
                const community = await pkc.createCommunity({ address: commentWithExtraProps.communityAddress });
                await community.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => {
                        const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(
                            commentWithExtraProps.cid!,
                            community.posts
                        );
                        return (commentInPage as CommentWithExtraProp | undefined)?.extraProp === extraProps.extraProp;
                    }
                });

                const commentInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(
                    commentWithExtraProps.cid!,
                    community.posts
                );

                const shapes = [
                    JSON.parse(JSON.stringify(commentInPage)),
                    await pkc.createComment(commentInPage!),
                    await pkc.createComment(await pkc.createComment(commentInPage!))
                ];

                for (const shape of shapes) expect((shape as CommentWithExtraProp).extraProp).to.equal(extraProps.extraProp);
                await community.stop();
            });
        });
    });

    describe.sequential(`Comments with extra props in author`, async () => {
        let pkc: PKC;
        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });
        afterAll(async () => {
            await pkc.destroy();
        });
        describe.sequential(`Publishing comment with extra props in author field - ${config.name}`, async () => {
            it(`Publishing with extra prop for author should fail if it's a reserved field`, async () => {
                const post = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
                await setExtraPropOnCommentAndSign(
                    post,
                    {
                        author: {
                            ...(post.raw.pubsubMessageToPublish?.author ?? (post.raw as any).unsignedPublicationOptions?.author),
                            community: "random"
                        }
                    },
                    true
                );

                const challengeRequestPromise = new Promise((resolve) => post.once("challengerequest", resolve));

                await publishWithExpectedResult({
                    publication: post,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_PUBLICATION_AUTHOR_HAS_RESERVED_FIELD
                });
                const challengeRequest = (await challengeRequestPromise) as { comment?: { author?: { community?: string } } };
                expect(challengeRequest.comment?.author?.community).to.equal("random");
            });
            it(`Publishing with extra prop for author should succeed`, async () => {
                const post = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
                const extraProps = { extraProp: "1234" };
                await setExtraPropOnCommentAndSign(
                    post,
                    {
                        author: {
                            ...(post.raw.pubsubMessageToPublish?.author ?? (post.raw as any).unsignedPublicationOptions?.author),
                            ...extraProps
                        }
                    },
                    true
                );

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
                postWithExtraAuthorProp = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
                await setExtraPropOnCommentAndSign(
                    postWithExtraAuthorProp,
                    {
                        author: {
                            ...(postWithExtraAuthorProp.raw.pubsubMessageToPublish?.author ??
                                (postWithExtraAuthorProp.raw as any).unsignedPublicationOptions?.author),
                            ...extraProps
                        }
                    },
                    true
                );

                await publishWithExpectedResult({ publication: postWithExtraAuthorProp, expectedChallengeSuccess: true });
            });
            it.sequential(`Can load a CommentIpfs with author.extraProp`, async () => {
                const loadedPost = await pkc.getComment({ cid: postWithExtraAuthorProp.cid });

                const loadedPostFromCreate = await pkc.createComment({ cid: postWithExtraAuthorProp.cid });
                await loadedPostFromCreate.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: loadedPostFromCreate,
                    predicate: async () => typeof loadedPostFromCreate.updatedAt === "number"
                });
                await loadedPostFromCreate.stop();

                const shapes = [
                    loadedPost,
                    JSON.parse(JSON.stringify(loadedPost)),
                    await pkc.createComment(loadedPost),
                    await pkc.createComment(JSON.parse(JSON.stringify(loadedPost))),
                    loadedPostFromCreate,
                    JSON.parse(JSON.stringify(loadedPostFromCreate)),
                    await pkc.createComment(loadedPostFromCreate),
                    await pkc.createComment(JSON.parse(JSON.stringify(loadedPostFromCreate)))
                ];

                for (const shape of shapes) expect((shape.author as AuthorWithExtraProp).extraProp).to.equal(extraProps.extraProp);
            });
            it(`Can load a page with comment.author.extraProp`, async () => {
                await waitTillPostInCommunityPages(postWithExtraAuthorProp as Parameters<typeof waitTillPostInCommunityPages>[0], pkc);

                const community = await pkc.createCommunity({ address: postWithExtraAuthorProp.communityAddress });
                await community.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: community,
                    predicate: async () => {
                        const postInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(
                            postWithExtraAuthorProp.cid!,
                            community.posts
                        );
                        return (postInPage?.author as AuthorWithExtraProp | undefined)?.extraProp === extraProps.extraProp;
                    }
                });
                const postInPage = await iterateThroughPagesToFindCommentInParentPagesInstance(
                    postWithExtraAuthorProp.cid!,
                    community.posts
                );
                // postInPage is the json representation of page.comments

                const shapes = [postInPage, await pkc.createComment(postInPage!)];

                for (const shape of shapes) expect((shape!.author as AuthorWithExtraProp).extraProp).to.equal(extraProps.extraProp);
                await community.stop();
            });
        });
    });

    describe.sequential(`Loading legacy pages with old author.address wire field - ${config.name}`, async () => {
        let pkc: PKC;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`loads a page and correctly derives runtime author fields from wire format`, async () => {
            const pageCid = await addStringToIpfs(JSON.stringify(validPageIpfsFixture));
            const community = await pkc.getCommunity({ address: communityAddress });
            const loadedPage = await community.posts.getPage({ cid: pageCid });

            // Find a domain author comment (author.name on wire)
            const domainComment = loadedPage.comments.find((comment) => typeof comment.raw.comment.author?.name === "string") as
                | CommentWithinRepliesPostsPageJson
                | undefined;
            // Find a non-domain comment (no author.name on wire)
            const base58Comment = loadedPage.comments.find((comment) => !comment.raw.comment.author?.name) as
                | CommentWithinRepliesPostsPageJson
                | undefined;

            expect(domainComment).to.exist;
            expect(base58Comment).to.exist;

            // Domain author: runtime address = domain name, publicKey derived from signature
            const expectedDomainPublicKey = getPKCAddressFromPublicKeySync(domainComment!.raw.comment.signature.publicKey);
            expect(domainComment!.author.publicKey).to.equal(expectedDomainPublicKey);
            expect(domainComment!.author.name).to.equal("plebbit.bso");
            expect(domainComment!.author.address).to.equal("plebbit.bso");

            // Base58 author: runtime address = derived B58 address from signature
            const expectedBase58PublicKey = getPKCAddressFromPublicKeySync(base58Comment!.raw.comment.signature.publicKey);
            expect(base58Comment!.author.publicKey).to.equal(expectedBase58PublicKey);
            expect(base58Comment!.author.name).to.be.undefined;
            expect(base58Comment!.author.address).to.equal(expectedBase58PublicKey);
        });
    });

    describe.sequential(`Loading CommentIpfs with reserved fields is rejected - ${config.name}`, async () => {
        let pkc: PKC;
        let validCommentIpfsRaw: Record<string, unknown>;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();

            // Publish a normal comment to get a valid CommentIpfs
            const post = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
            await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });

            const loadedComment = await pkc.getComment({ cid: post.cid });
            validCommentIpfsRaw = JSON.parse(JSON.stringify(loadedComment.raw.comment));
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        it(`getComment() throws when CommentIpfs has top-level nameResolved`, async () => {
            const maliciousRecord = { ...validCommentIpfsRaw, nameResolved: true };
            const maliciousCid = await addStringToIpfs(JSON.stringify(maliciousRecord));

            try {
                await pkc.getComment({ cid: maliciousCid });
                expect.fail("Should have thrown");
            } catch (e) {
                const error = e as PKCError;
                expect(error.code).to.equal("ERR_COMMENT_IPFS_SIGNATURE_IS_INVALID");
                expect(error.details.commentIpfsValidation.reason).to.equal(messages.ERR_COMMENT_IPFS_RECORD_INCLUDES_RESERVED_FIELD);
            }
        });

        it(`getComment() throws when CommentIpfs has author.nameResolved`, async () => {
            const maliciousRecord = {
                ...validCommentIpfsRaw,
                author: { ...(validCommentIpfsRaw.author as Record<string, unknown>), nameResolved: true }
            };
            const maliciousCid = await addStringToIpfs(JSON.stringify(maliciousRecord));

            try {
                await pkc.getComment({ cid: maliciousCid });
                expect.fail("Should have thrown");
            } catch (e) {
                const error = e as PKCError;
                expect(error.code).to.equal("ERR_COMMENT_IPFS_SIGNATURE_IS_INVALID");
                expect(error.details.commentIpfsValidation.reason).to.equal(messages.ERR_COMMENT_IPFS_AUTHOR_INCLUDES_RESERVED_FIELD);
            }
        });

        it(`comment.update() emits error when CommentIpfs has top-level nameResolved`, async () => {
            const maliciousRecord = { ...validCommentIpfsRaw, nameResolved: true };
            const maliciousCid = await addStringToIpfs(JSON.stringify(maliciousRecord));

            const comment = await pkc.createComment({ cid: maliciousCid });
            const errorPromise = new Promise<PKCError>((resolve) => comment.once("error", resolve as (err: Error) => void));

            await comment.update();
            const error = await errorPromise;

            expect(error.code).to.equal("ERR_COMMENT_IPFS_SIGNATURE_IS_INVALID");
            expect(error.details.commentIpfsValidation.reason).to.equal(messages.ERR_COMMENT_IPFS_RECORD_INCLUDES_RESERVED_FIELD);

            expect(comment.state).to.equal("stopped");
            await comment.stop();
        });

        it(`comment.update() emits error when CommentIpfs has author.nameResolved`, async () => {
            const maliciousRecord = {
                ...validCommentIpfsRaw,
                author: { ...(validCommentIpfsRaw.author as Record<string, unknown>), nameResolved: true }
            };
            const maliciousCid = await addStringToIpfs(JSON.stringify(maliciousRecord));

            const comment = await pkc.createComment({ cid: maliciousCid });
            const errorPromise = new Promise<PKCError>((resolve) => comment.once("error", resolve as (err: Error) => void));

            await comment.update();
            const error = await errorPromise;

            expect(error.code).to.equal("ERR_COMMENT_IPFS_SIGNATURE_IS_INVALID");
            expect(error.details.commentIpfsValidation.reason).to.equal(messages.ERR_COMMENT_IPFS_AUTHOR_INCLUDES_RESERVED_FIELD);

            expect(comment.state).to.equal("stopped");
            await comment.stop();
        });
    });
});

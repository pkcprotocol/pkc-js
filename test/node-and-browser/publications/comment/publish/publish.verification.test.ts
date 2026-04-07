import signers from "../../../../fixtures/signers.js";
import {
    generateMockPost,
    generateMockComment,
    publishWithExpectedResult,
    mockRemotePKC,
    publishRandomPost,
    createStaticCommunityRecordForComment,
    overrideCommentInstancePropsAndSign,
    setExtraPropOnCommentAndSign,
    disableValidationOfSignatureBeforePublishing,
    itSkipIfRpc,
    ensurePublicationIsSigned
} from "../../../../../dist/node/test/test-util.js";
import * as remeda from "remeda";
import { messages } from "../../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PKCError } from "../../../../../dist/node/pkc-error.js";
import type { PKC } from "../../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../../dist/node/publications/comment/types.js";
const communityAddress = signers[0].address;

describe.sequential(`Client side verification`, async () => {
    let pkc: PKC;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(".publish() throws if publication has invalid signature", async () => {
        const mockComment = await generateMockPost({
            communityAddress: communityAddress,
            pkc: pkc,
            postProps: { signer: signers[0] }
        });
        const community = await pkc.getCommunity({ address: communityAddress });
        if (!mockComment.raw.pubsubMessageToPublish)
            await ensurePublicationIsSigned(mockComment, community as Parameters<typeof ensurePublicationIsSigned>[1]);
        const pubsubPublication = JSON.parse(JSON.stringify(mockComment.raw.pubsubMessageToPublish!));
        pubsubPublication.timestamp += 1; // corrupts signature
        mockComment.raw.pubsubMessageToPublish = pubsubPublication;

        try {
            await mockComment.publish();
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as PKCError).code).to.equal("ERR_SIGNATURE_IS_INVALID");
        }
    });

    itSkipIfRpc.sequential(`.publish() throws if fetched community has an invalid signature`, async () => {
        // this test is flaky in CI for some reason
        const { commentCid, communityAddress: communityAddress } = await createStaticCommunityRecordForComment({
            invalidateCommunitySignature: true
        });
        const mockPost = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
        mockPost._getCommunityCache = (): ReturnType<Comment["_getCommunityCache"]> => undefined;

        try {
            await mockPost.publish();
            expect.fail("should fail");
        } catch (e) {
            expect((e as PKCError).code).to.equal(
                "ERR_COMMUNITY_SIGNATURE_IS_INVALID",
                "Got a different error than expected: " + JSON.stringify(e)
            );
        }
    });
});

describe.concurrent("Community rejection of incorrect values of fields", async () => {
    let pkc: PKC, post: Comment;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
        post = await publishRandomPost({ communityAddress: communityAddress, pkc: pkc });
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Community reject a comment with communityAddress that is not equal to its community.address`);
    it(`Community reject publish a comment without author.address`);
    it(`Community reject publish a comment with non valid signature.signedPropertyNames`);

    it("Community reject a comment under a non existent parent", async () => {
        const comment = await pkc.createComment({
            parentCid: "QmV8Q8tWqbLTPYdrvSXHjXgrgWUR1fZ9Ctj56ETPi58FDY", // random cid that's not related to this sub,
            postCid: "QmV8Q8tWqbLTPYdrvSXHjXgrgWUR1fZ9Ctj56ETPi58FDY",
            signer: remeda.sample(signers, 1)[0],
            content: `Random Content` + Date.now(),
            communityAddress: communityAddress
        });
        await publishWithExpectedResult({
            publication: comment,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_PARENT_DOES_NOT_EXIST_IN_COMMUNITY
        });
    });

    it(`A reply with timestamp earlier than its parent is rejected`, async () => {
        expect(post.timestamp).to.be.a("number");
        const reply = await generateMockComment(post as CommentIpfsWithCidDefined, pkc, false, {
            signer: signers[0],
            timestamp: post.timestamp - 1
        });
        expect(reply.timestamp).to.be.lessThan(post.timestamp);
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMUNITY_COMMENT_TIMESTAMP_IS_EARLIER_THAN_PARENT
        });
    });

    // Removed: "Throws an error when publishing a duplicate post" — idempotent duplicate handling is now
    // tested in test/node/community/unique.publishing.community.test.ts

    it(`Throws an error when comment is over size`, async () => {
        const veryLongString = "Hello".repeat(10000);
        const mockPost = await generateMockPost({
            communityAddress: signers[0].address,
            pkc: pkc,
            postProps: { content: veryLongString }
        });
        // Size of post should be ~50kb now

        await publishWithExpectedResult({
            publication: mockPost,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REQUEST_PUBLICATION_OVER_ALLOWED_SIZE
        });
    });

    itSkipIfRpc(`Throws an error when a comment has no title, link or content`, async () => {
        // should fail both locally in pkc.createComment, and when we publish to the community
        try {
            await generateMockPost({
                communityAddress: communityAddress,
                pkc: pkc,
                postProps: {
                    link: undefined,
                    content: undefined,
                    title: undefined
                } as Parameters<typeof generateMockPost>[0]["postProps"]
            });
            expect.fail("Should fail if no link, content and title are defined");
        } catch (e) {
            expect((e as PKCError).code).to.equal("ERR_INVALID_CREATE_COMMENT_ARGS_SCHEMA");
            expect((e as PKCError).details.zodError.issues[0].message).to.equal(messages.ERR_COMMENT_HAS_NO_CONTENT_LINK_TITLE);
        }

        const mockPost = await generateMockPost({ communityAddress: communityAddress, pkc: pkc }); // regular post with everything defined
        // @ts-expect-error - intentionally testing invalid props to verify error handling
        await overrideCommentInstancePropsAndSign(mockPost, {
            link: undefined,
            content: undefined,
            title: undefined
        });

        await publishWithExpectedResult({
            publication: mockPost,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REQUEST_ENCRYPTED_HAS_INVALID_SCHEMA_AFTER_DECRYPTING
        });
    });

    it.skip(`Throws an error if author.avatar.signature.signature is of a json string instead of a 0x string`, async () => {
        const test = {
            address: "0x52e6cD20f5FcA56DA5a0E489574C92AF118B8188",
            chainTicker: "matic",
            id: "9842",
            timestamp: 1709879936,
            signature: {
                signature:
                    '{"domainSeparator":"pkc-author-avatar","authorAddress":"12D3KooWJsiCyvG9mjRtWzc8TqzS7USKUrFFNs9s2AJuGqNhn9uU","timestamp":1709879936,"tokenAddress":"0x52e6cD20f5FcA56DA5a0E489574C92AF118B8188","tokenId":"9842"}',
                type: "eip191"
            }
        };
        const mockPost = await generateMockPost({
            communityAddress: communityAddress,
            pkc: pkc,
            postProps: { author: { avatar: test } }
        });
        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: false, expectedReason: "zxc" });
    });

    itSkipIfRpc(`Subs respond with error if an author submits an encrypted field with invalid json`, async () => {
        const post = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
        // @ts-expect-error - intentionally returning invalid type to test error handling
        post.toJSONPubsubRequestToEncrypt = () => "<html>dwad"; // Publication will encrypt this invalid json
        disableValidationOfSignatureBeforePublishing(post);
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REQUEST_ENCRYPTED_HAS_INVALID_SCHEMA_AFTER_DECRYPTING
        });
    });

    it(`Subs respond with error if you attempt to publish a reply without postCid defined`, async () => {
        try {
            await generateMockComment(post as CommentIpfsWithCidDefined, pkc, false, { postCid: undefined });
            expect.fail("Should fail to create a reply without postCid defined");
        } catch (e) {
            expect((e as PKCError).code).to.equal("ERR_INVALID_CREATE_COMMENT_ARGS_SCHEMA");
            expect((e as PKCError).details.zodError.issues[0].message).to.equal(messages.ERR_REPLY_HAS_NOT_DEFINED_POST_CID);
        }
        const reply = await generateMockComment(post as CommentIpfsWithCidDefined, pkc, false);
        await setExtraPropOnCommentAndSign(reply, { postCid: undefined }, true);
        expect(reply.postCid).to.be.undefined;
        const challengerequestPromise = new Promise<{ comment?: { postCid?: string } }>((resolve) =>
            reply.once("challengerequest", resolve as (request: unknown) => void)
        );
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_REPLY_HAS_NOT_DEFINED_POST_CID
        });
        const challengeRequest = await challengerequestPromise;
        expect(challengeRequest.comment?.postCid).to.be.undefined;
    });
});

describe.concurrent(`Posts with forbidden fields are rejected during challenge exchange`, async () => {
    let pkc: PKC;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    it(`Can't publish a post to community with signer being part of CommentPubsubMessage`, async () => {
        const post = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
        await setExtraPropOnCommentAndSign(post, { signer: { privateKey: post.signer.privateKey } }, true);
        await publishWithExpectedResult({
            publication: post,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_COMMENT_HAS_RESERVED_FIELD
        });
    });

    const forbiddenFieldsWithValue = [
        { cid: "QmVZR5Ts9MhRc66hr6TsYnX1A2oPhJ2H1fRJknxgjLLwrh" },
        { previousCid: "QmVZR5Ts9MhRc66hr6TsYnX1A2oPhJ2H1fRJknxgjLLwrh" },
        { depth: "0" },
        { upvoteCount: 1 },
        { downvoteCount: 1 },
        { replyCount: 1 },
        { updatedAt: 1234567 },
        { replies: { test: "testl" } },
        { edit: { content: "werw" } },
        { deleted: true },
        { pinned: true },
        { locked: true },
        { removed: true },
        { reason: "Test forbidden" },
        { shortCid: "QmVZR5Ts9MhRc66hr6TsYnX1A2oPhJ2H1fRJknxgjLLwrh" },
        { nameResolved: true }
    ];
    forbiddenFieldsWithValue.map((forbiddenType) =>
        itSkipIfRpc(`comment.${Object.keys(forbiddenType)[0]} is rejected by sub`, async () => {
            const post = await generateMockPost({ communityAddress: communityAddress, pkc: pkc });
            await setExtraPropOnCommentAndSign(post, forbiddenType, true);
            await publishWithExpectedResult({
                publication: post,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_HAS_RESERVED_FIELD
            });
        })
    );
});

describe("Posts with forbidden author fields are rejected", async () => {
    let pkc: PKC;
    beforeAll(async () => {
        pkc = await mockRemotePKC();
    });

    afterAll(async () => {
        await pkc.destroy();
    });

    const forbiddenFieldsWithValue: Record<string, unknown> = {
        community: { lastCommentCid: "QmRxNUGsYYg3hxRnhnbvETdYSc16PXqzgF8WP87UXpb9Rs", postScore: 0, replyScore: 0, banExpiresAt: 0 },
        shortAddress: "12345",
        nameResolved: true
    };
    Object.keys(forbiddenFieldsWithValue).map((forbiddenFieldName) =>
        it(`publication.author.${forbiddenFieldName} is rejected by sub`, async () => {
            const signer = await pkc.createSigner();
            const post = await pkc.createComment({
                communityAddress: communityAddress,
                title: "Nonsense" + Date.now(),
                signer: signer
            });
            await setExtraPropOnCommentAndSign(
                post,
                {
                    author: { ...post.author, [forbiddenFieldName]: forbiddenFieldsWithValue[forbiddenFieldName] }
                },
                true
            );
            await publishWithExpectedResult({
                publication: post,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_PUBLICATION_AUTHOR_HAS_RESERVED_FIELD
            });
        })
    );
});

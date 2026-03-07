import signers from "../../../../fixtures/signers.js";
import {
    generateMockPost,
    generateMockComment,
    publishWithExpectedResult,
    mockRemotePlebbit,
    publishRandomPost,
    createStaticSubplebbitRecordForComment,
    overrideCommentInstancePropsAndSign,
    setExtraPropOnCommentAndSign,
    disableValidationOfSignatureBeforePublishing,
    itSkipIfRpc
} from "../../../../../dist/node/test/test-util.js";
import * as remeda from "remeda";
import { messages } from "../../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll } from "vitest";
import type { PlebbitError } from "../../../../../dist/node/plebbit-error.js";
import type { Plebbit } from "../../../../../dist/node/plebbit/plebbit.js";
import type { Comment } from "../../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined } from "../../../../../dist/node/publications/comment/types.js";
const subplebbitAddress = signers[0].address;

describe.sequential(`Client side verification`, async () => {
    let plebbit: Plebbit;
    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(".publish() throws if publication has invalid signature", async () => {
        const mockComment = await generateMockPost({
            subplebbitAddress: subplebbitAddress,
            plebbit: plebbit,
            postProps: { signer: signers[0] }
        });
        const pubsubPublication = JSON.parse(JSON.stringify(mockComment.toJSONPubsubMessagePublication()));
        pubsubPublication.timestamp += 1; // corrupts signature
        mockComment.toJSONPubsubMessagePublication = () => pubsubPublication;

        try {
            await mockComment.publish();
            expect.fail("Should have thrown");
        } catch (e) {
            expect((e as PlebbitError).code).to.equal("ERR_SIGNATURE_IS_INVALID");
        }
    });

    itSkipIfRpc.sequential(`.publish() throws if fetched subplebbit has an invalid signature`, async () => {
        // this test is flaky in CI for some reason
        const { commentCid, subplebbitAddress } = await createStaticSubplebbitRecordForComment({ invalidateSubplebbitSignature: true });
        const mockPost = await generateMockPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit });
        mockPost._getSubplebbitCache = () => undefined;

        try {
            await mockPost.publish();
            expect.fail("should fail");
        } catch (e) {
            expect((e as PlebbitError).code).to.equal(
                "ERR_SUBPLEBBIT_SIGNATURE_IS_INVALID",
                "Got a different error than expected: " + JSON.stringify(e)
            );
        }
    });
});

describe.concurrent("Subplebbit rejection of incorrect values of fields", async () => {
    let plebbit: Plebbit, post: Comment;
    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
        post = await publishRandomPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit });
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`Subplebbit reject a comment with subplebbitAddress that is not equal to its subplebbit.address`);
    it(`Subplebbit reject publish a comment without author.address`);
    it(`Subplebbit reject publish a comment with non valid signature.signedPropertyNames`);

    it("Subplebbit reject a comment under a non existent parent", async () => {
        const comment = await plebbit.createComment({
            parentCid: "QmV8Q8tWqbLTPYdrvSXHjXgrgWUR1fZ9Ctj56ETPi58FDY", // random cid that's not related to this sub,
            postCid: "QmV8Q8tWqbLTPYdrvSXHjXgrgWUR1fZ9Ctj56ETPi58FDY",
            signer: remeda.sample(signers, 1)[0],
            content: `Random Content` + Date.now(),
            subplebbitAddress
        });
        await publishWithExpectedResult({
            publication: comment,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_PUBLICATION_PARENT_DOES_NOT_EXIST_IN_SUB
        });
    });

    it(`A reply with timestamp earlier than its parent is rejected`, async () => {
        expect(post.timestamp).to.be.a("number");
        const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, {
            signer: signers[0],
            timestamp: post.timestamp - 1
        });
        expect(reply.timestamp).to.be.lessThan(post.timestamp);
        await publishWithExpectedResult({
            publication: reply,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_SUB_COMMENT_TIMESTAMP_IS_EARLIER_THAN_PARENT
        });
    });

    it("Throws an error when publishing a duplicate post", async function () {
        const newPost = await generateMockPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit });
        newPost.toJSONPubsubMessagePublication = () => post.toJSONPubsubMessagePublication();
        await publishWithExpectedResult({
            publication: newPost,
            expectedChallengeSuccess: false,
            expectedReason: messages.ERR_DUPLICATE_COMMENT
        });
    });

    it(`Throws an error when comment is over size`, async () => {
        const veryLongString = "Hello".repeat(10000);
        const mockPost = await generateMockPost({
            subplebbitAddress: signers[0].address,
            plebbit: plebbit,
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
        // should fail both locally in plebbit.createComment, and when we publish to the sub
        try {
            await generateMockPost({
                subplebbitAddress: subplebbitAddress,
                plebbit: plebbit,
                postProps: {
                    link: undefined,
                    content: undefined,
                    title: undefined
                } as Parameters<typeof generateMockPost>[0]["postProps"]
            });
            expect.fail("Should fail if no link, content and title are defined");
        } catch (e) {
            expect((e as PlebbitError).code).to.equal("ERR_INVALID_CREATE_COMMENT_ARGS_SCHEMA");
            expect((e as PlebbitError).details.zodError.issues[0].message).to.equal(messages.ERR_COMMENT_HAS_NO_CONTENT_LINK_TITLE);
        }

        const mockPost = await generateMockPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit }); // regular post with everything defined
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
                    '{"domainSeparator":"plebbit-author-avatar","authorAddress":"12D3KooWJsiCyvG9mjRtWzc8TqzS7USKUrFFNs9s2AJuGqNhn9uU","timestamp":1709879936,"tokenAddress":"0x52e6cD20f5FcA56DA5a0E489574C92AF118B8188","tokenId":"9842"}',
                type: "eip191"
            }
        };
        const mockPost = await generateMockPost({
            subplebbitAddress: subplebbitAddress,
            plebbit: plebbit,
            postProps: { author: { avatar: test } }
        });
        await publishWithExpectedResult({ publication: mockPost, expectedChallengeSuccess: false, expectedReason: "zxc" });
    });

    itSkipIfRpc(`Subs respond with error if an author submits an encrypted field with invalid json`, async () => {
        const post = await generateMockPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit });
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
            await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false, { postCid: undefined });
            expect.fail("Should fail to create a reply without postCid defined");
        } catch (e) {
            expect((e as PlebbitError).code).to.equal("ERR_INVALID_CREATE_COMMENT_ARGS_SCHEMA");
            expect((e as PlebbitError).details.zodError.issues[0].message).to.equal(messages.ERR_REPLY_HAS_NOT_DEFINED_POST_CID);
        }
        const reply = await generateMockComment(post as CommentIpfsWithCidDefined, plebbit, false);
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
    let plebbit: Plebbit;
    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    it(`Can't publish a post to sub with signer being part of CommentPubsubMessage`, async () => {
        const post = await generateMockPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit });
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
        { shortCid: "QmVZR5Ts9MhRc66hr6TsYnX1A2oPhJ2H1fRJknxgjLLwrh" }
    ];
    forbiddenFieldsWithValue.map((forbiddenType) =>
        itSkipIfRpc(`comment.${Object.keys(forbiddenType)[0]} is rejected by sub`, async () => {
            const post = await generateMockPost({ subplebbitAddress: subplebbitAddress, plebbit: plebbit });
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
    let plebbit: Plebbit;
    beforeAll(async () => {
        plebbit = await mockRemotePlebbit();
    });

    afterAll(async () => {
        await plebbit.destroy();
    });

    const forbiddenFieldsWithValue: Record<string, unknown> = {
        subplebbit: { lastCommentCid: "QmRxNUGsYYg3hxRnhnbvETdYSc16PXqzgF8WP87UXpb9Rs", postScore: 0, replyScore: 0, banExpiresAt: 0 },
        shortAddress: "12345"
    };
    Object.keys(forbiddenFieldsWithValue).map((forbiddenFieldName) =>
        it(`publication.author.${forbiddenFieldName} is rejected by sub`, async () => {
            const signer = await plebbit.createSigner();
            const post = await plebbit.createComment({
                subplebbitAddress,
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

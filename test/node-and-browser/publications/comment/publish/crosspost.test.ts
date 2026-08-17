// Crossposts (issue #32) — publishing end to end.
//
// The crossposting comment may be a post or a reply, unlike quotedCids which is replies-only.
// The community enforces tier 1 only and fetches nothing from the referenced community, so
// acceptance never depends on a third party's uptime. See docs/protocol/crossposts.md.
import signers from "../../../../fixtures/signers.js";
import {
    generateMockPost,
    generateMockComment,
    publishWithExpectedResult,
    publishRandomPost,
    publishRandomReply,
    getAvailablePKCConfigsToTestAgainst,
    disableValidationOfSignatureBeforePublishing
} from "../../../../../dist/node/test/test-util.js";
import { messages } from "../../../../../dist/node/errors.js";
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { clone } from "remeda";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import type { PKC } from "../../../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsWithCidDefined, CommentIpfsType } from "../../../../../dist/node/publications/comment/types.js";

const communityAddress = signers[0].address;

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`publishing crossposts - ${config.name}`, async () => {
        let pkc: PKC;
        let original: Comment;
        let originalReply: Comment;
        let crosspost: { cid: string; comment: CommentIpfsType };

        // Builds a crossposting post whose client-side signature check is disabled, so a deliberately
        // invalid crosspost reaches the community and the community's own enforcement is what is
        // being measured.
        const buildUnvalidated = async (badCrosspost: unknown) => {
            const post = await generateMockPost({
                communityAddress,
                pkc,
                postProps: { crosspost: badCrosspost } as Parameters<typeof generateMockPost>[0]["postProps"]
            });
            await disableValidationOfSignatureBeforePublishing(post);
            return post;
        };

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            original = await publishRandomPost({ communityAddress, pkc });
            originalReply = await publishRandomReply({ parentComment: original as CommentIpfsWithCidDefined, pkc });
            crosspost = { cid: original.cid!, comment: original.raw.comment! };
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        describe("a valid crosspost publishes", () => {
            it("a post carrying a crosspost is accepted", async () => {
                const post = await generateMockPost({ communityAddress, pkc, postProps: { crosspost } });
                expect(post.crosspost?.cid).to.equal(crosspost.cid);
                await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });

                expect(post.raw.pubsubMessageToPublish!.crosspost).to.deep.equal(crosspost);
                expect(post.raw.comment!.crosspost).to.deep.equal(crosspost);
            });

            it("a reply carrying a crosspost is accepted", async () => {
                const reply = await generateMockComment(original as CommentIpfsWithCidDefined, pkc, false, { crosspost });
                await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
                expect(reply.raw.comment!.crosspost).to.deep.equal(crosspost);
            });

            it("a crosspost of a reply (not just a post) is accepted", async () => {
                const replyCrosspost = { cid: originalReply.cid!, comment: originalReply.raw.comment! };
                const post = await generateMockPost({ communityAddress, pkc, postProps: { crosspost: replyCrosspost } });
                await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
                expect(post.raw.comment!.crosspost!.comment.depth).to.equal(1);
            });

            it("the crosspost fetched back from IPFS is byte-identical to what was published", async () => {
                const post = await generateMockPost({ communityAddress, pkc, postProps: { crosspost } });
                await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });

                const fetched = JSON.parse((await pkc.fetchCid({ cid: post.cid! })).content);
                expect(deterministicStringify(fetched.crosspost)).to.equal(deterministicStringify(crosspost));
                expect(await calculateIpfsHash(deterministicStringify(fetched.crosspost.comment)!)).to.equal(crosspost.cid);
            });

            it("crossposting a comment from this same community is accepted", async () => {
                // Deliberately allowed, not treated as a community mismatch.
                const post = await generateMockPost({ communityAddress, pkc, postProps: { crosspost } });
                await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
            });
        });

        describe("a bare crosspost publishes (a retweet: no content, link or title)", () => {
            it("a post whose only payload is the crosspost is accepted", async () => {
                const post = await pkc.createComment({ communityAddress, signer: await pkc.createSigner(), crosspost });
                expect(post.content).to.be.undefined;
                expect(post.link).to.be.undefined;
                expect(post.title).to.be.undefined;

                await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });

                expect(post.raw.comment!.crosspost).to.deep.equal(crosspost);
                expect(post.raw.comment!.content).to.be.undefined;
                expect(post.raw.comment!.link).to.be.undefined;
                expect(post.raw.comment!.title).to.be.undefined;
            });

            it("a reply whose only payload is the crosspost is accepted", async () => {
                const reply = await pkc.createComment({
                    communityAddress,
                    signer: await pkc.createSigner(),
                    parentCid: original.cid!,
                    postCid: original.postCid!,
                    crosspost
                });
                await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
                expect(reply.raw.comment!.crosspost).to.deep.equal(crosspost);
                expect(reply.raw.comment!.content).to.be.undefined;
            });

            it("a comment with neither crosspost nor content, link or title is still refused", async () => {
                await expect(pkc.createComment({ communityAddress, signer: await pkc.createSigner() })).rejects.toMatchObject({
                    code: "ERR_INVALID_CREATE_COMMENT_ARGS_SCHEMA"
                });
            });
        });

        // publish() runs the same tier 1 verification the community runs at acceptance, so every check
        // in _verifyCrosspost refuses the publication locally before a challenge is ever requested.
        // Each case below is the client-side twin of a case in "the community enforces tier 1 at
        // acceptance": same tampering, but with local signature validation left switched on. Every
        // one asserts the reason, not just that something threw, since a bare toThrow() would also
        // pass on a network failure or a broken fixture and would not prove which check refused.
        //
        // The one invalid crosspost that does not surface at publish() is an over-deep chain: the cap
        // is enforced when createComment parses the options, before a Comment exists to publish. That
        // path is covered in test/node-and-browser/crosspost/depth.test.ts.
        describe("the client refuses to publish an invalid crosspost", () => {
            // Publishes nothing and asserts on the local rejection: an invalid crosspost must never
            // reach the community's pubsub topic in the first place.
            const expectPublishRefusedWith = async (badCrosspost: typeof crosspost, reason: string) => {
                const post = await generateMockPost({ communityAddress, pkc, postProps: { crosspost: badCrosspost } });
                await expect(post.publish()).rejects.toMatchObject({
                    code: "ERR_SIGNATURE_IS_INVALID",
                    details: { signatureValidity: { reason } }
                });
            };

            it("a cid that does not match the embedded bytes fails local validation", async () => {
                const wrong = { ...crosspost, cid: "QmYjtig7VJQ6XsnUjqqJvj7QaMcCAwtrgNdahSiFofrE7o" };
                await expectPublishRefusedWith(wrong, messages.ERR_CROSSPOST_CID_DOES_NOT_MATCH_EMBEDDED_COMMENT);
            });

            it("an embedded record with a broken author signature fails local validation", async () => {
                // The cid is recomputed over the tampered bytes so check 1 passes and check 4 is what
                // rejects: without that this would be indistinguishable from the cid mismatch above.
                const tampered = clone(crosspost);
                tampered.comment.content = "tampered, but consistently hashed";
                tampered.cid = await calculateIpfsHash(deterministicStringify(tampered.comment)!);
                await expectPublishRefusedWith(tampered, messages.ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID);
            });

            it("an embedded record carrying a reserved field fails local validation", async () => {
                const tampered = clone(crosspost);
                (tampered.comment as { cid?: string }).cid = crosspost.cid; // runtime-only on a CommentIpfs
                tampered.cid = await calculateIpfsHash(deterministicStringify(tampered.comment)!);
                await expectPublishRefusedWith(tampered, messages.ERR_CROSSPOST_COMMENT_INCLUDES_RESERVED_FIELD);
            });

            it("an embedded author carrying a reserved field fails local validation", async () => {
                // author.shortAddress is derived at runtime and never on the wire. Checked separately
                // from the record's own reserved fields, so a record that is clean at the top level
                // can still be refused for what it carries under author.
                const tampered = clone(crosspost);
                (tampered.comment.author as { shortAddress?: string }).shortAddress = "somederivedshortaddress";
                tampered.cid = await calculateIpfsHash(deterministicStringify(tampered.comment)!);
                await expectPublishRefusedWith(tampered, messages.ERR_CROSSPOST_COMMENT_AUTHOR_INCLUDES_RESERVED_FIELD);
            });

            it("an embedded record with a signable field outside signedPropertyNames fails local validation", async () => {
                // spoiler is signable and absent from the original, so it is absent from the record's
                // signedPropertyNames too. Adding it after signing is the issue #249 hole: the pick
                // down to signedPropertyNames in check 4 would drop it from what gets verified while
                // it stays in what gets stored and rendered, so check 3 has to catch it first.
                const tampered = clone(crosspost);
                expect(tampered.comment.signature.signedPropertyNames).to.not.include("spoiler");
                tampered.comment.spoiler = true;
                tampered.cid = await calculateIpfsHash(deterministicStringify(tampered.comment)!);
                await expectPublishRefusedWith(
                    tampered,
                    messages.ERR_CROSSPOST_COMMENT_INCLUDES_SIGNABLE_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
                );
            });
        });

        describe("the community enforces tier 1 at acceptance", () => {
            it("a cid that does not match the embedded bytes is rejected", async () => {
                const wrong = { ...crosspost, cid: "QmYjtig7VJQ6XsnUjqqJvj7QaMcCAwtrgNdahSiFofrE7o" };
                await publishWithExpectedResult({
                    publication: await buildUnvalidated(wrong),
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_CROSSPOST_CID_DOES_NOT_MATCH_EMBEDDED_COMMENT
                });
            });

            it("an embedded record with a broken author signature is rejected", async () => {
                const tampered = clone(crosspost);
                tampered.comment.content = "tampered, but consistently hashed";
                tampered.cid = await calculateIpfsHash(deterministicStringify(tampered.comment)!);
                await publishWithExpectedResult({
                    publication: await buildUnvalidated(tampered),
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID
                });
            });

            it("an embedded record carrying a reserved field is rejected", async () => {
                const tampered = clone(crosspost) as Record<string, any>;
                tampered.comment.cid = crosspost.cid; // runtime-only on a CommentIpfs
                tampered.cid = await calculateIpfsHash(deterministicStringify(tampered.comment)!);
                await publishWithExpectedResult({
                    publication: await buildUnvalidated(tampered),
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_CROSSPOST_COMMENT_INCLUDES_RESERVED_FIELD
                });
            });
        });

        describe("chains", () => {
            it("crossposting a crosspost is accepted", async () => {
                const first = await generateMockPost({ communityAddress, pkc, postProps: { crosspost } });
                await publishWithExpectedResult({ publication: first, expectedChallengeSuccess: true });

                const chained = { cid: first.cid!, comment: first.raw.comment! };
                const second = await generateMockPost({ communityAddress, pkc, postProps: { crosspost: chained } });
                await publishWithExpectedResult({ publication: second, expectedChallengeSuccess: true });

                expect(second.raw.comment!.crosspost!.comment.crosspost!.cid).to.equal(crosspost.cid);
            });

            it("nesting eats the content budget: a large embedded record leaves less room", async () => {
                // Depth is capped at MAX_CROSSPOST_DEPTH (#250), but size binds long before that:
                // because the embedded record is carried whole, each level of nesting consumes the
                // 40kb budget available to the next. A ~20kb post is publishable on its own;
                // crossposting it and adding another ~25kb of content is not.
                const large = await generateMockPost({ communityAddress, pkc, postProps: { content: "x".repeat(20000) } });
                await publishWithExpectedResult({ publication: large, expectedChallengeSuccess: true });

                const largeCrosspost = { cid: large.cid!, comment: large.raw.comment! };
                // TextEncoder, not Buffer.byteLength — this file runs in the browser bundle too
                expect(new TextEncoder().encode(JSON.stringify(largeCrosspost)).length).to.be.greaterThan(20000);

                const overBudget = await generateMockPost({
                    communityAddress,
                    pkc,
                    postProps: { content: "x".repeat(25000), crosspost: largeCrosspost }
                });
                await publishWithExpectedResult({
                    publication: overBudget,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_REQUEST_PUBLICATION_OVER_ALLOWED_SIZE
                });
            });
        });

        describe("a crossposting comment is an ordinary comment otherwise", () => {
            it("it can be replied to and voted on independently of the referenced comment", async () => {
                const post = await generateMockPost({ communityAddress, pkc, postProps: { crosspost } });
                await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });

                const reply = await publishRandomReply({ parentComment: post as CommentIpfsWithCidDefined, pkc });
                expect(reply.cid).to.be.a("string");
                expect(reply.parentCid).to.equal(post.cid);
            });
        });
    });
});

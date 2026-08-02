// Crossposts (issue #32) — what a client can do with one, and what it may not conclude from one.
//
// pkc-js ships tier 1 only. There is no tier-2 helper and none is needed: a client that wants the
// referenced comment's live state builds an instance from the embedded record and updates it. That
// loads the CommentUpdate from the community named in the embedded record and verifies its
// signature through the existing path. Because cid is inside CommentUpdateSignedPropertyNames and
// the CID hashes the entire record, a valid update is that community attesting to exactly these
// bytes, unsigned extras included. See docs/protocol/crossposts.md.
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import signers from "../../fixtures/signers.js";
import {
    generateMockPost,
    generateMockComment,
    publishWithExpectedResult,
    publishRandomPost,
    publishVote,
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue
} from "../../../dist/node/test/test-util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsType, CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";
import { messages } from "../../../dist/node/errors.js";

const communityAddress = signers[0].address;

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`consuming a crosspost - ${config.name}`, async () => {
        let pkc: PKC;
        let original: Comment;
        let crosspost: { cid: string; comment: CommentIpfsType };
        let crossposting: Comment;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            original = await publishRandomPost({ communityAddress, pkc });
            crosspost = { cid: original.cid!, comment: original.raw.comment! };

            crossposting = await generateMockPost({ communityAddress, pkc, postProps: { crosspost } });
            await publishWithExpectedResult({ publication: crossposting, expectedChallengeSuccess: true });
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        describe("crosspost is exposed on the Comment instance", () => {
            it("comment.crosspost is set after publishing", () => {
                expect(crossposting.crosspost).to.deep.equal(crosspost);
            });

            it("comment.raw.comment.crosspost matches comment.crosspost", () => {
                expect(crossposting.raw.comment!.crosspost).to.deep.equal(crossposting.crosspost);
            });

            it("comment.crosspost is undefined on a comment that is not a crosspost", () => {
                expect(original.crosspost).to.be.undefined;
            });

            it("crosspost is set on an instance loaded fresh by cid", async () => {
                const loaded = await pkc.createComment({ cid: crossposting.cid! });
                await loaded.update();
                await resolveWhenConditionIsTrue({ toUpdate: loaded, predicate: async () => typeof loaded.updatedAt === "number" });
                expect(loaded.crosspost).to.deep.equal(crosspost);
                await loaded.stop();
            });

            it("crosspost survives a createComment round trip", async () => {
                const roundTripped = await pkc.createComment({
                    cid: crossposting.cid!,
                    raw: { comment: JSON.parse(JSON.stringify(crossposting.raw.comment!)) }
                });
                expect(roundTripped.crosspost).to.deep.equal(crosspost);
            });
        });

        // The documented recipe. There is deliberately no pkc-js helper wrapping this.
        describe("building an instance for the referenced comment", () => {
            it("createComment({cid, raw: {comment}}) returns a usable instance", async () => {
                const referenced = await pkc.createComment({
                    cid: crossposting.crosspost!.cid,
                    raw: { comment: crossposting.crosspost!.comment }
                });
                expect(referenced.cid).to.equal(original.cid);
                expect(referenced.content).to.equal(original.content);
                await referenced.stop();
            });

            it("the instance's community is the one named in the embedded record", async () => {
                const referenced = await pkc.createComment({
                    cid: crossposting.crosspost!.cid,
                    raw: { comment: crossposting.crosspost!.comment }
                });
                expect(referenced.communityPublicKey).to.equal(crossposting.crosspost!.comment.communityPublicKey);
                await referenced.stop();
            });

            it("update() loads the referenced comment's CommentUpdate", async () => {
                const referenced = await pkc.createComment({
                    cid: crossposting.crosspost!.cid,
                    raw: { comment: crossposting.crosspost!.comment }
                });
                await referenced.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: referenced,
                    predicate: async () => typeof referenced.updatedAt === "number"
                });
                expect(referenced.raw.commentUpdate!.cid).to.equal(original.cid);
                expect(referenced.upvoteCount).to.be.a("number");
                await referenced.stop();
            });

            it("the loaded state reflects activity on the referenced comment, not the crosspost", async () => {
                // Tier 2 is where karma and mod state come from, and they belong to the referenced
                // comment. Voting on the original must not change the crossposting comment.
                await publishVote({ commentCid: original.cid!, communityAddress, vote: 1, pkc });

                const referenced = await pkc.createComment({
                    cid: crossposting.crosspost!.cid,
                    raw: { comment: crossposting.crosspost!.comment }
                });
                await referenced.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: referenced,
                    predicate: async () => typeof referenced.upvoteCount === "number" && referenced.upvoteCount > 0
                });
                expect(referenced.upvoteCount).to.be.greaterThan(0);
                await referenced.stop();

                const theCrosspost = await pkc.createComment({ cid: crossposting.cid! });
                await theCrosspost.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: theCrosspost,
                    predicate: async () => typeof theCrosspost.updatedAt === "number"
                });
                expect(theCrosspost.upvoteCount).to.equal(0);
                await theCrosspost.stop();
            });
        });

        // crosspost and quotedCids are both author-signed references and are not interchangeable.
        describe("crosspost vs quotedCids", () => {
            it("a reply can carry both crosspost and quotedCids", async () => {
                // quotedCids is replies-only, so this has to be a reply. crosspost is not, which is
                // itself part of the distinction between the two.
                const reply = await generateMockComment(original as CommentIpfsWithCidDefined, pkc, false, {
                    crosspost,
                    quotedCids: [original.cid!]
                });
                await publishWithExpectedResult({ publication: reply, expectedChallengeSuccess: true });
                expect(reply.crosspost).to.deep.equal(crosspost);
                expect(reply.quotedCids).to.deep.equal([original.cid!]);
                expect(reply.raw.comment!.crosspost).to.deep.equal(crosspost);
                expect(reply.raw.comment!.quotedCids).to.deep.equal([original.cid!]);
            });

            it("a post can carry a crosspost but not quotedCids", async () => {
                const post = await generateMockPost({ communityAddress, pkc, postProps: { crosspost, quotedCids: [original.cid!] } });
                await publishWithExpectedResult({
                    publication: post,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_POST_CANNOT_HAVE_QUOTED_CIDS
                });
            });

            it("crosspost is a single object, not an array", () => {
                expect(crossposting.crosspost).to.be.an("object");
                expect(Array.isArray(crossposting.crosspost)).to.be.false;
            });

            it("quotedCids stays reference-only and embeds nothing", async () => {
                expect(crossposting.quotedCids).to.be.undefined;
                expect(crossposting.crosspost!.comment).to.be.an("object");
            });
        });
    });
});

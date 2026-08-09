// Crossposts (issue #32) — what a client can do with one, and what it may not conclude from one.
//
// pkc-js ships tier 1 only. There is no tier-2 helper and none is needed: a client that wants the
// referenced comment's live state builds an instance from the embedded record and updates it. That
// loads the CommentUpdate from the community named in the embedded record and verifies its
// signature through the existing path. Because cid is inside CommentUpdateSignedPropertyNames and
// the CID hashes the entire record, a valid update is that community attesting to exactly these
// bytes, unsigned extras included. See docs/protocol/crossposts.md.
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import signers from "../../fixtures/signers.js";
import {
    generateMockPost,
    generateMockComment,
    publishWithExpectedResult,
    publishRandomPost,
    publishRandomReply,
    publishVote,
    getAvailablePKCConfigsToTestAgainst,
    resolveWhenConditionIsTrue,
    addStringToIpfs
} from "../../../dist/node/test/test-util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsType, CommentIpfsWithCidDefined } from "../../../dist/node/publications/comment/types.js";
import { messages } from "../../../dist/node/errors.js";
import type { PKCError } from "../../../dist/node/pkc-error.js";

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

            // crosspost is not replies-only like quotedCids, and neither is the thing it points at:
            // the embedded record can itself be a reply. Tier 2 has no depth-specific path, so this
            // is here to prove it, and to prove the reply's own tree position survives the round trip
            // through the embedded record.
            it("the referenced comment can be a reply, not just a post", async () => {
                const reply = await publishRandomReply({ parentComment: original as CommentIpfsWithCidDefined, pkc });
                const replyCrosspost = { cid: reply.cid!, comment: reply.raw.comment! };
                const crosspostingReply = await generateMockPost({
                    communityAddress,
                    pkc,
                    postProps: { crosspost: replyCrosspost }
                });
                await publishWithExpectedResult({ publication: crosspostingReply, expectedChallengeSuccess: true });

                const referenced = await pkc.createComment({
                    cid: crosspostingReply.crosspost!.cid,
                    raw: { comment: crosspostingReply.crosspost!.comment }
                });
                expect(referenced.depth).to.equal(1);
                expect(referenced.parentCid).to.equal(original.cid);

                await referenced.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: referenced,
                    predicate: async () => typeof referenced.updatedAt === "number"
                });
                expect(referenced.raw.commentUpdate!.cid).to.equal(reply.cid);
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

        // Everything here is unsigned by the author, so whoever builds the crosspost can choose it
        // freely and tier 1 still passes: the cid check only proves the cid matches whatever bytes
        // are present, and the signature check only covers signedPropertyNames. These are the cases
        // behind the client rules in docs/protocol/crossposts.md.
        describe("what tier 1 does NOT establish", () => {
            // Forges a field the hosting community would normally set, keeping cid consistent with
            // the forged bytes so tier 1 has nothing to object to.
            const forge = async (extra: Record<string, unknown>) => {
                const comment = JSON.parse(JSON.stringify(crosspost.comment));
                Object.assign(comment, extra);
                return { cid: await calculateIpfsHash(deterministicStringify(comment)!), comment };
            };

            it("thumbnailUrl on the embedded record is attacker-chosen and still passes tier 1", async () => {
                const forged = await forge({ thumbnailUrl: "https://example.com/attacker.png" });
                const post = await generateMockPost({ communityAddress, pkc, postProps: { crosspost: forged } });
                // The community accepts it: thumbnailUrl is not in signedPropertyNames, so the
                // original author's signature still verifies over the forged record.
                await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
                expect(post.raw.comment!.crosspost!.comment.thumbnailUrl).to.equal("https://example.com/attacker.png");
                expect(crosspost.comment.thumbnailUrl).to.be.undefined;
            });

            it("depth on the embedded record is attacker-chosen and still passes tier 1", async () => {
                const forged = await forge({ depth: 7 });
                const post = await generateMockPost({ communityAddress, pkc, postProps: { crosspost: forged } });
                await publishWithExpectedResult({ publication: post, expectedChallengeSuccess: true });
                expect(post.raw.comment!.crosspost!.comment.depth).to.equal(7);
                expect(crosspost.comment.depth).to.equal(0);
            });

            it("tier 2 is what rejects the forgery: no CommentUpdate exists for the forged cid", async () => {
                const forged = await forge({ thumbnailUrl: "https://example.com/attacker.png" });
                expect(forged.cid).to.not.equal(crosspost.cid);

                // The referenced community never issued a CommentUpdate for these bytes, so an
                // instance built from the forged record has nothing to load. That is the whole
                // reason "crossposted from C" and thumbnailUrl must not be presented as fact at
                // tier 1.
                const referenced = await pkc.createComment({ cid: forged.cid, raw: { comment: forged.comment } });
                await referenced.update();

                // A negative cannot be proven by waiting a fixed amount of time: on a slow runner
                // the wait would elapse before the update loop had its chance and the test would
                // pass for the wrong reason. Run a genuine record alongside it instead and wait on
                // that. Once a real cid has resolved a CommentUpdate, the same loop has had every
                // opportunity to resolve one for the forged cid.
                //
                // A freshly published post rather than crosspost.cid: this file is describe.concurrent
                // and other tests hold instances for that cid on the same pkc, so stopping a control
                // built from it would tear down an update loop they are still waiting on.
                const controlPost = await publishRandomPost({ communityAddress, pkc });
                const control = await pkc.createComment({ cid: controlPost.cid! });
                try {
                    await control.update();
                    await resolveWhenConditionIsTrue({ toUpdate: control, predicate: async () => typeof control.updatedAt === "number" });
                } finally {
                    await control.stop();
                }

                // updatedAt/raw.commentUpdate are the signal that a CommentUpdate resolved. The
                // "update" event is not — it also fires for the comment props the instance was
                // constructed with, which for a forged record are simply the forged bytes.
                expect(referenced.updatedAt, "a CommentUpdate must not resolve for forged bytes").to.be.undefined;
                expect(referenced.raw.commentUpdate).to.be.undefined;
                await referenced.stop();
            });
        });

        // The cid/bytes check lives in verifyCommentPubsubMessage, which verifyCommentIpfs delegates
        // to, so it guards fetches as well as the community's acceptance path. Tested through a load
        // rather than a direct verify call because the delegation is the thing that could regress:
        // moving the check into the community's path alone would leave every unit test green while
        // clients silently stopped rejecting a forged embed on fetch. See crosspost/verification.test.ts
        // for the checks themselves.
        describe("loading a comment whose crosspost.cid does not match the embedded bytes", () => {
            // A record the author validly signed over a mismatched crosspost. Tampering with a
            // published comment's crosspost would break its own outer signature and fail on that
            // first, so the crossposting comment is signed *after* the crosspost is broken.
            const plantMismatchedCrosspostOnIpfs = async () => {
                const mismatched = JSON.parse(JSON.stringify(crosspost));
                mismatched.comment.content = "the crossposter rewrote this and left cid alone";
                expect(await calculateIpfsHash(deterministicStringify(mismatched.comment)!)).to.not.equal(mismatched.cid);

                const signed = await generateMockPost({ communityAddress, pkc, postProps: { crosspost: mismatched } });
                // depth: what a community adds when it accepts a post, making this CommentIpfs-shaped
                const record = { ...signed.raw.pubsubMessageToPublish!, depth: 0 };
                return await addStringToIpfs(JSON.stringify(record));
            };

            it("pkc.getComment rejects it, naming the cid mismatch as the reason", async () => {
                const cid = await plantMismatchedCrosspostOnIpfs();
                // Captured rather than asserted inside a catch, so that "it loaded fine" reports as
                // itself instead of as an assertion error swallowed by the catch block.
                let error: PKCError | undefined;
                try {
                    await pkc.getComment({ cid });
                } catch (e) {
                    error = e as PKCError;
                }
                expect(error, "loading a comment with a mismatched crosspost.cid must not succeed").to.exist;
                expect(error!.code).to.equal("ERR_COMMENT_IPFS_SIGNATURE_IS_INVALID");
                // The specific reason, not just "invalid": the outer signature over these bytes is
                // genuine, so a generic failure would mean something else went wrong.
                expect(error!.details.commentIpfsValidation.reason).to.equal(messages.ERR_CROSSPOST_CID_DOES_NOT_MATCH_EMBEDDED_COMMENT);
            });

            // The same rejection through the updating path, where it surfaces as an "error" event
            // instead of a throw. Worth covering separately: this is the path a client that renders a
            // feed actually uses, and it has its own failure mode, namely applying the record's props
            // anyway or carrying on updating after a critical error.
            it("update() emits it as an error event and stops updating", async () => {
                const cid = await plantMismatchedCrosspostOnIpfs();
                const comment = await pkc.createComment({ cid });
                const errors: PKCError[] = [];
                comment.on("error", (err) => errors.push(err as PKCError));

                await comment.update();
                await resolveWhenConditionIsTrue({ toUpdate: comment, predicate: async () => errors.length >= 1, eventName: "error" });

                expect(errors[0].code).to.equal("ERR_COMMENT_IPFS_SIGNATURE_IS_INVALID");
                expect(errors[0].details.commentIpfsValidation.reason).to.equal(messages.ERR_CROSSPOST_CID_DOES_NOT_MATCH_EMBEDDED_COMMENT);
                // None of the rejected record's props may be applied, crosspost included.
                expect(comment.crosspost).to.be.undefined;
                expect(comment.content).to.be.undefined;
                expect(comment.updatedAt).to.be.undefined;
                // A bad record is not going to become good, so this is a terminal failure, not a retry.
                expect(comment.state).to.equal("stopped");
                expect(comment.updatingState).to.equal("failed");
                await comment.stop();
            });

            // validateComment is the explicit "is this comment trustworthy" call a client makes on
            // records it got from somewhere else, e.g. a page it already holds. Same check, but it
            // wraps the reason under its own error code, so the code is worth pinning too.
            it("pkc.validateComment rejects it as ERR_INVALID_COMMENT_IPFS", async () => {
                // A comment loaded normally, so raw.commentUpdate and postCid are real: validateComment
                // requires both before it verifies anything. Only raw.comment is swapped for the
                // mismatched record, which is what the CommentIpfs check then rejects.
                const loaded = await pkc.createComment({ cid: crossposting.cid! });
                await loaded.update();
                await resolveWhenConditionIsTrue({ toUpdate: loaded, predicate: async () => typeof loaded.updatedAt === "number" });
                await loaded.stop();

                const mismatched = JSON.parse(JSON.stringify(crosspost));
                mismatched.comment.content = "the crossposter rewrote this and left cid alone";
                const signed = await generateMockPost({ communityAddress, pkc, postProps: { crosspost: mismatched } });
                loaded.raw.comment = { ...signed.raw.pubsubMessageToPublish!, depth: 0 } as CommentIpfsType;

                let error: PKCError | undefined;
                try {
                    await pkc.validateComment(loaded);
                } catch (e) {
                    error = e as PKCError;
                }
                expect(error, "validateComment must not accept a mismatched crosspost.cid").to.exist;
                expect(error!.code).to.equal("ERR_INVALID_COMMENT_IPFS");
                expect(error!.details.commentIpfsValidity.reason).to.equal(messages.ERR_CROSSPOST_CID_DOES_NOT_MATCH_EMBEDDED_COMMENT);
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

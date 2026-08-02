// Crossposts (issue #32) — tier-1 verification of the embedded record.
//
// Tier 1 is local and does no network I/O. It proves who wrote the embedded content and that they
// *claim* it was posted to the community named in the embedded record. It proves nothing about the
// fields the hosting community added and the author never signed (depth, thumbnailUrl*, previousCid,
// pseudonymityMode), nor about that community having accepted the comment. See
// docs/protocol/crossposts.md.
//
// Verification is wired into verifyCommentPubsubMessage rather than verifyCommentIpfs so the single
// call site covers both the community's acceptance path and every client fetch path.
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { clone } from "remeda";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import signers from "../../fixtures/signers.js";
import { generateMockPost, publishRandomPost, getAvailablePKCConfigsToTestAgainst } from "../../../dist/node/test/test-util.js";
import { verifyCommentIpfs, verifyCommentPubsubMessage } from "../../../dist/node/signer/signatures.js";
import { messages } from "../../../dist/node/errors.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type { CommentIpfsType, CommentPubsubMessagePublication } from "../../../dist/node/publications/comment/types.js";

const communityAddress = signers[0].address;

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe.concurrent(`crosspost tier-1 verification - ${config.name}`, async () => {
        let pkc: PKC;
        let original: Comment; // a genuine published comment, used as the record to embed
        let crosspostRef: { cid: string; comment: CommentIpfsType };
        let clientsManager: Comment["_clientsManager"];

        // Signs a crossposting comment locally. createComment signs eagerly when the community
        // public key is known, so pubsubMessageToPublish is populated without publishing.
        const signCrossposting = async (crosspost: unknown): Promise<CommentPubsubMessagePublication> => {
            const comment = await generateMockPost({
                communityAddress,
                pkc,
                postProps: { crosspost } as Partial<Parameters<typeof generateMockPost>[0]["postProps"]>
            });
            return comment.raw.pubsubMessageToPublish!;
        };

        const verify = async (comment: CommentPubsubMessagePublication) =>
            verifyCommentPubsubMessage({ comment, resolveAuthorNames: false, clientsManager });

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
            original = await publishRandomPost({ communityAddress, pkc });
            crosspostRef = { cid: original.cid!, comment: original.raw.comment! };
            clientsManager = original._clientsManager;
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        describe("a well-formed crosspost verifies", () => {
            it("a crosspost of a genuine published comment is valid", async () => {
                expect(await verify(await signCrossposting(crosspostRef))).to.deep.equal({ valid: true });
            });

            it("the embedded record's cid is reproducible from its own bytes", async () => {
                expect(await calculateIpfsHash(deterministicStringify(crosspostRef.comment)!)).to.equal(crosspostRef.cid);
            });

            it("a comment with no crosspost is unaffected", async () => {
                const plain = await generateMockPost({ communityAddress, pkc });
                expect(await verify(plain.raw.pubsubMessageToPublish!)).to.deep.equal({ valid: true });
            });
        });

        describe("check 1: cid must match the embedded bytes", () => {
            it("a cid pointing at different bytes is rejected", async () => {
                const wrong = { ...crosspostRef, cid: "QmYjtig7VJQ6XsnUjqqJvj7QaMcCAwtrgNdahSiFofrE7o" };
                expect(await verify(await signCrossposting(wrong))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_CID_DOES_NOT_MATCH_EMBEDDED_COMMENT
                });
            });

            it("mutating the embedded content without updating cid is rejected", async () => {
                const tampered = clone(crosspostRef);
                tampered.comment.content = "tampered by the crossposter";
                expect(await verify(await signCrossposting(tampered))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_CID_DOES_NOT_MATCH_EMBEDDED_COMMENT
                });
            });

            it("adding a field to the embedded record without updating cid is rejected", async () => {
                const tampered = clone(crosspostRef) as Record<string, any>;
                tampered.comment.thumbnailUrl = "https://example.com/attacker.png";
                expect(await verify(await signCrossposting(tampered))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_CID_DOES_NOT_MATCH_EMBEDDED_COMMENT
                });
            });

            it("removing a field from the embedded record without updating cid is rejected", async () => {
                const tampered = clone(crosspostRef) as Record<string, any>;
                delete tampered.comment.title;
                expect(await verify(await signCrossposting(tampered))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_CID_DOES_NOT_MATCH_EMBEDDED_COMMENT
                });
            });
        });

        describe("check 2: the embedded record's author signature", () => {
            it("a tampered embedded signature is rejected", async () => {
                // Re-point cid at the tampered bytes so check 1 passes and check 2 is what fails.
                const tampered = clone(crosspostRef);
                tampered.comment.content = "tampered, but consistently hashed";
                tampered.cid = await calculateIpfsHash(deterministicStringify(tampered.comment)!);
                expect(await verify(await signCrossposting(tampered))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID
                });
            });

            it("a re-signed embedded record from a different key is rejected", async () => {
                const tampered = clone(crosspostRef) as Record<string, any>;
                tampered.comment.signature.publicKey = signers[3].publicKey;
                tampered.cid = await calculateIpfsHash(deterministicStringify(tampered.comment)!);
                expect(await verify(await signCrossposting(tampered))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID
                });
            });
        });

        describe("check 3: no reserved fields on the embedded record", () => {
            it("an embedded record carrying a reserved field is rejected", async () => {
                const tampered = clone(crosspostRef) as Record<string, any>;
                tampered.comment.cid = crosspostRef.cid; // `cid` is runtime-only on a CommentIpfs
                tampered.cid = await calculateIpfsHash(deterministicStringify(tampered.comment)!);
                expect(await verify(await signCrossposting(tampered))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_INCLUDES_RESERVED_FIELD
                });
            });

            it("an embedded record whose author carries a reserved field is rejected", async () => {
                const tampered = clone(crosspostRef) as Record<string, any>;
                tampered.comment.author = { ...tampered.comment.author, nameResolved: true };
                tampered.cid = await calculateIpfsHash(deterministicStringify(tampered.comment)!);
                expect(await verify(await signCrossposting(tampered))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_AUTHOR_INCLUDES_RESERVED_FIELD
                });
            });
        });

        // The embedded record belongs to a different community by construction, so the host
        // community's identity checks must not be applied to it.
        describe("the embedded record is not checked against the host community", () => {
            it("a crosspost of a comment from this same community is allowed", async () => {
                // Same-community crossposts are deliberately permitted, not treated as a mismatch.
                expect(await verify(await signCrossposting(crosspostRef))).to.deep.equal({ valid: true });
            });
        });

        describe("chains verify recursively", () => {
            it("a two-level chain verifies at every level", async () => {
                const inner = await signCrossposting(crosspostRef);
                const innerAsRecord = { ...inner, depth: 0 };
                const chain = { cid: await calculateIpfsHash(deterministicStringify(innerAsRecord)!), comment: innerAsRecord };
                expect(await verify(await signCrossposting(chain))).to.deep.equal({ valid: true });
            });

            it("a broken signature at the innermost level fails the whole outer comment", async () => {
                const brokenInner = clone(crosspostRef);
                brokenInner.comment.content = "tampered at the bottom of the chain";
                brokenInner.cid = await calculateIpfsHash(deterministicStringify(brokenInner.comment)!);

                const mid = await signCrossposting(brokenInner);
                const midAsRecord = { ...mid, depth: 0 };
                const chain = { cid: await calculateIpfsHash(deterministicStringify(midAsRecord)!), comment: midAsRecord };
                expect(await verify(await signCrossposting(chain))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID
                });
            });

            // The three checks above are each exercised at depth 1. Recursion means they must also
            // hold at depth 2 and beyond: a check that silently stops descending would let an
            // attacker hide a bad record one level further down than anyone tests.
            //
            // On the reason these assert: _verifyCrosspost flattens every recursive failure to
            // ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID, because the recursion runs through
            // verifyCommentPubsubMessage and its result is mapped to that one message regardless of
            // which check actually failed. So a cid mismatch or a reserved field below depth 1 is
            // reported as a bad signature. Rejection is the property that matters and these pin it;
            // the message is pinned too so that improving it is a deliberate edit rather than an
            // accidental change nobody notices.
            const wrapNextLevel = async (inner: { cid: string; comment: CommentIpfsType }) => {
                const mid = await signCrossposting(inner);
                const midAsRecord = { ...mid, depth: 0 } as unknown as CommentIpfsType;
                return { cid: await calculateIpfsHash(deterministicStringify(midAsRecord)!), comment: midAsRecord };
            };

            it("check 1 still applies at the innermost level: a cid not matching the inner bytes is rejected", async () => {
                const badCidInner = clone(crosspostRef);
                badCidInner.cid = await calculateIpfsHash("some other bytes entirely"); // not the hash of badCidInner.comment

                // flattened to the signature message, see above
                expect(await verify(await signCrossposting(await wrapNextLevel(badCidInner)))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID
                });
            });

            it("check 3 still applies at the innermost level: a reserved field on the inner record is rejected", async () => {
                const reservedInner = clone(crosspostRef) as Record<string, any>;
                reservedInner.comment.cid = crosspostRef.cid; // `cid` is runtime-only on a CommentIpfs
                reservedInner.cid = await calculateIpfsHash(deterministicStringify(reservedInner.comment)!);

                // flattened to the signature message, see above
                expect(await verify(await signCrossposting(await wrapNextLevel(reservedInner as any)))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID
                });
            });

            it("check 3 still applies at the innermost level: a reserved author field on the inner record is rejected", async () => {
                const reservedInner = clone(crosspostRef) as Record<string, any>;
                reservedInner.comment.author = { ...reservedInner.comment.author, nameResolved: true };
                reservedInner.cid = await calculateIpfsHash(deterministicStringify(reservedInner.comment)!);

                // flattened to the signature message, see above
                expect(await verify(await signCrossposting(await wrapNextLevel(reservedInner as any)))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID
                });
            });

            // Depth 1 is the one level where the specific reason does survive, so it stays distinct
            // from the flattened cases above.
            it("at depth 1 the specific failing check is still reported", async () => {
                const badCid = clone(crosspostRef);
                badCid.cid = await calculateIpfsHash("some other bytes entirely");
                expect(await verify(await signCrossposting(badCid))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_CID_DOES_NOT_MATCH_EMBEDDED_COMMENT
                });
            });
        });

        // There is deliberately no nesting-depth cap: the 40kb publication limit is the only bound.
        // These pin what that bound actually buys, so a change that shrinks the per-level byte cost
        // (and therefore lets chains get much deeper) or that makes verification stop descending
        // shows up as a failure rather than as a silent shift.
        describe("the size limit is the only depth bound", () => {
            // Builds the deepest chain that still fits under the publication size limit.
            const buildDeepestChainWithinLimit = async () => {
                let ref = crosspostRef as { cid: string; comment: CommentIpfsType };
                let deepest = await signCrossposting(ref);
                let depth = 1;
                for (let i = 0; i < 200; i++) {
                    const signed = await signCrossposting(ref);
                    if (Buffer.byteLength(JSON.stringify(signed)) > 40000) break;
                    deepest = signed;
                    depth = i + 1;
                    const asRecord = { ...signed, depth: 0 } as unknown as CommentIpfsType;
                    ref = { cid: await calculateIpfsHash(deterministicStringify(asRecord)!), comment: asRecord };
                }
                return { deepest, depth };
            };

            it("the deepest chain that fits under 40kb verifies at every level", async () => {
                const { deepest, depth } = await buildDeepestChainWithinLimit();
                expect(Buffer.byteLength(JSON.stringify(deepest))).to.be.lessThan(40000);
                // Measured at 62 levels when this was written. The band is wide on purpose: the exact
                // number moves whenever a wire field is added. A jump outside it means the per-level
                // cost changed materially and the depth bound moved with it.
                expect(depth).to.be.within(20, 150);
                expect(await verify(deepest)).to.deep.equal({ valid: true });
            });

            it("a broken signature at the bottom of a max-depth chain is still caught", async () => {
                // The recursion has to reach the very bottom. If it ever short-circuits at some depth,
                // this is what notices.
                const broken = clone(crosspostRef);
                broken.comment.content = "tampered at the bottom of a very deep chain";
                broken.cid = await calculateIpfsHash(deterministicStringify(broken.comment)!);

                let ref = broken as { cid: string; comment: CommentIpfsType };
                let deepest = await signCrossposting(ref);
                for (let i = 0; i < 200; i++) {
                    const signed = await signCrossposting(ref);
                    if (Buffer.byteLength(JSON.stringify(signed)) > 40000) break;
                    deepest = signed;
                    const asRecord = { ...signed, depth: 0 } as unknown as CommentIpfsType;
                    ref = { cid: await calculateIpfsHash(deterministicStringify(asRecord)!), comment: asRecord };
                }
                expect(await verify(deepest)).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID
                });
            });
        });

        // verifyCommentIpfs caches on the outer comment's signature + cid, and the check sits above
        // the crosspost work, so the cost of a chain is paid once per comment rather than on every
        // page load. Moving _verifyCrosspost above the cache lookup, or dropping the cache write,
        // would make deep chains re-verify on every read.
        describe("verification of a crossposting comment is cached", () => {
            it("a repeat verifyCommentIpfs of the same crossposting comment short-circuits", async () => {
                const signed = await signCrossposting(crosspostRef);
                const asRecord = { ...signed, depth: 0 } as unknown as CommentIpfsType;
                const cid = await calculateIpfsHash(deterministicStringify(asRecord)!);
                const args = { comment: asRecord, calculatedCommentCid: cid, resolveAuthorNames: false, clientsManager };

                expect(await verifyCommentIpfs(args)).to.deep.equal({ valid: true });

                // Corrupt the embedded record. A cached hit must not re-run the crosspost checks, so
                // this still reports valid; that is the observable proof the cache covers them.
                const corrupted = clone(asRecord) as Record<string, any>;
                corrupted.crosspost.comment.content = "changed after the first verification";
                expect(await verifyCommentIpfs({ ...args, comment: corrupted as unknown as CommentIpfsType })).to.deep.equal({
                    valid: true
                });
            });
        });
    });
});

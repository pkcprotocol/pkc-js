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

// TextEncoder, not Buffer.byteLength — this file runs in the browser bundle too, where Buffer is absent
const byteLength = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

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
                const tampered = clone(crosspostRef);
                tampered.comment.thumbnailUrl = "https://example.com/attacker.png";
                expect(await verify(await signCrossposting(tampered))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_CID_DOES_NOT_MATCH_EMBEDDED_COMMENT
                });
            });

            it("removing a field from the embedded record without updating cid is rejected", async () => {
                const tampered = clone(crosspostRef);
                delete tampered.comment.title;
                expect(await verify(await signCrossposting(tampered))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_CID_DOES_NOT_MATCH_EMBEDDED_COMMENT
                });
            });
        });

        describe("check 4: the embedded record's author signature", () => {
            it("a tampered embedded signature is rejected", async () => {
                // Re-point cid at the tampered bytes so check 1 passes and check 4 is what fails.
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

        describe("check 2: no reserved fields on the embedded record", () => {
            it("an embedded record carrying a reserved field is rejected", async () => {
                const tampered = clone(crosspostRef) as Record<string, any>;
                tampered.comment.cid = crosspostRef.cid; // `cid` is runtime-only on a CommentIpfs
                tampered.cid = await calculateIpfsHash(deterministicStringify(tampered.comment)!);
                expect(await verify(await signCrossposting(tampered))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_INCLUDES_RESERVED_FIELD
                });
            });

            // shortAddress rather than nameResolved, even though nameResolved is the field this check
            // matters most for: createComment now strips nameResolved from a crosspost before signing
            // (issue #251), so building the record through it would move the cid and fire check 1
            // instead. crosspost/name-resolved.test.ts covers nameResolved specifically, by signing
            // directly the way a foreign implementation would.
            it("an embedded record whose author carries a reserved field is rejected", async () => {
                const tampered = clone(crosspostRef) as Record<string, any>;
                tampered.comment.author = { ...tampered.comment.author, shortAddress: "12D3KooWN5rL" };
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
                const innerAsRecord = { ...inner, depth: 0 }; // comment.depth: a post
                const chain = { cid: await calculateIpfsHash(deterministicStringify(innerAsRecord)!), comment: innerAsRecord };
                expect(await verify(await signCrossposting(chain))).to.deep.equal({ valid: true });
            });

            it("a broken signature at the innermost level fails the whole outer comment", async () => {
                const brokenInner = clone(crosspostRef);
                brokenInner.comment.content = "tampered at the bottom of the chain";
                brokenInner.cid = await calculateIpfsHash(deterministicStringify(brokenInner.comment)!);

                const mid = await signCrossposting(brokenInner);
                const midAsRecord = { ...mid, depth: 0 }; // comment.depth: a post
                const chain = { cid: await calculateIpfsHash(deterministicStringify(midAsRecord)!), comment: midAsRecord };
                expect(await verify(await signCrossposting(chain))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID
                });
            });

            // "level" below counts crosspost nesting, not comment.depth: every record here is a post.
            // The three checks above are each exercised one crosspost in. Recursion means they must
            // also hold two crossposts in and beyond, since a check that silently stops descending
            // would let an attacker hide a bad record one level further down than anyone tests.
            //
            // On the reason these assert: _verifyCrosspost flattens every recursive failure to
            // ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID, because the recursion runs through
            // verifyCommentPubsubMessage and its result is mapped to that one message regardless of
            // which check actually failed. So a cid mismatch or a reserved field more than one
            // crosspost in is reported as a bad signature. Rejection is what matters and these pin it;
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

            it("check 2 still applies at the innermost level: a reserved field on the inner record is rejected", async () => {
                // `cid` is runtime-only on a CommentIpfs, so widening just that one field keeps the
                // rest of the record type-checked.
                const reservedInner = clone(crosspostRef) as { cid: string; comment: CommentIpfsType & { cid?: string } };
                reservedInner.comment.cid = crosspostRef.cid;
                reservedInner.cid = await calculateIpfsHash(deterministicStringify(reservedInner.comment)!);

                // flattened to the signature message, see above
                expect(await verify(await signCrossposting(await wrapNextLevel(reservedInner)))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID
                });
            });

            it("check 2 still applies at the innermost level: a reserved author field on the inner record is rejected", async () => {
                // `shortAddress` is runtime-only on the author, so widen just that one field.
                const reservedInner = clone(crosspostRef) as {
                    cid: string;
                    comment: CommentIpfsType & { author: CommentIpfsType["author"] & { shortAddress?: string } };
                };
                // shortAddress rather than nameResolved, for the reason given on check 2 above. It
                // matters more here: an inner failure flattens to the signature message either way, so
                // a stripped field would move the inner cid and this would still pass, on check 1.
                reservedInner.comment.author = { ...reservedInner.comment.author, shortAddress: "12D3KooWN5rL" };
                reservedInner.cid = await calculateIpfsHash(deterministicStringify(reservedInner.comment)!);

                // flattened to the signature message, see above
                expect(await verify(await signCrossposting(await wrapNextLevel(reservedInner)))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID
                });
            });

            // The outermost crosspost is the one level where the specific reason survives, so it
            // stays distinct from the flattened cases above.
            it("on a directly embedded record the specific failing check is still reported", async () => {
                const badCid = clone(crosspostRef);
                badCid.cid = await calculateIpfsHash("some other bytes entirely");
                expect(await verify(await signCrossposting(badCid))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_CID_DOES_NOT_MATCH_EMBEDDED_COMMENT
                });
            });
        });

        // signedPropertyNames lives inside `signature`, which is not part of the signed bytes, so a
        // record used to get to choose which of its own fields were verified. Nothing exotic was
        // needed to exploit that: _signJson derives the list from the fields actually present, so a
        // post signed without a crosspost simply has no `crosspost` entry, and attaching one
        // afterwards leaves the signature valid while the pick in check 4 hides the nested record
        // from the recursion. Issue #249.
        //
        // The fix rejects such a record outright: any author-signable field (one in
        // CommentSignedPropertyNames) present on the un-picked record but absent from
        // signature.signedPropertyNames invalidates it, so verified implies signed again. The guard
        // is deliberately restricted to the signable set: community-generated CommentIpfs fields
        // (depth, thumbnailUrl*, previousCid, pseudonymityMode) are legitimately unsigned, and
        // unknown extra props from future protocol versions must keep surviving loads.
        //
        // These reasons are the specific ones rather than the flattened
        // ERR_CROSSPOST_COMMENT_SIGNATURE_IS_INVALID above, because the guard runs in
        // _verifyCrosspost on the directly embedded record.
        describe("a record carrying an unsigned signable field is rejected outright (issue #249)", () => {
            // { cid, comment } whose comment carries an UNSIGNED crosspost pointing at `nested`.
            const embedWithUnsignedCrosspost = async (nested: { cid: string; comment: CommentIpfsType }) => {
                const carrier = (await generateMockPost({ communityAddress, pkc })).raw.pubsubMessageToPublish!;
                const record = { ...carrier, depth: 0, crosspost: nested } as unknown as CommentIpfsType; // comment.depth: a post
                return { cid: await calculateIpfsHash(deterministicStringify(record)!), comment: record };
            };

            it("the premise: a comment signed without a crosspost does not list one as signed", async () => {
                const plain = (await generateMockPost({ communityAddress, pkc })).raw.pubsubMessageToPublish!;
                expect(plain.signature.signedPropertyNames).to.not.include("crosspost");
            });

            it("an embedded record with an unsigned crosspost is rejected, even a well-formed one", async () => {
                expect(await verify(await signCrossposting(await embedWithUnsignedCrosspost(crosspostRef)))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_INCLUDES_SIGNABLE_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
                });
            });

            it("the unsigned subtree no longer decides the outcome: a tampered unsigned nested crosspost is rejected the same way", async () => {
                const badCid = clone(crosspostRef);
                badCid.cid = await calculateIpfsHash("some other bytes entirely");
                expect(await verify(await signCrossposting(await embedWithUnsignedCrosspost(badCid)))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_INCLUDES_SIGNABLE_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
                });
            });

            it("an unsigned non-crosspost signable field is rejected the same way", async () => {
                const carrier = (await generateMockPost({ communityAddress, pkc })).raw.pubsubMessageToPublish!;
                expect(carrier.signature.signedPropertyNames).to.not.include("spoiler");
                const record = { ...carrier, depth: 0, spoiler: true } as unknown as CommentIpfsType; // comment.depth: a post
                const embedded = { cid: await calculateIpfsHash(deterministicStringify(record)!), comment: record };
                expect(await verify(await signCrossposting(embedded))).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_INCLUDES_SIGNABLE_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
                });
            });

            it("control: community-generated unsigned fields do not trigger the guard", async () => {
                // crosspostRef.comment carries depth (and possibly thumbnail fields) unsigned, since
                // the hosting community adds them after the author signs.
                expect(crosspostRef.comment.signature.signedPropertyNames).to.not.include("depth");
                expect(await verify(await signCrossposting(crosspostRef))).to.deep.equal({ valid: true });
            });
        });

        // The same rule on the other picking path: a cid the client did not get from a
        // community-signed page or CommentUpdate goes through verifyCommentIpfs, which also picks by
        // signedPropertyNames before delegating. The guard runs on the raw record before that pick.
        describe("verifyCommentIpfs enforces the same rule on the raw record (issue #249)", () => {
            const verifyAsIpfs = async (record: CommentIpfsType) =>
                verifyCommentIpfs({
                    comment: record,
                    calculatedCommentCid: await calculateIpfsHash(deterministicStringify(record)!),
                    resolveAuthorNames: false,
                    clientsManager
                });

            it("a CommentIpfs carrying an unsigned crosspost is rejected", async () => {
                const carrier = (await generateMockPost({ communityAddress, pkc })).raw.pubsubMessageToPublish!;
                const record = { ...carrier, depth: 0, crosspost: crosspostRef } as unknown as CommentIpfsType;
                expect(await verifyAsIpfs(record)).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_COMMENT_IPFS_RECORD_INCLUDES_SIGNABLE_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
                });
            });

            it("a CommentIpfs carrying an unsigned non-crosspost signable field is rejected", async () => {
                const carrier = (await generateMockPost({ communityAddress, pkc })).raw.pubsubMessageToPublish!;
                const record = { ...carrier, depth: 0, spoiler: true } as unknown as CommentIpfsType;
                expect(await verifyAsIpfs(record)).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_COMMENT_IPFS_RECORD_INCLUDES_SIGNABLE_FIELD_NOT_IN_SIGNED_PROPERTY_NAMES
                });
            });

            it("control: the same record with the crosspost signed verifies", async () => {
                const signed = await signCrossposting(crosspostRef);
                const record = { ...signed, depth: 0 } as unknown as CommentIpfsType;
                expect(await verifyAsIpfs(record)).to.deep.equal({ valid: true });
            });
        });

        // There is deliberately no cap on how many crossposts can nest inside one another: the 40kb
        // publication limit is the only bound. These pin what that bound actually buys, so a change
        // that shrinks the per-level byte cost (and therefore lets chains nest further) or that makes
        // verification stop descending shows up as a failure rather than as a silent shift.
        //
        // "nesting" here is crosspost chaining (crosspost.comment.crosspost.comment...), which is a
        // different axis from comment.depth, the reply depth in the comment tree. Every record built
        // below is a post, comment.depth 0; only the crosspost chain gets longer.
        describe("the size limit is the only bound on crosspost nesting", () => {
            // Builds the most deeply nested chain that still fits under the publication size limit.
            const buildDeepestChainWithinLimit = async () => {
                let ref = crosspostRef as { cid: string; comment: CommentIpfsType };
                let deepest = await signCrossposting(ref);
                let nestingLevels = 1;
                for (let i = 0; i < 200; i++) {
                    const signed = await signCrossposting(ref);
                    if (byteLength(signed) > 40000) break;
                    deepest = signed;
                    nestingLevels = i + 1;
                    const asRecord = { ...signed, depth: 0 } as unknown as CommentIpfsType; // comment.depth: a post
                    ref = { cid: await calculateIpfsHash(deterministicStringify(asRecord)!), comment: asRecord };
                }
                return { deepest, nestingLevels };
            };

            it("the most deeply nested chain that fits under 40kb verifies at every level", async () => {
                const { deepest, nestingLevels } = await buildDeepestChainWithinLimit();
                // at.most, not lessThan: exactly 40000 bytes is a legal publication (the community
                // rejects only sizes over 40kb), and the builder keeps a record that lands on it.
                expect(byteLength(deepest)).to.be.at.most(40000);
                // Measured at 62 nested crossposts when this was written. The band is wide on purpose:
                // the exact number moves whenever a wire field is added. A jump outside it means the
                // per-level byte cost changed materially and the nesting bound moved with it.
                expect(nestingLevels).to.be.within(20, 150);
                expect(await verify(deepest)).to.deep.equal({ valid: true });
            });

            it("a broken signature at the bottom of a maximally nested chain is still caught", async () => {
                // The recursion has to reach the innermost crosspost. If it ever short-circuits part
                // way down the chain, this is what notices.
                const broken = clone(crosspostRef);
                broken.comment.content = "tampered at the bottom of a very deep chain";
                broken.cid = await calculateIpfsHash(deterministicStringify(broken.comment)!);

                let ref = broken as { cid: string; comment: CommentIpfsType };
                let deepest = await signCrossposting(ref);
                for (let i = 0; i < 200; i++) {
                    const signed = await signCrossposting(ref);
                    if (byteLength(signed) > 40000) break;
                    deepest = signed;
                    const asRecord = { ...signed, depth: 0 } as unknown as CommentIpfsType; // comment.depth: a post
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

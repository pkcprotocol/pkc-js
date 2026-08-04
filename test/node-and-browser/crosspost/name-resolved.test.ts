// Crossposts (issue #32) — nameResolved on the embedded record's author (issue #251).
//
// Tier 1 proves who *signed* the embedded record, not who they are. author.address is derived as
// name || publicKey, so a name is only a claim: anyone can generate a keypair, set author.name to
// somebody else's domain, and sign a record that passes all three tier-1 checks. What catches that
// is domain resolution setting nameResolved, and until #251 it never ran for an embedded record, so
// a client rendering "originally by <name>" had no signal at all.
//
// nameResolved stays runtime-only. comment.crosspost is therefore a copy: crosspost.cid hashes the
// embedded record whole, so writing into raw.comment.crosspost would stop it reproducing its own cid.
// The raw assertions below are what pin that separation.
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { clone } from "remeda";
import { of as calculateIpfsHash } from "typestub-ipfs-only-hash";
import { stringify as deterministicStringify } from "safe-stable-stringify";
import signers from "../../fixtures/signers.js";
import {
    generateMockPost,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    getAvailablePKCConfigsToTestAgainst
} from "../../../dist/node/test/test-util.js";
import { signComment, verifyCommentPubsubMessage } from "../../../dist/node/signer/signatures.js";
import { messages } from "../../../dist/node/errors.js";
import { extractCrosspostRuntimeFields } from "../../../dist/node/publications/comment/crosspost-runtime.js";
import { deepMergeRuntimeFields } from "../../../dist/node/util.js";
import type { PKC } from "../../../dist/node/pkc/pkc.js";
import type { Comment } from "../../../dist/node/publications/comment/comment.js";
import type {
    CommentIpfsType,
    CommentOptionsToSign,
    CommentPubsubMessagePublication
} from "../../../dist/node/publications/comment/types.js";

const communityAddress = signers[0].address;

// The mock resolver maps plebbit.bso -> signers[3] and testgibbreish.bso -> signers[4].
const RESOLVES_TO_SIGNER = { name: "plebbit.bso", signer: signers[3] };
const IMPERSONATED = { name: "plebbit.bso", signer: signers[7] }; // signed by somebody the domain does not point at
const NO_RESOLVER_FOR_TLD = { name: "hello.scam", signer: signers[5] };
// Used only by the chain test, so nothing else in this file can warm its cache entry.
const RESOLVES_BUT_ONLY_IF_ASKED = { name: "testgibbreish.bso", signer: signers[4] };

getAvailablePKCConfigsToTestAgainst().map((config) => {
    describe(`crosspost.comment.author.nameResolved - ${config.name}`, async () => {
        let pkc: PKC;

        // A signed CommentIpfs-shaped record for the identity under test. Deliberately not published:
        // tier 1 reads only the embedded bytes, so the referenced comment does not have to exist, and
        // an impersonating record would not be accepted by a community anyway.
        const embeddedRecordBy = async (author?: { name: string; signer: (typeof signers)[number] }) => {
            const post = await generateMockPost({
                communityAddress,
                pkc,
                postProps: author ? { author: { name: author.name }, signer: author.signer } : {}
            });
            // depth: what a community adds on acceptance, making this CommentIpfs-shaped
            const comment = { ...post.raw.pubsubMessageToPublish!, depth: 0 } as unknown as CommentIpfsType;
            return { cid: await calculateIpfsHash(deterministicStringify(comment)!), comment };
        };

        const publishCrosspostOf = async (crosspost: unknown) => {
            const crossposting = await generateMockPost({
                communityAddress,
                pkc,
                postProps: { crosspost } as Partial<Parameters<typeof generateMockPost>[0]["postProps"]>
            });
            await publishWithExpectedResult({ publication: crossposting, expectedChallengeSuccess: true });
            return crossposting;
        };

        const loadUntilLoaded = async (cid: string) => {
            const loaded = await pkc.createComment({ cid });
            await loaded.update();
            await resolveWhenConditionIsTrue({ toUpdate: loaded, predicate: async () => typeof loaded.updatedAt === "number" });
            return loaded;
        };

        const embeddedNameResolvedOf = (comment: Comment) => comment.crosspost?.comment.author?.nameResolved;

        beforeAll(async () => {
            pkc = await config.pkcInstancePromise();
        });

        afterAll(async () => {
            await pkc.destroy();
        });

        describe("the verdict a client renders on", () => {
            it("true when the embedded author's domain points at the key that signed the record", async () => {
                const crosspost = await embeddedRecordBy(RESOLVES_TO_SIGNER);
                const crossposting = await publishCrosspostOf(crosspost);
                const loaded = await loadUntilLoaded(crossposting.cid!);
                await resolveWhenConditionIsTrue({
                    toUpdate: loaded,
                    predicate: async () => typeof embeddedNameResolvedOf(loaded) === "boolean"
                });
                expect(embeddedNameResolvedOf(loaded)).to.be.true;
                await loaded.stop();
            });

            // The case the whole feature exists for. Tier 1 passes here: the record is validly signed,
            // the cid matches, no reserved fields. Only resolution reveals that the name belongs to
            // somebody else.
            it("false when the embedded author's name resolves to a different key", async () => {
                const crosspost = await embeddedRecordBy(IMPERSONATED);
                const crossposting = await publishCrosspostOf(crosspost);
                const loaded = await loadUntilLoaded(crossposting.cid!);
                await resolveWhenConditionIsTrue({
                    toUpdate: loaded,
                    predicate: async () => typeof embeddedNameResolvedOf(loaded) === "boolean"
                });
                expect(embeddedNameResolvedOf(loaded)).to.be.false;
                await loaded.stop();
            });

            it("the impersonating crosspost still passes tier-1 verification, which is why this is needed", async () => {
                const crosspost = await embeddedRecordBy(IMPERSONATED);
                const crossposting = await generateMockPost({
                    communityAddress,
                    pkc,
                    postProps: { crosspost } as Partial<Parameters<typeof generateMockPost>[0]["postProps"]>
                });
                const validity = await verifyCommentPubsubMessage({
                    comment: crossposting.raw.pubsubMessageToPublish!,
                    resolveAuthorNames: false,
                    clientsManager: crossposting._clientsManager
                });
                expect(validity).to.deep.equal({ valid: true });
            });

            it("undefined when no resolver in this instance handles the embedded author's TLD", async () => {
                const crosspost = await embeddedRecordBy(NO_RESOLVER_FOR_TLD);
                const crossposting = await publishCrosspostOf(crosspost);
                const loaded = await loadUntilLoaded(crossposting.cid!);
                expect(embeddedNameResolvedOf(loaded)).to.be.undefined;
                await loaded.stop();
            });

            it("undefined when the embedded author has no name at all", async () => {
                const crosspost = await embeddedRecordBy();
                const crossposting = await publishCrosspostOf(crosspost);
                const loaded = await loadUntilLoaded(crossposting.cid!);
                expect(embeddedNameResolvedOf(loaded)).to.be.undefined;
                await loaded.stop();
            });
        });

        // The reason comment.crosspost is a copy rather than the wire object.
        describe("the wire record is untouched", () => {
            let loaded: Comment;
            let crosspost: { cid: string; comment: CommentIpfsType };

            beforeAll(async () => {
                crosspost = await embeddedRecordBy(RESOLVES_TO_SIGNER);
                const crossposting = await publishCrosspostOf(crosspost);
                loaded = await loadUntilLoaded(crossposting.cid!);
                await resolveWhenConditionIsTrue({
                    toUpdate: loaded,
                    predicate: async () => typeof embeddedNameResolvedOf(loaded) === "boolean"
                });
            });

            afterAll(async () => {
                await loaded.stop();
            });

            it("raw.comment.crosspost never carries nameResolved", () => {
                expect(loaded.raw.comment!.crosspost!.comment.author!).to.not.have.property("nameResolved");
            });

            it("raw.comment.crosspost still reproduces crosspost.cid", async () => {
                expect(await calculateIpfsHash(deterministicStringify(loaded.raw.comment!.crosspost!.comment)!)).to.equal(crosspost.cid);
            });

            it("comment.crosspost is a copy, not the same object as the wire record", () => {
                expect(loaded.crosspost).to.not.equal(loaded.raw.comment!.crosspost);
                expect(loaded.crosspost!.comment.author).to.not.equal(loaded.raw.comment!.crosspost!.comment.author);
            });

            // A client re-crossposting what it just read passes the runtime copy straight back in.
            // The runtime field has to come back off before signing, or the record would no longer
            // hash to crosspost.cid and would be rejected as a reserved field besides.
            it("re-crossposting the runtime copy reproduces the original wire bytes", async () => {
                expect(embeddedNameResolvedOf(loaded), "the test is vacuous unless a verdict is present").to.be.a("boolean");

                const republished = await generateMockPost({
                    communityAddress,
                    pkc,
                    postProps: { crosspost: loaded.crosspost } as Partial<Parameters<typeof generateMockPost>[0]["postProps"]>
                });
                const wireCrosspost = republished.raw.pubsubMessageToPublish!.crosspost!;
                expect(wireCrosspost.comment.author!).to.not.have.property("nameResolved");
                expect(await calculateIpfsHash(deterministicStringify(wireCrosspost.comment)!)).to.equal(crosspost.cid);
                expect(wireCrosspost).to.deep.equal(crosspost);
                await publishWithExpectedResult({ publication: republished, expectedChallengeSuccess: true });
            });

            it("and the instance the caller passed in is not mutated by that", () => {
                expect(embeddedNameResolvedOf(loaded)).to.be.a("boolean");
            });
        });

        // nameResolved is runtime-only, so a record arriving with one is asserting a verdict it has no
        // standing to assert. Check 3 of _verifyCrosspost rejects it, and that is what makes stripping
        // on the publish path sufficient rather than merely tidy.
        //
        // createComment cannot produce this record: it strips the field before signing, so the cid
        // would stop matching and check 1 would fire first. Signed directly here instead, which is
        // what a record forged by another implementation looks like on the wire.
        describe("an embedded record that arrives already carrying nameResolved", () => {
            let validity: Awaited<ReturnType<typeof verifyCommentPubsubMessage>>;

            beforeAll(async () => {
                const crosspost = clone(await embeddedRecordBy(IMPERSONATED)) as {
                    cid: string;
                    comment: CommentIpfsType & { author: Record<string, unknown> };
                };
                crosspost.comment.author.nameResolved = true;
                // cid recomputed over the tampered bytes, so check 1 passes and check 3 is what fires
                crosspost.cid = await calculateIpfsHash(deterministicStringify(crosspost.comment)!);

                // A normally created comment, only for its resolved community fields.
                const reference = await generateMockPost({ communityAddress, pkc });
                const optionsToSign: Record<string, unknown> = {
                    communityAddress,
                    communityPublicKey: reference.communityPublicKey,
                    ...(reference.communityName ? { communityName: reference.communityName } : {}),
                    title: "forged crosspost",
                    content: "forged crosspost",
                    timestamp: reference.timestamp,
                    protocolVersion: reference.protocolVersion,
                    signer: await pkc.createSigner(),
                    crosspost
                };
                const signature = await signComment({ comment: optionsToSign as unknown as CommentOptionsToSign, pkc });
                const forged = {
                    ...Object.fromEntries(signature.signedPropertyNames.map((name) => [name, optionsToSign[name]])),
                    signature
                } as unknown as CommentPubsubMessagePublication;

                validity = await verifyCommentPubsubMessage({
                    comment: forged,
                    resolveAuthorNames: false,
                    clientsManager: reference._clientsManager
                });
            });

            it("is rejected as a reserved field on the embedded author", () => {
                expect(validity).to.deep.equal({
                    valid: false,
                    reason: messages.ERR_CROSSPOST_COMMENT_AUTHOR_INCLUDES_RESERVED_FIELD
                });
            });
        });

        // An RPC client resolves nothing itself: it usually has no nameResolvers configured and would
        // wrongly conclude false, so the server ships what it resolved through runtimeFields. The two
        // halves are unit-tested here because the end-to-end loop needs a test server running this
        // branch's dist, and a stale server would fail this file for a reason that has nothing to do
        // with the transport being right.
        describe("the runtime-fields transport RPC clients receive it through", () => {
            let crosspost: { cid: string; comment: CommentIpfsType };

            beforeAll(async () => {
                crosspost = await embeddedRecordBy(RESOLVES_TO_SIGNER);
            });

            it("is undefined when no level has a verdict, so nothing is sent", async () => {
                const crossposting = await generateMockPost({
                    communityAddress,
                    pkc,
                    postProps: { crosspost } as Partial<Parameters<typeof generateMockPost>[0]["postProps"]>
                });
                expect(extractCrosspostRuntimeFields(crossposting.crosspost!)).to.be.undefined;
            });

            it("mirrors the object path the verdict sits at", async () => {
                const crossposting = await generateMockPost({
                    communityAddress,
                    pkc,
                    postProps: { crosspost } as Partial<Parameters<typeof generateMockPost>[0]["postProps"]>
                });
                crossposting.crosspost!.comment.author!.nameResolved = false;
                expect(extractCrosspostRuntimeFields(crossposting.crosspost!)).to.deep.equal({
                    comment: { author: { nameResolved: false } }
                });
            });

            // The client half. deepMergeRuntimeFields refuses to create new complex properties, so
            // this only works because the instance already built its crosspost copy from the raw
            // record before the merge runs.
            it("merges onto an instance that built its crosspost from the raw record", async () => {
                const crossposting = await generateMockPost({
                    communityAddress,
                    pkc,
                    postProps: { crosspost } as Partial<Parameters<typeof generateMockPost>[0]["postProps"]>
                });
                expect(crossposting.crosspost!.comment.author!.nameResolved).to.be.undefined;

                deepMergeRuntimeFields(crossposting, { crosspost: { comment: { author: { nameResolved: true } } } });

                expect(crossposting.crosspost!.comment.author!.nameResolved).to.be.true;
                // and the wire record is still untouched by the merge
                expect(crossposting.raw.pubsubMessageToPublish!.crosspost!.comment.author!).to.not.have.property("nameResolved");
            });
        });

        // Chains are attacker-controlled in both depth and content (#249, #250), so one fetched
        // comment must not turn into an unbounded number of name resolutions. Only the first level
        // gets a resolution triggered for it. Deeper levels still pick up a cached verdict for free,
        // which is why the domain below is used nowhere else in this file.
        describe("only the first chain level triggers a resolution", () => {
            let loaded: Comment;

            beforeAll(async () => {
                const inner = await embeddedRecordBy(RESOLVES_BUT_ONLY_IF_ASKED);
                const middle = await generateMockPost({
                    communityAddress,
                    pkc,
                    postProps: {
                        author: { name: RESOLVES_TO_SIGNER.name },
                        signer: RESOLVES_TO_SIGNER.signer,
                        crosspost: inner
                    } as Partial<Parameters<typeof generateMockPost>[0]["postProps"]>
                });
                const middleComment = { ...middle.raw.pubsubMessageToPublish!, depth: 0 } as unknown as CommentIpfsType;
                const outer = {
                    cid: await calculateIpfsHash(deterministicStringify(middleComment)!),
                    comment: middleComment
                };
                const crossposting = await publishCrosspostOf(outer);
                loaded = await loadUntilLoaded(crossposting.cid!);
                await resolveWhenConditionIsTrue({
                    toUpdate: loaded,
                    predicate: async () => typeof embeddedNameResolvedOf(loaded) === "boolean"
                });
            });

            afterAll(async () => {
                await loaded.stop();
            });

            it("the first level gets a verdict", () => {
                expect(embeddedNameResolvedOf(loaded)).to.be.true;
            });

            it("the second level does not, even though its domain would resolve", () => {
                expect(loaded.crosspost!.comment.crosspost!.comment.author?.nameResolved).to.be.undefined;
            });

            it("the whole chain is still exposed, it just has no verdict below the first level", () => {
                expect(loaded.crosspost!.comment.crosspost!.comment.author?.name).to.equal(RESOLVES_BUT_ONLY_IF_ASKED.name);
            });
        });
    });
});

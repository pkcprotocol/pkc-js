import { beforeAll, afterAll, describe, it, expect } from "vitest";
import signers from "../../../fixtures/signers.js";
import {
    publishWithExpectedResult,
    publishRandomPost,
    itSkipIfRpc,
    mockNameResolvers,
    resolveWhenConditionIsTrue,
    mockPlebbitV2,
    getAvailablePlebbitConfigsToTestAgainst,
    createStaticSubplebbitRecordForComment
} from "../../../../dist/node/test/test-util.js";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";

const subplebbitAddress = signers[0].address;

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe(`author.nameResolved - ${config.name}`, async () => {
        let plebbit: Plebbit;
        let domainCommentCid: string;
        let noDomainCommentCid: string;
        let mismatchedDomainCommentCid: string;
        let unresolvableDomainCommentCid: string;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();

            // Publish a domain comment (plebbit.bso → signers[3]) for reuse across tests
            const domainComment = await publishRandomPost({
                subplebbitAddress,
                plebbit,
                postProps: {
                    author: { name: "plebbit.bso" },
                    signer: signers[3]
                }
            });
            domainCommentCid = domainComment.cid!;

            // Publish a non-domain comment for reuse
            const noDomainComment = await publishRandomPost({ subplebbitAddress, plebbit });
            noDomainCommentCid = noDomainComment.cid!;

            const mismatchedDomainComment = await createStaticSubplebbitRecordForComment({
                plebbit,
                commentOptions: {
                    author: { name: "plebbit.bso" },
                    signer: signers[7]
                }
            });
            mismatchedDomainCommentCid = mismatchedDomainComment.commentCid;

            // Comment with a domain that no resolver can resolve
            const unresolvableDomainComment = await createStaticSubplebbitRecordForComment({
                plebbit,
                commentOptions: {
                    author: { name: "hello.scam" },
                    signer: signers[5]
                }
            });
            unresolvableDomainCommentCid = unresolvableDomainComment.commentCid;
        });

        afterAll(async () => {
            await plebbit.destroy();
        });

        // === Tests that work for ALL configs ===

        it("nameResolved is undefined when loading a non-domain comment via comment.update()", async () => {
            const loaded = await plebbit.createComment({ cid: noDomainCommentCid });
            await loaded.update();
            await resolveWhenConditionIsTrue({
                toUpdate: loaded,
                predicate: async () => Boolean(loaded.content)
            });
            await loaded.stop();

            expect(loaded.author.nameResolved).to.be.undefined;
        });

        it("nameResolved is true when loading a domain comment via comment.update()", async () => {
            const loaded = await plebbit.createComment({ cid: domainCommentCid });
            await loaded.update();
            await resolveWhenConditionIsTrue({
                toUpdate: loaded,
                predicate: async () => Boolean(loaded.content)
            });
            await loaded.stop();

            expect(loaded.author.nameResolved).to.equal(true);
            expect(loaded.author.address).to.equal("plebbit.bso");
        });

        it("nameResolved is true immediately after challenge verification", async () => {
            const comment = await plebbit.createComment({
                author: { displayName: `Test Author - ${Date.now()}`, name: "plebbit.bso" },
                signer: signers[3],
                content: `Test content - ${Date.now()}`,
                title: "Test post",
                subplebbitAddress
            });

            await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });

            // On non-RPC path, verifyCommentIpfs runs during challenge verification,
            // populating nameResolvedCache before _initIpfsProps reads it
            expect(comment.author.nameResolved).to.equal(true);
            expect(comment.author.address).to.equal("plebbit.bso");
        });

        it("createComment preserves author.nameResolved on the runtime instance only", async () => {
            const comment = await plebbit.createComment({
                author: {
                    displayName: `Test Author - ${Date.now()}`,
                    name: "plebbit.bso",
                    nameResolved: true
                },
                signer: signers[3],
                content: `Test content - ${Date.now()}`,
                title: "Test post",
                subplebbitAddress
            });

            expect(comment.author.nameResolved).to.equal(true);
            expect(comment.author.address).to.equal("plebbit.bso");
            expect(comment.raw.pubsubMessageToPublish).to.be.an("object");
            expect(comment.raw.pubsubMessageToPublish!.author).to.not.have.property("nameResolved");
        });

        it("nameResolved is false when the loaded comment's author name does not match its signature public key", async () => {
            const comment = await plebbit.createComment({ cid: mismatchedDomainCommentCid });
            await comment.update();
            await resolveWhenConditionIsTrue({
                toUpdate: comment,
                predicate: async () => Boolean(comment.content)
            });
            await comment.stop();

            expect(comment.author.nameResolved).to.equal(false);
            // address is immutable — stays as the domain even when nameResolved is false
            expect(comment.author.address).to.equal("plebbit.bso");
        });

        it("nameResolved is false when the author's domain cannot be resolved", async () => {
            const comment = await plebbit.createComment({ cid: unresolvableDomainCommentCid });
            await comment.update();
            await resolveWhenConditionIsTrue({
                toUpdate: comment,
                predicate: async () => Boolean(comment.content)
            });
            await comment.stop();

            // Resolver returns null for unknown domain → null !== derivedAddress → nameResolved = false
            expect(comment.author.nameResolved).to.equal(false);
            expect(comment.author.address).to.equal("hello.scam");
        });

        itSkipIfRpc("nameResolved is undefined when resolveAuthorNames is false", async () => {
            const noResolvePlebbit = await mockPlebbitV2({
                stubStorage: false,
                remotePlebbit: true,
                plebbitOptions: { resolveAuthorNames: false }
            });

            const loaded = await noResolvePlebbit.createComment({ cid: domainCommentCid });
            await loaded.update();
            await resolveWhenConditionIsTrue({
                toUpdate: loaded,
                predicate: async () => Boolean(loaded.content)
            });
            await loaded.stop();

            // Verification skips resolution when disabled, cache never populated
            expect(loaded.author.nameResolved).to.be.undefined;

            await noResolvePlebbit.destroy();
        });

        itSkipIfRpc("nameResolved is false when resolver throws", async () => {
            const readerPlebbit = await mockPlebbitV2({
                stubStorage: false,
                remotePlebbit: true,
                mockResolve: false
            });
            mockNameResolvers({
                plebbit: readerPlebbit,
                resolveFunction: async () => {
                    throw new Error("Network error: resolver unreachable");
                }
            });

            const comment = await readerPlebbit.createComment({ cid: domainCommentCid });
            await comment.update();
            await resolveWhenConditionIsTrue({
                toUpdate: comment,
                predicate: async () => Boolean(comment.content)
            });
            await comment.stop();

            // Resolver throws → _resolveViaNameResolvers catches and returns null
            // null !== derivedAddress → cache set to false
            expect(comment.author.nameResolved).to.equal(false);

            await readerPlebbit.destroy();
        });

        it("multiple comment instances sharing same plebbit use same nameResolved cache", async () => {
            const instance1 = await plebbit.createComment({ cid: domainCommentCid });
            const instance2 = await plebbit.createComment({ cid: domainCommentCid });

            await instance1.update();
            await resolveWhenConditionIsTrue({
                toUpdate: instance1,
                predicate: async () => Boolean(instance1.content)
            });
            await instance1.stop();

            await instance2.update();
            await resolveWhenConditionIsTrue({
                toUpdate: instance2,
                predicate: async () => Boolean(instance2.content)
            });
            await instance2.stop();

            expect(instance1.author.nameResolved).to.equal(true);
            expect(instance2.author.nameResolved).to.equal(true);
        });

        it("nameResolved is not present in raw CommentIpfs record", async () => {
            const comment = await publishRandomPost({
                subplebbitAddress,
                plebbit,
                postProps: {
                    author: { name: "plebbit.bso" },
                    signer: signers[3]
                }
            });

            expect(comment.author.nameResolved).to.equal(true);

            // raw.comment holds the CommentIpfs as stored on IPFS
            expect(comment.raw.comment).to.be.an("object");
            const rawAuthor = comment.raw.comment!.author;

            // Runtime-only fields should NOT be in the raw CommentIpfs
            expect(rawAuthor).to.not.have.property("nameResolved");
            expect(rawAuthor).to.not.have.property("address");
            expect(rawAuthor).to.not.have.property("publicKey");
            expect(rawAuthor).to.not.have.property("shortAddress");
        });

        it("createComment rejects author.name without a dot that is not a valid B58 address", async () => {
            await expect(
                plebbit.createComment({
                    author: { displayName: "Test", name: "notadomain" },
                    signer: signers[6],
                    content: `No dot test - ${Date.now()}`,
                    title: "Test",
                    subplebbitAddress
                })
            ).rejects.toThrow();
        });

        // === Tests that require non-RPC (mock resolvers or local verification) ===
    });
});

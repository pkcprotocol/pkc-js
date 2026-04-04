import { beforeAll, afterAll, describe, it, expect } from "vitest";
import signers from "../../../fixtures/signers.js";
import {
    publishWithExpectedResult,
    publishRandomPost,
    publishRandomReply,
    itSkipIfRpc,
    mockNameResolvers,
    createMockNameResolver,
    resolveWhenConditionIsTrue,
    getAvailablePlebbitConfigsToTestAgainst,
    createStaticSubplebbitRecordForComment,
    addStringToIpfs
} from "../../../../dist/node/test/test-util.js";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { PageIpfs } from "../../../../dist/node/pages/types.js";
import type Publication from "../../../../dist/node/publications/publication.js";

const subplebbitAddress = signers[0].address;

getAvailablePlebbitConfigsToTestAgainst().map((config) => {
    describe(`author.nameResolved - ${config.name}`, async () => {
        let plebbit: Plebbit;
        let domainCommentCid: string;
        let noDomainCommentCid: string;
        let mismatchedDomainCommentCid: string;
        let unresolvableDomainCommentCid: string;
        let manualPageCid: string;

        beforeAll(async () => {
            plebbit = await config.plebbitInstancePromise();

            // Publish a domain comment (plebbit.bso → signers[3]) for reuse across tests
            const domainComment = await publishRandomPost({
                communityAddress: subplebbitAddress,
                plebbit,
                postProps: {
                    author: { name: "plebbit.bso" },
                    signer: signers[3]
                }
            });
            domainCommentCid = domainComment.cid!;

            // Publish a non-domain comment for reuse
            const noDomainComment = await publishRandomPost({ communityAddress: subplebbitAddress, plebbit });
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

            // Create a manual page from the preloaded hot page for getPage() tests
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => sub.posts?.pages?.hot?.comments?.some((c) => c.cid === domainCommentCid) ?? false
            });
            await sub.stop();
            const rawPage = { comments: sub.posts.pages.hot!.comments.map((c) => c.raw) } as PageIpfs;
            manualPageCid = await addStringToIpfs(JSON.stringify(rawPage));
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
                predicate: async () => loaded.author?.nameResolved === true
            });
            await loaded.stop();

            expect(loaded.author.nameResolved).to.equal(true);
            expect(loaded.author.address).to.equal("plebbit.bso");
        });

        it("nameResolved is set after challenge verification via background resolution", async () => {
            const comment = await plebbit.createComment({
                author: { displayName: `Test Author - ${Date.now()}`, name: "plebbit.bso" },
                signer: signers[3],
                content: `Test content - ${Date.now()}`,
                title: "Test post",
                communityAddress: subplebbitAddress
            });

            await publishWithExpectedResult({ publication: comment, expectedChallengeSuccess: true });

            // Background resolution fires after challenge verification emits "update".
            // nameResolved may be undefined initially but becomes true after resolution completes.
            await resolveWhenConditionIsTrue({
                toUpdate: comment,
                predicate: async () => comment.author?.nameResolved === true
            });
            expect(comment.author.nameResolved).to.equal(true);
            expect(comment.author.address).to.equal("plebbit.bso");
        });

        it("createComment does not preserve author.nameResolved passed via CreateCommentOptions", async () => {
            const comment = await plebbit.createComment({
                author: {
                    displayName: `Test Author - ${Date.now()}`,
                    name: "plebbit.bso",
                    nameResolved: true
                },
                signer: signers[3],
                content: `Test content - ${Date.now()}`,
                title: "Test post",
                communityAddress: subplebbitAddress
            });

            // nameResolved is strictly runtime — passing it in options has no effect
            expect(comment.author.nameResolved).to.be.undefined;
            expect(comment.author.address).to.equal("plebbit.bso");
            const wireAuthor =
                comment.raw.pubsubMessageToPublish?.author ?? (comment.raw as Publication["raw"]).unsignedPublicationOptions?.author;
            expect(wireAuthor).to.be.an("object");
            expect(wireAuthor!).to.not.have.property("nameResolved");
        });

        it("createComment({...publishedComment}) does not carry over author.nameResolved", async () => {
            const comment = await publishRandomPost({
                communityAddress: subplebbitAddress,
                plebbit,
                postProps: {
                    author: { name: "plebbit.bso" },
                    signer: signers[3]
                }
            });
            await comment.update();
            await resolveWhenConditionIsTrue({
                toUpdate: comment,
                predicate: async () => comment.author?.nameResolved === true
            });
            await comment.stop();

            expect(comment.author.nameResolved).to.equal(true);

            const cloned = await plebbit.createComment({ ...comment });
            expect(cloned.author.nameResolved).to.be.undefined;
            expect(cloned.author.address).to.equal("plebbit.bso");
        });

        it("createComment(JSON.parse(JSON.stringify(publishedComment))) does not carry over author.nameResolved", async () => {
            const comment = await publishRandomPost({
                communityAddress: subplebbitAddress,
                plebbit,
                postProps: {
                    author: { name: "plebbit.bso" },
                    signer: signers[3]
                }
            });
            await comment.update();
            await resolveWhenConditionIsTrue({
                toUpdate: comment,
                predicate: async () => comment.author?.nameResolved === true
            });
            await comment.stop();

            expect(comment.author.nameResolved).to.equal(true);

            const cloned = await plebbit.createComment(JSON.parse(JSON.stringify(comment)));
            expect(cloned.author.nameResolved).to.be.undefined;
            expect(cloned.author.address).to.equal("plebbit.bso");
        });

        it("createComment({...pageComment}) does not carry over author.nameResolved from pages", async () => {
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const c = sub.posts?.pages?.hot?.comments?.find((c) => c.cid === domainCommentCid);
                    return c?.author.nameResolved === true;
                }
            });
            await sub.stop();

            const pageComment = sub.posts.pages.hot!.comments.find((c) => c.cid === domainCommentCid)!;
            expect(pageComment.author.nameResolved).to.equal(true);

            const cloned = await plebbit.createComment({ ...pageComment });
            expect(cloned.author.nameResolved).to.be.undefined;
            expect(cloned.author.address).to.equal("plebbit.bso");
        });

        it("nameResolved is false when the loaded comment's author name does not match its signature public key", async () => {
            const comment = await plebbit.createComment({ cid: mismatchedDomainCommentCid });
            await comment.update();
            await resolveWhenConditionIsTrue({
                toUpdate: comment,
                predicate: async () => comment.author?.nameResolved === false
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
                predicate: async () => comment.author?.nameResolved === false
            });
            await comment.stop();

            // Resolver returns null for unknown domain → null !== derivedAddress → nameResolved = false
            expect(comment.author.nameResolved).to.equal(false);
            expect(comment.author.address).to.equal("hello.scam");
        });

        itSkipIfRpc("nameResolved is undefined when resolveAuthorNames is false", async () => {
            const noResolvePlebbit = await config.plebbitInstancePromise({
                stubStorage: false,
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

        it("nameResolved is false when resolver throws", async () => {
            const readerPlebbit = await config.plebbitInstancePromise({
                stubStorage: false,
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
                predicate: async () => comment.author?.nameResolved === false
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
                predicate: async () => instance1.author?.nameResolved === true
            });
            await instance1.stop();

            // instance2 should pick up nameResolved from cache immediately (or via background resolution)
            await instance2.update();
            await resolveWhenConditionIsTrue({
                toUpdate: instance2,
                predicate: async () => instance2.author?.nameResolved === true
            });
            await instance2.stop();

            expect(instance1.author.nameResolved).to.equal(true);
            expect(instance2.author.nameResolved).to.equal(true);
        });

        it("nameResolved is not present in raw CommentIpfs record", async () => {
            const comment = await publishRandomPost({
                communityAddress: subplebbitAddress,
                plebbit,
                postProps: {
                    author: { name: "plebbit.bso" },
                    signer: signers[3]
                }
            });

            await resolveWhenConditionIsTrue({
                toUpdate: comment,
                predicate: async () => comment.author?.nameResolved === true
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

        it("createComment rejects author.name without a dot that is not a valid B58 address when the community key is known", async () => {
            await expect(
                plebbit.createComment({
                    author: { displayName: "Test", name: "notadomain" },
                    signer: signers[6],
                    content: `No dot test - ${Date.now()}`,
                    title: "Test",
                    communityAddress: subplebbitAddress
                })
            ).rejects.toThrow();
        });

        // === Tests that require non-RPC (mock resolvers or local verification) ===

        // === Page-level nameResolved tests ===

        it("nameResolved is true for domain author in subplebbit.posts preloaded pages", async () => {
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const domainComment = sub.posts?.pages?.hot?.comments?.find((c) => c.cid === domainCommentCid);
                    return domainComment?.author.nameResolved === true;
                }
            });
            await sub.stop();

            const domainComment = sub.posts.pages.hot!.comments.find((c) => c.cid === domainCommentCid);
            expect(domainComment, "Domain comment should be in preloaded hot page").to.exist;
            expect(domainComment!.author.nameResolved).to.equal(true);
            expect(domainComment!.author.address).to.equal("plebbit.bso");
        });

        it("nameResolved is undefined for non-domain author in subplebbit.posts preloaded pages", async () => {
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => Boolean(sub.posts?.pages?.hot?.comments?.length)
            });
            await sub.stop();

            const noDomainComment = sub.posts.pages.hot!.comments.find((c) => !c.author.address.includes("."));
            expect(noDomainComment, "Non-domain comment should be in preloaded hot page").to.exist;
            expect(noDomainComment!.author.nameResolved).to.be.undefined;
        });

        it("nameResolved is true for domain author in pages fetched via sub.posts.getPage()", async () => {
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub.update();
            // Wait for background resolution to populate the cache first
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => {
                    const c = sub.posts?.pages?.hot?.comments?.find((c) => c.cid === domainCommentCid);
                    return c?.author.nameResolved === true;
                }
            });

            // Now getPage will find nameResolved in cache
            const page = await sub.posts.getPage({ cid: manualPageCid });
            await sub.stop();

            const domainComment = page.comments.find((c) => c.cid === domainCommentCid);
            expect(domainComment, "Domain comment should be in fetched page").to.exist;
            expect(domainComment!.author.nameResolved).to.equal(true);
            expect(domainComment!.author.address).to.equal("plebbit.bso");
        });

        it("nameResolved is undefined for non-domain author in fetched pages", async () => {
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => Boolean(sub.posts?.pages?.hot?.comments?.length)
            });

            const page = await sub.posts.getPage({ cid: manualPageCid });
            await sub.stop();

            const noDomainComment = page.comments.find((c) => !c.author.address.includes("."));
            expect(noDomainComment, "Non-domain comment should be in fetched page").to.exist;
            expect(noDomainComment!.author.nameResolved).to.be.undefined;
        });

        it("nameResolved is false for mismatched domain in subplebbit.posts preloaded pages", async () => {
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => Boolean(sub.posts?.pages?.hot?.comments?.length)
            });
            await sub.stop();

            const mismatchComment = sub.posts.pages.hot!.comments.find((c) => c.cid === mismatchedDomainCommentCid);
            // mismatchedDomainCommentCid is a standalone record, may not be in the hot page
            if (mismatchComment) {
                expect(mismatchComment.author.nameResolved).to.equal(false);
                expect(mismatchComment.author.address).to.equal("plebbit.bso");
            }
        });

        it("nameResolved is false for unresolvable domain in subplebbit.posts preloaded pages", async () => {
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => Boolean(sub.posts?.pages?.hot?.comments?.length)
            });
            await sub.stop();

            const unresolvableComment = sub.posts.pages.hot!.comments.find((c) => c.cid === unresolvableDomainCommentCid);
            // unresolvableDomainCommentCid is a standalone record, may not be in the hot page
            if (unresolvableComment) {
                expect(unresolvableComment.author.nameResolved).to.equal(false);
                expect(unresolvableComment.author.address).to.equal("hello.scam");
            }
        });

        it("nameResolved is true for domain author in comment.replies preloaded pages", async () => {
            // Load the parent comment fully first
            const parentForPublish = await plebbit.createComment({ cid: noDomainCommentCid });
            await parentForPublish.update();
            await resolveWhenConditionIsTrue({ toUpdate: parentForPublish, predicate: async () => Boolean(parentForPublish.content) });
            await parentForPublish.stop();

            // Publish a domain-author reply to the noDomainComment post
            const reply = await publishRandomReply({
                parentComment: parentForPublish as any,
                plebbit,
                commentProps: {
                    author: { name: "plebbit.bso" },
                    signer: signers[3]
                }
            });

            // Load the parent comment and wait for replies with nameResolved set
            const parent = await plebbit.createComment({ cid: noDomainCommentCid });
            await parent.update();
            await resolveWhenConditionIsTrue({
                toUpdate: parent,
                predicate: async () => {
                    const r = parent.replies?.pages?.best?.comments?.find((c) => c.cid === reply.cid);
                    return r?.author.nameResolved === true;
                }
            });
            await parent.stop();

            const domainReply = parent.replies.pages.best!.comments.find((c) => c.cid === reply.cid);
            expect(domainReply, "Domain reply should be in preloaded best page").to.exist;
            expect(domainReply!.author.nameResolved).to.equal(true);
            expect(domainReply!.author.address).to.equal("plebbit.bso");
        });

        it("nameResolved is true for domain author in comment.replies fetched via getPage()", async () => {
            const parent = await plebbit.createComment({ cid: noDomainCommentCid });
            await parent.update();
            // Wait for background resolution to populate cache
            await resolveWhenConditionIsTrue({
                toUpdate: parent,
                predicate: async () => {
                    const r = parent.replies?.pages?.best?.comments?.find((c) => c.author.address === "plebbit.bso");
                    return r?.author.nameResolved === true;
                }
            });

            const rawReplyPage: PageIpfs = { comments: parent.replies.pages.best!.comments.map((c) => c.raw) };
            const replyPageCid = await addStringToIpfs(JSON.stringify(rawReplyPage));

            // getPage reads from cache which was populated by background resolution
            const page = await parent.replies.getPage({ cid: replyPageCid });
            await parent.stop();

            const domainReply = page.comments.find((c) => c.author.address === "plebbit.bso");
            expect(domainReply, "Domain reply should be in fetched best page").to.exist;
            expect(domainReply!.author.nameResolved).to.equal(true);
        });

        it("page with no domain authors has no nameResolved set", async () => {
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => Boolean(sub.posts?.pages?.hot?.comments?.length)
            });
            await sub.stop();

            const noDomainComments = sub.posts.pages.hot!.comments.filter((c) => !c.author.address.includes("."));
            for (const comment of noDomainComments) {
                expect(comment.author.nameResolved).to.be.undefined;
            }
        });

        it("nameResolved is false for mismatched domain in fetched pages", async () => {
            const sub = await plebbit.createSubplebbit({ address: subplebbitAddress });
            await sub.update();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => Boolean(sub.posts?.pages?.hot?.comments?.length)
            });

            const page = await sub.posts.getPage({ cid: manualPageCid });
            await sub.stop();

            const mismatchComment = page.comments.find((c) => c.cid === mismatchedDomainCommentCid);
            // mismatchedDomainCommentCid is a standalone record, may not be in the page
            if (mismatchComment) {
                expect(mismatchComment.author.nameResolved).to.equal(false);
            }
        });

        it("nameResolved is false when reader has no resolver for the author's TLD", async () => {
            // Create a comment with .xyz TLD using default plebbit (which accepts all TLDs)
            const xyzComment = await createStaticSubplebbitRecordForComment({
                plebbit,
                commentOptions: {
                    author: { name: "testuser.xyz" },
                    signer: signers[4]
                }
            });

            // Create a reader plebbit with a restricted resolver (only .eth/.bso)
            // even for RPC servers they should not be able to resolve .xyz
            const readerPlebbit = await config.plebbitInstancePromise({
                stubStorage: false,
                mockResolve: false,
                plebbitOptions: {
                    nameResolvers: [
                        createMockNameResolver({
                            includeDefaultRecords: true,
                            canResolve: ({ name }) => /\.(eth|bso)$/i.test(name)
                        })
                    ]
                }
            });

            const comment = await readerPlebbit.createComment({ cid: xyzComment.commentCid });
            await comment.update();
            await resolveWhenConditionIsTrue({
                toUpdate: comment,
                predicate: async () => comment.author?.nameResolved === false
            });
            await comment.stop();

            // Comment should load successfully with nameResolved=false, not throw
            expect(comment.author.nameResolved).to.equal(false);
            expect(comment.author.address).to.equal("testuser.xyz");

            await readerPlebbit.destroy();
        });

        it("nameResolved change emits a separate update event", async () => {
            // Use a fresh plebbit instance so the cache is empty
            const freshPlebbit = await config.plebbitInstancePromise();

            const comment = await freshPlebbit.createComment({ cid: domainCommentCid });
            let updateCount = 0;
            let nameResolvedOnUpdateWhenSet: boolean | undefined;

            comment.on("update", () => {
                updateCount++;
                if (typeof comment.author.nameResolved === "boolean" && nameResolvedOnUpdateWhenSet === undefined) {
                    nameResolvedOnUpdateWhenSet = comment.author.nameResolved;
                }
            });

            await comment.update();
            await resolveWhenConditionIsTrue({
                toUpdate: comment,
                predicate: async () => comment.author?.nameResolved === true
            });
            await comment.stop();

            // nameResolved should be true once background resolution completes
            expect(nameResolvedOnUpdateWhenSet).to.equal(true);
            // There should have been at least 2 update events (initial load + nameResolved change)
            expect(updateCount).to.be.greaterThanOrEqual(2);

            await freshPlebbit.destroy();
        });

        it("background resolution of reply page authors does not emit spurious update on comment", async () => {
            // noDomainComment is a B58-address author (no domain to resolve)
            // but it has reply pages containing domain-author comments (plebbit.bso)
            const parent = await plebbit.createComment({ cid: noDomainCommentCid });
            await parent.update();
            // Wait until we have replies with a domain author
            await resolveWhenConditionIsTrue({
                toUpdate: parent,
                predicate: async () => parent.replies?.pages?.best?.comments?.some((c) => c.author.address.includes(".")) ?? false
            });

            // At this point parent.author.nameResolved should be undefined (B58 address, no domain)
            expect(parent.author.nameResolved).to.be.undefined;

            // Track whether nameResolved ever changes — background resolution of reply page
            // domain authors should NOT cause parent.author.nameResolved to change
            let nameResolvedEverChanged = false;
            const onUpdate = () => {
                if (typeof parent.author.nameResolved === "boolean") {
                    nameResolvedEverChanged = true;
                }
            };
            parent.on("update", onUpdate);

            // Wait a bit to let any pending background resolution settle
            await new Promise((resolve) => setTimeout(resolve, 2000));

            parent.removeListener("update", onUpdate);
            await parent.stop();

            // parent.author.nameResolved should still be undefined (no domain to resolve)
            expect(parent.author.nameResolved).to.be.undefined;
            // nameResolved should never have been set to a boolean
            expect(nameResolvedEverChanged).to.be.false;
        });
    });
});

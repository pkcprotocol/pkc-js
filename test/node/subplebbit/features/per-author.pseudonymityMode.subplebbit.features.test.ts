import { describe, it, beforeAll, afterAll } from "vitest";
import {
    createSubWithNoChallenge,
    describeSkipIfRpc,
    getAvailablePlebbitConfigsToTestAgainst,
    mockPlebbit,
    publishRandomPost,
    publishRandomReply,
    publishWithExpectedResult,
    resolveWhenConditionIsTrue,
    forceSubplebbitToGenerateAllPostsPages,
    forceLocalSubPagesToAlwaysGenerateMultipleChunks,
    waitTillPostInSubplebbitPages,
    waitTillReplyInParentPages,
    waitTillReplyInParentPagesInstance
} from "../../../../dist/node/test/test-util.js";
import { messages } from "../../../../dist/node/errors.js";
import { timestamp } from "../../../../dist/node/util.js";
import { createSigner, SignerWithPublicKeyAddress } from "../../../../dist/node/signer/index.js";
import { signComment } from "../../../../dist/node/signer/signatures.js";
import signers from "../../../fixtures/signers.js";
import type { Plebbit } from "../../../../dist/node/plebbit/plebbit.js";
import type { LocalSubplebbit } from "../../../../dist/node/runtime/node/subplebbit/local-subplebbit.js";
import type { RpcLocalSubplebbit } from "../../../../dist/node/subplebbit/rpc-local-subplebbit.js";
import type { Comment } from "../../../../dist/node/publications/comment/comment.js";
import type { DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor } from "../../../../dist/node/pubsub-messages/types.js";
import type { SignerType } from "../../../../dist/node/signer/types.js";
import type {
    CommentPubsubMessagePublication,
    CommentIpfsWithCidDefined,
    CommentsTableRow,
    CommentUpdatesRow
} from "../../../../dist/node/publications/comment/types.js";
import type { PseudonymityAliasRow } from "../../../../dist/node/runtime/node/subplebbit/db-handler-types.js";

const remotePlebbitConfigs = getAvailablePlebbitConfigsToTestAgainst({ includeAllPossibleConfigOnEnv: true });

interface PerAuthorContext {
    publisherPlebbit: Plebbit;
    subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    cleanup: () => Promise<void>;
    post?: Comment;
    reply?: Comment;
    postDisplayName?: string;
    replyDisplayName?: string;
    editContent?: string;
}

interface AnonymityTransitionContext {
    subplebbit: LocalSubplebbit | RpcLocalSubplebbit;
    dbHandler: LocalSubplebbit["_dbHandler"];
    plebbit: Plebbit;
    subplebbitAddress: string;
    cleanup: () => Promise<void>;
}

type AliasRow = Pick<PseudonymityAliasRow, "mode" | "aliasPrivateKey" | "originalAuthorSignerPublicKey">;
type StoredCommentUpdate = Pick<
    CommentUpdatesRow,
    "cid" | "updatedAt" | "replyCount" | "protocolVersion" | "signature" | "edit" | "author"
>;
type StoredComment = Pick<CommentsTableRow, "cid" | "author" | "signature" | "parentCid" | "pseudonymityMode">;

// Type to access private methods for testing purposes
interface LocalSubplebbitWithPrivateMethods {
    storePublication: (args: { comment: CommentPubsubMessagePublication }) => Promise<{ cid: string }>;
    initDbHandlerIfNeeded: () => Promise<void>;
    _dbHandler: LocalSubplebbit["_dbHandler"];
}

describeSkipIfRpc('subplebbit.features.pseudonymityMode="per-author"', () => {
    describe.concurrent("local anonymization", () => {
        let context: PerAuthorContext;
        let authorSigner: SignerWithPublicKeyAddress;
        let otherSigner: SignerWithPublicKeyAddress;

        beforeAll(async () => {
            context = await createPerAuthorSubplebbit();
            authorSigner = await context.publisherPlebbit.createSigner();
            otherSigner = await context.publisherPlebbit.createSigner();
        });

        afterAll(async () => {
            await context.cleanup();
        });

        it.sequential(
            'Spec: same signer maps to a stable pseudonymous author address across all posts and replies when pseudonymityMode="per-author"',
            async () => {
                const firstPost = await publishRandomPost({
                    subplebbitAddress: context.subplebbit.address,
                    plebbit: context.publisherPlebbit,
                    postProps: { signer: authorSigner }
                });
                const secondPost = await publishRandomPost({
                    subplebbitAddress: context.subplebbit.address,
                    plebbit: context.publisherPlebbit,
                    postProps: { signer: authorSigner }
                });
                const reply = await publishRandomReply({
                    parentComment: secondPost as CommentIpfsWithCidDefined,
                    plebbit: context.publisherPlebbit,
                    commentProps: {
                        signer: authorSigner
                    }
                });

                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, firstPost);
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, secondPost);
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, reply);

                const aliasRow = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                    authorSigner.publicKey
                ) as AliasRow;
                expect(aliasRow).to.exist;
                expect(aliasRow.mode).to.equal("per-author");
                const aliasSigner = await context.publisherPlebbit.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });

                const storedFirst = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(firstPost.cid) as StoredComment;
                const storedSecond = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(secondPost.cid) as StoredComment;
                const storedReply = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(reply.cid) as StoredComment;

                for (const stored of [storedFirst, storedSecond, storedReply]) {
                    await expectCommentCidToUseAlias(context.publisherPlebbit, stored.cid, aliasSigner);
                    expect(stored?.author?.address).to.equal(aliasSigner.address);
                    expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
                    expect(stored?.pseudonymityMode).to.equal("per-author");
                }

                expect(storedReply?.parentCid).to.equal(secondPost.cid);
                await firstPost.stop();
                await secondPost.stop();
                await reply.stop();
            }
        );

        it.sequential("Spec: two different signers never share the same pseudonymous author address", async () => {
            const thirdPost = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: otherSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, thirdPost);

            const firstAlias = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                authorSigner.publicKey
            ) as AliasRow;
            const secondAlias = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                otherSigner.publicKey
            ) as AliasRow;

            expect(firstAlias).to.exist;
            expect(secondAlias).to.exist;
            const firstAliasSigner = await context.publisherPlebbit.createSigner({
                privateKey: firstAlias.aliasPrivateKey,
                type: "ed25519"
            });
            const secondAliasSigner = await context.publisherPlebbit.createSigner({
                privateKey: secondAlias.aliasPrivateKey,
                type: "ed25519"
            });
            expect(firstAliasSigner.address).to.not.equal(secondAliasSigner.address);
            expect(firstAlias.aliasPrivateKey).to.not.equal(secondAlias.aliasPrivateKey);
            await thirdPost.stop();
        });

        it.sequential("Spec: author.address domains resolve and are anonymized consistently", async () => {
            const domainAuthorSigner = await context.publisherPlebbit.createSigner(signers[6]);
            const domainAddress = "plebbit.bso";

            const resolvedAddress = await context.publisherPlebbit.resolveAuthorName({ address: domainAddress });
            expect(resolvedAddress).to.equal(domainAuthorSigner.address);

            const domainPost = await context.publisherPlebbit.createComment({
                subplebbitAddress: context.subplebbit.address,
                signer: domainAuthorSigner,
                author: { address: domainAddress, displayName: "Domain author" },
                content: "Domain anonymization content " + Date.now(),
                title: "Domain anonymization title " + Date.now()
            });
            await publishWithExpectedResult({ publication: domainPost, expectedChallengeSuccess: true });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, domainPost);

            const aliasRow = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                domainAuthorSigner.publicKey
            ) as AliasRow;
            expect(aliasRow).to.exist;
            const aliasSigner = await context.publisherPlebbit.createSigner({
                privateKey: aliasRow.aliasPrivateKey,
                type: "ed25519"
            });

            await resolveWhenConditionIsTrue({
                toUpdate: domainPost,
                predicate: async () => domainPost.author?.address === aliasSigner.address
            });

            expect(domainPost.author.address).to.equal(aliasSigner.address);
            expect(domainPost.original?.author?.address).to.equal(domainAddress);

            const stored = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(domainPost.cid) as StoredComment;
            expect(stored?.author?.address).to.equal(aliasSigner.address);
            expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            await expectCommentCidToUseAlias(context.publisherPlebbit, domainPost.cid, aliasSigner);

            await domainPost.stop();
        });

        it.sequential("Spec: anonymized publication keeps author displayName while stripping wallets/avatar/flairs fields", async () => {
            const noisyAuthor = {
                address: authorSigner.address,
                displayName: "Noisy Display Name",
                wallets: {
                    eth: {
                        address: "0x1234",
                        timestamp: Math.round(Date.now() / 1000),
                        signature: { signature: "signature", type: "ed25519" }
                    }
                },
                avatar: {
                    chainTicker: "eth",
                    address: "0x5678",
                    id: "1",
                    timestamp: Math.round(Date.now() / 1000),
                    signature: { signature: "signature", type: "ed25519" }
                },
                flairs: [{ text: "flair" }],
                previousCommentCid: "QmYwAPJzv5CZsnAzt8auVTL8gdD5pqqBYn2fvDMLoG34he"
            };
            const noisyPost = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: {
                    author: noisyAuthor,
                    signer: authorSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, noisyPost);

            const aliasRow = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                authorSigner.publicKey
            ) as AliasRow;
            const aliasSigner = await context.publisherPlebbit.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });

            const stored = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(noisyPost.cid) as StoredComment;
            expect(stored?.author).to.deep.equal({ address: aliasSigner.address, displayName: noisyAuthor.displayName });
            expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            await expectCommentCidToUseAlias(context.publisherPlebbit, noisyPost.cid, aliasSigner);
            await noisyPost.stop();
        });

        it("Spec: anonymized publication omits author.previousCommentCid", async () => {
            const chainAuthor = await context.publisherPlebbit.createSigner();
            const previousPost = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: chainAuthor }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, previousPost);

            const chainedPost = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: {
                    signer: chainAuthor,
                    author: { previousCommentCid: previousPost.cid, address: chainAuthor.address }
                }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, chainedPost);

            const aliasRow = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                chainAuthor.publicKey
            ) as AliasRow;
            const aliasSigner = await context.publisherPlebbit.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });
            const stored = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(chainedPost.cid) as StoredComment;
            expect(stored?.author?.previousCommentCid).to.be.undefined;
            expect(stored?.author?.address).to.equal(aliasSigner.address);
            await expectCommentCidToUseAlias(context.publisherPlebbit, chainedPost.cid, aliasSigner);
            await previousPost.stop();
            await chainedPost.stop();
        });

        it("Spec: author receives anonymized comment but comment.original keeps original fields", async () => {
            const originalAuthor = {
                address: authorSigner.address,
                displayName: "Original Display",
                wallets: {
                    eth: {
                        address: "0x5678",
                        timestamp: Math.round(Date.now() / 1000),
                        signature: { signature: "signature", type: "ed25519" }
                    }
                },
                flairs: [{ text: "OG flair" }],
                previousCommentCid: "QmYwAPJzv5CZsnAzt8auVTL8gdD5pqqBYn2fvDMLoG34he"
            };
            const originalContent = "Content before anonymization";
            const originalTitle = "Title before anonymization";

            const authoredPost = await context.publisherPlebbit.createComment({
                subplebbitAddress: context.subplebbit.address,
                signer: authorSigner,
                author: originalAuthor,
                content: originalContent,
                title: originalTitle
            });
            await publishWithExpectedResult({ publication: authoredPost, expectedChallengeSuccess: true });
            expect(authoredPost.original).to.be.ok;
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, authoredPost);

            const aliasRow = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                authorSigner.publicKey
            ) as AliasRow;
            expect(aliasRow).to.exist;
            const alias = await context.publisherPlebbit.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });
            const expectOriginalFields = () => {
                expect(authoredPost.original?.author?.address).to.equal(originalAuthor.address);
                expect(authoredPost.original?.author?.displayName).to.equal(originalAuthor.displayName);
                expect(authoredPost.original?.author?.wallets).to.deep.equal(originalAuthor.wallets);
                expect(authoredPost.original?.author?.flairs).to.deep.equal(originalAuthor.flairs);
                expect(authoredPost.original?.author?.previousCommentCid).to.equal(originalAuthor.previousCommentCid);
                expect(authoredPost.original?.content).to.equal(originalContent);
                expect(authoredPost.original?.signature?.publicKey).to.equal(authorSigner.publicKey);
            };

            const stored = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(authoredPost.cid) as StoredComment;
            expect(stored?.author?.address).to.equal(alias.address);
            expect(stored?.signature?.publicKey).to.equal(alias.publicKey);
            await expectCommentCidToUseAlias(context.publisherPlebbit, authoredPost.cid, alias);
            expectOriginalFields();

            await authoredPost.update();
            await resolveWhenConditionIsTrue({ toUpdate: authoredPost, predicate: async () => typeof authoredPost.updatedAt === "number" });

            expect(authoredPost.author.address).to.equal(alias.address);
            expect(authoredPost.author.displayName).to.equal(originalAuthor.displayName);
            expectOriginalFields();

            await authoredPost.stop();
        });

        it("Spec: comment edit signed by original author is accepted and re-signed with anonymized author key", async () => {
            const editSigner = await context.publisherPlebbit.createSigner();
            const editablePost = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: editSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, editablePost);

            const aliasRow = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                editSigner.publicKey
            ) as AliasRow;
            expect(aliasRow).to.exist;
            const aliasSigner = await context.publisherPlebbit.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });

            const editedContent = "Edited content - " + Date.now();
            const edit = await context.publisherPlebbit.createCommentEdit({
                subplebbitAddress: editablePost.subplebbitAddress,
                commentCid: editablePost.cid,
                content: editedContent,
                signer: editSigner
            });
            await publishWithExpectedResult({ publication: edit, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: context.subplebbit,
                predicate: async () =>
                    (
                        (context.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: editablePost.cid
                        }) as StoredCommentUpdate
                    )?.edit?.content === editedContent
            });

            const storedUpdate = (context.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                cid: editablePost.cid
            }) as StoredCommentUpdate;
            expect(storedUpdate?.edit?.content).to.equal(editedContent);
            expect(storedUpdate?.edit?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            await editablePost.stop();
        });

        it("Spec: comment edit is rejected when original author does not match stored anonymization mapping", async () => {
            const ownerSigner = await context.publisherPlebbit.createSigner();
            const intruderSigner = await context.publisherPlebbit.createSigner();
            const targetPost = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: ownerSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, targetPost);

            const badEdit = await context.publisherPlebbit.createCommentEdit({
                subplebbitAddress: targetPost.subplebbitAddress,
                commentCid: targetPost.cid,
                content: "Unauthorized edit " + Date.now(),
                signer: intruderSigner
            });
            await publishWithExpectedResult({
                publication: badEdit,
                expectedChallengeSuccess: false,
                expectedReason: messages.ERR_COMMENT_EDIT_CAN_NOT_EDIT_COMMENT_IF_NOT_ORIGINAL_AUTHOR
            });

            const storedUpdate = (context.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({ cid: targetPost.cid }) as
                | StoredCommentUpdate
                | undefined;
            expect(storedUpdate?.edit).to.be.undefined;
            await targetPost.stop();
        });

        it("Spec: anonymized comment.signature.publicKey differs from original author's signer publicKey", async () => {
            const freshSigner = await context.publisherPlebbit.createSigner();
            const post = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: freshSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, post);

            const stored = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(post.cid) as StoredComment;
            const aliasRow = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                freshSigner.publicKey
            ) as AliasRow;
            expect(aliasRow).to.exist;
            const aliasSigner = await context.publisherPlebbit.createSigner({
                privateKey: aliasRow.aliasPrivateKey,
                type: "ed25519"
            });
            expect(stored?.signature?.publicKey).to.not.equal(freshSigner.publicKey);
            expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
            expect(stored?.author?.address).to.equal(aliasSigner.address);
            await expectCommentCidToUseAlias(context.publisherPlebbit, post.cid, aliasSigner);
            await post.stop();
        });

        it("Spec: purging an anonymized comment removes its alias mapping", async () => {
            const purgeSigner = await context.publisherPlebbit.createSigner();
            const purgeTarget = await publishRandomPost({
                subplebbitAddress: context.subplebbit.address,
                plebbit: context.publisherPlebbit,
                postProps: { signer: purgeSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, purgeTarget);

            const aliasBeforePurge = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                purgeSigner.publicKey
            );
            expect(aliasBeforePurge).to.exist;

            await (context.subplebbit as LocalSubplebbit)._dbHandler.purgeComment(purgeTarget.cid);

            const aliasAfterPurge = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(purgeTarget.cid);
            expect(aliasAfterPurge).to.be.undefined;
            const commentAfterPurge = (context.subplebbit as LocalSubplebbit)._dbHandler.queryComment(purgeTarget.cid);
            expect(commentAfterPurge).to.be.undefined;
        });

        it("Spec: disabling pseudonymousAuthors stops anonymization for new comments without rewriting old ones", async () => {
            const localContext = await createPerAuthorSubplebbit();
            const plainSigner = await localContext.publisherPlebbit.createSigner();
            let plainPost: Comment | undefined;

            try {
                await localContext.subplebbit.edit({ features: { pseudonymityMode: undefined } });
                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () => localContext.subplebbit.features?.pseudonymityMode === undefined
                });

                plainPost = await publishRandomPost({
                    subplebbitAddress: localContext.subplebbit.address,
                    plebbit: localContext.publisherPlebbit,
                    postProps: {
                        signer: plainSigner
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, plainPost);

                const stored = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryComment(plainPost.cid) as StoredComment;
                expect(stored?.author?.address).to.equal(plainSigner.address);
                expect(stored?.signature?.publicKey).to.equal(plainSigner.publicKey);
                const alias = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                    plainSigner.publicKey
                );
                expect(alias).to.be.undefined;
            } finally {
                await plainPost?.stop();
                await localContext.cleanup();
            }
        });

        it("Spec: sub owner can resolve the pseudonymous author address back to the original author address", async () => {
            const aliasRow = (context.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                authorSigner.publicKey
            ) as AliasRow;
            expect(aliasRow).to.exist;
            expect(aliasRow.originalAuthorSignerPublicKey).to.equal(authorSigner.publicKey);

            const aliasSigner = await context.publisherPlebbit.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });
            expect(aliasSigner.address).to.be.a("string");
        });

        it("Spec: challengerequest emits full publication author.subplebbit fields without anonymization in per-author mode", async () => {
            const localContext = await createPerAuthorSubplebbit();
            const localAuthor = await localContext.publisherPlebbit.createSigner();
            const voter = await localContext.publisherPlebbit.createSigner();

            try {
                const seededPost = await publishRandomPost({
                    subplebbitAddress: localContext.subplebbit.address,
                    plebbit: localContext.publisherPlebbit,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, seededPost);

                const upvote = await localContext.publisherPlebbit.createVote({
                    subplebbitAddress: localContext.subplebbit.address,
                    commentCid: seededPost.cid,
                    vote: 1,
                    signer: voter
                });
                await publishWithExpectedResult({ publication: upvote, expectedChallengeSuccess: true });

                const aliasRow = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                    localAuthor.publicKey
                ) as AliasRow;
                expect(aliasRow).to.exist;
                const aliasSigner = await localContext.publisherPlebbit.createSigner({
                    privateKey: aliasRow.aliasPrivateKey,
                    type: "ed25519"
                });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () => {
                        const aggregated = (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(
                            localAuthor.address
                        );
                        return (
                            aggregated?.lastCommentCid === seededPost.cid &&
                            aggregated?.firstCommentTimestamp === seededPost.timestamp &&
                            aggregated?.postScore === 1 &&
                            aggregated?.replyScore === 0
                        );
                    }
                });

                const subplebbitAuthorBefore = (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(
                    localAuthor.address
                );
                expect(subplebbitAuthorBefore, "expected subplebbit author to exist for original signer").to.be.ok;
                expect(subplebbitAuthorBefore).to.include.keys(["postScore", "replyScore", "lastCommentCid", "firstCommentTimestamp"]);
                expect(subplebbitAuthorBefore.lastCommentCid).to.equal(seededPost.cid);
                expect(subplebbitAuthorBefore.firstCommentTimestamp).to.equal(seededPost.timestamp);
                expect(subplebbitAuthorBefore.postScore).to.equal(1);
                expect(subplebbitAuthorBefore.replyScore).to.equal(0);

                const challengeRequestPromise = new Promise<DecryptedChallengeRequestMessageTypeWithSubplebbitAuthor>((resolve) =>
                    localContext.subplebbit.once("challengerequest", resolve)
                );
                const publication = await localContext.publisherPlebbit.createComment({
                    subplebbitAddress: localContext.subplebbit.address,
                    signer: localAuthor,
                    content: "Challengerequest author.subplebbit check",
                    title: "Challengerequest author.subplebbit check"
                });
                await publishWithExpectedResult({ publication: publication, expectedChallengeSuccess: true });

                const challengerequest = await challengeRequestPromise;
                expect(challengerequest.comment?.author.address).to.equal(localAuthor.address);
                expect(challengerequest.comment?.author.address).to.not.equal(aliasSigner.address);
                expect(challengerequest.comment?.author.subplebbit).to.deep.equal(subplebbitAuthorBefore);
                expect(challengerequest.comment?.author.subplebbit?.lastCommentCid).to.equal(seededPost.cid);
                expect(challengerequest.comment?.author.subplebbit?.firstCommentTimestamp).to.equal(seededPost.timestamp);
                expect(challengerequest.comment?.author.subplebbit?.postScore).to.equal(1);
                expect(challengerequest.comment?.author.subplebbit?.replyScore).to.equal(0);
                await seededPost.stop();
                await publication.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.subplebbit.lastCommentCid tracks the author's latest comment in the subplebbit for per-author mode", async () => {
            const localContext = await createPerAuthorSubplebbit();
            const localAuthor = await localContext.publisherPlebbit.createSigner();

            try {
                const firstPost = await publishRandomPost({
                    subplebbitAddress: localContext.subplebbit.address,
                    plebbit: localContext.publisherPlebbit,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, firstPost);

                const followUpReply = await publishRandomReply({
                    parentComment: firstPost as CommentIpfsWithCidDefined,
                    plebbit: localContext.publisherPlebbit,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, followUpReply);

                const aggregatedAuthor = (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(localAuthor.address);
                expect(aggregatedAuthor?.lastCommentCid).to.equal(followUpReply.cid);

                const replyUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: followUpReply.cid
                }) as StoredCommentUpdate;
                expect(replyUpdate?.author?.subplebbit?.lastCommentCid).to.equal(followUpReply.cid);

                const postUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: firstPost.cid
                }) as StoredCommentUpdate;
                expect(postUpdate?.author?.subplebbit?.lastCommentCid).to.equal(followUpReply.cid);

                await firstPost.stop();
                await followUpReply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.subplebbit.banExpiresAt rejects new publications and surfaces on all of the author's comments in per-author mode", async () => {
            const localContext = await createPerAuthorSubplebbit();
            const localAuthor = await localContext.publisherPlebbit.createSigner();
            const moderator = await localContext.publisherPlebbit.createSigner();

            await localContext.subplebbit.edit({ roles: { [moderator.address]: { role: "moderator" } } });
            await resolveWhenConditionIsTrue({
                toUpdate: localContext.subplebbit,
                predicate: async () => typeof localContext.subplebbit.updatedAt === "number"
            });

            try {
                const post = await publishRandomPost({
                    subplebbitAddress: localContext.subplebbit.address,
                    plebbit: localContext.publisherPlebbit,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, post);
                const reply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    plebbit: localContext.publisherPlebbit,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, reply);

                const banExpiresAt = timestamp() + 60;
                const banModeration = await localContext.publisherPlebbit.createCommentModeration({
                    subplebbitAddress: localContext.subplebbit.address,
                    commentCid: post.cid,
                    commentModeration: { author: { banExpiresAt }, reason: "ban for test" },
                    signer: moderator
                });
                await publishWithExpectedResult({ publication: banModeration, expectedChallengeSuccess: true });

                await post.update();
                await reply.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () =>
                        (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(localAuthor.address)?.banExpiresAt ===
                        banExpiresAt
                });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () => {
                        const postUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: post.cid
                        }) as StoredCommentUpdate;
                        const replyUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: reply.cid
                        }) as StoredCommentUpdate;
                        return (
                            postUpdate?.author?.subplebbit?.banExpiresAt === banExpiresAt &&
                            replyUpdate?.author?.subplebbit?.banExpiresAt === banExpiresAt
                        );
                    }
                });

                const postUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                const replyUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: reply.cid
                }) as StoredCommentUpdate;
                expect(postUpdate?.author?.subplebbit?.banExpiresAt).to.equal(banExpiresAt);
                expect(replyUpdate?.author?.subplebbit?.banExpiresAt).to.equal(banExpiresAt);

                const blockedPost = await localContext.publisherPlebbit.createComment({
                    subplebbitAddress: localContext.subplebbit.address,
                    signer: localAuthor,
                    title: "should be rejected",
                    content: "should be rejected"
                });
                await publishWithExpectedResult({
                    publication: blockedPost,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_AUTHOR_IS_BANNED
                });

                await post.stop();
                await reply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: banning an anonymized comment maps to original and alias author addresses in per-author mode", async () => {
            const localContext = await createPerAuthorSubplebbit();
            const localAuthor = await localContext.publisherPlebbit.createSigner();
            const moderator = await localContext.publisherPlebbit.createSigner();

            await localContext.subplebbit.edit({ roles: { [moderator.address]: { role: "moderator" } } });
            await resolveWhenConditionIsTrue({
                toUpdate: localContext.subplebbit,
                predicate: async () => typeof localContext.subplebbit.updatedAt === "number"
            });

            try {
                const post = await publishRandomPost({
                    subplebbitAddress: localContext.subplebbit.address,
                    plebbit: localContext.publisherPlebbit,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, post);

                const aliasRow = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                    localAuthor.publicKey
                ) as AliasRow;
                expect(aliasRow).to.exist;
                const aliasSigner = await localContext.publisherPlebbit.createSigner({
                    privateKey: aliasRow.aliasPrivateKey,
                    type: "ed25519"
                });
                expect(aliasSigner.address).to.not.equal(localAuthor.address);

                const banExpiresAt = timestamp() + 60;
                const banModeration = await localContext.publisherPlebbit.createCommentModeration({
                    subplebbitAddress: localContext.subplebbit.address,
                    commentCid: post.cid,
                    commentModeration: { author: { banExpiresAt }, reason: "ban alias mapping test" },
                    signer: moderator
                });
                await publishWithExpectedResult({ publication: banModeration, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () => {
                        const originalAuthor = (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(
                            localAuthor.address
                        );
                        const aliasAuthor = (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(
                            aliasSigner.address
                        );
                        return originalAuthor?.banExpiresAt === banExpiresAt && aliasAuthor?.banExpiresAt === banExpiresAt;
                    }
                });

                const originalAuthor = (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(localAuthor.address);
                const aliasAuthor = (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(aliasSigner.address);
                expect(originalAuthor?.banExpiresAt).to.equal(banExpiresAt);
                expect(aliasAuthor?.banExpiresAt).to.equal(banExpiresAt);

                await post.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.subplebbit.postScore is present with total post karma when pseudonymityMode is per-author", async () => {
            const localContext = await createPerAuthorSubplebbit();
            const localAuthor = await localContext.publisherPlebbit.createSigner();
            const voter = await localContext.publisherPlebbit.createSigner();

            try {
                const post = await publishRandomPost({
                    subplebbitAddress: localContext.subplebbit.address,
                    plebbit: localContext.publisherPlebbit,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, post);

                const upvote = await localContext.publisherPlebbit.createVote({
                    subplebbitAddress: localContext.subplebbit.address,
                    commentCid: post.cid,
                    vote: 1,
                    signer: voter
                });
                await publishWithExpectedResult({ publication: upvote, expectedChallengeSuccess: true });

                const waitForPostScoreInUpdate = async () => {
                    const timeoutMs = 60000;
                    const start = Date.now();
                    while (Date.now() - start < timeoutMs) {
                        const postUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: post.cid
                        }) as StoredCommentUpdate | undefined;
                        if (postUpdate?.author?.subplebbit?.postScore === 1) return;
                        await new Promise((resolve) => setTimeout(resolve, 50));
                    }
                    throw new Error("Timed out waiting for postScore to update in comment update");
                };
                await waitForPostScoreInUpdate();

                const reply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    plebbit: localContext.publisherPlebbit,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                const secondPost = await publishRandomPost({
                    subplebbitAddress: localContext.subplebbit.address,
                    plebbit: localContext.publisherPlebbit,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, reply);
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, secondPost);

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () => {
                        const firstReplyUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: reply.cid
                        }) as StoredCommentUpdate;
                        const secondPostUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: secondPost.cid
                        }) as StoredCommentUpdate;
                        return (
                            firstReplyUpdate?.author?.subplebbit?.postScore === 1 && secondPostUpdate?.author?.subplebbit?.postScore === 1
                        );
                    }
                });

                const postUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                expect(postUpdate?.author?.subplebbit?.postScore).to.equal(1);
                expect(postUpdate?.author?.subplebbit?.replyScore).to.equal(0);

                const replyUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: reply.cid
                }) as StoredCommentUpdate;
                expect(replyUpdate?.author?.subplebbit?.postScore).to.equal(1);
                expect(replyUpdate?.author?.subplebbit?.replyScore).to.equal(0);

                const secondPostUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: secondPost.cid
                }) as StoredCommentUpdate;
                expect(secondPostUpdate?.author?.subplebbit?.postScore).to.equal(1);
                expect(secondPostUpdate?.author?.subplebbit?.replyScore).to.equal(0);

                await reply.stop();
                await secondPost.stop();
                await post.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.subplebbit.postScore adjusts when a vote flips from upvote to downvote", async () => {
            const localContext = await createPerAuthorSubplebbit();
            const localAuthor = await localContext.publisherPlebbit.createSigner();
            const voter = await localContext.publisherPlebbit.createSigner();

            try {
                const post = await publishRandomPost({
                    subplebbitAddress: localContext.subplebbit.address,
                    plebbit: localContext.publisherPlebbit,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, post);

                const upvote = await localContext.publisherPlebbit.createVote({
                    subplebbitAddress: localContext.subplebbit.address,
                    commentCid: post.cid,
                    vote: 1,
                    signer: voter
                });
                await publishWithExpectedResult({ publication: upvote, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () =>
                        (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(localAuthor.address)?.postScore === 1
                });

                const downvote = await localContext.publisherPlebbit.createVote({
                    subplebbitAddress: localContext.subplebbit.address,
                    commentCid: post.cid,
                    vote: -1,
                    signer: voter
                });
                await publishWithExpectedResult({ publication: downvote, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () =>
                        (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(localAuthor.address)?.postScore === -1
                });

                const waitForFlippedScoreInUpdate = async () => {
                    const timeoutMs = 60000;
                    const start = Date.now();
                    while (Date.now() - start < timeoutMs) {
                        const postUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: post.cid
                        }) as StoredCommentUpdate | undefined;
                        if (postUpdate?.author?.subplebbit?.postScore === -1) return;
                        await new Promise((resolve) => setTimeout(resolve, 50));
                    }
                    throw new Error("Timed out waiting for postScore to reflect flipped vote in comment update");
                };
                await waitForFlippedScoreInUpdate();

                const postUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                expect(postUpdate?.author?.subplebbit?.postScore).to.equal(-1);
                expect(postUpdate?.author?.subplebbit?.replyScore).to.equal(0);

                await post.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.subplebbit.replyScore is present with total reply karma when pseudonymityMode is per-author", async () => {
            const localContext = await createPerAuthorSubplebbit();
            const localAuthor = await localContext.publisherPlebbit.createSigner();
            const voter = await localContext.publisherPlebbit.createSigner();

            try {
                const post = await publishRandomPost({
                    subplebbitAddress: localContext.subplebbit.address,
                    plebbit: localContext.publisherPlebbit,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, post);
                const reply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    plebbit: localContext.publisherPlebbit,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, reply);

                const upvote = await localContext.publisherPlebbit.createVote({
                    subplebbitAddress: localContext.subplebbit.address,
                    commentCid: reply.cid,
                    vote: 1,
                    signer: voter
                });
                await publishWithExpectedResult({ publication: upvote, expectedChallengeSuccess: true });

                const waitForReplyScoreInUpdate = async () => {
                    const timeoutMs = 60000;
                    const start = Date.now();
                    while (Date.now() - start < timeoutMs) {
                        const replyUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: reply.cid
                        }) as StoredCommentUpdate | undefined;
                        if (replyUpdate?.author?.subplebbit?.replyScore === 1) return;
                        await new Promise((resolve) => setTimeout(resolve, 50));
                    }
                    throw new Error("Timed out waiting for replyScore to update in comment update");
                };
                await waitForReplyScoreInUpdate();

                const replyUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: reply.cid
                }) as StoredCommentUpdate;
                expect(replyUpdate?.author?.subplebbit?.replyScore).to.equal(1);
                expect(replyUpdate?.author?.subplebbit?.postScore).to.equal(0);

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () => {
                        const postUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: post.cid
                        }) as StoredCommentUpdate;
                        return postUpdate?.author?.subplebbit?.replyScore === 1 && postUpdate?.author?.subplebbit?.postScore === 0;
                    }
                });

                const postUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                expect(postUpdate?.author?.subplebbit?.replyScore).to.equal(1);
                expect(postUpdate?.author?.subplebbit?.postScore).to.equal(0);

                await post.stop();
                await reply.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: votes from multiple authors aggregate into author.subplebbit.postScore for per-author mode", async () => {
            const localContext = await createPerAuthorSubplebbit();
            const localAuthor = await localContext.publisherPlebbit.createSigner();
            const voterOne = await localContext.publisherPlebbit.createSigner();
            const voterTwo = await localContext.publisherPlebbit.createSigner();

            try {
                const post = await publishRandomPost({
                    subplebbitAddress: localContext.subplebbit.address,
                    plebbit: localContext.publisherPlebbit,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, post);

                const upvoteOne = await localContext.publisherPlebbit.createVote({
                    subplebbitAddress: localContext.subplebbit.address,
                    commentCid: post.cid,
                    vote: 1,
                    signer: voterOne
                });
                await publishWithExpectedResult({ publication: upvoteOne, expectedChallengeSuccess: true });

                const upvoteTwo = await localContext.publisherPlebbit.createVote({
                    subplebbitAddress: localContext.subplebbit.address,
                    commentCid: post.cid,
                    vote: 1,
                    signer: voterTwo
                });
                await publishWithExpectedResult({ publication: upvoteTwo, expectedChallengeSuccess: true });

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () =>
                        (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(localAuthor.address)?.postScore === 2
                });

                const waitForAggregatedScoreInUpdate = async () => {
                    const timeoutMs = 60000;
                    const start = Date.now();
                    while (Date.now() - start < timeoutMs) {
                        const postUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: post.cid
                        }) as StoredCommentUpdate | undefined;
                        if (postUpdate?.author?.subplebbit?.postScore === 2) return;
                        await new Promise((resolve) => setTimeout(resolve, 50));
                    }
                    throw new Error("Timed out waiting for aggregated postScore in comment update");
                };
                await waitForAggregatedScoreInUpdate();

                const postUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: post.cid
                }) as StoredCommentUpdate;
                expect(postUpdate?.author?.subplebbit?.postScore).to.equal(2);
                expect(postUpdate?.author?.subplebbit?.replyScore).to.equal(0);

                const reply = await publishRandomReply({
                    parentComment: post as CommentIpfsWithCidDefined,
                    plebbit: localContext.publisherPlebbit,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, reply);

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () => {
                        const replyUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: reply.cid
                        }) as StoredCommentUpdate;
                        return replyUpdate?.author?.subplebbit?.postScore === 2;
                    }
                });

                const replyUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: reply.cid
                }) as StoredCommentUpdate;
                expect(replyUpdate?.author?.subplebbit?.postScore).to.equal(2);
                expect(replyUpdate?.author?.subplebbit?.replyScore).to.equal(0);
                await reply.stop();

                await post.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.subplebbit karma IS shared across different posts when pseudonymityMode is per-author", async () => {
            // In per-author mode, all posts by the same author share the same alias
            // Karma from post1 SHOULD appear in post2's author.subplebbit

            const localContext = await createPerAuthorSubplebbit();
            const localAuthor = await localContext.publisherPlebbit.createSigner();
            const voter = await localContext.publisherPlebbit.createSigner();

            try {
                // Create first post and upvote it
                const post1 = await publishRandomPost({
                    subplebbitAddress: localContext.subplebbit.address,
                    plebbit: localContext.publisherPlebbit,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, post1);

                const upvotePost1 = await localContext.publisherPlebbit.createVote({
                    subplebbitAddress: localContext.subplebbit.address,
                    commentCid: post1.cid,
                    vote: 1,
                    signer: voter
                });
                await publishWithExpectedResult({ publication: upvotePost1, expectedChallengeSuccess: true });

                // Wait for post1 to have postScore = 1
                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () => {
                        const update = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: post1.cid
                        }) as StoredCommentUpdate | undefined;
                        return update?.author?.subplebbit?.postScore === 1;
                    }
                });

                // Create second post - same alias in per-author mode
                const post2 = await publishRandomPost({
                    subplebbitAddress: localContext.subplebbit.address,
                    plebbit: localContext.publisherPlebbit,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, post2);

                // Wait for post2's update to reflect the shared karma
                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () => {
                        const update = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: post2.cid
                        }) as StoredCommentUpdate | undefined;
                        return update?.author?.subplebbit?.postScore === 1;
                    }
                });

                // Verify post1's alias has postScore = 1
                const post1Update = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: post1.cid
                }) as StoredCommentUpdate;
                expect(post1Update?.author?.subplebbit?.postScore).to.equal(1);

                // Verify post2's alias also has postScore = 1 (shared from post1)
                const post2Update = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: post2.cid
                }) as StoredCommentUpdate;
                expect(post2Update?.author?.subplebbit?.postScore).to.equal(1);

                // Verify they have the SAME alias by checking the alias private keys
                const post1Alias = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                    post1.cid
                ) as AliasRow;
                const post2Alias = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(
                    post2.cid
                ) as AliasRow;
                expect(post1Alias).to.exist;
                expect(post2Alias).to.exist;
                expect(post1Alias.aliasPrivateKey).to.equal(post2Alias.aliasPrivateKey);

                await post1.stop();
                await post2.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.subplebbit.firstCommentTimestamp is present and matches the first comment time for per-author mode", async () => {
            const localContext = await createPerAuthorSubplebbit();
            const localAuthor = await localContext.publisherPlebbit.createSigner();

            try {
                const firstPost = await publishRandomPost({
                    subplebbitAddress: localContext.subplebbit.address,
                    plebbit: localContext.publisherPlebbit,
                    postProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, firstPost);
                const firstTimestamp = firstPost.timestamp;

                const secondComment = await publishRandomReply({
                    parentComment: firstPost as CommentIpfsWithCidDefined,
                    plebbit: localContext.publisherPlebbit,
                    commentProps: {
                        signer: localAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(localContext.subplebbit as LocalSubplebbit, secondComment);

                await secondComment.update();
                await resolveWhenConditionIsTrue({
                    toUpdate: secondComment,
                    predicate: async () => typeof secondComment.author?.subplebbit?.firstCommentTimestamp === "number"
                });

                const aggregatedAuthor = (localContext.subplebbit as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(localAuthor.address);
                expect(aggregatedAuthor?.firstCommentTimestamp).to.equal(firstTimestamp);
                expect(secondComment.author?.subplebbit?.firstCommentTimestamp).to.equal(firstTimestamp);

                await resolveWhenConditionIsTrue({
                    toUpdate: localContext.subplebbit,
                    predicate: async () =>
                        (
                            (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                                cid: firstPost.cid
                            }) as StoredCommentUpdate
                        )?.author?.subplebbit?.firstCommentTimestamp === firstTimestamp
                });

                const firstPostUpdate = (localContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: firstPost.cid
                }) as StoredCommentUpdate;
                expect(firstPostUpdate?.author?.subplebbit?.firstCommentTimestamp).to.equal(firstTimestamp);

                await firstPost.stop();
                await secondComment.stop();
            } finally {
                await localContext.cleanup();
            }
        });

        it("Spec: author.subplebbit in CommentUpdate does NOT include karma from original author's prior comments when pseudonymityMode is per-author", async () => {
            // This test verifies that enabling pseudonymity mode doesn't leak prior karma into new aliases
            // 1. Author builds karma without pseudonymity mode
            // 2. Enable pseudonymity mode
            // 3. Author publishes new post (gets a persistent alias for per-author mode)
            // 4. Alias's author.subplebbit should show 0 karma, not the original author's prior karma

            const plebbit = await mockPlebbit();
            const sub = await createSubWithNoChallenge({}, plebbit);

            // Ensure pseudonymity mode is initially disabled
            await sub.edit({ features: { pseudonymityMode: undefined } });
            await sub.start();
            await resolveWhenConditionIsTrue({
                toUpdate: sub,
                predicate: async () => typeof sub.updatedAt === "number"
            });

            const author = await plebbit.createSigner();
            const voter = await plebbit.createSigner();

            try {
                // Step 1: Build up karma without pseudonymity mode
                const nonPseudonymousPost = await publishRandomPost({
                    subplebbitAddress: sub.address,
                    plebbit: plebbit,
                    postProps: { signer: author }
                });
                await waitForStoredCommentUpdateWithAssertions(sub as LocalSubplebbit, nonPseudonymousPost);

                // Upvote the post to give author post karma
                const upvote = await plebbit.createVote({
                    subplebbitAddress: sub.address,
                    commentCid: nonPseudonymousPost.cid,
                    vote: 1,
                    signer: voter
                });
                await publishWithExpectedResult({ publication: upvote, expectedChallengeSuccess: true });

                // Verify original author has post karma
                await resolveWhenConditionIsTrue({
                    toUpdate: sub,
                    predicate: async () => {
                        const authorSubplebbit = (sub as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                        return authorSubplebbit?.postScore === 1;
                    }
                });

                const originalAuthorKarma = (sub as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                expect(originalAuthorKarma?.postScore).to.equal(1);

                // Step 2: Enable pseudonymity mode
                await sub.edit({ features: { pseudonymityMode: "per-author" } });
                await resolveWhenConditionIsTrue({
                    toUpdate: sub,
                    predicate: async () => sub.features?.pseudonymityMode === "per-author"
                });

                // Step 3: Author publishes a new post (gets a persistent alias for per-author mode)
                const pseudonymousPost = await publishRandomPost({
                    subplebbitAddress: sub.address,
                    plebbit: plebbit,
                    postProps: { signer: author }
                });
                await waitForStoredCommentUpdateWithAssertions(sub as LocalSubplebbit, pseudonymousPost);

                // Step 4: Verify the alias's CommentUpdate shows isolated karma (0), not original author's karma (1)
                const postUpdate = (sub as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                    cid: pseudonymousPost.cid
                }) as StoredCommentUpdate;

                // The alias should have its own isolated karma, not the original author's karma
                expect(postUpdate?.author?.subplebbit?.postScore).to.equal(0);
                expect(postUpdate?.author?.subplebbit?.replyScore).to.equal(0);

                // Verify the alias is different from the original author
                const aliasRow = (sub as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(pseudonymousPost.cid);
                expect(aliasRow).to.exist;
                expect(aliasRow?.originalAuthorSignerPublicKey).to.equal(author.publicKey);

                // Double-check: original author's karma should still be 1
                const originalAuthorKarmaAfter = (sub as LocalSubplebbit)._dbHandler.querySubplebbitAuthor(author.address);
                expect(originalAuthorKarmaAfter?.postScore).to.equal(1);

                await nonPseudonymousPost.stop();
                await pseudonymousPost.stop();
            } finally {
                await sub.stop();
                await plebbit.destroy();
            }
        });
    });

    describe.concurrent("duplicate comment regression", () => {
        let context: PerAuthorContext;
        let duplicateSigner: SignerWithPublicKeyAddress;

        const clonePublication = <T>(value: T): T => JSON.parse(JSON.stringify(value));

        beforeAll(async () => {
            context = await createPerAuthorSubplebbit();
            duplicateSigner = await context.publisherPlebbit.createSigner();
        });

        afterAll(async () => {
            await context.cleanup();
        });

        it("Spec: rejects duplicate post publication in per-author pseudonymity mode", async () => {
            let originalPost: Comment | undefined;
            let duplicatePost: Comment | undefined;

            try {
                originalPost = await context.publisherPlebbit.createComment({
                    subplebbitAddress: context.subplebbit.address,
                    signer: duplicateSigner,
                    title: `duplicate-per-author-title-${Date.now()}`,
                    content: `duplicate-per-author-content-${Date.now()}`
                });
                const originalPublication = clonePublication(originalPost.toJSONPubsubMessagePublication());

                await publishWithExpectedResult({ publication: originalPost, expectedChallengeSuccess: true });
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, originalPost);

                duplicatePost = await context.publisherPlebbit.createComment(originalPublication);
                await publishWithExpectedResult({
                    publication: duplicatePost,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_DUPLICATE_COMMENT
                });
            } finally {
                await duplicatePost?.stop();
                await originalPost?.stop();
            }
        });

        it("Spec: rejects duplicate reply publication in per-author pseudonymity mode", async () => {
            let parentPost: Comment | undefined;
            let originalReply: Comment | undefined;
            let duplicateReply: Comment | undefined;

            try {
                parentPost = await publishRandomPost({
                    subplebbitAddress: context.subplebbit.address,
                    plebbit: context.publisherPlebbit,
                    postProps: { signer: duplicateSigner }
                });
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, parentPost);

                originalReply = await context.publisherPlebbit.createComment({
                    subplebbitAddress: context.subplebbit.address,
                    signer: duplicateSigner,
                    parentCid: parentPost.cid,
                    postCid: parentPost.cid,
                    content: `duplicate-per-author-reply-${Date.now()}`
                });
                const originalReplyPublication = clonePublication(originalReply.toJSONPubsubMessagePublication());

                await publishWithExpectedResult({ publication: originalReply, expectedChallengeSuccess: true });
                await waitForStoredCommentUpdateWithAssertions(context.subplebbit as LocalSubplebbit, originalReply);

                duplicateReply = await context.publisherPlebbit.createComment(originalReplyPublication);
                await publishWithExpectedResult({
                    publication: duplicateReply,
                    expectedChallengeSuccess: false,
                    expectedReason: messages.ERR_DUPLICATE_COMMENT
                });
            } finally {
                await duplicateReply?.stop();
                await originalReply?.stop();
                await parentPost?.stop();
            }
        });
    });

    describe.concurrent("remote loading with anonymized comments", () => {
        describe("preloaded pages", () => {
            let sharedContext: PerAuthorContext;
            let aliasSigner: SignerWithPublicKeyAddress;
            let signingAuthor: SignerWithPublicKeyAddress;

            beforeAll(async () => {
                sharedContext = await createPerAuthorSubplebbit();
                signingAuthor = await sharedContext.publisherPlebbit.createSigner();
                sharedContext.post = await publishRandomPost({
                    subplebbitAddress: sharedContext.subplebbit.address,
                    plebbit: sharedContext.publisherPlebbit,
                    postProps: {
                        signer: signingAuthor
                    }
                });
                sharedContext.postDisplayName = sharedContext.post.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(sharedContext.subplebbit as LocalSubplebbit, sharedContext.post);
                sharedContext.reply = await publishRandomReply({
                    parentComment: sharedContext.post as CommentIpfsWithCidDefined,
                    plebbit: sharedContext.publisherPlebbit,
                    commentProps: {
                        signer: signingAuthor
                    }
                });
                sharedContext.replyDisplayName = sharedContext.reply.author.displayName;
                await waitForStoredCommentUpdateWithAssertions(sharedContext.subplebbit as LocalSubplebbit, sharedContext.reply);
                await waitTillPostInSubplebbitPages(sharedContext.post as CommentIpfsWithCidDefined, sharedContext.publisherPlebbit);
                await waitTillReplyInParentPages(
                    sharedContext.reply as Required<Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">>,
                    sharedContext.publisherPlebbit
                );

                const aliasRow = (sharedContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                    signingAuthor.publicKey
                ) as AliasRow;
                expect(aliasRow).to.exist;
                aliasSigner = await sharedContext.publisherPlebbit.createSigner({ privateKey: aliasRow.aliasPrivateKey, type: "ed25519" });

                sharedContext.editContent = "Edited content for remote load " + Date.now();
                const edit = await sharedContext.publisherPlebbit.createCommentEdit({
                    subplebbitAddress: sharedContext.subplebbit.address,
                    commentCid: sharedContext.post!.cid,
                    content: sharedContext.editContent,
                    signer: signingAuthor
                });
                await publishWithExpectedResult({ publication: edit, expectedChallengeSuccess: true });
                await resolveWhenConditionIsTrue({
                    toUpdate: sharedContext.subplebbit,
                    predicate: async () =>
                        (
                            (sharedContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                                cid: sharedContext.post!.cid
                            }) as StoredCommentUpdate
                        )?.edit?.content === sharedContext.editContent
                });
            });

            afterAll(async () => {
                await sharedContext?.post?.stop();
                await sharedContext?.reply?.stop();
                await sharedContext?.cleanup();
            });

            remotePlebbitConfigs.forEach((config) => {
                describe.concurrent(`${config.name} - preloaded`, () => {
                    let remotePlebbit: Plebbit;

                    beforeAll(async () => {
                        remotePlebbit = await config.plebbitInstancePromise();
                        await waitTillPostInSubplebbitPages(sharedContext.post! as CommentIpfsWithCidDefined, remotePlebbit);
                        await waitTillReplyInParentPages(
                            sharedContext.reply! as Required<Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">>,
                            remotePlebbit
                        );
                    });

                    afterAll(async () => {
                        await remotePlebbit?.destroy();
                    });

                    it("Spec: loads preloaded pages with anonymized posts/replies without failing verification", async () => {
                        const remoteSubplebbit = await remotePlebbit.getSubplebbit({ address: sharedContext.subplebbit.address });
                        expect(Object.keys(remoteSubplebbit.posts.pages).length).to.be.greaterThan(0);
                        for (const sortName of Object.keys(remoteSubplebbit.posts.pages)) {
                            const page = remoteSubplebbit.posts.pages[sortName];
                            const postInPage = page.comments.find((c) => c.cid === sharedContext.post!.cid);
                            expect(postInPage).to.be.ok;
                            expect(postInPage?.author?.address).to.equal(aliasSigner.address);
                            expect(postInPage?.author?.displayName).to.equal(sharedContext.postDisplayName);
                            expect(postInPage?.author?.wallets).to.be.undefined;
                            expect(postInPage?.author?.flairs).to.be.undefined;
                            expect(postInPage?.signature?.publicKey).to.equal(aliasSigner.publicKey);
                            expect(postInPage?.pseudonymityMode).to.equal("per-author");
                        }
                    });

                    it("Can load an anonymized comment with getComment and fetch its CommentUpdate", async () => {
                        const remoteComment = await remotePlebbit.getComment({ cid: sharedContext.post!.cid });
                        await remoteComment.update();
                        await resolveWhenConditionIsTrue({
                            toUpdate: remoteComment,
                            predicate: async () =>
                                typeof remoteComment.updatedAt === "number" && remoteComment.edit?.content === sharedContext.editContent
                        });
                        expect(remoteComment.author.address).to.equal(aliasSigner.address);
                        expect(remoteComment.author.displayName).to.equal(sharedContext.postDisplayName);
                        expect(remoteComment.content).to.equal(sharedContext.editContent);
                        expect(remoteComment.edit?.content).to.equal(sharedContext.editContent);
                        expect(remoteComment.edit?.signature?.publicKey).to.equal(aliasSigner.publicKey);
                        expect(remoteComment.signature.publicKey).to.equal(aliasSigner.publicKey);
                        expect(remoteComment.pseudonymityMode).to.equal("per-author");
                        await remoteComment.stop();
                    });

                    it("Can update an anonymized comment with comment.update()", async () => {
                        const remoteReply = await remotePlebbit.getComment({ cid: sharedContext.reply!.cid });
                        await remoteReply.update();
                        await resolveWhenConditionIsTrue({
                            toUpdate: remoteReply,
                            predicate: async () => typeof remoteReply.updatedAt === "number"
                        });
                        expect(remoteReply.author.address).to.equal(aliasSigner.address);
                        expect(remoteReply.author.displayName).to.equal(sharedContext.replyDisplayName);

                        expect(remoteReply.signature.publicKey).to.equal(aliasSigner.publicKey);
                        await remoteReply.stop();
                    });
                });
            });
        });

        describe.concurrent("paginated pages", () => {
            let paginatedContext: PerAuthorContext;
            let paginatedAliasSigner: SignerWithPublicKeyAddress;
            let paginatedSigningAuthor: SignerWithPublicKeyAddress;
            let paginatedForcedChunkingCleanup: (() => void) | undefined;

            beforeAll(async () => {
                paginatedContext = await createPerAuthorSubplebbit();
                paginatedSigningAuthor = await paginatedContext.publisherPlebbit.createSigner();
                paginatedContext.post = await publishRandomPost({
                    subplebbitAddress: paginatedContext.subplebbit.address,
                    plebbit: paginatedContext.publisherPlebbit,
                    postProps: {
                        signer: paginatedSigningAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(paginatedContext.subplebbit as LocalSubplebbit, paginatedContext.post);
                paginatedContext.reply = await publishRandomReply({
                    parentComment: paginatedContext.post as CommentIpfsWithCidDefined,
                    plebbit: paginatedContext.publisherPlebbit,
                    commentProps: {
                        signer: paginatedSigningAuthor
                    }
                });
                await waitForStoredCommentUpdateWithAssertions(paginatedContext.subplebbit as LocalSubplebbit, paginatedContext.reply);
                const { cleanup } = await forceLocalSubPagesToAlwaysGenerateMultipleChunks({
                    subplebbit: paginatedContext.subplebbit,
                    parentComment: paginatedContext.post
                });
                paginatedForcedChunkingCleanup = cleanup;
                await forceSubplebbitToGenerateAllPostsPages(paginatedContext.subplebbit);
                await waitTillPostInSubplebbitPages(paginatedContext.post as CommentIpfsWithCidDefined, paginatedContext.publisherPlebbit);
                await waitTillReplyInParentPages(
                    paginatedContext.reply as Required<Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">>,
                    paginatedContext.publisherPlebbit
                );

                const aliasRow = (paginatedContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                    paginatedSigningAuthor.publicKey
                ) as AliasRow;
                expect(aliasRow).to.exist;
                paginatedAliasSigner = await paginatedContext.publisherPlebbit.createSigner({
                    privateKey: aliasRow.aliasPrivateKey,
                    type: "ed25519"
                });
            });

            afterAll(async () => {
                await paginatedContext?.post?.stop();
                await paginatedContext?.reply?.stop();
                await paginatedForcedChunkingCleanup?.();
                await paginatedContext?.cleanup();
            });

            remotePlebbitConfigs.forEach((config) => {
                describe.concurrent(`${config.name} - paginated`, () => {
                    let remotePlebbit: Plebbit;

                    beforeAll(async () => {
                        remotePlebbit = await config.plebbitInstancePromise();
                        await waitTillPostInSubplebbitPages(paginatedContext.post! as CommentIpfsWithCidDefined, remotePlebbit);
                        await waitTillReplyInParentPages(
                            paginatedContext.reply! as Required<Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">>,
                            remotePlebbit
                        );
                    });

                    afterAll(async () => {
                        await remotePlebbit?.destroy();
                    });

                    it("Spec: subplebbit.posts.getPage({ cid }) loads a page with anonymized comments", async () => {
                        const remoteSubplebbit = await remotePlebbit.getSubplebbit({ address: paginatedContext.subplebbit.address });
                        expect(Object.keys(remoteSubplebbit.posts.pageCids).length).to.be.greaterThan(0);
                        for (const firstPageCid of Object.values(remoteSubplebbit.posts.pageCids)) {
                            let currentCid: string | undefined = firstPageCid;
                            let found = false;
                            while (currentCid && !found) {
                                const page = await remoteSubplebbit.posts.getPage({ cid: currentCid });
                                const postInPage = page.comments.find((c) => c.cid === paginatedContext.post!.cid);
                                if (postInPage) {
                                    expect(postInPage?.author?.address).to.equal(paginatedAliasSigner.address);
                                    expect(postInPage?.signature?.publicKey).to.equal(paginatedAliasSigner.publicKey);
                                    found = true;
                                } else currentCid = page.nextCid;
                            }
                            expect(found, "expected paginated post to appear in one of the pages").to.be.true;
                        }
                    });

                    it("Spec: comment.replies.getPage({ cid }) loads a page with anonymized replies", async () => {
                        const remoteParent = await remotePlebbit.getComment({ cid: paginatedContext.post!.cid });
                        await remoteParent.update();
                        await waitTillReplyInParentPagesInstance(
                            paginatedContext.reply! as Required<Pick<CommentIpfsWithCidDefined, "subplebbitAddress" | "parentCid" | "cid">>,
                            remoteParent
                        );
                        expect(
                            Object.keys(remoteParent.replies.pageCids || {}),
                            "expected replies.pageCids to be populated for paginated replies"
                        ).to.not.be.empty;
                        const replyPageCid = Object.values(remoteParent.replies.pageCids || {})[0];
                        expect(replyPageCid, "expected a replies page cid after forcing pagination").to.be.ok;
                        const repliesPage = await remoteParent.replies.getPage({ cid: replyPageCid });
                        const replyEntryInPage = repliesPage.comments.find((c) => c.cid === paginatedContext.reply!.cid);
                        expect(replyEntryInPage?.author?.address).to.equal(paginatedAliasSigner.address);
                        expect(replyEntryInPage?.signature?.publicKey).to.equal(paginatedAliasSigner.publicKey);
                        await remoteParent.stop();
                    });
                });
            });
        });
    });

    describe.sequential("mod exclusion from pseudonymization", () => {
        let modContext: PerAuthorContext;
        let modSigner: SignerWithPublicKeyAddress;
        let regularSigner: SignerWithPublicKeyAddress;

        beforeAll(async () => {
            modContext = await createPerAuthorSubplebbit();
            modSigner = await modContext.publisherPlebbit.createSigner();
            regularSigner = await modContext.publisherPlebbit.createSigner();

            // Assign mod role
            await modContext.subplebbit.edit({ roles: { [modSigner.address]: { role: "moderator" } } });
            await resolveWhenConditionIsTrue({
                toUpdate: modContext.subplebbit,
                predicate: async () => modContext.subplebbit.roles?.[modSigner.address]?.role === "moderator"
            });
        });

        afterAll(async () => {
            await modContext.cleanup();
        });

        it("Spec: mod comment is NOT pseudonymized in per-author mode", async () => {
            const modPost = await publishRandomPost({
                subplebbitAddress: modContext.subplebbit.address,
                plebbit: modContext.publisherPlebbit,
                postProps: { signer: modSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(modContext.subplebbit as LocalSubplebbit, modPost);

            const stored = (modContext.subplebbit as LocalSubplebbit)._dbHandler.queryComment(modPost.cid) as StoredComment;
            expect(stored?.author?.address).to.equal(modSigner.address);
            expect(stored?.signature?.publicKey).to.equal(modSigner.publicKey);
            expect(stored?.pseudonymityMode).to.be.undefined;

            const aliasRow = (modContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasByCommentCid(modPost.cid);
            expect(aliasRow).to.be.undefined;

            const aliasForAuthor = (modContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                modSigner.publicKey
            );
            expect(aliasForAuthor).to.be.undefined;

            await modPost.stop();
        });

        it("Spec: non-mod is still pseudonymized alongside mod in per-author mode", async () => {
            const modPost = await publishRandomPost({
                subplebbitAddress: modContext.subplebbit.address,
                plebbit: modContext.publisherPlebbit,
                postProps: { signer: modSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(modContext.subplebbit as LocalSubplebbit, modPost);

            const regularPost = await publishRandomPost({
                subplebbitAddress: modContext.subplebbit.address,
                plebbit: modContext.publisherPlebbit,
                postProps: {
                    signer: regularSigner
                }
            });
            await waitForStoredCommentUpdateWithAssertions(modContext.subplebbit as LocalSubplebbit, regularPost);

            // Mod should use real address
            const storedMod = (modContext.subplebbit as LocalSubplebbit)._dbHandler.queryComment(modPost.cid) as StoredComment;
            expect(storedMod?.author?.address).to.equal(modSigner.address);
            expect(storedMod?.signature?.publicKey).to.equal(modSigner.publicKey);

            // Regular user should be pseudonymized
            const storedRegular = (modContext.subplebbit as LocalSubplebbit)._dbHandler.queryComment(regularPost.cid) as StoredComment;
            expect(storedRegular?.author?.address).to.not.equal(regularSigner.address);
            expect(storedRegular?.signature?.publicKey).to.not.equal(regularSigner.publicKey);

            const aliasRow = (modContext.subplebbit as LocalSubplebbit)._dbHandler.queryPseudonymityAliasForAuthor(
                regularSigner.publicKey
            ) as AliasRow;
            expect(aliasRow).to.exist;
            expect(aliasRow.mode).to.equal("per-author");

            await modPost.stop();
            await regularPost.stop();
        });

        it("Spec: mod comment edit uses real key in per-author mode", async () => {
            const modPost = await publishRandomPost({
                subplebbitAddress: modContext.subplebbit.address,
                plebbit: modContext.publisherPlebbit,
                postProps: { signer: modSigner }
            });
            await waitForStoredCommentUpdateWithAssertions(modContext.subplebbit as LocalSubplebbit, modPost);

            const editedContent = "Mod edited content - " + Date.now();
            const edit = await modContext.publisherPlebbit.createCommentEdit({
                subplebbitAddress: modPost.subplebbitAddress,
                commentCid: modPost.cid,
                content: editedContent,
                signer: modSigner
            });
            await publishWithExpectedResult({ publication: edit, expectedChallengeSuccess: true });

            await resolveWhenConditionIsTrue({
                toUpdate: modContext.subplebbit,
                predicate: async () =>
                    (
                        (modContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                            cid: modPost.cid
                        }) as StoredCommentUpdate
                    )?.edit?.content === editedContent
            });

            const storedUpdate = (modContext.subplebbit as LocalSubplebbit)._dbHandler.queryStoredCommentUpdate({
                cid: modPost.cid
            }) as StoredCommentUpdate;
            expect(storedUpdate?.edit?.content).to.equal(editedContent);
            expect(storedUpdate?.edit?.signature?.publicKey).to.equal(modSigner.publicKey);

            await modPost.stop();
        });
    });

    describe("Spec: existing replies keep original pseudonymityMode while new replies follow current mode", () => {
        it("Spec: per-author replies stay per-author after switching to per-post", async () => {
            await assertPseudonymityModeTransition({ initialMode: "per-author", nextMode: "per-post" });
        });

        it("Spec: per-author replies stay per-author after switching to per-reply", async () => {
            await assertPseudonymityModeTransition({ initialMode: "per-author", nextMode: "per-reply" });
        });
    });
});

async function expectCommentCidToUseAlias(plebbit: Plebbit, cid: string, aliasSigner: SignerWithPublicKeyAddress) {
    const fetched = JSON.parse(await plebbit.fetchCid({ cid })) as {
        author?: { address?: string };
        signature?: { publicKey?: string };
        pseudonymityMode?: string;
    };
    expect(fetched?.author?.address).to.equal(aliasSigner.address);
    expect(fetched?.signature?.publicKey).to.equal(aliasSigner.publicKey);
    expect(fetched?.pseudonymityMode).to.equal("per-author");
}

const PROTOCOL_VERSION = "1.0.0";

async function assertPseudonymityModeTransition({ initialMode, nextMode }: { initialMode: string; nextMode: string }) {
    const context = await createAnonymityTransitionContext(initialMode);
    const authorSigner = await createSigner({ privateKey: signers[0].privateKey, type: signers[0].type });

    try {
        const parentPost = await buildSignedPostPublication({
            signer: authorSigner,
            subplebbitAddress: context.subplebbitAddress
        });
        const storedParentPost = await (context.subplebbit as unknown as LocalSubplebbitWithPrivateMethods).storePublication({
            comment: parentPost
        });
        const postCid = storedParentPost.cid;

        const originalReply = await buildSignedReplyPublication({
            signer: authorSigner,
            subplebbitAddress: context.subplebbitAddress,
            postCid,
            parentCid: postCid
        });
        const oldStored = await (context.subplebbit as unknown as LocalSubplebbitWithPrivateMethods).storePublication({
            comment: originalReply
        });
        const oldReplyCid = oldStored.cid;
        const oldAliasRow = context.dbHandler.queryPseudonymityAliasByCommentCid(oldReplyCid) as AliasRow;
        expect(oldAliasRow?.mode).to.equal(initialMode);

        const oldAliasSigner = await createSigner({ privateKey: oldAliasRow.aliasPrivateKey, type: "ed25519" });
        expectStoredCommentToUseAlias(context.dbHandler, oldReplyCid, oldAliasSigner);

        await context.subplebbit.edit({ features: { pseudonymityMode: nextMode as "per-author" | "per-post" | "per-reply" } });
        await ensureSubplebbitDbReady(context.subplebbit as LocalSubplebbit);

        const newReply = await buildSignedReplyPublication({
            signer: authorSigner,
            subplebbitAddress: context.subplebbitAddress,
            postCid,
            parentCid: postCid
        });
        const newReplyStored = await (context.subplebbit as unknown as LocalSubplebbitWithPrivateMethods).storePublication({
            comment: newReply
        });
        const newReplyAliasRow = context.dbHandler.queryPseudonymityAliasByCommentCid(newReplyStored.cid) as AliasRow;
        expect(newReplyAliasRow?.mode).to.equal(nextMode);

        const newReplyAliasSigner = await createSigner({ privateKey: newReplyAliasRow.aliasPrivateKey, type: "ed25519" });
        expect(newReplyAliasRow.aliasPrivateKey).to.not.equal(oldAliasRow.aliasPrivateKey);
        expectStoredCommentToUseAlias(context.dbHandler, newReplyStored.cid, newReplyAliasSigner);

        const newPost = await buildSignedPostPublication({
            signer: authorSigner,
            subplebbitAddress: context.subplebbitAddress
        });
        const newPostStored = await (context.subplebbit as unknown as LocalSubplebbitWithPrivateMethods).storePublication({
            comment: newPost
        });
        const newPostAliasRow = context.dbHandler.queryPseudonymityAliasByCommentCid(newPostStored.cid) as AliasRow;
        expect(newPostAliasRow?.mode).to.equal(nextMode);

        const newPostAliasSigner = await createSigner({ privateKey: newPostAliasRow.aliasPrivateKey, type: "ed25519" });
        expect(newPostAliasRow.aliasPrivateKey).to.not.equal(oldAliasRow.aliasPrivateKey);
        expectStoredCommentToUseAlias(context.dbHandler, newPostStored.cid, newPostAliasSigner);

        const storedAliasAfter = context.dbHandler.queryPseudonymityAliasByCommentCid(oldReplyCid) as AliasRow;
        expect(storedAliasAfter?.mode).to.equal(initialMode);
        expect(storedAliasAfter?.aliasPrivateKey).to.equal(oldAliasRow.aliasPrivateKey);
    } finally {
        await context.cleanup();
    }
}

async function buildSignedReplyPublication({
    signer,
    subplebbitAddress,
    postCid,
    parentCid
}: {
    signer: SignerWithPublicKeyAddress;
    subplebbitAddress: string;
    postCid: string;
    parentCid: string;
}) {
    const base = {
        signer,
        author: { address: signer.address },
        subplebbitAddress,
        timestamp: timestamp(),
        protocolVersion: PROTOCOL_VERSION,
        content: `transition-reply-${Date.now()}`,
        postCid,
        parentCid
    };
    const signature = await signComment({ comment: base, plebbit: {} as Plebbit });
    const publication = { ...base, signature } as CommentPubsubMessagePublication & { signer?: SignerWithPublicKeyAddress };
    delete publication.signer;
    return publication;
}

async function buildSignedPostPublication({
    signer,
    subplebbitAddress
}: {
    signer: SignerWithPublicKeyAddress;
    subplebbitAddress: string;
}) {
    const base = {
        signer,
        author: { address: signer.address },
        subplebbitAddress,
        timestamp: timestamp(),
        protocolVersion: PROTOCOL_VERSION,
        title: `transition-post-${Date.now()}`,
        content: `transition-post-content-${Date.now()}`
    };
    const signature = await signComment({ comment: base, plebbit: {} as Plebbit });
    const publication = { ...base, signature } as CommentPubsubMessagePublication & { signer?: SignerWithPublicKeyAddress };
    delete publication.signer;
    return publication;
}

async function ensureSubplebbitDbReady(subplebbit: LocalSubplebbit) {
    const sub = subplebbit as unknown as LocalSubplebbitWithPrivateMethods;
    if (typeof sub.initDbHandlerIfNeeded === "function") {
        await sub.initDbHandlerIfNeeded();
    }
    await subplebbit._dbHandler.initDbIfNeeded({ fileMustExist: false });
}

function expectStoredCommentToUseAlias(dbHandler: LocalSubplebbit["_dbHandler"], cid: string, aliasSigner: SignerWithPublicKeyAddress) {
    const stored = dbHandler.queryComment(cid) as StoredComment;
    expect(stored?.author?.address).to.equal(aliasSigner.address);
    expect(stored?.signature?.publicKey).to.equal(aliasSigner.publicKey);
}

async function createAnonymityTransitionContext(initialMode: string): Promise<AnonymityTransitionContext> {
    const plebbit = await mockPlebbit();
    const subplebbit = (await createSubWithNoChallenge({}, plebbit)) as LocalSubplebbit;
    await subplebbit.edit({ features: { pseudonymityMode: initialMode as "per-author" | "per-post" | "per-reply" } });
    await subplebbit._dbHandler.initDbIfNeeded({ fileMustExist: false });
    await subplebbit._dbHandler.createOrMigrateTablesIfNeeded();
    return {
        subplebbit,
        dbHandler: subplebbit._dbHandler,
        plebbit,
        subplebbitAddress: subplebbit.address,
        cleanup: async () => {
            await subplebbit.delete();
            await plebbit.destroy();
        }
    };
}

async function createPerAuthorSubplebbit(): Promise<PerAuthorContext> {
    const publisherPlebbit = await mockPlebbit();
    const subplebbit = await createSubWithNoChallenge({}, publisherPlebbit);
    await subplebbit.edit({ features: { pseudonymityMode: "per-author" } });
    await subplebbit.start();
    await resolveWhenConditionIsTrue({ toUpdate: subplebbit, predicate: async () => typeof subplebbit.updatedAt === "number" });

    return {
        publisherPlebbit,
        subplebbit,
        cleanup: async () => {
            await subplebbit.delete();
            await publisherPlebbit.destroy();
        }
    };
}

async function waitForStoredCommentUpdateWithAssertions(subplebbit: LocalSubplebbit, comment: Comment): Promise<StoredCommentUpdate> {
    const storedUpdate = await waitForStoredCommentUpdate(subplebbit, comment.cid);
    expect(storedUpdate.cid).to.equal(comment.cid);
    expect(storedUpdate.updatedAt).to.be.a("number");
    expect(storedUpdate.replyCount).to.be.a("number");
    expect(storedUpdate.protocolVersion).to.be.a("string");
    expect(storedUpdate.signature).to.be.an("object");
    expect(storedUpdate.signature.signedPropertyNames).to.be.an("array").that.is.not.empty;
    return storedUpdate;
}

async function waitForStoredCommentUpdate(subplebbit: LocalSubplebbit, cid: string): Promise<StoredCommentUpdate> {
    const timeoutMs = 60000;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const stored = subplebbit._dbHandler.queryStoredCommentUpdate({ cid }) as StoredCommentUpdate | undefined;
        if (stored) return stored;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for stored comment update for ${cid}`);
}
